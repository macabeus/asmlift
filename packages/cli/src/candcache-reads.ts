// What a candidate TU reads besides its own bytes — the per-KEY half of the candidate store's
// soundness (candcache.ts holds the namespace half). A stored answer is keyed on the TU's text and
// the pipeline's namespace, and a file the TU names is in neither, so an answer that read one is
// never kept.
//
// The compile's own preprocessor says which files it entered: its dependency list
// (`cppReportFlags`) is exact however the directive was spelled — behind a `//` comment holding
// `/*`, a string holding `/*`, a line splice on a form feed or a lone CR, `#embed`, or a macro.
// What no such list can show is read off the text, and every textual test here matches more
// spellings than any compiler honours, so a miss can only cost a cache hit:
//   - a lookup that found nothing (`__has_include`, `__has_embed`) leaves no entry, yet its answer
//     changes when the file appears; `##` can build those names, and the path and clock macros,
//     out of pieces;
//   - with no list (a preprocessor inside the compiler, or one that stopped on an error), any
//     directive that can name a file. A directive's name is never macro-expanded or pasted, so it
//     is in the text as a whole word, at most broken by line splices or spelled with a UCN. That
//     includes `#line` and a linemarker: a GCC-family compiler quoting a source line in a
//     diagnostic reads it from the file the line's NAME names;
//   - what a GNU assembler reads: `.include` and `.incbin` open files, and its macros, an asm
//     operand, a string escape or a string concatenation can each build those names, so inline
//     asm with any template text is refused. A string the compiler copies into its assembly
//     unquoted (a section name, MEASURED on agbcc and GCC 2.7.2: `section(".data\n.incbin …")`
//     puts the `.incbin` on a line of its own) is refused when, decoded and joined, it names a
//     directive that reads a file or builds one. Only preprocessed text holds every string whole.
//     Raw text cannot say which construct copies a string out (a macro, a trigraph or a flag of the
//     command builds one with no keyword in the TU), and GNU `as` names a file only in a string, so
//     raw text refuses any string text it could make;
//   - with no list, the command too: a word that defines a macro or reads flags or text from
//     elsewhere hands the TU text it never spelled, which the TU's own text cannot show.
import { existsSync, readFileSync } from 'node:fs';

/** What a compile's preprocessor reported about a TU it ran to the end on. */
export interface PreprocessorReport {
  /** every file it entered besides the TU itself */
  files: readonly string[];
  /** the text it produced */
  text: string;
}

/** How a pipeline's answer for a TU is classified. */
export interface ReadsCheck {
  /** its preprocessor's report, when one ran to the end; without one the TU's text is read */
  report?: PreprocessorReport;
  /** whether inline asm reaches a GNU assembler, which reads `.include` and `.incbin` files */
  gnuAs: boolean;
  /** the compile's command as text, with the value of every variable it reads: read when there is
   *  no report */
  command: string;
}

/** A line splice in any spelling some compiler honours: a backslash or the `??/` trigraph, any
 *  horizontal whitespace, then a newline written as LF, CRLF or a lone CR. */
const SPLICE = String.raw`(?:\\|\?\?/)[ \t\f\v]*(?:\r\n|\r|\n)`;

/** `w` as a whole word, with a line splice allowed between any two of its characters. Every
 *  boundary is read off the raw text, where a splice's own backslash or newline also counts as one:
 *  matched in more places than a compiler sees the word, never fewer. */
const word = (w: string): string => `(?<![A-Za-z0-9_])${[...w].join(`(?:${SPLICE})*`)}(?![A-Za-z0-9_])`;
const words = (ws: readonly string[]): RegExp => new RegExp(ws.map(word).join('|'));

const HASH = String.raw`(?:#|%(?:${SPLICE})*:|\?\?=)`;
/** A block comment, which may sit between a directive's `#` and its name. */
const COMMENT = String.raw`/(?:${SPLICE})*\*[\s\S]*?\*(?:${SPLICE})*/`;
const GAP = String.raw`(?:[ \t\f\v]|${SPLICE}|${COMMENT})*`;
const PASTE = new RegExp(`${HASH}(?:${SPLICE})*${HASH}`);
const PROBE = words(['__has_include', '__has_include_next', '__has_embed']);
const PATH_OR_CLOCK = words([
  '__FILE__',
  '__BASE_FILE__',
  '__FILE_NAME__',
  '__DATE__',
  '__TIME__',
  '__TIMESTAMP__',
  '__INCLUDE_LEVEL__',
]);
/** The directives that open a file — `include`, `include_next`, `import`, `embed` — and GCC's
 *  `#pragma GCC dependency`, whose diagnostics depend on one. */
const FILE_DIRECTIVE = words(['include', 'include_next', 'import', 'embed', 'dependency']);
/** `#line` or a GNU linemarker (`# 12 "name"`): what follows is named after a file the compile may
 *  read to quote a line of it. */
const LINE_DIRECTIVE = new RegExp(`${HASH}${GAP}(?:${word('line')}|[0-9])`);
const UCN = new RegExp(String.raw`(?:\\|\?\?/)(?:${SPLICE})*[uU]`);
const ASM = words(['asm', '__asm', '__asm__']);
/** An asm statement whose template is empty: `asm("")`, `__asm__ volatile("" ::: "memory")`. */
const EMPTY_ASM =
  /(?<![A-Za-z0-9_])(?:__asm__|__asm|asm)\s*(?:(?:__volatile__|__volatile|volatile|inline|goto)\s*)*\(\s*""\s*(?=[:)])/g;

/** A directive that reads a file, or a GNU assembler macro, loop or mode that can build one. */
const AS_FILE_DIRECTIVE = /\.\s*(?:inc|macro|irp|mri)/i;
const C_ESCAPE = /\\(?:x([0-9a-fA-F]+)|([0-7]{1,3})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([\s\S]))/g;
const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  f: '\f',
  a: '\x07',
  b: '\b',
  e: '\x1b',
};
const decoded = (s: string): string =>
  s.replace(C_ESCAPE, (_m, x?: string, o?: string, u?: string, U?: string, c?: string) =>
    x !== undefined
      ? String.fromCharCode(parseInt(x.slice(-2), 16))
      : o !== undefined
        ? String.fromCharCode(parseInt(o, 8) & 0xff)
        : u !== undefined || U !== undefined
          ? String.fromCodePoint(Math.min(parseInt((u ?? U)!, 16), 0x10ffff))
          : (SIMPLE_ESCAPES[c!] ?? c!),
  );
/** Every string literal of preprocessed C, decoded and joined end to end. */
const stringText = (text: string): string =>
  [...text.matchAll(/'(?:\\.|[^'\\\n])*'|"((?:\\.|[^"\\\n])*)"/g)].map((m) => decoded(m[1] ?? '')).join('');

/** Whether raw text can make string text: a `"` anywhere (in a character constant too, which costs
 *  that key only), any trigraph, or a `#` that is not the first token of its line, which a macro
 *  body stringizes with. */
function mayMakeStringText(text: string): boolean {
  if (text.includes('"') || text.includes('??')) {
    return true;
  }
  const directive = new RegExp(`^[ \\t\\f\\v]*${HASH}`);
  const hash = new RegExp(HASH);
  return text
    .replace(new RegExp(SPLICE, 'g'), '')
    .split(/\r\n|\r|\n/)
    .some((l) => hash.test(l.replace(directive, '')));
}

/** Whether a GNU assembler fed `text`'s compile may read a file: inline asm with a template, or a
 *  string naming a file directive. `preprocessed` text holds no comment or splice, and every string
 *  in it is whole, so its strings are read decoded and joined; raw text is refused when it can make
 *  string text at all, or names a directive anywhere, splices joined. */
function assemblerMayReadFile(text: string, preprocessed: boolean): boolean {
  if (ASM.test(text.replace(EMPTY_ASM, ''))) {
    return true;
  }
  if (preprocessed) {
    return AS_FILE_DIRECTIVE.test(stringText(text));
  }
  return mayMakeStringText(text) || AS_FILE_DIRECTIVE.test(decoded(text.replace(new RegExp(SPLICE, 'g'), '')));
}

/** A word of a compile command that hands the TU text it never spelled, or reads the TU's text
 *  otherwise: a macro defined or undefined (`-D`, `-U`, CodeWarrior's `-d`/`-define`), a file read
 *  ahead of the TU (`-include`, `-imacros`, CodeWarrior's `-prefix`), flags from a file (`@file`,
 *  `-specs`), from a command's output (`$(…)`, a backquote) or handed straight to the preprocessor
 *  (`-Xpreprocessor`), a preprocessor that pastes tokens across a comment (`-traditional`), or
 *  another input charset. Matched wherever a word may start, quotes ignored. */
const COMMAND_SHAPES_TEXT =
  /(?:^|[\s"'`=,;&|()\\])(?:-[DUd]|--?(?:define|undefine|include|imacros|specs)|-prefix|-Xpreprocessor|-traditional|-finput-charset|@)|\$\(|`/;
/** The command words that are fixed and make no string: a macro defined as `1` or as a number, or
 *  undefined, each one bare word. */
const PLAIN_MACRO_WORD = /(?<=^|\s)-(?:D[A-Za-z_]\w*(?:=[0-9][\w.]*)?|U[A-Za-z_]\w*)(?=\s|$)/g;
/** The command substitutions that print only a scratch path. */
const PATH_SUBSTITUTION = /\$\((?:dirname|basename) \{\{(?:inputPath|outputPath)\}\}\)/g;

/** Whether `command` may hand the TU text it never spelled (`COMMAND_SHAPES_TEXT`). */
const commandShapesText = (command: string): boolean =>
  COMMAND_SHAPES_TEXT.test(command.replace(PLAIN_MACRO_WORD, ' ').replace(PATH_SUBSTITUTION, ' '));

/** The reason no answer for `tu` may be stored, whatever its compile reports, or undefined: what a
 *  preprocessor's dependency list cannot show. Checked before the store is asked. */
export function candidateCacheRefusal(tu: string): string | undefined {
  if (PROBE.test(tu)) {
    return 'the-TU-asks-whether-a-file-exists';
  }
  if (PASTE.test(tu)) {
    return 'the-TU-pastes-tokens';
  }
  // MEASURED: three uncached compiles of one `__FILE__` TU produced three different 836-byte objects
  // through the very namespace the bench uses, and the stamp probe — one fixed TU that uses neither —
  // certified the pipeline pure.
  if (PATH_OR_CLOCK.test(tu)) {
    return 'the-TU-bakes-its-path-or-the-clock-into-the-object';
  }
  return undefined;
}

/** The reason the answer compiled for `tu` may not be stored, or undefined. */
export function candidateReadsRefusal(tu: string, { report, gnuAs, command }: ReadsCheck): string | undefined {
  const before = candidateCacheRefusal(tu);
  if (before !== undefined) {
    return before;
  }
  if (report === undefined) {
    if (commandShapesText(command)) {
      return 'the-command-hands-the-TU-text';
    }
    if (FILE_DIRECTIVE.test(tu) || LINE_DIRECTIVE.test(tu) || UCN.test(tu)) {
      return 'the-TU-may-read-a-file';
    }
  } else if (report.files.length > 0) {
    return 'the-TU-reads-a-file';
  }
  if (gnuAs && assemblerMayReadFile(report?.text ?? tu, report !== undefined)) {
    return 'the-TU-hands-its-assembler-text';
  }
  return undefined;
}

const DEP_TARGET = 'tu';

/** The flags under which a GNU cpp reports everything it read: its dependency list, written to
 *  `depPath`, and messages that quote no source line, since a quote is read from the file a line's
 *  name names, which no list shows. */
export const cppReportFlags = (depPath: string): string[] => [
  '-MD',
  '-MF',
  depPath,
  '-MT',
  DEP_TARGET,
  '-fno-diagnostics-show-caret',
];

/** The report of a GNU cpp that ran to the end writing its dependency list for `target` to
 *  `depPath` (`cppReportFlags`) and its text to `iPath`, from `tuPath` (undefined: from stdin, which
 *  its list leaves out). A list in any other shape names a file this cannot read, and is kept as
 *  one. */
export function cppReport(depPath: string, iPath: string, tuPath?: string, target = DEP_TARGET): PreprocessorReport {
  if (!existsSync(iPath)) {
    return { files: ['<no preprocessor output>'], text: '' };
  }
  const text = readFileSync(iPath, 'utf8');
  if (!existsSync(depPath)) {
    return { files: ['<no dependency list>'], text };
  }
  const list = readFileSync(depPath, 'utf8')
    .replace(/\\\r?\n/g, ' ')
    .trim();
  if (list === '') {
    return { files: [], text };
  }
  if (!list.startsWith(`${target}:`)) {
    return { files: [list], text };
  }
  const files = (list.slice(target.length + 1).match(/(?:\\.|[^\s\\])+/g) ?? [])
    .map((f) => f.replace(/\\(.)/g, '$1').replaceAll('$$', '$'))
    .filter((f) => f !== tuPath);
  return { files, text };
}
