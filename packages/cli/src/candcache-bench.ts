// Which compile commands the candidate store keys: the benchmark's own, and no other. A command is
// keyed only when it is, byte for byte, the committed template of a benchmark toolchain
// (apps/benchmark/dataset/toolchains/<id>/decomp.yaml) with the values the benchmark substitutes for
// its `$ASMLIFT_*` placeholders, and every program it runs is a native executable or a `#!/bin/sh`
// script whose whole program is `exec <program> "$@"`. A project's own command is never keyed: what
// its programs read besides its words has no bound, and a store keyed on the words would serve an
// old object after one of those reads changed. An installed CLI ships no benchmark, so it keys
// nothing.
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { stripShellComments } from './shell-text';

/** The benchmark toolchain a command was rendered for, and the value each `$ASMLIFT_*` placeholder
 *  of that toolchain's committed template took. */
export interface BenchCommand {
  toolchain: string;
  placeholders: Readonly<Record<string, string>>;
}

/** The checkout's committed benchmark configs: the same relative place from `src/` and `dist/`. */
const BENCH_TOOLCHAINS = fileURLToPath(new URL('../../../apps/benchmark/dataset/toolchains/', import.meta.url));

/** The reason every key of a command that is not the benchmark's own is refused. */
export const NOT_A_BENCH_TEMPLATE = 'the-command-is-not-a-bench-template';

/** `text` with each `"$NAME"` replaced by the shell-quoted value and each bare `$NAME` by the value
 *  itself, for every `ASMLIFT_*` name. Throws on a name `placeholders` has no value for. */
export function renderBenchPlaceholders(text: string, placeholders: Readonly<Record<string, string>>): string {
  return text.replace(/"\$(ASMLIFT_[A-Z0-9_]+)"|\$(ASMLIFT_[A-Z0-9_]+)/g, (_, quoted?: string, bare?: string) => {
    const value = placeholders[(quoted ?? bare)!];
    if (value === undefined) {
      throw new Error(`unknown placeholder $${quoted ?? bare}`);
    }
    return quoted !== undefined ? `'${value.replaceAll("'", `'\\''`)}'` : value;
  });
}

/** The committed compile template of the benchmark toolchain `toolchain`, or undefined where this
 *  checkout has none. */
function committedTemplate(toolchain: string): string | undefined {
  const file = join(BENCH_TOOLCHAINS, toolchain, 'decomp.yaml');
  if (!/^[\w.]+$/.test(toolchain) || !existsSync(file)) {
    return undefined;
  }
  const compiler = (YAML.parse(readFileSync(file, 'utf8')) as { tools?: { asmlift?: { compiler?: unknown } } })?.tools
    ?.asmlift?.compiler;
  return typeof compiler === 'string' ? compiler : undefined;
}

/** The benchmark's command for `bench`: its toolchain's committed template with the placeholders
 *  rendered, `{{…}}` left in place. */
export function benchCommand({ toolchain, placeholders }: BenchCommand): string {
  const template = committedTemplate(toolchain);
  if (template === undefined) {
    throw new Error(`no committed benchmark template for ${toolchain}`);
  }
  return renderBenchPlaceholders(template, placeholders);
}

class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};

/** What a file is, read off its first bytes: a program (an ELF or Mach-O executable or shared
 *  library), a `#!` script, or anything else. One that cannot be read is anything else. */
function fileKind(p: string): 'native' | 'script' | 'other' {
  let head: Buffer;
  try {
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(64);
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return 'other';
  }
  if (head.length >= 20) {
    const magic = head.readUInt32BE(0);
    // ELF: `e_type` 2 (an executable) or 3 (a shared object, which a position-independent
    // executable is too), in the byte order `EI_DATA` names.
    if (magic === 0x7f454c46) {
      const type = head[5] === 2 ? head.readUInt16BE(16) : head.readUInt16LE(16);
      return type === 2 || type === 3 ? 'native' : 'other';
    }
    // Mach-O: `filetype` 2 (an executable), 6 (a dylib), 7 (the dynamic linker) or 8 (a bundle);
    // a universal file, whose second word counts its architectures where a Java class file's
    // (same first word) is a version, holds programs.
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) {
      const type = magic === 0xfeedface || magic === 0xfeedfacf ? head.readUInt32BE(12) : head.readUInt32LE(12);
      return [2, 6, 7, 8].includes(type) ? 'native' : 'other';
    }
    if ((magic === 0xcafebabe || magic === 0xcafebabf) && head.readUInt32BE(4) < 0x20) {
      return 'native';
    }
  }
  return head.subarray(0, 2).toString('latin1') === '#!' ? 'script' : 'other';
}

/** The program a script runs when its interpreter line is exactly `#!/bin/sh` and its whole program
 *  is `exec <program> "$@"`, else undefined. Started as `sh`, bash, zsh and dash read no startup file
 *  running a script, whatever `ENV`, `BASH_ENV` or `ZDOTDIR` hold; zsh started as `zsh` reads
 *  `.zshenv` for every script, bash started as `bash` reads `$BASH_ENV`, and `sh -l` reads
 *  `.profile`. So no other interpreter and no interpreter flag is followed, and `refuseUnkeyedEnv`
 *  (candcache.ts) refuses while `ENV` or `BASH_ENV` is set. */
function execShimTarget(p: string): string | undefined {
  const [shebang, ...rest] = readFileSync(p, 'utf8').split('\n');
  if (!/^#!\/bin\/sh[ \t]*$/.test(shebang)) {
    return undefined;
  }
  const lines = stripShellComments(rest.join('\n'))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const exec = lines.length === 1 ? /^exec\s+(["']?)([A-Za-z0-9_./+-]+)\1\s+"\$@"$/.exec(lines[0]) : null;
  return exec === null ? undefined : exec[2];
}

/** Where the shell finds the program `name` on `env`'s PATH, or undefined. */
function onPath(name: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const p = join(dir === '' ? cwd : dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        return p;
      }
    } catch {
      /* not in this directory */
    }
  }
  return undefined;
}

/** How deep an `exec` shim may delegate to another. */
const SHIM_DEPTH = 4;

/** Refuses unless `name` (found at `path`) is a native executable, directly or through `exec`
 *  shims. */
function admitProgram(name: string, path: string | undefined, env: NodeJS.ProcessEnv, cwd: string, depth = 0): void {
  if (path === undefined) {
    refuse(`it runs ${name}, which is no program on this PATH`);
  }
  let real: string;
  try {
    real = realpathSync(path!);
  } catch {
    return refuse(`it runs ${name}, which does not exist`);
  }
  const st = statSync(real);
  if (!st.isFile() || (st.mode & 0o111) === 0) {
    refuse(`it runs ${name}, which is not an executable file`);
  }
  const kind = fileKind(real);
  if (kind === 'native') {
    return;
  }
  const target = kind === 'script' && depth < SHIM_DEPTH ? execShimTarget(real) : undefined;
  if (target === undefined) {
    refuse(
      kind === 'script'
        ? `it runs ${name}, a script that is not a flagless #!/bin/sh exec of a program with its own arguments`
        : `it runs ${name}, which is not a native executable`,
    );
  }
  // A relative path is the shell's working directory's, which this cannot know.
  const next = isAbsolute(target!) ? target : target!.includes('/') ? undefined : onPath(target!, env, cwd);
  admitProgram(target!, next, env, cwd, depth + 1);
}

/** The program word of each simple command of a committed template: a placeholder or a name. */
function programWords(template: string): string[] {
  return stripShellComments(template)
    .split(/;|&&|\n/)
    .map((c) => c.trim().split(/\s+/)[0])
    .filter((w) => w !== undefined && w !== '');
}

/**
 * Why no key compiled by `command` (a compile template, `{{flags}}` unfilled) may be stored, or
 * undefined when it is the benchmark's own: `bench`'s committed template rendered with
 * `bench.placeholders`, every program it runs admitted (`admitProgram`). `cwd` is where the command
 * runs and `env` the environment it runs under.
 */
export function benchCommandRefusal(
  command: string,
  bench: BenchCommand | undefined,
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): string | undefined {
  const template = bench === undefined ? undefined : committedTemplate(bench.toolchain);
  if (bench === undefined || template === undefined) {
    return NOT_A_BENCH_TEMPLATE;
  }
  let rendered: string;
  try {
    rendered = renderBenchPlaceholders(template, bench.placeholders);
  } catch {
    return NOT_A_BENCH_TEMPLATE;
  }
  if (rendered !== command) {
    return NOT_A_BENCH_TEMPLATE;
  }
  try {
    for (const word of programWords(template)) {
      const placeholder = /^"?\$(ASMLIFT_[A-Z0-9_]+)"?$/.exec(word);
      const name = placeholder === null ? word : bench.placeholders[placeholder[1]];
      if (placeholder === null && !/^[A-Za-z][\w.+-]*$/.test(word)) {
        refuse(`its program word ${word} is neither a placeholder nor a name`);
      }
      const path = name.includes('/') ? resolve(cwd, name) : onPath(name, env, cwd);
      admitProgram(name, path, env, cwd);
    }
  } catch (e) {
    if (e instanceof Refused) {
      return `the-bench-command-runs-what-the-store-cannot-key: ${e.message}`;
    }
    throw e;
  }
  return undefined;
}
