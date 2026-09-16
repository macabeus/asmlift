// asmlift — compiler flags, parsed into the codegen profile a function was compiled at.
//
// A function's compile and its decompile read one flag set. The compile receives the argv verbatim,
// and every flag set of a toolchain decompiles against that toolchain's compiler behaviors
// (target.ts). The profile says what the flags make the compiler do, for display, grouping and
// derivation: each option that can change what the compiler emits, as a named slot holding the value
// the compiler acts on (`O=1`, `g=3`, `-fhex-asm=on`), next to the build's own words for it.
//
// Every word is one of two kinds, per compiler family:
//   inert    cannot change what the compiler emits for a preprocessed translation unit: include
//            paths, defines, diagnostics. A build's flags are stored without them.
//   codegen  may change the object or the assembly text. A table entry names its slot; a word no
//            table names is codegen too, reported as unclassified and never assumed inert.
//
// WHERE A TABLE SAYS HOW A FAMILY READS ITS FLAGS, IT CITES THE COMPILED PAIR IT WAS READ OFF. Each
// pair compares `.text` after `objcopy -j .text` (agbcc: the whole `.s`; mwcc: the whole object), on
// these probes:
//   loop.c    int arr[64];
//             int sum(int n){ int i, s = 0; for (i = 0; i < n; i++) { s += arr[i] * 3 + i; } return s; }
//             int mul(int a, int b){ int x = a * b; int y = x + a; return y - b + x * 2; }
//   call.c    int g(int);
//             int f(int a, int b) { int i, s = 0; for (i = 0; i < a; i++) { s += b * 4 + g(i); } return s; }
//   hoist.c   extern unsigned char *gp; void A(int); void B(int);
//             void f(int c) { if (c) A(*gp); else B(*gp); }
//   common.c  int counter; int bump(void){ return ++counter; }
//   sq.c      static int sq(int x) { return x * x; }
//             int f(int *a, int n) { int s = 0, i; for (i = 0; i < n; i++) s += sq(a[i]) + a[i] * 3; return s; }
//   inl.c     static int f(int x){ return x * 3 + 1; } int g(int y){ return f(y) + f(y + 2); }
//   str.c     const char* a(void){ return "hello"; } const char* b(void){ return "hello"; }
//   big.c     int tbl[100]; int glob;
//             static int add3(int a, int b, int c) { return a + b + c; }
//             int g(int *a, int *b, int n, int k) { int i, j, s = 0;
//               for (i = 0; i < n; i++) { a[i] = b[k * 2 + 1] + i * 4; s += add3(a[i], k, i); }
//               for (i = 0; i < 8; i++) for (j = 0; j < 8; j++) s += tbl[i * 8 + j] * j;
//               return s; }
//             int h(int a, int b) { int x = a * b + 3; int y = a * b + 5; glob = x; return x * y + (a * b) + glob; }
//             float fl(float *v, int n) { float t = 0.0f; int i; for (i = 0; i < n; i++) t += v[i] * v[i]; return t; }
//             int sw(int x) { switch (x) { case 0: return 7; case 1: return 9; case 2: return 11; case 3: return 13;
//                                          case 4: return 2; case 5: return 5; default: return -1; } }
//             void cp(char *d, const char *s, int n) { while (n--) *d++ = *s++; }
// agbcc at `-mthumb-interwork -fhex-asm`, IDO 7.1 at `-mips2 -32 -non_shared -G 0`, KMC gcc at its
// canonical flags, and mwcc_242_81 at `-proc gekko`, each with the words named at the entry.
//
// Browser-pure: string work only. Deriving flags from a build reads files and lives outside core.

export type FlagFamily = 'agbcc' | 'ido' | 'gcc' | 'mwcc';

const FAMILIES: readonly FlagFamily[] = ['agbcc', 'ido', 'gcc', 'mwcc'];

/** The characters a double-quoted backslash escapes in POSIX sh; before any other it is literal. */
const DQ_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);

/** POSIX shell word splitting with quotes and backslashes, and no expansion. dtk projects spell
 *  `-pragma "cats off"`, which is one argument; a backslash-newline continues the line, as in a
 *  Makefile recipe. An unterminated quote throws, naming its column. */
export function tokenizeFlags(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let quoteAt = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === '\\' && quote === '"' && DQ_ESCAPABLE.has(text[i + 1])) {
        if (text[++i] !== '\n') {
          word += text[i];
        }
      } else {
        word += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      quoteAt = i + 1;
      inWord = true;
    } else if (c === '\\' && i + 1 < text.length) {
      if (text[++i] !== '\n') {
        word += text[i];
        inWord = true;
      }
    } else if (/\s/.test(c)) {
      if (inWord) {
        out.push(word);
      }
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) {
    throw new Error(`unterminated ${quote} quote at column ${quoteAt}: ${text}`);
  }
  if (inWord) {
    out.push(word);
  }
  return out;
}

type Match = readonly (string | undefined)[];

interface OptionSpec {
  /** the exact word, or a pattern over it */
  match: string | RegExp;
  /** the slot a codegen option assigns, or how its match names one; options sharing a slot override
   *  each other and the last wins. Absent ⇒ inert. */
  slot?: string | ((m: Match) => string);
  /** the value is the next word */
  takesArg?: boolean;
  /** the value is a comma list the shell may have split into several words (`-str reuse, readonly`) */
  commaList?: boolean;
  /** each occurrence adds to what the earlier ones set, so none overrides another */
  accumulates?: boolean;
  /** the value the compiler acts on, from the spelled one (the argument, else the pattern's last
   *  capture group, else empty) */
  value?: (spelled: string, m: Match) => string;
}

const toggle = (_: string, m: Match) => (m[1] ? 'off' : 'on');

const cppAndDiagnostics: OptionSpec[] = [
  { match: /^-[IDU](.+)$/ },
  { match: /^-(I|D|U|iquote|isystem|include)$/, takesArg: true },
  // `-W<pass>,<option>` hands an option to another pass (gcc `-Wa,`, IDO `-Wo,`), so it is codegen:
  // IDO loop.c at -O2 is 256 bytes of `.text`, and 96 with `-Wo,-loopunroll,0`. Every other `-W` is a
  // diagnostic.
  { match: /^-W(?![a-z]+,)/ },
  { match: /^-(w|quiet|nostdinc|c)$/ },
];

const gccFamily: OptionSpec[] = [
  // toplev.c assigns `optimize` at every -O it scans, so the last level wins (agbcc hoist.c: `-O2 -O1`
  // and `-O1`, same `.s`). Bare -O is level 1 (`-O` and `-O1`, same `.s`), and a level above 3 is 3
  // (`-O9` and `-O3`, same `.s`).
  { match: '-O', slot: 'O', value: () => '1' },
  { match: /^-O(\d+)$/, slot: 'O', value: (v) => String(Math.min(Number(v), 3)) },
  // -Os sets optimize_size beside level 2, so it is its own level: agbcc hoist.c differs at `-O2` and
  // `-Os`, where the address load moves above the branch.
  { match: '-Os', slot: 'O', value: () => 's' },
  ...cppAndDiagnostics,
  // -B tells the driver where its own programs are: which compiler runs is the toolchain, not a flag
  { match: /^-B(.+)$/ },
  { match: '-B', takesArg: true },
  // agbcc -g is codegen: over the 181 vendored agbcc translation units `.text` is byte-identical with
  // and without it at -O0, -O2, -O3 and -Os, and differs at -O1 on one (pokeemerald
  // `Cmd_tryconversiontypechange`).
  { match: /^-g(\d?)$/, slot: 'g', value: (v) => v || '2' },
  // KMC loop.c: `-G 0` and `-G0`, same `.text`
  { match: '-G', slot: 'G', takesArg: true },
  { match: /^-G(\d+)$/, slot: 'G' },
  { match: /^-mips(\d)$/, slot: 'mips' },
  { match: /^-E([BL])$/, slot: 'endian' },
  { match: '-x', slot: 'x', takesArg: true },
  // the driver hands every `-Wa,` list to the assembler, so the occurrences add up
  { match: /^-Wa,(.+)$/, slot: 'Wa', accumulates: true },
  { match: /^-m([A-Za-z][\w-]*)=(.*)$/, slot: (m) => `-m${m[1]}=` },
  // gcc keeps one variable per -f/-m switch, set by the switch and cleared by its no- form, so the
  // last wins: agbcc common.c at -O2 puts `counter` in .bss with `-fcommon -fno-common` and emits
  // `.comm counter` with `-fno-common -fcommon`.
  { match: /^-f(no-)?([A-Za-z][\w-]*)$/, slot: (m) => `-f${m[2]}`, value: toggle },
  { match: /^-m(no-)?([A-Za-z][\w-]*)$/, slot: (m) => `-m${m[2]}`, value: toggle },
];

const TABLES: Record<FlagFamily, readonly OptionSpec[]> = {
  agbcc: gccFamily,
  ido: [
    // the last level wins (`-O1 -O2` and `-O2`, same `.text` on loop.c and call.c), and bare -O is
    // -O2 (`-O` and `-O2`, same `.text` on both)
    { match: '-O', slot: 'O', value: () => '2' },
    { match: /^-O([0-3])$/, slot: 'O' },
    // `-Olimit 3000 -O2` and `-O2 -Olimit 3000` both compile to `-O2`'s `.text` on both probes
    { match: '-Olimit', slot: 'Olimit', takesArg: true },
    ...cppAndDiagnostics,
    // -g alone is -g2; `-O2 -g3` and `-O2` differ on both probes
    { match: /^-g([0-3]?)$/, slot: 'g', value: (v) => v || '2' },
    { match: '-woff', takesArg: true },
    { match: /^-(Xcpluscomm|Xfullwarn|fullwarn|verbose)$/ },
    { match: /^-mips([1-4])$/, slot: 'mips' },
    { match: '-32', slot: 'abi', value: () => '32' },
    { match: '-non_shared', slot: 'pic', value: () => 'non_shared' },
    { match: '-signed', slot: 'char', value: () => 'signed' },
    { match: '-G', slot: 'G', takesArg: true },
    { match: /^-G(\d+)$/, slot: 'G' },
  ],
  gcc: gccFamily,
  mwcc: [
    // mwcceppc takes -O, -O0…-O4, -Op, -Os and -O<0-4>,<p|s>, and refuses anything else: `-O+p` is
    // "Unknown option '+p'; expected one of '0, 1, 2, 3, 4, p, or s'". A word sets a level, a mode or
    // both, and `mwccLevel` reads what a sequence of them compiles at.
    { match: /^-O((?:[0-4](?:,[ps])?|[ps])?)$/, slot: 'O' },
    { match: /^-[ID](.+)$/ },
    { match: /^-(d|D|i|I|ir|maxerrors|w|msgstyle)$/, takesArg: true },
    { match: /^-(nodefaults|nosyspath|nostdinc|stderr|c|multibyte|requireprotos)$/ },
    // `-dialect | -lang keyword` is one option under two names (mwcceppc -help), and all four
    // spellings compile the same source to the same object in the container.
    { match: /^-(?:lang|dialect)=(.+)$/, slot: 'lang' },
    { match: '-dialect', slot: 'lang', takesArg: true },
    { match: '-fp', slot: 'fp', takesArg: true, value: (v) => (v === 'hardware' ? 'hard' : v) },
    // These add to what earlier occurrences enabled. At -O4,p inl.c with `-inline auto -inline
    // deferred` differs from both `-inline auto` and `-inline deferred`, and str.c with `-str noreuse
    // -str pool,readonly` differs from `-str pool,readonly`.
    ...['str', 'inline'].map((o): OptionSpec => ({
      match: `-${o}`,
      slot: o,
      takesArg: true,
      commaList: true,
      accumulates: true,
    })),
    { match: '-rostr', slot: 'rostr', value: () => 'on' },
    ...[
      'lang',
      'proc',
      'sdata',
      'sdata2',
      'sdatathreshold',
      'char',
      'fp_contract',
      'use_lmw_stmw',
      'pool',
      'enum',
      'common',
      'func_align',
      'RTTI',
      'Cpp_exceptions',
      'align',
      'sym',
      'vector',
    ].map((o): OptionSpec => ({ match: `-${o}`, slot: o, takesArg: true })),
  ],
};

interface Implication {
  /** each slot's values, one of which the profile must carry */
  when: Readonly<Record<string, readonly string[]>>;
  set: Readonly<Record<string, string>>;
  note: string;
}

/** What a family's compiler does where the flags are silent, and what one slot does to another. */
const EFFECTIVE: Record<FlagFamily, { defaults: Readonly<Record<string, string>>; implies: readonly Implication[] }> = {
  // agbcc hoist.c with no -O emits `-O0`'s `.s`
  agbcc: { defaults: { O: '0' }, implies: [] },
  ido: {
    // cc with no -O compiles loop.c and call.c to `-O1`'s `.text`
    defaults: { O: '1' },
    implies: [
      // uopt warns "file not optimized; use -g3 if both optimization and debug wanted": on both
      // probes `-O2 -g` compiles to `-O1 -g`'s `.text` and `-O2 -g1` to `-g1`'s. `-O3 -g` does so on
      // call.c only, so it stays -O3.
      {
        when: { O: ['2'], g: ['1', '2'] },
        set: { O: '1' },
        note: 'ido does not optimise with -g or -g1: -O2 compiles as -O1 (-g3 keeps both)',
      },
    ],
  },
  gcc: { defaults: {}, implies: [] },
  mwcc: { defaults: {}, implies: [] },
};

/** A `-O` word a family cannot read. `spelledBy` is the family whose levels are spelled that way,
 *  when the word is a toolchain mix-up rather than a typo. */
export class UnreadableLevelError extends Error {
  constructor(
    readonly word: string,
    readonly family: FlagFamily,
    readonly spelledBy: FlagFamily | undefined,
  ) {
    super(
      spelledBy === undefined
        ? `${word} is not an optimisation level ${family} accepts`
        : `${word} is not an optimisation level ${family} accepts; ${spelledBy} spells its levels that way`,
    );
  }
}

/** A `-O` word the family cannot read: mwcc refuses every level it does not know, and a word another
 *  family spells its levels with (`-O4,p` given to agbcc) is a toolchain mix-up. Any other `-O` word
 *  is left to the compiler. */
function refuseLevel(family: FlagFamily, word: string): void {
  if (!word.startsWith('-O')) {
    return;
  }
  if (family === 'mwcc') {
    throw new UnreadableLevelError(word, family, undefined);
  }
  const other = FAMILIES.find((f) => f !== family && specFor(f, word)?.spec.slot === 'O');
  if (other !== undefined && !/^-O(\d*|s)$/.test(word)) {
    throw new UnreadableLevelError(word, family, other);
  }
}

export interface CodegenProfile {
  family: FlagFamily;
  /** slot → the value the compiler acts on: the last spelled value (every value, for an option whose
   *  occurrences add up), the family's default where no flag names the slot, then what other slots imply */
  slots: Readonly<Record<string, string>>;
  /** slot → the build's own words for it (`-fhex-asm`, `-inline auto -inline deferred`); absent for a default */
  spelled: Readonly<Record<string, string>>;
  /** codegen words no table names, in build order, an exact repeat kept at its last position only;
   *  the compiler still receives every one */
  unclassified: readonly string[];
  /** argv indices of every codegen word a later word overrode or repeated */
  overriddenAt: readonly number[];
  /** argv indices of every inert word and its argument */
  inertAt: readonly number[];
  /** argv indices of every word that is neither an option nor an option's argument, such as the file
   *  a compile command names or `-` for standard input; each is also unclassified */
  operandAt: readonly number[];
  /** argv positions by option, in build order: an option with its argument words, a word no table names
   *  with the operand right after it (the table cannot say whether it takes one), every other word alone */
  spans: readonly (readonly number[])[];
  /** one line per override that changed a value, `-O1 overridden by later -O2` */
  overrides: readonly string[];
  /** one line per value the compiler reads other than as spelled: a level word it reads as another level,
   *  or a value another slot implies */
  implied: readonly string[];
}

function specFor(family: FlagFamily, word: string): { spec: OptionSpec; m: Match } | undefined {
  for (const spec of TABLES[family]) {
    const m = typeof spec.match === 'string' ? (word === spec.match ? [word] : null) : word.match(spec.match);
    if (m) {
      return { spec, m };
    }
  }
  return undefined;
}

/** A word that is not an option: a file, or `-`, which names standard input. */
const isOperand = (word: string): boolean => word === '-' || !word.startsWith('-');

/** A `-pragma` whose name only steers diagnostics. `cats` is NOT one of them: `-pragma "cats off"`
 *  suppresses the `.mwcats.text` section CodeWarrior otherwise writes — one ADDR32 record per
 *  function — so a build stored without it emits a section the build itself does not. (Measured on
 *  Pikmin's `nlibmath.cpp`: the section appears and disappears with the word, and the function's
 *  own bytes are identical either way.) */
const INERT_PRAGMA = /^(warn_\w+|msg_show_realref)\b/;

interface LevelReading {
  value: string;
  /** the words still in force, and where they are */
  spelled: string;
  at: number[];
  overriddenAt: number[];
  /** each note, at the position of the word that overrode */
  overrides: { at: number; line: string }[];
}

/** The level mwcc compiles at after its `-O` words. Each pair below compiles to one object on sq.c, loop.c
 *  and big.c:
 *  - a word sets a level (bare -O is -O2: `-O` and `-O2`), a mode (p for speed, s for size), or both;
 *  - a mode holds until another mode: `-O4 -Op`, `-Op -O4` and `-O4,p`; `-O4,p -O0` and `-O0,p`;
 *  - a mode with no level is level 0: `-Op` and `-O0,p`; `-Os` and `-O0`;
 *  - a level replaces the one before it: `-O3 -O2` and `-O2`; `-O1 -O3` and `-O3`; `-O2 -O1 -O4` and `-O4`;
 *    `-O2 -O1 -O0` and `-O0`; `-O4 -O0 -O1` and `-O1`;
 *  - except that a lower level keeps what a higher one turned on. A level from 1 to 3 after -O4 adds to it:
 *    `-O4 -O2`, `-O4,p -O2,p` and `-O2 -O4 -O2` compile alike, to neither `-O4` nor `-O2`, and `-O4 -O2 -O1`
 *    to `-O4 -O1`. -O1 after -O2 or -O3 adds to it: `-O2 -O1`, `-O3 -O2 -O1` and `-O1 -O2 -O1` compile alike,
 *    to neither `-O2` nor `-O1` on big.c, while `-O2 -O1 -O2` is `-O2`.
 *  A level is otherwise kept as spelled: sq.c differs at `-O4` and `-O4,p`, and at `-O0` and `-O0,p`.
 *  `-O4` and `-O4,s` compile alike and stay apart anyway: a value that splits two equal objects costs
 *  grouping, and one that merged two different objects would be wrong. The value names the higher level
 *  a lower one keeps and the lower level (`4 -O2,p`, `2 -O1`), and a word is overridden once later words
 *  set everything it set. */
function mwccLevel(words: readonly { at: number; word: string }[]): LevelReading {
  const read = words.map(({ at, word }) => {
    const m = /^-O(?:([0-4])(?:,([ps]))?|([ps]))?$/.exec(word);
    return { at, word, level: word === '-O' ? '2' : m?.[1], mode: m?.[2] ?? m?.[3], levelSet: true, modeSet: true };
  });
  let levels: typeof read = [];
  let mode: (typeof read)[number] | undefined;
  const value = () =>
    `${levels.length === 0 ? '0' : levels.map((l) => l.level).join(' -O')}${mode ? `,${mode.mode}` : ''}`;
  const overriddenAt: number[] = [];
  const overrides: LevelReading['overrides'] = [];
  read.forEach((w, k) => {
    const before = k === 0 ? undefined : value();
    const earlier = read.slice(0, k);
    const inForce = (r: (typeof read)[number]) =>
      (r.level !== undefined && r.levelSet) || (r.mode !== undefined && r.modeSet);
    const live = earlier.filter(inForce);
    if (w.level !== undefined) {
      const kept =
        w.level === '0' || w.level === '4'
          ? undefined
          : (levels.find((l) => l.level === '4') ??
            (w.level === '1' ? levels.find((l) => l.level === '2' || l.level === '3') : undefined));
      earlier.forEach((r) => (r.levelSet = r === kept && r.levelSet));
      levels = kept === undefined ? [w] : [kept, w];
    }
    if (w.mode !== undefined) {
      earlier.forEach((r) => (r.modeSet = false));
      mode = w;
    }
    const after = value();
    for (const r of live.filter((r) => !inForce(r))) {
      overriddenAt.push(r.at);
      if (before !== after && r.word !== w.word) {
        overrides.push({ at: w.at, line: `${r.word} overridden by later ${w.word}` });
      }
    }
  });
  const kept = read.filter((r) => !overriddenAt.includes(r.at));
  return {
    value: value(),
    spelled: kept.map((r) => r.word).join(' '),
    at: kept.map((r) => r.at),
    overriddenAt,
    overrides,
  };
}

/** The profile of one flag set. Throws on a `-O` word the family cannot read. */
export function parseFlags(family: FlagFamily, argv: readonly string[]): CodegenProfile {
  const slots: Record<string, string> = {};
  const unknown: number[] = [];
  const lastAt = new Map<string, { at: number[]; spelled: string }>();
  const overriddenAt: number[] = [];
  const inertAt: number[] = [];
  const overrides: LevelReading['overrides'] = [];
  const mwccLevelWords: { at: number; word: string }[] = [];
  const spans: number[][] = [];
  const assign = (slot: string, value: string, at: number[], spelled: string, accumulates: boolean) => {
    const prev = lastAt.get(slot);
    if (prev && accumulates) {
      slots[slot] = `${slots[slot]} ${value}`;
      lastAt.set(slot, { at: [...prev.at, ...at], spelled: `${prev.spelled} ${spelled}` });
      return;
    }
    if (prev) {
      overriddenAt.push(...prev.at);
      if (slots[slot] !== value) {
        overrides.push({ at: at[0], line: `${prev.spelled} overridden by later ${spelled}` });
      }
    }
    lastAt.set(slot, { at, spelled });
    slots[slot] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (family === 'mwcc' && word === '-pragma') {
      const at = i + 1 < argv.length ? [i, i + 1] : [i];
      spans.push(at);
      const text = argv[i + 1] ?? '';
      if (INERT_PRAGMA.test(text)) {
        inertAt.push(...at);
      } else {
        const [name, ...rest] = text.split(/\s+/);
        assign(`pragma:${name}`, rest.join(' '), at, `-pragma "${text}"`, false);
      }
      i++;
      continue;
    }
    const hit = specFor(family, word);
    if (!hit) {
      refuseLevel(family, word);
      unknown.push(i);
      spans.push([i]);
      continue;
    }
    if (family === 'mwcc' && hit.spec.slot === 'O') {
      mwccLevelWords.push({ at: i, word });
      spans.push([i]);
      continue;
    }
    const at = [i];
    let spelledValue = hit.m.length > 1 ? (hit.m[hit.m.length - 1] ?? '') : '';
    if (hit.spec.takesArg) {
      spelledValue = argv[i + 1] ?? '';
      if (i + 1 < argv.length) {
        at.push(++i);
      }
      while (hit.spec.commaList && spelledValue.endsWith(',') && i + 1 < argv.length) {
        spelledValue += argv[++i];
        at.push(i);
      }
    }
    spans.push(at);
    if (hit.spec.slot === undefined) {
      inertAt.push(...at);
      continue;
    }
    const slot = typeof hit.spec.slot === 'string' ? hit.spec.slot : hit.spec.slot(hit.m);
    const value = hit.spec.value ? hit.spec.value(spelledValue, hit.m) : spelledValue;
    assign(slot, value, at, at.map((k) => argv[k]).join(' '), hit.spec.accumulates === true);
  }
  if (mwccLevelWords.length > 0) {
    const level = mwccLevel(mwccLevelWords);
    slots.O = level.value;
    lastAt.set('O', { at: level.at, spelled: level.spelled });
    overriddenAt.push(...level.overriddenAt);
    overrides.push(...level.overrides);
  }

  const rules = EFFECTIVE[family];
  for (const [slot, v] of Object.entries(rules.defaults)) {
    if (!(slot in slots)) {
      slots[slot] = v;
    }
  }
  const implied: string[] = [];
  // a level word the compiler reads as another level (agbcc `-O9` is `-O3`), or level words it reads
  // together (mwcc `-O4 -O2`), before what other slots imply
  const spelledLevel = lastAt.get('O')?.spelled;
  if (spelledLevel !== undefined) {
    const reading = [
      ...(spelledLevel === `-O${slots.O}` ? [] : [`-O${slots.O}`]),
      ...(slots.O.includes(' ') ? ['neither level alone'] : []),
    ];
    if (reading.length > 0) {
      implied.push(`${family} reads ${spelledLevel} as ${reading.join(', ')}`);
    }
  }
  for (const rule of rules.implies) {
    if (Object.entries(rule.when).every(([slot, vs]) => slot in slots && vs.includes(slots[slot]))) {
      Object.assign(slots, rule.set);
      implied.push(rule.note);
    }
  }

  const lastUnknown = new Map<string, number>();
  for (const k of unknown) {
    lastUnknown.set(argv[k], k);
  }
  const unclassified: string[] = [];
  for (const k of unknown) {
    if (!isOperand(argv[k]) && lastUnknown.get(argv[k]) !== k) {
      overriddenAt.push(k);
    } else {
      unclassified.push(argv[k]);
    }
  }
  const unknownAt = new Set(unknown);
  const grouped: number[][] = [];
  for (const span of spans) {
    const previous = grouped.at(-1);
    const joinsPrevious =
      previous?.length === 1 &&
      span.length === 1 &&
      unknownAt.has(previous[0]) &&
      !isOperand(argv[previous[0]]) &&
      isOperand(argv[span[0]]);
    if (joinsPrevious) {
      previous.push(span[0]);
    } else {
      grouped.push([...span]);
    }
  }
  return {
    family,
    slots,
    spelled: Object.fromEntries([...lastAt].map(([slot, { spelled }]) => [slot, spelled])),
    unclassified,
    overriddenAt: overriddenAt.sort((a, b) => a - b),
    inertAt,
    operandAt: unknown.filter((k) => isOperand(argv[k])),
    spans: grouped,
    overrides: overrides.sort((a, b) => a.at - b.at).map((o) => o.line),
    implied,
  };
}

/** A word the shell reads back as itself without quotes. */
const SHELL_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** The flags as shell words, quoted only where the shell needs it (`-pragma 'cats off'`), so that
 *  `tokenizeFlags(shellJoinFlags(argv))` is `argv`. */
export function shellJoinFlags(argv: readonly string[]): string {
  return argv.map((w) => (SHELL_BARE.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(' ');
}

/** One string per distinct profile: the slots by name, whatever order the build spelled them in, then
 *  the unclassified words in build order, since their order may matter to the compiler. */
export function profileKey(profile: CodegenProfile): string {
  const slots = Object.keys(profile.slots)
    .sort()
    .map((k) => `${k}=${profile.slots[k]}`);
  return [...slots, ...profile.unclassified].join(' ');
}

/** The argv without the words a later word overrode: what the compiler acts on, in build order. */
export function effectiveFlags(family: FlagFamily, argv: readonly string[]): string[] {
  const dropped = new Set(parseFlags(family, argv).overriddenAt);
  return argv.filter((_, i) => !dropped.has(i));
}

/** A build's flags in their normal form: every inert word and its argument removed, the rest verbatim
 *  and in build order. */
export function storedFlags(family: FlagFamily, argv: readonly string[]): string[] {
  const inert = new Set(parseFlags(family, argv).inertAt);
  return argv.filter((_, i) => !inert.has(i));
}

/** THE DIALECT a translation unit is compiled in — the benchmark row's `language`, the `-lang` word
 *  its target and every candidate compile state, and (on a C++ row) the linkage a candidate needs
 *  to export the mangled symbol its target is keyed by.
 *
 *  THE BUILD'S FLAGS ARE THE SIGNAL, never the file name: 62 of Animal Crossing's `.c` units are
 *  compiled `-lang=c++`. The option has two names and two spellings and one project uses two of
 *  them — Pikmin's 385 game units say `-lang=c++` and its 57 jaudio units say `-lang c++` — so the
 *  mwcc flag table owns the slot and the LAST occurrence wins, as it does on the command line.
 *
 *  Its whole vocabulary is `c | c++ | ec++` (mwcceppc -help). `ec++` is Embedded C++, which the
 *  help says only adds warnings, and the container agrees: a unit with a virtual function, a loop
 *  and an `extern "C"` entry point compiles to a BYTE-IDENTICAL object at `-lang=ec++` and
 *  `-lang=c++`. So it is a C++ row, and any other word is refused rather than read as C — a unit
 *  built by the C++ front end and compiled here by the C one would publish a number about a
 *  language it never read.
 *
 *  `unit` is the fallback and only that: where the flags name no dialect, the file's extension is
 *  what the front end itself would have used. Across the three GameCube projects the only units
 *  whose flags say nothing are six `.s` files no compile edge builds. Only mwcc has a dialect
 *  option, and only mwcc has a C++ front end, so every other family answers `c` unless its unit is
 *  named for C++ — which none is, and where one is, real.ts refuses the row by name. */
export function unitLanguage(unit: string, cflags: readonly string[]): 'c' | 'c++' {
  const stated = parseFlags('mwcc', cflags).slots.lang;
  if (stated === undefined) {
    return /\.(cc|cp|cpp|cxx)$/i.test(unit) ? 'c++' : 'c';
  }
  if (stated !== 'c' && stated !== 'c++' && stated !== 'ec++') {
    throw new Error(`${unit}: CodeWarrior dialect '${stated}' is not one of c, c++, ec++`);
  }
  return stated === 'c' ? 'c' : 'c++';
}

/** The optimisation level the compiler acts on (`-O2`, `-O4,p`), or null when the flags name none and
 *  the family has no measured default. */
export function optLevel(family: FlagFamily, argv: readonly string[]): string | null {
  return levelOf(parseFlags(family, argv));
}

/** A profile's optimisation level (`-O2`, `-O4,p`), or null when it has none. */
export function levelOf(profile: Pick<CodegenProfile, 'slots'>): string | null {
  const o = profile.slots.O;
  return o === undefined ? null : `-O${o}`;
}
