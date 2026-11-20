// asmlift — the files a project's assembly `.include`s, found the way gas finds them, and the names
// of the macros they define.
//
// gas reads an `.include "x"` as the file `x` relative to the directory it runs in, and failing
// that `x` under each `-I` directory, in order. A decomp project assembles from its root (the
// decomp.yaml directory, where the CLI runs the project's compile command), so that is the
// directory here, and the `-I` directories are the ones the project's compile command spells.
// The command may hand some of them to the preprocessor and not to gas (kl2dct's `-I include`):
// a file found two ways is no answer, so taking every `-I` the command spells can only turn an
// answer into none.
//
// A macro a project defines under an instruction's name (`.macro mov rd, imm` / `add \rd, \imm`)
// is expanded by gas before it reads the instruction of that name, so a text that calls one
// assembles to bytes its own lines do not spell. A reader of the text must then know every
// `.macro` name in force, and those are in the included files as much as in the text.
//
// THE RULE FOR NAMES IS #462's `definedMacros` (core frontend/splat.ts), copied here because that
// PR is not merged; the CLI's Splat include reader (lane INCREAD) unifies the two. Names are
// lower-cased (gas reads a macro name without case); a `.macro` is counted wherever it sits (in a
// body, under `.if 0`, after a `.purgem`), and here also inside a comment or a string, since this
// reader scans the raw text for every `.macro` rather than cutting it into statements: that errs
// toward a name more, never one fewer. `*` stands for a name this reader cannot read (`.macro \x`,
// `x: y .macro`), and matches every name.
//
// Every `.include` must be read the same way: one whose operand is not a plain path (see
// {@link isPlainPath}: `.include \x` in a macro body, a path built from a symbol, an absolute path, a
// `..` component), one no directory holds, one two directories hold, and one that includes a file
// already on the chain (gas recurses until it fails) each make the whole chain no answer, and the
// caller then gives no answer either.
//
// A `..` component is refused rather than resolved: the kernel walks `lnk/../x` through the link
// `lnk` points at, and a lexical `resolve` folds it to `./x`, another file (measured). With no `..`,
// the lexical join and the kernel's walk name the same file, and its realpath is the answer.
//
// THE COMMAND IS READ FAIL-CLOSED ({@link includeSearchFromCommand}): every flag that adds a file or a
// search directory the compile reads, other than the `-I` forms read there, gives no search at all.
// KNOWN GAP: a compile command that runs a script (`sh build.sh`) whose own text writes an `.include`
// or passes a flag is opaque here; only the command's own words are read.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Where gas looks for an included file: the directory it runs in, then each `-I` in order. */
export interface IncludeSearch {
  cwd: string;
  dirs: readonly string[];
}

/** A relative path of plain characters with no `..` component: one the lexical join and the
 *  kernel's walk read as the same file. */
export function isPlainPath(path: string): boolean {
  return /^[\w.+/-]+$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..');
}

// THE FLAGS OF A COMPILE COMMAND, in one place. Accepted: `-I <dir>`, `-I<dir>` and `-I"<dir>"`, where
// `<dir>` is plain characters with no `..` component (absolute allowed); they are the search
// directories, in order. Refused (no search, so no body): every other include-path or include-file
// flag, which adds a directory or a file this reader does not follow: gcc's `-i…` family
// (`-include`, `-imacros`, `-iquote`, `-isystem`, `-idirafter`, `-iprefix`, …), `--include…`,
// flags handed to the assembler or preprocessor (`-Wa,`, `-Wp,`, `-Xassembler`, `-Xpreprocessor`),
// a response file (`@file`), a `-D`/`-U` naming anything with `asm` in it (it would rewrite the
// header's `asm(…)` or INCLUDE_ASM), and an `-I` whose directory is not plain (`-I $(D)`, `-I-`).
//
// The command runs in a shell, which can spell any flag the words do not (`X=-include` then `$X`,
// `$(… | base64 -d)`, `"-"include`, `$CPPFLAGS`). So before any flag is read, EVERY WORD MUST BE
// SHELL-LITERAL (an allowlist, like the header's): words are split on blanks and line breaks, and
// each is the template's `{{…}}` placeholders and {@link LITERAL_WORD} characters only, or exactly
// `-I"<dir>"`. Any other character (`$`, a backtick, a quote, `\`, `(`, `)`, `<`, `>`, `|`, `&`, `;`,
// `*`, `?`, `[`, `~`, `!`, `#`, `{`, …), a `NAME=value` word anywhere (an assignment, or one `env`
// hands the compile: `CPATH=…`), or a line starting `.`, `source`, `eval` or `exec` gives no search.
const REFUSED_FLAG = /^(?:-i|--include|-Wa,|-Wp,|-Xassembler|-Xpreprocessor|@)/;
const LITERAL_WORD = /^[A-Za-z0-9_./+,=:-]*$/;
const QUOTED_I = /^-I"[\w.+/-]+"$/;
const REFUSED_COMMAND_WORD = new Set(['.', 'source', 'eval', 'exec']);

/** Whether `command` is words a shell reads as written (see above). */
function shellLiteral(command: string): boolean {
  for (const line of command.split('\n')) {
    const words = line.split(/[ \t]+/).filter((w) => w !== '');
    if (words.length > 0 && REFUSED_COMMAND_WORD.has(words[0])) {
      return false;
    }
    for (const w of words) {
      if (/^[A-Za-z_]\w*=/.test(w) || !(QUOTED_I.test(w) || LITERAL_WORD.test(w.replace(/\{\{\w+\}\}/g, '')))) {
        return false;
      }
    }
  }
  return true;
}
const PLAIN_DIR = (d: string) => /^[\w.+/-]+$/.test(d) && d !== '-' && !d.split('/').includes('..');

/** The `-I` directories a compile command and its flags spell, in order, resolved against `cwd`;
 *  undefined where the command is not shell-literal or carries any flag the list above refuses. */
export function includeSearchFromCommand(
  cwd: string,
  command: string,
  flags: readonly string[] = [],
): IncludeSearch | undefined {
  if (!shellLiteral(command) || !flags.every((f) => shellLiteral(f))) {
    return undefined;
  }
  const words = `${command} ${flags.join(' ')}`.split(/\s+/).filter((w) => w !== '');
  const dirs: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (REFUSED_FLAG.test(w)) {
      return undefined;
    }
    if (/^-[DU]/.test(w)) {
      const name = w.length > 2 ? w.slice(2) : (words[k + 1] ?? '');
      if (/asm/i.test(name)) {
        return undefined;
      }
      continue;
    }
    if (w.startsWith('-I')) {
      const raw = (w.length > 2 ? w.slice(2) : (words[++k] ?? '')).replace(/^"(.*)"$/, '$1');
      if (!PLAIN_DIR(raw)) {
        return undefined;
      }
      dirs.push(resolve(cwd, raw));
    }
  }
  return { cwd, dirs };
}

/** The one file `path` names under `search`; undefined where it is no plain path, or none or two
 *  different files answer it. */
export function resolveInclude(path: string, search: IncludeSearch): string | undefined {
  if (!isPlainPath(path)) {
    return undefined;
  }
  const found = new Set<string>();
  for (const t of [search.cwd, ...search.dirs].map((d) => resolve(d, path))) {
    try {
      if (existsSync(t) && statSync(t).isFile()) {
        found.add(realpathSync(t));
      }
    } catch {
      return undefined;
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Every `.include` of a gas text, in order, as the path it names; undefined where one is not
 *  written `.include "<path>"` with a plain path (see the header). */
export function includeOperands(text: string): string[] | undefined {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w.$])\.include(?![\w.$])(.*)/gi)) {
    const op = m[1].match(/^\s+"([^"\\\n]+)"\s*(?:[@#;].*)?$/);
    if (op === null || !isPlainPath(op[1])) {
      return undefined;
    }
    out.push(op[1]);
  }
  return out;
}

/** The name of every `.macro` a gas text defines, lower-cased, `*` for one this reader cannot read
 *  (see the header), with the statements of each definition's body where its lines are plain
 *  (no `"`, `'`, `;` or comment opener; undefined otherwise). */
export function definedMacros(text: string): Map<string, Array<string[] | undefined>> {
  const out = new Map<string, Array<string[] | undefined>>();
  const add = (name: string, body: string[] | undefined) => {
    out.set(name, [...(out.get(name) ?? []), body]);
  };
  const lines = text.split('\n');
  for (const [k, line] of lines.entries()) {
    for (const m of line.matchAll(/(?<![\w.$])\.macro(?![\w.$])/gi)) {
      const at = m.index;
      const before = line.slice(0, at);
      const after = line.slice(at + m[0].length);
      const labels = /^\s*(?:[A-Za-z_.$][\w.$]*\s*:\s*)*$/.test(before)
        ? [...before.matchAll(/([A-Za-z_.$][\w.$]*)\s*:/g)].map((l) => l[1])
        : undefined;
      const operand = after.match(/^\s+([A-Za-z_.$][\w.$]*)(?=$|[\s,@])/)?.[1];
      if (labels === undefined || (operand === undefined && labels.length === 0)) {
        add('*', undefined);
        continue;
      }
      const body = macroBody(lines, k + 1);
      // a label before `.macro` is the macro's name (thumb.ts macro scan), and the operand may be
      // too: both count
      for (const n of [...labels, ...(operand === undefined ? [] : [operand])]) {
        add(n.toLowerCase(), body);
      }
    }
  }
  return out;
}

/** The statements from line `from` to the next `.endm`, where every one is plain. */
function macroBody(lines: readonly string[], from: number): string[] | undefined {
  const out: string[] = [];
  for (let k = from; k < lines.length; k++) {
    const t = lines[k].replace(/@.*$/, '').trim();
    if (/["';]|\/\*|\*\/|^#/.test(t) || /(?<![\w.$])\.macro(?![\w.$])/i.test(t)) {
      return undefined;
    }
    if (/^\.endm$/i.test(t)) {
      return out;
    }
    if (t !== '') {
      out.push(t);
    }
  }
  return undefined;
}

/** What an include chain gives: each included file's path and text in the order gas reads them,
 *  and the macros they define ({@link definedMacros}). */
export interface IncludedTexts {
  texts: Array<{ path: string; text: string }>;
  macros: Map<string, Array<string[] | undefined>>;
}

/** The files `paths` (each an `.include` operand, in order) and every file they include in turn,
 *  depth first as gas reads them; undefined where any one is no answer (see the header). */
export function readIncludes(paths: readonly string[], search: IncludeSearch): IncludedTexts | undefined {
  const texts: IncludedTexts['texts'] = [];
  const macros: IncludedTexts['macros'] = new Map();
  const visit = (path: string, chain: readonly string[]): boolean => {
    const file = resolveInclude(path, search);
    if (file === undefined || chain.includes(file)) {
      return false;
    }
    let text: string;
    try {
      text = readFileSync(file, 'latin1');
    } catch {
      return false;
    }
    texts.push({ path: file, text });
    for (const [name, bodies] of definedMacros(text)) {
      macros.set(name, [...(macros.get(name) ?? []), ...bodies]);
    }
    const nested = includeOperands(text);
    return nested !== undefined && nested.every((p) => visit(p, [...chain, file]));
  };
  return paths.every((p) => visit(p, [])) ? { texts, macros } : undefined;
}
