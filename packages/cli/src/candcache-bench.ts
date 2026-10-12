// Which compile commands the candidate store keys: the benchmark's own, and no other. A command is
// keyed only when it is, byte for byte, a committed template of a benchmark toolchain — its
// decomp.yaml command (apps/benchmark/dataset/toolchains/<id>/decomp.yaml) or the command it runs on a
// host that runs it natively (apps/benchmark/dataset/toolchains/native-commands.yaml) — with the
// values the benchmark substitutes for its `$ASMLIFT_*` placeholders, every program it runs is a
// native executable or a `#!/bin/sh` script whose whole program is `exec <program> "$@"`, and the
// shell it runs under is `/bin/sh`. A project's own command is never keyed: what its programs read
// besides its words has no bound, and a store keyed on the words would serve an old object after one
// of those reads changed. An installed CLI ships no benchmark, so it keys nothing.
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { findOnPath } from './candcache';
import { stripShellComments } from './shell-text';

/** The benchmark toolchain a command was rendered for, the value each `$ASMLIFT_*` placeholder of
 *  that toolchain's committed template took, and whether the template is its native command. */
export interface BenchCommand {
  toolchain: string;
  placeholders: Readonly<Record<string, string>>;
  native?: boolean;
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

/** The native commands' file: each toolchain's command for a host that runs it natively. */
export const NATIVE_COMMANDS_FILE = join(BENCH_TOOLCHAINS, 'native-commands.yaml');

/** The committed compile template of the benchmark toolchain `toolchain` — its native command when
 *  `native` — or undefined where this checkout has none. */
function committedTemplate(toolchain: string, native = false): string | undefined {
  if (!/^[\w.]+$/.test(toolchain)) {
    return undefined;
  }
  const file = native ? NATIVE_COMMANDS_FILE : join(BENCH_TOOLCHAINS, toolchain, 'decomp.yaml');
  if (!existsSync(file)) {
    return undefined;
  }
  const doc = YAML.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  const template = native
    ? doc?.[toolchain]
    : (doc as { tools?: { asmlift?: { compiler?: unknown } } } | null)?.tools?.asmlift?.compiler;
  return typeof template === 'string' ? template : undefined;
}

/** The benchmark's command for `bench`: its toolchain's committed template with the placeholders
 *  rendered, `{{…}}` left in place. */
export function benchCommand({ toolchain, placeholders, native }: BenchCommand): string {
  const template = committedTemplate(toolchain, native);
  if (template === undefined) {
    throw new Error(`no committed benchmark ${native ? 'native command' : 'template'} for ${toolchain}`);
  }
  return renderBenchPlaceholders(template, placeholders);
}

const refuse = (why: string): never => {
  throw new Error(why);
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
  const next = isAbsolute(target!) ? target : target!.includes('/') ? undefined : findOnPath(target!, env, [cwd]);
  admitProgram(target!, next, env, cwd, depth + 1);
}

/** One simple command of a template: the assignments it opens with and its program word. */
interface SimpleCommand {
  assignments: string[];
  program: string;
}

/** Every simple command of a committed template, in order: each `;`, `&&` or newline separated
 *  command, and the command of each `$(…)` in it. */
export function templateCommands(template: string): SimpleCommand[] {
  const text = stripShellComments(template);
  const pieces = [...text.matchAll(/\$\(([^()]*)\)/g)].map((m) => m[1]);
  const out: SimpleCommand[] = [];
  for (const piece of [...text.split(/;|&&|\n/), ...pieces]) {
    const words = piece
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '');
    const assignments: string[] = [];
    while (words.length > 0 && /^[A-Za-z_]\w*=/.test(words[0])) {
      assignments.push(words.shift()!);
    }
    if (words.length > 0) {
      out.push({ assignments, program: words[0] });
    }
  }
  return out;
}

/** The assignments a committed template may open a command with, per native command: GCC 2.7.2's
 *  driver finds its `cc1` and assembler through `COMPILER_PATH`, here its own directory, which the
 *  namespace hashes by content like every directory a template names. */
const NATIVE_ASSIGNMENTS: Readonly<Record<string, readonly string[]>> = {
  'gcc2.7.2': ['COMPILER_PATH="$ASMLIFT_GCC272_DIR"'],
};

/** The shell builtins a committed template runs, which name no program. */
const BUILTINS = new Set(['cd']);

/**
 * Why no key compiled by `command` (a compile template, `{{flags}}` unfilled) may be stored, or
 * undefined when it is the benchmark's own: `bench`'s committed template rendered with
 * `bench.placeholders`, and admitted by `templateRefusal`. `cwd` is where the command runs and `env`
 * the environment it runs under.
 */
export function benchCommandRefusal(
  command: string,
  bench: BenchCommand | undefined,
  where: { cwd: string; env: NodeJS.ProcessEnv },
): string | undefined {
  const template = bench === undefined ? undefined : committedTemplate(bench.toolchain, bench.native);
  if (bench === undefined || template === undefined) {
    return NOT_A_BENCH_TEMPLATE;
  }
  let rendered: string;
  try {
    rendered = renderBenchPlaceholders(template, bench.placeholders);
  } catch {
    return NOT_A_BENCH_TEMPLATE;
  }
  return rendered === command ? templateRefusal(template, bench, where) : NOT_A_BENCH_TEMPLATE;
}

/** Why the template `template`, rendered with `bench.placeholders`, runs what the store cannot key,
 *  or undefined: it runs under the `/bin/sh` a spawn finds as `sh` on `env`'s PATH, every program it
 *  runs is admitted (`admitProgram`), and every assignment it makes is one `NATIVE_ASSIGNMENTS` lists
 *  for `bench`. */
export function templateRefusal(
  template: string,
  bench: BenchCommand,
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): string | undefined {
  try {
    const sh = findOnPath('sh', env, [cwd]);
    if (sh === undefined || realpathSync(sh) !== realpathSync('/bin/sh')) {
      refuse(`its shell, the sh a spawn finds on PATH, is ${sh ?? 'on no PATH directory'} and not /bin/sh`);
    }
    const assignable = (bench.native === true && NATIVE_ASSIGNMENTS[bench.toolchain]) || [];
    for (const { assignments, program } of templateCommands(template)) {
      for (const a of assignments) {
        if (!assignable.includes(a)) {
          refuse(`it assigns ${a} for ${program}`);
        }
      }
      if (BUILTINS.has(program)) {
        continue;
      }
      const placeholder = /^"?\$(ASMLIFT_[A-Z0-9_]+)"?((?:\/[\w.+-]+)*\/?)$/.exec(program);
      if (placeholder === null && !/^[A-Za-z][\w.+-]*$/.test(program)) {
        refuse(`its program word ${program} is neither a placeholder nor a name`);
      }
      const value = placeholder === null ? program : bench.placeholders[placeholder[1]];
      if (value === undefined) {
        refuse(`its program word ${program} names a placeholder with no value`);
      }
      const name = placeholder === null ? program : value + placeholder[2];
      const path = name.includes('/') ? resolve(cwd, name) : findOnPath(name, env, [cwd]);
      admitProgram(name, path, env, cwd);
    }
  } catch (e) {
    return `the-bench-command-runs-what-the-store-cannot-key: ${(e as Error).message}`;
  }
  return undefined;
}
