// Which project compile commands the candidate store keys at all. A key is a TU's text under a
// namespace (compile-command.ts `stamp`): the command's text, the files and directories its words
// name, the programs it runs and the variables it reads. A program the command runs can read more
// than that, and each of these served an old object after a file it read changed: a wrapper script
// adding `-include pre.h` to its arguments, flags piped from a file through `xargs`, a variable
// named through another (`${!P}`). Whatever shape comes next is constructible, so a command is
// admitted only in a form whose every input is in view, and any other form refuses every key:
//   - simple commands joined by `;` or `&&`. No pipe, background job, subshell, group, input
//     redirection, glob, backquote, backslash escape (a line continuation aside) or command
//     substitution, but `$(dirname …)` and `$(basename …)` of `{{inputPath}}` or `{{outputPath}}`,
//     which print a scratch path. No expansion but `$NAME` or `${NAME}` of a variable the command
//     does not set itself;
//   - output redirected only to /dev/null or into the scratch directory;
//   - each program a native executable (Mach-O or ELF), found as the shell finds it, or a shell
//     script whose whole program is `exec <program> "$@"`, which adds nothing to the words;
//   - no other word naming a program, a script or a text file, which a program could run or read as
//     flags or code; a word naming nothing holds only a flag's or a path's characters;
//   - `cd` only into the scratch directory, and an assignment before a program only of a plain word
//     or of a path that exists, which the namespace hashes.
// What the admitted words still hand the TU (`-D`, `-include`, `@file`) is the per-key check's
// (candcache-reads.ts), which reads them.
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

import { stripShellComments } from './shell-text';

/** A command's words as its programs receive them, or why no key of it may be stored. */
export type CommandAdmission = { words: string[] } | { refusal: string };

class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};

interface Word {
  /** the word after quote removal and expansion */
  text: string;
  /** how the command spells it */
  raw: string;
}

interface SimpleCommand {
  words: Word[];
  /** the files its output is redirected to */
  targets: Word[];
}

/** The command substitutions that print a scratch path. */
const PATH_SUBSTITUTION = /^\$\((?:dirname|basename) \{\{(?:inputPath|outputPath)\}\}\)/;
/** Whether `w` is a path in the scratch directory, which holds only the candidate's own files: a
 *  scratch file's name extended (`{{inputPath}}.s`), or a path under its directory. A basename is a
 *  scratch path only where the shell runs in that directory (`inScratch`), and no `..` leaves it. */
function isScratchPath(w: string, inScratch: boolean): boolean {
  const m =
    /^(?:\{\{(?:inputPath|outputPath)\}\}([A-Za-z0-9_./-]*)|\$\(dirname \{\{(?:inputPath|outputPath)\}\}\)((?:\/[A-Za-z0-9_./-]*)?)|\$\(basename \{\{(?:inputPath|outputPath)\}\}\)([A-Za-z0-9_./-]*))$/.exec(
      w,
    );
  if (m === null || (m[3] !== undefined && !inScratch)) {
    return false;
  }
  return !/(?:^|\/)\.\.(?:\/|$)/.test(m[1] ?? m[2] ?? m[3]);
}
/** The characters of a flag's operand or a path. */
const PLAIN = /^[A-Za-z0-9_.,+=:/ -]*$/;
const BARE_NAME = /^[A-Za-z][\w.+-]*$/;
/** The shells that read `exec <program> "$@"` alike. */
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
/** How deep an `exec` shim may delegate to another. */
const SHIM_DEPTH = 4;

/** The simple commands `text` runs, with every word expanded through `env`. */
function simpleCommands(text: string, env: NodeJS.ProcessEnv): SimpleCommand[] {
  const assigned = new Set<string>();
  for (const m of stripShellComments(text).matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=/g)) {
    assigned.add(m[1]);
  }
  const commands: SimpleCommand[] = [];
  let words: Word[] = [];
  let targets: Word[] = [];
  let word: Word | undefined;
  let redirecting = false;
  const add = (s: string, raw: string): void => {
    word ??= { text: '', raw: '' };
    word.text += s;
    word.raw += raw;
  };
  const endWord = (): void => {
    if (word === undefined) {
      return;
    }
    (redirecting ? targets : words).push(word);
    redirecting = false;
    word = undefined;
  };
  const endCommand = (): void => {
    endWord();
    if (redirecting) {
      refuse('a redirection names no file');
    }
    if (words.length > 0 || targets.length > 0) {
      commands.push({ words, targets });
    }
    words = [];
    targets = [];
  };
  /** A `{{…}}` at `at`: a scratch path, or a refusal. */
  const placeholder = (at: number): number => {
    const m = /^\{\{(\w+)\}\}/.exec(text.slice(at));
    if (m === null) {
      return refuse('a brace group or expansion');
    }
    if (m[1] !== 'inputPath' && m[1] !== 'outputPath') {
      return refuse(`a word holding {{${m[1]}}}, whose value can name a file`);
    }
    add(m[0], m[0]);
    return at + m[0].length;
  };
  /** A `$` expansion at `at`, quoted or split into words as the shell splits it. */
  const expansion = (at: number, quoted: boolean): number => {
    const rest = text.slice(at);
    const sub = PATH_SUBSTITUTION.exec(rest);
    if (sub !== null) {
      add(sub[0], sub[0]);
      return at + sub[0].length;
    }
    const v = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(rest);
    if (v === null) {
      return refuse(`the expansion ${rest.slice(0, 3)}…, which is neither $NAME nor \${NAME}`);
    }
    const name = v[1] ?? v[2];
    if (assigned.has(name)) {
      refuse(`$${name}, a variable the command sets itself`);
    }
    const value = env[name] ?? '';
    if (quoted) {
      add(value, v[0]);
    } else {
      if (/[*?[]/.test(value)) {
        refuse(`$${name} unquoted, whose value is a glob`);
      }
      for (const c of value) {
        if (c === ' ' || c === '\t' || c === '\n') {
          endWord();
        } else {
          add(c, v[0]);
        }
      }
    }
    return at + v[0].length;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n') {
      i += 2;
    } else if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '#' && word === undefined) {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
    } else if (c === '\n' || c === ';') {
      endCommand();
      i++;
    } else if (c === '&' && text[i + 1] === '&') {
      endCommand();
      i += 2;
    } else if (c === '>') {
      if (word !== undefined && /^[0-9]+$/.test(word.raw)) {
        word = undefined;
      } else {
        endWord();
      }
      i += text[i + 1] === '>' ? 2 : 1;
      if (text[i] === '&') {
        const fd = /^&[0-9]+/.exec(text.slice(i));
        if (fd === null) {
          refuse('a redirection that closes or moves a descriptor');
        }
        i += fd![0].length;
      } else {
        redirecting = true;
      }
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) {
        refuse('an unterminated quote');
      }
      const body = text.slice(i + 1, close);
      for (const m of body.matchAll(/\{\{(\w+)\}\}/g)) {
        if (m[1] !== 'inputPath' && m[1] !== 'outputPath') {
          refuse(`a word holding {{${m[1]}}}, whose value can name a file`);
        }
      }
      add(body, text.slice(i, close + 1));
      i = close + 1;
    } else if (c === '"') {
      i++;
      add('', '"');
      while (i < text.length && text[i] !== '"') {
        const d = text[i];
        if (d === '\\' || d === '`') {
          refuse(d === '`' ? 'a backquote' : 'a backslash escape');
        } else if (d === '$') {
          i = expansion(i, true);
        } else if (d === '{' && text[i + 1] === '{') {
          i = placeholder(i);
        } else {
          add(d, d);
          i++;
        }
      }
      if (i >= text.length) {
        refuse('an unterminated quote');
      }
      add('', '"');
      i++;
    } else if (c === '$') {
      i = expansion(i, false);
    } else if (c === '{') {
      i = placeholder(i);
    } else if (c === '|') {
      refuse('a pipe');
    } else if (c === '&') {
      refuse('a command run in the background');
    } else if (c === '<') {
      refuse('an input redirection');
    } else if (c === '(' || c === ')' || c === '}') {
      refuse('a subshell or group');
    } else if (c === '`') {
      refuse('a backquote');
    } else if (c === '\\') {
      refuse('a backslash escape');
    } else if (c === '*' || c === '?' || c === '[' || c === '~' || c === '!') {
      refuse(`the unquoted ${c}, which the shell expands or reads as an operator`);
    } else {
      add(c, c);
      i++;
    }
  }
  endCommand();
  return commands;
}

/** What a file is, read off its first bytes: a program (an ELF or Mach-O executable or shared
 *  library), a `#!` script, other text, or other binary data (an object file among it). One that
 *  cannot be read is text, the refusing side. */
function fileKind(p: string): 'native' | 'script' | 'text' | 'binary' {
  let head: Buffer;
  try {
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(8192);
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return 'text';
  }
  if (head.length >= 20) {
    const magic = head.readUInt32BE(0);
    // ELF: `e_type` 2 (an executable) or 3 (a shared object, which a position-independent
    // executable is too), in the byte order `EI_DATA` names.
    if (magic === 0x7f454c46) {
      const type = head[5] === 2 ? head.readUInt16BE(16) : head.readUInt16LE(16);
      return type === 2 || type === 3 ? 'native' : 'binary';
    }
    // Mach-O: `filetype` 2 (an executable), 6 (a dylib), 7 (the dynamic linker) or 8 (a bundle);
    // a universal file, whose second word counts its architectures where a Java class file's
    // (same first word) is a version, holds programs.
    if (magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe) {
      const type = magic === 0xfeedface || magic === 0xfeedfacf ? head.readUInt32BE(12) : head.readUInt32LE(12);
      return [2, 6, 7, 8].includes(type) ? 'native' : 'binary';
    }
    if ((magic === 0xcafebabe || magic === 0xcafebabf) && head.readUInt32BE(4) < 0x20) {
      return 'native';
    }
  }
  if (head.subarray(0, 2).toString('latin1') === '#!') {
    return 'script';
  }
  return head.includes(0) ? 'binary' : 'text';
}

/** The program a script runs when its whole program is `exec <program> "$@"` under a shell, else
 *  undefined. */
function execShimTarget(p: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
  const [shebang, ...rest] = text.split('\n');
  const interpreter = /^#!\s*(\/\S+)(?:\s+-[A-Za-z]+)?\s*$/.exec(shebang);
  if (interpreter === null || !SHELLS.has(basename(interpreter[1]))) {
    return undefined;
  }
  try {
    if (fileKind(realpathSync(interpreter[1])) !== 'native') {
      return undefined;
    }
  } catch {
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

/** Whether `name` resolves to a native executable, directly or through `exec` shims. */
function admitProgram(name: string, path: string | undefined, env: NodeJS.ProcessEnv, cwd: string, depth = 0): void {
  if (path === undefined) {
    refuse(`it runs ${name}, a shell builtin or no program on this PATH`);
  }
  let real: string;
  try {
    real = realpathSync(path!);
    const st = statSync(real);
    if (!st.isFile() || (st.mode & 0o111) === 0) {
      refuse(`it runs ${name}, which is not an executable file`);
    }
  } catch (e) {
    if (e instanceof Refused) {
      throw e;
    }
    return refuse(`it runs ${name}, which does not exist`);
  }
  const kind = fileKind(real);
  if (kind === 'native') {
    return;
  }
  const target = kind === 'script' && depth < SHIM_DEPTH ? execShimTarget(real) : undefined;
  if (target === undefined) {
    refuse(
      kind === 'script'
        ? `it runs ${name}, a script that does more than exec a program with its own arguments`
        : `it runs ${name}, which is not a native executable`,
    );
  }
  // A relative path is the shell's working directory's, which a `cd` before the shim moves.
  const next = isAbsolute(target!) ? target : target!.includes('/') ? undefined : onPath(target!, env, cwd);
  admitProgram(target!, next, env, cwd, depth + 1);
}

/**
 * The command `command` (a compile template, `{{flags}}` filled) as the words its programs receive,
 * or the reason it is not admitted: see the head of this file. `cwd` is where it runs; `env` is the
 * environment it runs under.
 */
export function commandAdmission(
  command: string,
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): CommandAdmission {
  try {
    const commands = simpleCommands(command, env);
    let inScratch = false;
    /** The path a word names, where the shell would look for it. */
    const pathOf = (w: string): string | undefined => (isAbsolute(w) ? w : inScratch ? undefined : resolve(cwd, w));
    const words: string[] = [];
    for (const { words: all, targets } of commands) {
      for (const t of targets) {
        if (t.text !== '/dev/null' && !isScratchPath(t.text, inScratch)) {
          refuse(`a redirection to ${t.text}, outside the scratch directory`);
        }
      }
      const at = all.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w.raw));
      if (at === -1) {
        refuse('a command that only sets shell variables');
      }
      const [program, ...args] = all.slice(at);
      words.push(...all.map((w) => w.text));
      if (program.text === 'cd' && at === 0) {
        if (
          args.length !== 1 ||
          !/^\$\(dirname \{\{(?:inputPath|outputPath)\}\}\)$/.test(args[0].text) ||
          targets.length > 0
        ) {
          refuse('a cd anywhere but into the scratch directory');
        }
        inScratch = true;
        continue;
      }
      for (const a of all.slice(0, at)) {
        const value = a.text.slice(a.text.indexOf('=') + 1);
        const p = value === '' ? undefined : pathOf(value);
        const exists = p !== undefined && statOrUndefined(p) !== undefined;
        if (a.text.startsWith('PATH=') || !(exists || /^[A-Za-z0-9_.,+-]*$/.test(value))) {
          refuse(`the assignment ${a.text}, which names no path the namespace can hash`);
        }
      }
      if (basename(program.text) === 'env') {
        refuse('it runs env, which runs whatever program its words name');
      }
      const programPath = program.text.includes('/') ? pathOf(program.text) : onPath(program.text, env, cwd);
      admitProgram(program.text, programPath, env, cwd);
      for (const a of args) {
        admitArgument(a, program.text, isScratchPath(a.text, inScratch), pathOf, env, cwd);
      }
    }
    return { words };
  } catch (e) {
    if (e instanceof Refused) {
      return { refusal: e.message };
    }
    throw e;
  }
}

const statOrUndefined = (p: string): ReturnType<typeof statSync> | undefined => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};

/** Refuses an argument that names a program, a script or a text file, or that holds characters
 *  neither a flag's operand nor a path has. A flag is the per-key check's to read; a scratch path
 *  names only the candidate's own files. */
function admitArgument(
  a: Word,
  program: string,
  scratch: boolean,
  pathOf: (w: string) => string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): void {
  if (a.text.startsWith('-') || scratch) {
    return;
  }
  const pieces = new Set([a.text, ...a.text.split(/\s+/)].filter((s) => s !== ''));
  for (const piece of pieces) {
    const p = pathOf(piece);
    const st = p === undefined ? undefined : statOrUndefined(p);
    if (st !== undefined) {
      if (st.isDirectory() || p === '/dev/null') {
        continue;
      }
      const kind = st.isFile() ? fileKind(p!) : 'special';
      if (kind === 'native' || kind === 'script') {
        refuse(`it hands ${program} ${piece}, a program or a script`);
      }
      if (kind !== 'binary') {
        refuse(`it hands ${program} ${piece}, a file it may read as flags or code`);
      }
      continue;
    }
    if (!PLAIN.test(piece)) {
      refuse(`it hands ${program} the word ${piece}, which is neither a flag nor a path`);
    }
    if (BARE_NAME.test(piece) && onPath(piece, env, cwd) !== undefined) {
      refuse(`it hands ${program} ${piece}, a program on this PATH`);
    }
  }
}
