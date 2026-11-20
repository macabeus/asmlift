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
// Every `.include` must be read the same way: one whose operand is not a plain quoted path
// (`.include \x` in a macro body, a path built from a symbol), one no directory holds, one two
// directories hold, and one that includes a file already on the chain (gas recurses until it
// fails) each make the whole chain no answer, and the caller then gives no answer either.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Where gas looks for an included file: the directory it runs in, then each `-I` in order. */
export interface IncludeSearch {
  cwd: string;
  dirs: readonly string[];
}

/** The `-I` directories a compile command and its flags spell, in order, resolved against `cwd`;
 *  undefined where one is not a plain word (`-I $(DIR)`, `-I{{x}}`), since the directory gas then
 *  searches is not known. */
export function includeSearchFromCommand(
  cwd: string,
  command: string,
  flags: readonly string[] = [],
): IncludeSearch | undefined {
  const dirs: string[] = [];
  for (const m of `${command} ${flags.join(' ')}`.matchAll(/(?<=^|\s)-I(?:\s+|(?=\S))(\S+)/g)) {
    const raw = m[1].replace(/^(["'])(.*)\1$/, '$2');
    if (!/^[\w./+-]+$/.test(raw)) {
      return undefined;
    }
    dirs.push(resolve(cwd, raw));
  }
  return { cwd, dirs };
}

/** The one file `path` names under `search`; undefined where none does or two different ones do. */
export function resolveInclude(path: string, search: IncludeSearch): string | undefined {
  const tries = isAbsolute(path) ? [path] : [search.cwd, ...search.dirs].map((d) => resolve(d, path));
  const found = new Set<string>();
  for (const t of tries) {
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
    if (op === null) {
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
