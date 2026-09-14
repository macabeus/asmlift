// asmlift — what every registered variation MEANS, for a reader: the webapp's Fan Explorer, the
// function detail's winning spelling, and anyone reading a candidate's name in a log.
//
// KEYED BY THE REGISTRY, NEVER A SECOND LIST OF NAMES. `VARIATION_DEFINITIONS` is typed by
// `VariationName`, which `variation-tokens.ts` derives from `VARIATION_TOKENS`, so a registry entry
// with no definition and a definition naming no registered variation are both type errors in this
// package. `packages/core/test/variation-definitions.test.ts` asserts the same at run time, and
// `apps/benchmark/test/variation-closure.test.ts` checks every name the committed artifact
// publishes against it.
//
// WHY CORE AND NOT `@asmlift/bench-schema`, where the feature vocabulary lives. A feature tag is a
// fact about a benchmark ROW, authored in the dataset and derived by `apps/benchmark`; a variation
// is a fact about core's ENUMERATION, minted in `rank.ts`, printed by the CLI and shown by the
// playground as much as by the benchmark pages. Its name set is already here, and the bench-schema
// package takes no dependencies.
//
// A READING OF THE CODE, NEVER A SOURCE FOR IT. Nothing here is consulted by enumeration. Each entry
// paraphrases the argument at its mint site in `rank.ts` / `rank-variations.ts` and at the pass
// `implementedIn` names; where they disagree, the code is right and this entry is the defect.
//
// Pure data: this module stays browser-safe. `offeredWhen` names admission tables by key; their rules
// are `variation-gates.ts`, which a reader of a title or a summary never loads.
import type { GateTableName } from './variation-gates';
import type { GatingBehavior, VariationKind, VariationName } from './variation-tokens';

export interface ReaderWord {
  word: string;
  meaning: string;
  /** the command that shows it, for a contributor; the table's cell is `meaning` then `command` */
  command?: string;
}

/** The words a reader of candidate enumeration needs, as `docs/vocabulary.md` defines them. The
 *  test holds that table to this one, text for text. */
export const READER_WORDS: readonly ReaderWord[] = [
  {
    word: 'candidate',
    meaning:
      'One complete C source asmlift emits for a function. Each is compiled and scored against the target object.',
  },
  {
    word: 'fan',
    meaning: 'Every candidate asmlift enumerated for one function, whether it built or not.',
    command: '`pnpm bench fan <row>` lists it.',
  },
  {
    word: 'winner',
    meaning: "The best-scoring candidate among those that may be published. Its source is the function's result.",
    command: '`pnpm bench fan <row> --show winner` prints it.',
  },
  {
    word: 'variation',
    meaning:
      'One way asmlift can write a function differently, e.g. `defsite`, `unmerge`, `raw-globals`. Signedness (`unsigned` / `signed`) is a variation too.',
  },
  { word: 'dropped', meaning: 'A candidate the scorer refused: its source did not build.' },
  {
    word: 'withheld',
    meaning: 'A candidate that compiled and scored, but was refused publication for want of a byte-exact proof.',
  },
];

export interface VariationKindDefinition {
  title: string;
  meaning: string;
  /** registered variations of this kind, as a candidate's name spells them */
  examples: readonly string[];
}

/** The five variation kinds, as `docs/vocabulary.md`'s kinds table defines them, in kind order. */
export const VARIATION_KIND_DEFINITIONS: { readonly [K in VariationKind]: VariationKindDefinition } = {
  signedness: {
    title: 'Signedness',
    meaning:
      "Whether the function's parameters are read as signed or unsigned. Every candidate carries one, as its first variation.",
    examples: ['unsigned', 'signed'],
  },
  lift: {
    title: 'Lift',
    meaning:
      'How the instructions are read before any C is built: which moves set up a call, how a chain of tests joins, whether paths share a return.',
    examples: ['setup-args', 'connective', 'shared-ret', 'shared-tail'],
  },
  structure: {
    title: 'Structure',
    meaning:
      'How the checked control flow becomes C: which way a test reads, where a loop starts, what reaches a merge (the point where two paths meet), where a value is kept, and how a read or a compare is spelled.',
    examples: ['flip-branch', 'defsite', 'loop-entry', 'reread-globals', 'uns-cmp'],
  },
  respell: {
    title: 'Respell',
    meaning:
      'A rewrite of the finished C that keeps what it does: where a value lives, whether an address is held in a pointer, how statements are ordered.',
    examples: ['unmerge', 'offmember', 'livebase', 'coalesce-v0-v1', 'volatile'],
  },
  'symbol-map': {
    title: 'Symbol map',
    meaning:
      "Globals are written as raw addresses instead of the names the project's symbol map gives them. Always the last variation.",
    examples: ['raw-globals'],
  },
};

/** A compiler an example is built with, as the benchmark's rows name it. */
export type ExampleCompiler = 'agbcc' | 'ido' | 'gcc' | 'mwcc';

/** Each example compiler as a reader knows it. */
export const EXAMPLE_COMPILER_NAMES: { readonly [C in ExampleCompiler]: string } = {
  agbcc: 'agbcc',
  ido: 'IDO 7.1',
  gcc: 'KMC gcc',
  mwcc: 'CodeWarrior (mwcc)',
};

/** Where a spelling sits in its example's translation unit. No C token is spelled `@`. */
export const EXAMPLE_HOLE = '@';

/** The function every example's translation unit defines, and the one its two objects are compared on. */
export const EXAMPLE_FUNCTION = 'example';

/** A minimal pair the matching suite compiles (`packages/cli/test/matching/variation-examples.test.ts`):
 *  `unit` with `before` in its hole and with `after` in it must be two different objects under
 *  `compiler`. The drawer shows the two fragments; the unit is what makes them C. */
export interface VariationExample {
  /** the spelling without the variation */
  before: string;
  /** the spelling with it */
  after: string;
  compiler: ExampleCompiler;
  /** a complete translation unit defining `EXAMPLE_FUNCTION`, holding `EXAMPLE_HOLE` exactly once */
  unit: string;
  note?: string;
}

/** An export of a core source file, relative to the repository root: where a decision is made. */
export interface CodePointer {
  symbol: string;
  file: string;
}

/** Each compiler behavior a registered variation's target gate names, as a reader reads it after
 *  "a target whose compiler". The gate itself is the registry entry's `target`. */
export const TARGET_BEHAVIOR_READINGS: { readonly [B in GatingBehavior]: string } = {
  foldsConstAddrOffset: 'folds a constant address offset into the literal it loads',
  arrayShapeFromStride: "loads a declared array's base before it scales the index",
  nearBaseSpan: 'declares how far one base local may reach a neighbouring address',
  foldsPointerAdvance: 'folds a stepped pointer back into an offset load',
};

/** When enumeration offers a variation. Wherever it changes nothing, the candidate it would add
 *  repeats a source an earlier candidate has, and is not enumerated.
 *
 *  - `'always'`: on every function.
 *  - `judges` and `gates`: for each thing `judges` names, a noun phrase, that no rule of `gates`
 *    refuses. The rules are read from the tables themselves.
 *  - `when` and `decidedBy`: where no table decides, one sentence and the export that does. `gates`
 *    names a table that export applies to part of the decision.
 *
 *  A variation offered only on some compilers says so in its registry entry's `target`. */
export type OfferedWhen =
  | 'always'
  | { judges: string; gates: readonly GateTableName[] }
  | { when: string; decidedBy: CodePointer; gates?: readonly GateTableName[] };

export interface VariationDefinition {
  /** a short heading: the catalogue row, the drawer title */
  title: string;
  /** one line: the catalogue subtitle and a chip's tooltip */
  summary: string;
  /** what the variation changes in the emitted C, and why the assembly leaves that open */
  detail: string;
  /** the compiler behavior that makes the two spellings different objects, where one is known */
  compilerBehavior?: string;
  offeredWhen: OfferedWhen;
  /** what the trailing `-…` names. Present exactly when the registry entry takes a subject. */
  subject?: { meaning: string; examples: readonly string[] };
  /** a minimal pair: the spelling without the variation, then with it */
  example: VariationExample;
  /** the file holding the rewrite, relative to the repository root */
  implementedIn: string;
  seeAlso?: readonly VariationName[];
}

/** The callees the examples call. Unprototyped, so each takes whatever its call passes. */
const CALLS =
  'void A(); void B(); void C(); void D(); void X(); void Y(); void P(); void Q(); s32 f(); s32 g(); s32 h(); void use();\n';

const RANK = 'packages/core/src/rank.ts';
const RANK_VARIATIONS = 'packages/core/src/rank-variations.ts';
const SYMBOLS = 'packages/core/src/symbols.ts';
const STRUCTURE = 'packages/core/src/structure/structure.ts';
const ANALYSIS = 'packages/core/src/structure/analysis.ts';
const BASECSE = 'packages/core/src/l3/basecse.ts';
const l3 = (file: string): string => `packages/core/src/l3/${file}.ts`;

/** A losing candidate is the control its winner was scored against: every entry below describes an
 *  alternative that rides BESIDE the spelling without it, never one that replaces it. */
export const VARIATION_DEFINITIONS: { readonly [N in VariationName]: VariationDefinition } = {
  // ── signedness ──────────────────────────────────────────────────────────────────────────────
  unsigned: {
    title: 'Unsigned parameters',
    summary: 'the scalar entry parameters are declared unsigned',
    detail:
      'A register holds bits, not a signedness, so the declaration of a parameter is not in the assembly. ' +
      'Every scalar entry parameter whose type is still unknown or a 32-bit int is pinned `u32` before type ' +
      'recovery. A recovered pointer or aggregate parameter is never pinned, and neither is one narrowed by ' +
      'its own extension, which already states its signedness. On a function with nothing to pin every ' +
      'candidate still carries `unsigned`, and it changed nothing.',
    compilerBehavior:
      'Signedness picks the instruction: an arithmetic or a logical right shift, a signed or an unsigned ' +
      'branch after a compare, a sign or a zero extension of a narrower value.',
    offeredWhen: 'always',
    example: {
      compiler: 'agbcc',
      unit: '@ { return a0 >> a1; }',
      before: 's32 example(s32 a0, s32 a1)',
      after: 's32 example(u32 a0, u32 a1)',
    },
    implementedIn: RANK,
    seeAlso: ['signed', 'uns-cmp'],
  },
  signed: {
    title: 'Signed parameters',
    summary: 'the scalar entry parameters are declared signed',
    detail:
      'The other signedness: every pinnable scalar entry parameter is declared `s32` before type recovery. ' +
      'Every candidate carries exactly one of `unsigned` and `signed`, so the two counts of one fan add up ' +
      'to its size.',
    compilerBehavior: 'The same as `unsigned`: shifts, compare branches and extensions follow the declaration.',
    offeredWhen: {
      when: 'Some scalar entry parameter is left for the pin to declare.',
      decidedBy: { symbol: 'NO_PIN_KINDS', file: RANK_VARIATIONS },
    },
    example: {
      compiler: 'agbcc',
      unit: '@ { return a0 >> a1; }',
      before: 's32 example(u32 a0, u32 a1)',
      after: 's32 example(s32 a0, s32 a1)',
    },
    implementedIn: RANK,
    seeAlso: ['unsigned'],
  },

  // ── lift ────────────────────────────────────────────────────────────────────────────────────
  'setup-args': {
    title: 'Only the arguments the call set up',
    summary: 'a call with a guessed arity passes only what its own block wrote',
    detail:
      'With no declared prototype, the arity of a call is guessed from the argument registers, and by ' +
      'default a register whose value merely survives from an earlier block still counts as an argument. ' +
      'This lift cuts each guessed call to the arguments the calling block itself set up. Dropping an ' +
      'argument changes what every later stage sees, which is why it is a lift and not a rewrite of the ' +
      'finished tree.',
    compilerBehavior:
      'agbcc leaves a value already in `r0` where it is and branches to the call, so `if (x) f(x);` and ' +
      '`if (x) f();` usually compile alike. Under an equality guard the compiler proves the argument ' +
      'constant and has to load it, and a missing load rules the wider reading out.',
    offeredWhen: {
      when: 'A call whose arity was guessed passes a register its own block did not set.',
      decidedBy: { symbol: 'hasSetupArgsNarrowing', file: 'packages/core/src/frontend/ssa.ts' },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 a0) { @ }',
      before: 'if (a0 == 5) f(a0);',
      after: 'if (a0 == 5) f();',
    },
    implementedIn: 'packages/core/src/frontend/ssa.ts',
  },
  connective: {
    title: 'Comparison chain as `||`',
    summary: 'a chain of constant tests on one value is spelled with `||` instead of as a switch',
    detail:
      'A chain of `x == K` tests on one value can be recovered as a `switch` or folded into a short-circuit ' +
      'condition, and one reading of the assembly cannot do both: a folded `||` is no longer the comparison a switch is ' +
      'recovered from. This lift lets the short-circuit fold take the chain. It also reaches functions whose ' +
      'switch recovery declined entirely and came out as nested `if` statements.',
    compilerBehavior:
      'With one group of cases and a `default:` the two spellings are one object on agbcc. With a second ' +
      'group they differ: the switch builds a balanced dispatch where the chain tests one value after another.',
    offeredWhen: {
      when: 'The short-circuit fold refused a chain only because it reads as a comparison tree.',
      decidedBy: { symbol: 'runPreRecovery', file: 'packages/core/src/raise/pre-recovery.ts' },
      gates: ['ARM_REREAD_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 x) { @ }',
      before: 'switch (x) { case 0: case 2: A(); break; case 5: B(); break; }',
      after: 'if (x == 0 || x == 2) { A(); } else if (x == 5) { B(); }',
    },
    implementedIn: 'packages/core/src/raise/shortcircuit.ts',
    seeAlso: ['site-sense'],
  },
  'shared-ret': {
    title: 'Shared code after an early return',
    summary: 'code both arms of an `if` reach before returning is written once, after the `if`',
    detail:
      'An `if` whose arms never meet again before the function returns has no follow, so by default a ' +
      'region both arms reach is written in each of them. This structures the same raised function again ' +
      "with that shared region as the `if`'s follow: it is written once after the `if`, and every other " +
      'path leaves through an early `return`.',
    offeredWhen: {
      when: 'Some `if` has arms that reach a common `return` block and no common block before it.',
      decidedBy: { symbol: 'hasDivergentSharedRet', file: STRUCTURE },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 c, s32 x) { @ }',
      before: 'if (c) { A(); B(); } else { if (x) { C(); return; } B(); }',
      after: 'if (c) { A(); } else { if (x) { C(); return; } } B();',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['shared-tail'],
  },
  'shared-tail': {
    title: 'Store tail copied back',
    summary: 'a store the compiler merged into one tail is copied back into each path, then shared',
    detail:
      "agbcc's global common-subexpression pass can move a trailing store into every predecessor of a join, " +
      'and the paths then jump into one `store; return` tail. This lift copies that tail back into each ' +
      'path that branches to it, and then structures with the shared follow `shared-ret` uses, so the ' +
      'store the source wrote once is written after the `if` and the others before an early `return`. It is ' +
      'enumerated apart from `shared-ret` because the sink can delete the shared `return` that variation needs.',
    compilerBehavior:
      'Two sources that lift to the same code (one with the store written once, one with it in each arm) ' +
      'compile to different register assignments, so only the differ can tell which one it was.',
    offeredWhen: {
      when: 'The sink changed the function and some `if` of the result still shares a `return`.',
      decidedBy: { symbol: 'sinkStoreTails', file: 'packages/core/src/raise/tailsink.ts' },
    },
    example: {
      compiler: 'agbcc',
      unit:
        CALLS +
        'void fnA(void); void fnB(void); struct Q { void (*cur)(void); }; extern struct Q gQ; void example(s32 c, s32 x) { void (*v)(void); @ }',
      before: 'if (c) { A(); v = fnB; } else if (x) { v = fnA; } else { v = fnB; } gQ.cur = v;',
      after: 'if (c) { A(); } else if (x) { gQ.cur = fnA; return; } gQ.cur = fnB;',
      note: 'the shape of `synthetic:gcsetail`',
    },
    implementedIn: 'packages/core/src/raise/tailsink.ts',
    seeAlso: ['shared-ret'],
  },

  // ── structure ───────────────────────────────────────────────────────────────────────────────
  'flip-branch': {
    title: 'Flipped branch sense',
    summary: 'an `if` whose arms never rejoin is spelled with the opposite condition',
    detail:
      'An `if` can be written `if (c) A else B` or `if (!c) B else A`, and the assembly does not say which ' +
      'one the source used. By default a divergent `if` (one whose arms do not meet again) follows the ' +
      'layout: the arm the branch falls into is `then`. This spells every divergent `if` of the function the ' +
      "other way. The name is relative to the target's default sense.",
    compilerBehavior:
      'A compiler that keeps source order lays the `then` arm out first, so the two spellings are two ' +
      'layouts and two objects.',
    offeredWhen: 'always',
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 c) { @ }',
      before: 'if (c) { A(); return; } B();',
      after: 'if (!c) { B(); return; } A();',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['flip-join', 'site-sense', 'sense'],
  },
  defsite: {
    title: 'Constant written where defined',
    summary: "a merge's constant is written where the assembly loaded it, not on the path into the merge",
    detail:
      'When one path into a merge carries a constant, the structurer normally writes it on that edge, as an ' +
      '`else` arm. The assembly shows where the constant was loaded, and this writes it there instead: ' +
      'above the `if`, with the other path overwriting it. Where the source wrote it is still open, so both ' +
      'placements are enumerated, crossed with branch sense, because emptying an arm changes which sense ' +
      'matches.',
    offeredWhen: 'always',
    example: {
      compiler: 'agbcc',
      unit: CALLS + 's32 example(s32 c) { s32 v; @ return v; }',
      before: 'if (c) { v = f(); } else { v = 0; }',
      after: 'v = 0; if (c) { v = f(); }',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['loop-entry', 'fresh-merge'],
  },
  'loop-entry': {
    title: "Loop's entry constant above its guard",
    summary: "a loop's starting constant is written above the guard, not on the edge into the loop",
    detail:
      "The same placement question as `defsite`, asked of a loop header's entry constant. It is a second " +
      'decision rather than a wider `defsite`: a function holding both kinds of constant has three ' +
      'spellings, and one switch for both would make the middle one unreachable. The two are enumerated as ' +
      'a chain (neither, `defsite`, then `defsite/loop-entry`), so this never appears without `defsite`.',
    offeredWhen: 'always',
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 n) { s32 i = 0; s32 s; @ use(s); }',
      before: 'if (0 < n) { s = 0; do { s += i; i++; } while (i < n); }',
      after: 's = 0; if (0 < n) { do { s += i; i++; } while (i < n); }',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['defsite', 'initfirst'],
  },
  'flip-join': {
    title: 'Flipped sense of a rejoining `if`',
    summary: 'a two-armed `if` whose arms rejoin is spelled with the opposite condition',
    detail:
      'The sibling of `flip-branch` for an `if` whose arms meet again. Its default reads the same layout ' +
      'evidence, and three things invert it, each per `if` where this variation is per function: a ' +
      "short-circuit fold choosing the orientation, a branch relayed past Thumb's branch range, and a " +
      "loop's zero-trip guard, an `if` no source wrote. The name is relative to the target's default sense.",
    compilerBehavior: 'agbcc emits different bytes for the arms-swapped spelling wherever such an `if` exists.',
    offeredWhen: 'always',
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 c) { @ }',
      before: 'if (c) { A(); } else { B(); } D();',
      after: 'if (!c) { B(); } else { A(); } D();',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['flip-branch', 'site-sense', 'sense'],
  },
  sense: {
    title: 'Per-site branch sense (measurement)',
    summary: 'chosen branch-sense sites are spelled the other way, one bit per site',
    detail:
      '`flip-branch` and `flip-join` flip every `if` of a function at once, which cannot spell a function ' +
      'whose `if` statements were written in opposite senses. This measurement crosses the whole fan with every mask ' +
      'over the first sites, which costs a factor of two per site, to price that gap and to learn whether ' +
      "a target's mix is reachable at all. The CLI asks for it through `ASMLIFT_PERSITE_SENSE`.",
    offeredWhen: {
      when: 'Only when the caller asks for per-site sense bits; no default fan carries it.',
      decidedBy: { symbol: 'enumerateCandidates', file: RANK },
    },
    subject: {
      meaning:
        'A decimal bitmask over the branch-sense sites in the order structuring first visits them: bit i set ' +
        'spells site i the other way. `sense-5` flips sites 0 and 2.',
      examples: ['sense-1', 'sense-5'],
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 a, s32 b) { @ }',
      before: 'if (a) { X(); } else { Y(); } if (b) { P(); } else { Q(); }',
      after: 'if (!a) { Y(); } else { X(); } if (b) { P(); } else { Q(); }',
      note: 'as the variation `sense-1` spells it',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['flip-branch', 'flip-join', 'site-sense'],
  },
  'no-bitfield': {
    title: 'Shifts instead of a bitfield member',
    summary: 'a bitfield read keeps its shift arithmetic instead of the name the symbol map gives it',
    detail:
      'With a symbol map that declares bitfield members, a `(x << a) >> b` extract of a struct global is ' +
      'spelled as the named member. This keeps the shifts over the loaded word.',
    compilerBehavior:
      "A named bitfield read compiles at the declaration's access width. Where that differs from the width " +
      'the assembly loaded, only the shift spelling reproduces the load.',
    offeredWhen: {
      when: 'The symbol map declares a bitfield member, and only on the candidates that use the map.',
      decidedBy: { symbol: 'declaresBitfields', file: SYMBOLS },
    },
    example: {
      compiler: 'agbcc',
      unit: 'struct Packed { u8 hearts : 2; u8 stars : 3; u16 dreamStones : 7; u32 unk4; }; extern struct Packed gPacked; u32 example(void) { @ }',
      before: 'return gPacked.dreamStones;',
      after: 'return (*(u32 *)&gPacked << 20) >> 25;',
      note: '`synthetic:bfwordread`',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['no-ptr-elem', 'raw-globals'],
  },
  'no-ptr-elem': {
    title: 'Byte arithmetic through a pointer member',
    summary: 'an element read through a pointer member keeps its byte arithmetic',
    detail:
      'With a symbol map that declares a sized pointer member, an element-scaled offset through it is ' +
      'spelled as a whole-element subscript. This keeps the byte arithmetic it replaces. The two are the ' +
      'same address.',
    compilerBehavior:
      'Compiled on agbcc the two are the same instruction count and different objects: they differ in ' +
      'which register the `add` targets.',
    offeredWhen: {
      when: 'The map declares a pointer member with a 1, 2 or 4-byte pointee on a global the function names.',
      decidedBy: { symbol: 'isPtrField', file: SYMBOLS },
    },
    example: {
      compiler: 'agbcc',
      unit: 'struct BgPtrs { u16 *pMap; }; extern struct BgPtrs gBgPtrs; u16 example(s32 i) { @ }',
      before: 'return gBgPtrs.pMap[i + 157];',
      after: 'return *(u16 *)((i << 1) + (u8 *)gBgPtrs.pMap + 314);',
      note: '`synthetic:ptrelem`',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['no-bitfield', 'flat-rank'],
  },
  'flat-rank': {
    title: 'Flat arithmetic instead of subscripts',
    summary: 'a multidimensional array access is spelled as flat arithmetic, not the declared subscripts',
    detail:
      'By default an access to a multidimensional array global recovers the declared subscripts from a ' +
      'term at the row stride. That term is evidence the access crosses rows, not evidence about which of ' +
      'the two spellings produced it.',
    compilerBehavior:
      'Under agbcc, KMC gcc and mwcc the two differ only in where the pool load sits; under IDO they are ' +
      'byte-identical.',
    offeredWhen: {
      when: 'The function names a global that the symbol map, or its own index strides, declare a multidimensional array.',
      decidedBy: { symbol: 'arrayInnerExtents', file: SYMBOLS },
    },
    example: {
      compiler: 'agbcc',
      unit: 'extern u16 gTbl[4][0x400]; s32 example(s32 r, s32 i) { s32 x; @ return x; }',
      before: 'x = gTbl[r][i];',
      after: 'x = *(u16 *)((r << 11) + (i << 1) + (u32)&gTbl);',
      note: 'for `u16 gTbl[4][0x400]`',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['no-ptr-elem'],
  },
  'reread-globals': {
    title: 'Global read again at each use',
    summary: 'a global is read at each use instead of once into a variable',
    detail:
      'By default a read of a named global is cached in a local before a later store. This lets the read ' +
      'render at its use across stores that provably cannot reach it, such as a store to a different ' +
      'named global. Whether the source read it once or at each use is not in the assembly.',
    compilerBehavior:
      'The compiler folds the repeated reads back into one load, and agbcc has been measured landing on ' +
      'both sides inside a single function.',
    offeredWhen: {
      when: 'Some load resolves to a named global.',
      decidedBy: { symbol: 'globalCellOf', file: 'packages/core/src/ir/alias.ts' },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'extern s32 gCount; extern s32 gFlag; void example(void) { @ }',
      before: 's32 v = gCount; gFlag = 0; f(v);',
      after: 'gFlag = 0; f(gCount);',
    },
    implementedIn: ANALYSIS,
    seeAlso: ['raw-globals', 'derived-home'],
  },
  inplace: {
    title: 'Overwrite in place',
    summary: 'a loaded value feeding a merge is named, so one arm becomes an in-place overwrite',
    detail:
      'A load that feeds a conditional merge is given its own variable, the merge takes that name, and the ' +
      'arm that only passes the value through disappears.',
    compilerBehavior:
      'The two-sided form needs a second register, at the margin a callee-saved push, and the emptied arm ' +
      'flips the branch sense.',
    offeredWhen: {
      when: "A load feeds an argument of a conditional branch's merge.",
      decidedBy: { symbol: 'STRUCTURE_VARIATIONS', file: RANK_VARIATIONS },
    },
    example: {
      compiler: 'mwcc',
      unit: 's32 example(u8 *p) { s32 t; s32 v; @ return v; }',
      before: 't = *p; if (t > 31) { v = 32; } else { v = t; }',
      after: 'v = *p; if (v > 31) v = 32;',
    },
    implementedIn: ANALYSIS,
    seeAlso: ['merge-names', 'fresh-merge'],
  },
  'merge-names': {
    title: 'One name across a copy',
    summary: 'the two sides of a merge copy share one variable when their values never overlap',
    detail:
      'Two variables a merge copy would join become one where the values under them never interfere. ' +
      'Whether the source had one variable there is not in the naming, and removing a copy is worth less ' +
      'than it looks, because the compiler coalesces most copies itself. What moves the score is which ' +
      'values share a register.',
    offeredWhen: {
      when: 'Some merge is fed by two or more edges.',
      decidedBy: { symbol: 'STRUCTURE_VARIATIONS', file: RANK_VARIATIONS },
      gates: ['NAME_COALESCE_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 's32 example(s32 n) { s32 v1; s32 v2; s32 i; @ }',
      before: 'v1 = f(); for (i = 0; i < n; i++) { v2 = v1; if (g(i)) v2 = 0; v1 = v2 + i; } return v1;',
      after: 'v1 = f(); for (i = 0; i < n; i++) { if (g(i)) v1 = 0; v1 = v1 + i; } return v1;',
    },
    implementedIn: 'packages/core/src/structure/namecoalesce.ts',
    seeAlso: ['coalesce', 'inplace'],
  },
  'addr-home': {
    title: 'Pointer local for a computed address',
    summary: 'a computed address used at two or more sites is held in a pointer local',
    detail:
      'A pure computed address dereferenced at two or more sites, and the loads through it, get locals: ' +
      "the source's pointer local and scalar temporary. By default the address is derived again at each use.",
    offeredWhen: {
      when: "A symbol-map setting's own lift dereferences one computed address at two or more sites.",
      decidedBy: { symbol: 'hasHomeableSharedAddress', file: ANALYSIS },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 's32 example(u32 a0, u32 a1) { @ }',
      before:
        'if (((u8 *)((a0 << 2) + a1 + 0x8057acc))[1] == 2) return g(((u8 *)((a0 << 2) + a1 + 0x8057acc))[0]); return 0;',
      after: 'u8 *p = (u8 *)((a0 << 2) + a1 + 0x8057acc); if (p[1] == 2) return g(p[0]); return 0;',
    },
    implementedIn: ANALYSIS,
    seeAlso: ['expr-home', 'derived-home', 'livebase'],
  },
  'expr-home': {
    title: 'Named value used inside a loop',
    summary: 'a value computed before a loop and used inside it is held in a local',
    detail:
      'A pure value defined outside a loop, with two or more consumers of which at least one is inside it, ' +
      'gets a local of its recovered type: the register the compiler holds across the iterations. By ' +
      'default it is derived again at each use.',
    offeredWhen: {
      when: "A symbol-map setting's own lift uses a value from before a loop two or more times, once inside it.",
      decidedBy: { symbol: 'hasLoopSharedPureValue', file: ANALYSIS },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 t) { s32 i; @ }',
      before: 'for (i = 0; i < (16 << t); i++) g(i * (16 << t));',
      after: 's32 size = 16 << t; for (i = 0; i < size; i++) g(i * size);',
    },
    implementedIn: ANALYSIS,
    seeAlso: ['addr-home', 'derived-home'],
  },
  'derived-home': {
    title: 'Named value derived from a read',
    summary: 'a value computed from a memory read is held in a local, instead of the read',
    detail:
      'A pure value with two or more consumers, standing on a memory read, gets a local, and the read then ' +
      'renders once inside it. By default the read gets the local and the computation is repeated at each ' +
      'use.',
    compilerBehavior: 'Both compile, and agbcc folds the repeated computation back, so only the score separates them.',
    offeredWhen: {
      when: "A symbol-map setting's own lift has a value computed from a memory read with two or more consumers.",
      decidedBy: { symbol: 'hasDerivedReadHome', file: ANALYSIS },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + '#define REG_KEYINPUT (*(u16 *)0x4000130)\nvoid example(void) { @ }',
      before: 'u16 k = REG_KEYINPUT; f(0x3FF ^ k); g(0x3FF ^ k);',
      after: 'u16 k = 0x3FF ^ REG_KEYINPUT; f(k); g(k);',
    },
    implementedIn: ANALYSIS,
    seeAlso: ['expr-home', 'reread-globals'],
  },
  'merge-home': {
    title: 'Value computed once above a branch',
    summary: 'a value several paths hand to one merge is computed once, above the branch',
    detail:
      'A pure value that the paths into one merge hand to the same variable from two or more places gets a ' +
      'local in the block above them, the value the source computed once before branching. By default ' +
      'there is no name to refer to on a path, and each arm computes it again.',
    offeredWhen: {
      when: "A symbol-map setting's own lift hands one merge the same value from two or more places.",
      decidedBy: { symbol: 'hasMergeFeedHome', file: ANALYSIS },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 's32 example(s32 c, s32 a0) { s32 v; @ return v; }',
      before: 'if (c) { v = a0 << 2; A(); } else { v = a0 << 2; B(); }',
      after: 's32 m = a0 << 2; if (c) { v = m; A(); } else { v = m; B(); }',
    },
    implementedIn: ANALYSIS,
    seeAlso: ['expr-home', 'fresh-merge'],
  },
  'uns-cmp': {
    title: 'Unsigned compare spelled unsigned',
    summary: 'an unsigned compare carries a `(u32)` cast where its operands do not already say so',
    detail:
      'An unsigned comparison takes a `(u32)` cast on an operand the rendering does not already make ' +
      'unsigned, and a declaration claimed by both kinds of use becomes `u32` when nothing under it needs ' +
      'signed. Which the source wrote is open in one direction: a signed spelling that matched was proved ' +
      'non-negative by the compiler, and asmlift can prove less than the compiler can.',
    compilerBehavior:
      'A compiler emits an unsigned branch from a signed compare only where it proved both sides non-negative.',
    offeredWhen: {
      when: 'The function has an unsigned comparison.',
      decidedBy: { symbol: 'STRUCTURE_VARIATIONS', file: RANK_VARIATIONS },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 a, s32 b) { @ A(); }',
      before: 'if (a < b)',
      after: 'if ((u32)a < b)',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['unsigned', 'signed'],
  },
  'fresh-merge': {
    title: 'Own local for a merge into a parameter',
    summary: 'a merge that would assign back into a parameter gets its own local',
    detail:
      'A merge whose value lives in a parameter takes its own local where the default assigns back into the ' +
      'parameter. Both are ordinary C over the same values. A merge with its own local also lets `defsite` ' +
      "write a constant above the branch, which a merge that adopted the parameter's name refuses.",
    compilerBehavior:
      'On mwcc a clamp written into the parameter and the same clamp through its own local are different ' +
      'objects. agbcc compiles that pair alike, and a two-argument max compiles alike on both.',
    offeredWhen: {
      when: 'Some merge is fed a parameter on one edge and a different value on another.',
      decidedBy: { symbol: 'hasParamRootedMerge', file: STRUCTURE },
      gates: ['FRESH_MERGE_GATES'],
    },
    example: {
      compiler: 'mwcc',
      unit: 'u8 example(s32 a0) { s32 v0; @ }',
      before: 'if (a0 > 255) a0 = 255; return a0;',
      after: 'if (a0 > 255) { v0 = 255; } else { v0 = a0; } return v0;',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['defsite', 'merge-home'],
  },
  'copy-defpos': {
    title: 'Copies in the order values were defined',
    summary: "a path's copies into a merge are ordered by where each value was defined",
    detail:
      'On a path into a merge, the copies are laid out by default in the order the assembly wrote their ' +
      'destinations. That order is only forced for a cyclic set of copies (a swap), where the spill has to ' +
      'be the register overwritten first. For an acyclic set this orders the copies by where each value was ' +
      'defined instead; a cyclic set keeps the recorded order either way.',
    compilerBehavior:
      'The benchmark answers it both ways inside one compiler: some mwcc rows match only with the record, others score better without it.',
    offeredWhen: {
      when: "The two orders differ somewhere in a symbol-map setting's own lift.",
      decidedBy: { symbol: 'edgeCopyOrdersDiffer', file: STRUCTURE },
    },
    example: {
      compiler: 'agbcc',
      unit:
        CALLS +
        's32 example(s32 a0, s32 a1, s32 c) { s32 v1; s32 v2; if (c) { v1 = f(); v2 = g(); } else { @ } return h(v1, v2); }',
      before: 'v2 = a1; v1 = a0;',
      after: 'v1 = a0; v2 = a1;',
      note: 'the copies at the end of one path into a merge',
    },
    implementedIn: STRUCTURE,
  },
  'site-sense': {
    title: 'Branch sense read per condition',
    summary: "each folded `&&`/`||` condition takes its sense from the fold's own evidence",
    detail:
      'A short-circuit fold records, for each condition it built, whether the arm both tests reach was ' +
      'fallen into, which successor it landed in, and whether a long-branch relay sat on an edge. This ' +
      'spells each such `if` from that record instead of from the per-function sense, so one function can ' +
      'mix senses.',
    compilerBehavior:
      "The reading rests on gcc laying a condition's arms out in source order. A long branch breaks it " +
      '(gcc inverts the last test and lays the `else` arm first), which is why a relayed edge is never read.',
    offeredWhen: {
      when: "This lift's raised function carries a short-circuit fold's orientation record.",
      decidedBy: { symbol: 'STRUCTURE_VARIATIONS', file: RANK_VARIATIONS },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 a, s32 b) { @ }',
      before: 'if (a != 0 && b != 0) { X(); } else { Y(); }',
      after: 'if (a == 0 || b == 0) { Y(); } else { X(); }',
      note: 'at a site whose record puts the shared arm in the taken slot',
    },
    implementedIn: STRUCTURE,
    seeAlso: ['flip-join', 'flip-branch', 'sense', 'connective'],
  },

  // ── respell ─────────────────────────────────────────────────────────────────────────────────
  unmerge: {
    title: 'Merged statement copied back into its arms',
    summary: 'a statement the compiler merged after an `if` is written back inside each arm',
    detail:
      'agbcc merges a store the source wrote in both arms into one copy at the join (cross-jumping), so the lifted tree carries its ' +
      "address and value on temporaries. This substitutes each arm's own definitions and writes the whole " +
      'statement back into each arm. Unlike the other respell variations it is applied before the rest: ' +
      "the whole respell set then runs again on its output, which is how an arm's own base pointer can " +
      'hold the copied store. It rewrites every eligible `if` at once.',
    compilerBehavior:
      'Sometimes the merged and the per-arm spellings are one object; where only the value merges, the ' +
      'per-arm spelling keeps two literal pools and a branch to the join.',
    offeredWhen: {
      judges: 'each `if` followed by a statement that reads what its arms define',
      gates: [
        'UNMERGE_SITE_GATES',
        'UNMERGE_ARM_GATES',
        'UNMERGE_VALUE_GATES',
        'UNMERGE_RUNG_GATES',
        'UNMERGE_TOTALITY_GATES',
      ],
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(s32 c, u16 a, u16 b) { u16 *v16; u16 v17; @ }',
      before: 'if (c) { v16 = (u16 *)0x3001000; v17 = a; } else { v16 = (u16 *)0x3001008; v17 = b; } *v16 = v17;',
      after: 'if (c) { *(u16 *)0x3001000 = a; } else { *(u16 *)0x3001008 = b; }',
    },
    implementedIn: l3('unmerge'),
    seeAlso: ['initfirst', 'regionbase'],
  },
  argbase: {
    title: 'Argument bases named before the call',
    summary: "the fixed addresses a call's arguments read are loaded into pointer locals first",
    detail:
      "When two or more of a call's arguments each read through a different fixed address, this names " +
      "those addresses in locals before the call. Only a pure base (a global's address, a numeric address " +
      'or a declared global) moves, so loading it earlier cannot be observed.',
    compilerBehavior:
      'Inline, agbcc finishes one argument before starting the next (`ldr; ldrb; ldr; ldrb`); with named ' +
      'bases it loads both addresses first (`ldr; ldr; ldrb; ldrb`).',
    offeredWhen: {
      when: 'Two or more arguments of one call read through distinct pure bases.',
      decidedBy: { symbol: 'materializeArgBases', file: l3('argbase') },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'extern u8 gEntityArray[]; void example(void) { @ }',
      before: 'f(*(u8 *)0x4000006, gEntityArray[8]);',
      after: 'u8 *p = (u8 *)0x4000006; u8 *e = gEntityArray; f(*p, e[8]);',
    },
    implementedIn: l3('argbase'),
    seeAlso: ['scopebase', 'livebase'],
  },
  zerosub: {
    title: 'Negation as `0 - x`',
    summary: 'a negated subtraction that is also used elsewhere is written `0 - (a - b)`',
    detail:
      '`-x` and `0 - x` are the same C expression, but not to the folder: `-(a - b)` is rewritten into ' +
      '`(b - a)` before common subexpressions are found, while `0 - (a - b)` keeps the subtraction itself. ' +
      'Over a subtraction the function also uses elsewhere, that is one computation and one register ' +
      'apart.',
    compilerBehavior:
      "gcc 2.9's fold turns `-(a - b)` into `b - a`. On the shared shape agbcc, IDO, KMC gcc and gcc 2.7.2 " +
      'each emit two different functions for the two spellings; mwcc emits one.',
    offeredWhen: {
      when: 'A negated subtraction whose subtraction also appears elsewhere, with no effect inside it.',
      decidedBy: { symbol: 'zeroSubNegates', file: l3('zerosub') },
    },
    example: {
      compiler: 'agbcc',
      unit: 's32 example(s32 a, s32 b) { @ return 0; }',
      before: 'if (a - b < 0) return -(a - b);',
      after: 'if (a - b < 0) return 0 - (a - b);',
    },
    implementedIn: l3('zerosub'),
  },
  volatile: {
    title: 'Volatile pointer local',
    summary: 'a pointer local holding a numeric address points at volatile data',
    detail:
      'A numeric address has no declaration anywhere, so whether the source read it through a `volatile` ' +
      'pointer is not in the assembly. The qualifier only restricts what the compiler may do, so every ' +
      'execution of the qualified spelling is one of the plain one. Which pointers the source qualified is ' +
      'per pointer, so each subset is its own candidate. It also rides on the locals other respell ' +
      'variations create (`livebase/volatile`, `indexed/volatile`, `inlinebase/volatile`).',
    compilerBehavior:
      'A volatile memory reference may not be moved or combined, which reorders the loop optimizer and lands ' +
      'the register allocator on different homes.',
    offeredWhen: {
      when: "A pointer local is assigned a numeric address and never a value containing a global's address.",
      decidedBy: { symbol: 'volatilePtrLocals', file: l3('volatileptr') },
    },
    subject: {
      meaning:
        'The locals qualified, joined by hyphens: `volatile-p1` qualifies only `p1`. With no subject every eligible ' +
        'local is qualified. Subsets are enumerated up to three eligible locals.',
      examples: ['volatile-p1', 'volatile-p0-p1'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(void) { @ while (*p == 0) { } *p = 1; }',
      before: 'u16 *p = (u16 *)0x3000010;',
      after: 'volatile u16 *p = (u16 *)0x3000010;',
    },
    implementedIn: l3('volatileptr'),
    seeAlso: ['vol-store', 'vol-slot', 'livebase'],
  },
  'vol-slot': {
    title: 'Volatile stack local',
    summary: 'a scalar local kept in a stack slot is declared volatile',
    detail:
      '`volatile` on a scalar local forces its value into memory: without it the allocator may keep the ' +
      'value in a callee-saved register across a call. A value kept in a stack slot can also come from an ' +
      'address-taken local or from register pressure, so the assembly does not say which the source used.',
    offeredWhen: { judges: 'each local the lift recovered as a stack slot', gates: ['VOL_SLOT_GATES'] },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(void) { @ sp0 = f(); g(); h(sp0); }',
      before: 'u16 sp0;',
      after: 'volatile u16 sp0;',
    },
    implementedIn: l3('volatileval'),
    seeAlso: ['volatile', 'inlinebase'],
  },
  'vol-store': {
    title: 'Volatile store to a device register',
    summary: 'a store to a fixed device-register address is written through a volatile cast',
    detail:
      'The spelling a `REG_*` macro produces: the store itself is qualified, where `volatile` qualifies a ' +
      'pointer local holding the address. Only a store whose whole address is a constant inside the ' +
      "target's device-register window is qualified.",
    compilerBehavior:
      "agbcc's loop optimizer promotes an unqualified store to a fixed address into a register and writes " +
      'it once after the loop. A qualified store stays in the loop body, so no loop driving a device ' +
      'register matches without it.',
    offeredWhen: { judges: 'each store through an address', gates: ['VOL_STORE_GATES'] },
    example: {
      compiler: 'agbcc',
      unit: 'void example(s32 n) { s32 i; for (i = 0; i < n; i++) { @ } }',
      before: '*(s32 *)0x40000d4 = i;',
      after: '*(volatile s32 *)0x40000d4 = i;',
    },
    implementedIn: l3('volstore'),
    seeAlso: ['volatile', 'unreduce'],
  },
  unreduce: {
    title: 'Accumulator written as its closed form',
    summary: 'a loop-carried accumulator is deleted and each read is written from the loop counter',
    detail:
      'Strength reduction is a compiler pass, so the assembly shows the accumulated form whichever form ' +
      'the source had. This writes the other one: the accumulator and its step are deleted, and each read ' +
      'becomes its value in terms of the loop counter. Published only when the candidate matches byte for ' +
      'byte, because a device store in the loop may write memory the moved read reads; otherwise it is ' +
      'withheld.',
    compilerBehavior:
      "A compiler-created induction value is initialized below the loop's hoisted invariants, a slot no C " +
      'statement before the loop can reach.',
    offeredWhen: {
      judges: 'each accumulator a loop steps by a constant alongside a counter stepped by a constant',
      gates: ['UNREDUCE_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: '#define REG 0x40000d4\nvoid example(s32 a0, s32 a1) { s32 v0; s32 v1 = 0; @ }',
      before: 'v0 = (v1 << 6) + a1; while (v1 <= 31) { *(s32 *)REG = v0; v0 = v0 + 64; v1 = v1 + 1; }',
      after: 'while (v1 <= 31) { *(s32 *)REG = (v1 << 6) + a1; v1 = v1 + 1; }',
      note: 'wins only together with `vol-store`',
    },
    implementedIn: l3('unreduce'),
    seeAlso: ['vol-store', 'ptr-field', 'indexed'],
  },
  'ptr-field': {
    title: 'Word field declared a pointer',
    summary: 'a recovered word-wide struct field is declared a pointer, cast back at each read',
    detail:
      'A struct field is typed from its access width alone, so a 4-byte field is `s32`. On a 32-bit target ' +
      '`void *` fits the same load exactly. Every read is cast back to the recovered integer type, so each ' +
      'use computes the same value.',
    compilerBehavior:
      'A pointer and an `s32` are different alias sets. At `-O2` the loop optimizer may hoist a pointer ' +
      "field's load past an `s32` store it must otherwise keep behind.",
    offeredWhen: { judges: 'each recovered struct field', gates: ['PTR_FIELD_GATES'] },
    example: {
      compiler: 'agbcc',
      unit: 'struct S { s32 field_0; @ }; void example(struct S *s, s32 lo) { s32 i; for (i = lo; i < 32; i++) { *(volatile s32 *)0x40000d4 = (s32)s->field_4 + i * 64; } }',
      before: 's32 field_4;',
      after: 'void *field_4;',
      note: 'wins only together with `vol-store/unreduce`',
    },
    implementedIn: l3('ptrfield'),
    seeAlso: ['unreduce', 'vol-store'],
  },
  offmember: {
    title: 'Constant subscript as a struct member',
    summary: 'a constant subscript of a fixed address is written as a struct member',
    detail:
      'Both spellings denote the same cell. The assembly says which one the compiler was given: an offset ' +
      "that reached the load's own displacement got there because nothing folded it into the address. A " +
      'named base (`basefold`) is the other source of that shape, so both are enumerated.',
    compilerBehavior:
      'On a compiler that folds a constant address offset, a subscript folds into the literal ' +
      '(`.word 0x3003476` + `ldrh r0, [r0]`) while a member stays in the operand (`.word 0x3003468` + ' +
      '`ldrh r0, [r0, #0xe]`).',
    offeredWhen: {
      judges: 'each fixed-address base a load reads through',
      gates: ['OFFMEMBER_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'struct S { u8 pad[14]; u16 m14; }; s32 example(void) { s32 x; @ return x; }',
      before: 'x = ((u16 *)0x3003468)[7];',
      after: 'x = ((struct S *)0x3003468)->m14;',
    },
    implementedIn: l3('offmember'),
    seeAlso: ['basefold', 'livebase'],
  },
  inlinebase: {
    title: 'Constant address written at each use',
    summary: 'a pointer local holding a constant address is deleted and the address written at each use',
    detail:
      'Structuring holds a constant with several consumers that lives across a call in a pointer local, the ' +
      'callee-saved register the compiler kept it in. A constant written at each use is folded into that ' +
      'same register, so the assembly does not say the source named it. A second candidate carries ' +
      '`volatile` onto each cast, since the deleted local was the only place a volatile pointee could be ' +
      'written.',
    compilerBehavior:
      "The local's assignment is scheduled ahead of the rest of the entry block, so the pool load moves in " +
      'front of the frame address the target materializes first.',
    offeredWhen: { judges: 'each local holding a constant', gates: ['INLINEBASE_GATES'] },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 n) { s32 i; @ }',
      before: 'u16 *p = (u16 *)0x4000208; for (i = 0; i < n; i++) { *p = i; f(); }',
      after: 'for (i = 0; i < n; i++) { *(u16 *)0x4000208 = i; f(); }',
    },
    implementedIn: l3('inlinebase'),
    seeAlso: ['vol-slot', 'volatile'],
  },
  scopebase: {
    title: 'Base pointer at its innermost scope',
    summary: 'a reused global base is named in a pointer local assigned in the scope holding its uses',
    detail:
      'The default base hoist names a reused base at the top of the function, which keeps it live across ' +
      'everything before an `if` arm that alone uses it. This assigns the local in the innermost statement ' +
      "list holding all of its uses. It also sees the bare `gSym[i]` spelling a map's declared array " +
      'produces, which the default hoist does not.',
    offeredWhen: {
      judges: 'each global base whose uses all sit inside one nested statement list',
      gates: ['SCOPEBASE_ELIGIBILITY', 'SCOPEBASE_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'extern u16 gTbl[]; void example(s32 c, u16 a) { u16 *p; @ }',
      before: 'p = gTbl; f(); if (c) { p[0x252] = a; p[0x272] = a + 1; }',
      after: 'f(); if (c) { p = gTbl; p[0x252] = a; p[0x272] = a + 1; }',
    },
    implementedIn: l3('scopebase'),
    seeAlso: ['regionbase', 'livebase', 'coalesce'],
  },
  regionbase: {
    title: 'One base pointer per region',
    summary: 'a base used in several separate regions gets one pointer local per region',
    detail:
      'The second region rule of `scopebase`: a base the source uses inside N disjoint regions becomes N ' +
      'locals, each assigned in its own region.',
    compilerBehavior:
      'agbcc distinguishes the number of locals with disjoint lifetimes, not where they are declared: the ' +
      'function-top and block-scoped declarations assemble identically, and a count of one does not.',
    offeredWhen: {
      judges: 'each global base, in each region that uses it',
      gates: ['SCOPEBASE_ELIGIBILITY', 'REGIONBASE_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'extern u8 gTbl[]; void example(s32 c, u8 a, u8 b, u8 d, u8 e) { u8 *p; u8 *p0; u8 *p1; @ }',
      before: 'p = gTbl; if (c) { p[1] = a; p[2] = b; } else { p[3] = d; p[4] = e; }',
      after: 'if (c) { p0 = gTbl; p0[1] = a; p0[2] = b; } else { p1 = gTbl; p1[3] = d; p1[4] = e; }',
    },
    implementedIn: l3('scopebase'),
    seeAlso: ['scopebase', 'homesplit', 'vol-store'],
  },
  coalesce: {
    title: 'Two locals share one variable',
    summary: 'two locals whose lifetimes never overlap are merged into one',
    detail:
      'Which locals the register allocator gave one register is not in the tree, and picking the first ' +
      'legal merge gets it wrong, so every legal single merge is its own candidate. It is offered in two cases: the ' +
      'lifetimes are disjoint in statement order, or one `if` picks between the two.',
    offeredWhen: {
      judges: 'each pair of locals, by statement order and by opposite arms of one `if`',
      gates: ['COALESCE_GATES', 'ARM_DISJOINT_GATES'],
    },
    subject: {
      meaning:
        'The two locals, joined by a hyphen: `coalesce-v0-v1` renames `v0` to `v1` and drops the declaration of `v0`.',
      examples: ['coalesce-v0-v1', 'coalesce-v2-v3'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(u8 *a, u8 *b, s32 n) { s32 v0; s32 v1; @ }',
      before: 'for (v0 = 0; v0 < n; v0++) a[v0] = b[v0]; for (v1 = n; v1 < 16; v1++) a[v1] = 0;',
      after: 'for (v1 = 0; v1 < n; v1++) a[v1] = b[v1]; for (v1 = n; v1 < 16; v1++) a[v1] = 0;',
      note: 'as the variation `coalesce-v0-v1` spells it',
    },
    implementedIn: l3('coalesce'),
    seeAlso: ['merge-names', 'scopebase', 'livebase'],
  },
  indexed: {
    title: 'Indexed loop, not a pointer walk',
    summary: 'a pointer walk is written as the indexed loop it was reduced from',
    detail:
      'A compiler reduces a source `arr[i]` loop into a pointer walk, so the faithful lift emits the walk, ' +
      'and recompiling the walk rarely reproduces the bytes the indexed source produced. This writes the ' +
      'indexed loop back.',
    compilerBehavior: 'The two spellings get a different induction variable and a different register allocation.',
    offeredWhen: {
      when: 'A loop walks a pointer one element per step, or counts down the do-while agbcc emits for an indexed loop.',
      decidedBy: { symbol: 'reindexWalks', file: l3('reindex') },
      gates: ['COUNTDOWN_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(u8 *base, s32 n) { u8 *p = base; s32 i; @ }',
      before: 'while (p < base + n) { use(*p); p = p + 1; }',
      after: 'for (i = 0; i < n; i++) { use(base[i]); }',
    },
    implementedIn: l3('reindex'),
    seeAlso: ['unreduce', 'volatile', 'livebase'],
  },
  livebase: {
    title: 'Base pointer held across the body',
    summary: 'a fixed address reused inside a loop or at one offset again and again is held in a pointer local',
    detail:
      'The default base hoist refuses a base reused inside a loop or at a repeated constant offset, ' +
      'predicting that the compiler loads the address again. A memory-mapped poll (store, then re-read the ' +
      'same register while it spins) is where that prediction is wrong: the compiler holds one register ' +
      'across the stores, the loop and the read-back. This hoist admits those bases. Its combinations with ' +
      '`indexed`, `sinkinit`, `nearbase`, `coalesce` and `homesplit` are enumerated beside it.',
    offeredWhen: {
      judges: 'each fixed-address base reached twice or more, even inside a loop or at one repeated offset',
      gates: ['LIVEBASE_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(u32 go) { @ }',
      before: '((u32 *)0x40000d4)[2] = go; while (((u32 *)0x40000d4)[2] & 0x80000000) {}',
      after: 'u32 *p = (u32 *)0x40000d4; p[2] = go; while (p[2] & 0x80000000) {}',
    },
    implementedIn: BASECSE,
    seeAlso: ['livebase-block', 'volatile', 'offmember'],
  },
  'livebase-block': {
    title: 'Base pointer for a register block only',
    summary: 'like `livebase`, but a base read at one fixed offset stays inline',
    detail:
      'Which of several numeric bases the source named is per base: a DMA register block wants one register ' +
      'held across the body while the RAM halfword beside it is loaded each time. This is `livebase` with ' +
      'every base reached at a single fixed offset left inline.',
    offeredWhen: {
      judges: 'each fixed-address base reached twice or more, at more than one offset',
      gates: ['LIVEBASE_BLOCK_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(u32 src, u32 go) { u32 *p = (u32 *)0x40000d4; u16 *q = (u16 *)0x3001048; @ }',
      before: 'p[0] = src; p[2] = go; q[0] = q[0] + 1;',
      after: 'p[0] = src; p[2] = go; *(u16 *)0x3001048 = *(u16 *)0x3001048 + 1;',
      note: 'with `p` the DMA block and `q` the halfword, both held in pointer locals by `livebase`',
    },
    implementedIn: BASECSE,
    seeAlso: ['livebase', 'homesplit'],
  },
  basefold: {
    title: 'Base pointer for an unfolded offset',
    summary: 'a fixed address whose offset stayed in the load gets a pointer local, even if used once',
    detail:
      'The default hoist refuses a base reached once. A load that kept its constant offset in the operand is ' +
      'evidence against that, on a compiler that folds a subscript into the literal: something other than a ' +
      'subscript put it there. `basefold/sinkinit` is the same rule with the local assigned at its first use.',
    compilerBehavior:
      "agbcc folds a constant subscript into the literal it loads and keeps a named base's offset in the " +
      'instruction.',
    offeredWhen: {
      judges: 'each fixed-address base whose load kept its constant offset, even one reached once',
      gates: ['BASEFOLD_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 's32 example(void) { s32 x; @ return x; }',
      before: 'x = ((u16 *)0x3003468)[7];',
      after: 'u16 *p = (u16 *)0x3003468; x = p[7];',
    },
    implementedIn: BASECSE,
    seeAlso: ['offmember', 'unfolded', 'sinkinit'],
  },
  unfolded: {
    title: 'Unfolded base pointer at first use',
    summary: 'a reused fixed address whose offset stayed in the load is assigned where it is first used',
    detail:
      'Admits a base reached two or more times whose offset survived into the load, and assigns its local ' +
      'at the first use. Where it binds a base another hoist already names it takes the name, so its count ' +
      'includes renames.',
    offeredWhen: {
      judges: 'each fixed-address base reached twice or more whose load kept its constant offset',
      gates: ['UNFOLDED_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 's32 example(void) { u16 *p; s32 x; s32 y; @ return x + y; }',
      before: 'f(); x = ((u16 *)0x3003468)[7]; y = ((u16 *)0x3003468)[8];',
      after: 'f(); p = (u16 *)0x3003468; x = p[7]; y = p[8];',
    },
    implementedIn: BASECSE,
    seeAlso: ['basefold', 'livebase', 'sinkinit'],
  },
  orderbase: {
    title: 'Base pointer the load order licenses',
    summary: 'an array base the assembly loaded before scaling its index gets a pointer local',
    detail:
      'The only base hoist whose evidence is the instruction order: the base was materialized before the ' +
      "index was scaled, which is what a declared array or a pointer local's own assignment produces. It " +
      'can bind the `(struct S *)&gSym` base of an array-of-struct element, which no other hoist sees.',
    compilerBehavior:
      "On agbcc the array subscript expansion loads a declared array's base first and scales the index " +
      'first for the inline cast.',
    offeredWhen: {
      judges: 'each fixed-address base the assembly loaded before scaling its index',
      gates: ['ORDERBASE_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'struct S { u16 f; u16 g; }; extern u8 gTbl[]; s32 example(s32 i) { s32 x; s32 y; @ return x + y; }',
      before: 'x = ((struct S *)&gTbl)[i].f; y = ((struct S *)&gTbl)[i].g;',
      after: 'struct S *p = (struct S *)&gTbl; x = p[i].f; y = p[i].g;',
    },
    implementedIn: BASECSE,
    seeAlso: ['orderbase-scoped', 'livebase'],
  },
  'orderbase-scoped': {
    title: 'Licensed base pointer inside its scope',
    summary: 'like `orderbase`, with the local assigned inside the nested scope holding its uses',
    detail:
      'The same admission as `orderbase`, with the assignment placed in the nested statement list holding ' +
      'every use. Where no nested list holds them all it declines rather than repeat the flat placement.',
    compilerBehavior: 'The same assignment above an `if` and inside its arm compile differently on agbcc.',
    offeredWhen: {
      judges: 'each base the assembly loaded before scaling its index, whose uses one nested statement list holds',
      gates: ['ORDERBASE_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'struct S { u16 f; u16 g; }; extern u8 gTbl[]; s32 example(s32 c, s32 i) { struct S *p; s32 x = 0; @ return x; }',
      before: 'p = (struct S *)&gTbl; if (c) { x = p[i].f; }',
      after: 'if (c) { p = (struct S *)&gTbl; x = p[i].f; }',
    },
    implementedIn: BASECSE,
    seeAlso: ['orderbase', 'scopebase'],
  },
  homesplit: {
    title: 'One base at the top, one split per region',
    summary: 'after a `livebase` hoist, one withheld base is split into one local per region',
    detail:
      'Both base policies are whole-function: `livebase` holds every base it admits in a local at the top, and ' +
      '`regionbase` splits every base it admits. A function whose two bases want opposite answers is spelled ' +
      'by neither. This runs the hoist with one base withheld, then splits that base per region. It always ' +
      'follows `livebase` or `livebase-block` in a name.',
    offeredWhen: {
      judges: 'each base a `livebase` or `livebase-block` hoist holds in a pointer local',
      gates: ['HOMESPLIT_FAN_GATES', 'HOMESPLIT_GATES'],
    },
    subject: {
      meaning:
        'The withheld base, then `.`, its access width in bytes and `s` or `u` for signedness: ' +
        '`homesplit-0x40000d4.4s` withholds the signed 4-byte key at 0x40000d4. A symbol base is spelled by ' +
        'name, with a cast type in `<…>` when it has one.',
      examples: ['homesplit-0x40000d4.4s', 'homesplit-gFoo<u8*>.1u'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(s32 c) { u16 *w0; u16 *w1; @ }',
      before: 'u32 *d = (u32 *)0x40000d4; u16 *w = (u16 *)0x3001048; if (c) { d[2] = w[0]; } else { d[3] = w[1]; }',
      after:
        'u32 *d = (u32 *)0x40000d4; if (c) { w0 = (u16 *)0x3001048; d[2] = w0[0]; } else { w1 = (u16 *)0x3001048; d[3] = w1[1]; }',
      note: 'the halfword base withheld from the top and split',
    },
    implementedIn: l3('homesplit'),
    seeAlso: ['livebase', 'livebase-block', 'regionbase'],
  },
  mulfirst: {
    title: 'Product first in a sum',
    summary: 'a sum with one product operand puts the product first',
    detail:
      'Operands of a commutative sum are spelled in evaluation order, which recovers the source order on ' +
      'gcc. IDO can load the independent operand above the multiply, so evaluation order spells a ' +
      'product-first source the other way round.',
    compilerBehavior:
      'IDO loads a struct field `c` in `a * b + c` above the multiply, so the order of the loads does not show ' +
      'which operand the source wrote first. On mwcc the two orders compile to one object.',
    offeredWhen: {
      when: 'A `+` with exactly one product operand and no effect in either operand.',
      decidedBy: { symbol: 'mulFirstSums', file: l3('mulfirst') },
    },
    example: {
      compiler: 'ido',
      unit: 'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; }; s32 example(struct Bg *bg) { s32 x; @ return x; }',
      before: 'x = bg->tiles + bg->w * bg->h;',
      after: 'x = bg->w * bg->h + bg->tiles;',
    },
    implementedIn: l3('mulfirst'),
  },
  nearbase: {
    title: 'Neighbor cells from one base',
    summary: 'nearby fixed addresses are written as offsets from one base local',
    detail:
      "Raw-address accesses a few bytes apart are one object's cells: the compiler holds the object's base " +
      'in a register and derives each cell, where a per-cell spelling gives each address its own pool ' +
      'constant.',
    compilerBehavior:
      'Past the load range the compiler derives a cell with an `add` off one pool word instead of loading a ' +
      'second literal.',
    offeredWhen: {
      when: "Two or more distinct constant addresses fall within the target's derivation reach.",
      decidedBy: { symbol: 'nearBaseClusters', file: l3('nearbase') },
    },
    example: {
      compiler: 'agbcc',
      unit: 's32 example(void) { s32 x; s32 y; @ return x + y; }',
      before: 'x = *(u16 *)0x0300104A; y = *(u16 *)0x03001048;',
      after: 'u8 *b = (u8 *)0x03001048; x = *(u16 *)(b + 2); y = *(u16 *)b;',
    },
    implementedIn: l3('nearbase'),
    seeAlso: ['livebase', 'sinkinit', 'advance'],
  },
  advance: {
    title: 'Pointer advanced between accesses',
    summary: 'accesses the machine made through one moving register are written through a stepped pointer',
    detail:
      'The assembly held an address in a register, used it, added to it and used it again. The lift folds ' +
      'that pair into two constant addresses and records that it did; this writes the stepped pointer. The ' +
      'chain is read off constant addresses, so a symbol map that names them hides it.',
    compilerBehavior:
      'Through a `volatile` pointer agbcc keeps the step as an `add` between the two accesses, which the same ' +
      'accesses through two constant addresses do not compile to. The plain step lost on every agbcc row that ' +
      'reached it, so on agbcc it is offered only together with `volatile`.',
    offeredWhen: {
      judges: 'each chain of accesses the machine made through one stepped register',
      gates: ['ADVANCE_HEAD_GATES', 'ADVANCE_MEMBER_GATES'],
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(u16 a, u16 b) { @ }',
      before: '*(volatile u16 *)0x04000048 = a; *(volatile u16 *)0x0400004A = b;',
      after: 'volatile u16 *p = (volatile u16 *)0x04000048; *p = a; p = p + 1; *p = b;',
      note: 'shown with `volatile`, the only company it is offered in on agbcc',
    },
    implementedIn: l3('advance'),
    seeAlso: ['volatile', 'nearbase'],
  },
  parkfirst: {
    title: 'Parameter copies first',
    summary: 'copies of incoming parameters move to the front of the entry block',
    detail:
      'A copy of a parameter into a local reproduces a register park, and the park lifts to no instruction ' +
      'at all, so its position falls out of emission order. The compiler may have parked before anything ' +
      'else ran. Only plain assignments of parameters and constants in the leading run move, never across a ' +
      'statement that touches what they read or write.',
    offeredWhen: {
      when: 'The leading run of assignments holds a parameter or constant copy that can move ahead.',
      decidedBy: { symbol: 'parkParamsFirst', file: l3('parkfirst') },
    },
    example: {
      compiler: 'agbcc',
      unit: 's32 example(s32 a0, s32 a1) { s32 v0; s32 v1; s32 v2; s32 v3; s32 i; @ v2 = ((u8 *)a0)[4]; v3 = ((u8 *)a0)[5]; for (i = 0; i < a1; i++) { v0 += v1 * v2; v1 += v3; v2 += v0; v3 += v1; } return v0 + v1 + v2 + v3; }',
      before: 'v0 = *(u8 *)a0; v1 = a1;',
      after: 'v1 = a1; v0 = *(u8 *)a0;',
    },
    implementedIn: l3('parkfirst'),
    seeAlso: ['sinkinit'],
  },
  sinkinit: {
    title: 'Base pointer assigned at first use',
    summary: 'each leading base-pointer assignment moves down to the statement that first uses it',
    detail:
      'A base hoist assigns every base local at the top of the body, keeping it live across everything ' +
      'above its first use. This moves each assignment of the leading run down to the first top-level ' +
      'statement mentioning it, never into a nested scope. It also follows `nearbase` and the `livebase` ' +
      'hoists.',
    compilerBehavior:
      'On `synthetic:basehome` the top assignment costs a callee-saved push and pop that the first-use ' +
      'assignment avoids.',
    offeredWhen: {
      when: 'The body starts with base-pointer assignments whose first use is further down.',
      decidedBy: { symbol: 'sinkInitsToFirstUse', file: l3('sinkinit') },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'extern u8 gTbl[]; void example(void) { u8 *p; @ }',
      before: 'p = (u8 *)&gTbl; f(); g(); p[1] = 0;',
      after: 'f(); g(); p = (u8 *)&gTbl; p[1] = 0;',
    },
    implementedIn: l3('sinkinit'),
    seeAlso: ['livebase', 'nearbase', 'basefold'],
  },
  regcopy: {
    title: 'Register copies written out',
    summary: 'register copies the structurer merged away are written back as locals',
    detail:
      'Register allocation leaves source-visible copies that coalescing erases: a merge made as a copy ' +
      'plus an in-place update on one arm, a large constant staged in its own register, a return value ' +
      'built in another register. This writes them back, in the top-level statement list only. With no ' +
      'subject it applies the first two; a subject adds a return assignment.',
    offeredWhen: {
      when: 'A top-level `if` whose arms set one variable from one pure value, or a constant expression used as an operand.',
      decidedBy: { symbol: 'registerishSpellings', file: l3('regspell') },
    },
    subject: {
      meaning:
        'How the returned value is written. `regcopy-ret` assigns it to the variable the copy left unused ' +
        'and returns that; `regcopy-ret-fresh` assigns it to a new variable.',
      examples: ['regcopy-ret', 'regcopy-ret-fresh'],
    },
    example: {
      compiler: 'ido',
      unit: 's32 example(s32 *p, s32 i) { s32 j; s32 r; j = i; if (j >= 8) j -= 8; @ }',
      before: 'return p[j] + i;',
      after: 'r = p[j] + i; return r;',
      note: 'as the variation `regcopy-ret-fresh` spells it',
    },
    implementedIn: l3('regspell'),
    seeAlso: ['coalesce', 'merge-names'],
  },
  initfirst: {
    title: 'Loop start before its guard',
    summary: "a loop's starting assignment moves above the guard, and the guard reads the variable",
    detail:
      '`for (i = 0; i < n; i++)` compiles with the assignment before the zero-trip test, while ' +
      '`if (0 < n) { i = 0; do … }` compiles with it behind the branch, and both lift to the same code. It ' +
      "touches private locals only. Applied on top of every other candidate's source, alone and together " +
      'with `pollguard` and `pollread`.',
    offeredWhen: {
      when: 'An `if` whose arms both start with the same constant assignment, or whose then-arm assigns the value its condition compares.',
      decidedBy: { symbol: 'initFirstGuards', file: l3('initfirst') },
    },
    example: {
      compiler: 'agbcc',
      unit: CALLS + 'void example(s32 n) { s32 v; @ }',
      before: 'if (0 < n) { v = 0; do { use(v); v++; } while (v < n); }',
      after: 'v = 0; if (v < n) { do { use(v); v++; } while (v < n); }',
    },
    implementedIn: l3('initfirst'),
    seeAlso: ['loop-entry', 'defsite'],
  },
  pollguard: {
    title: 'Guard around an empty wait loop',
    summary: 'an empty bottom-tested loop gets back the guard the compiler folded into its test',
    detail:
      'For an empty body the two forms compile to the same instructions and evaluate the condition the same ' +
      'number of times. The difference is a register-allocation ripple: the extra source read raises the ' +
      "use counts of the condition. Applied on top of every other candidate's source.",
    compilerBehavior:
      'gcc merges the guard into the bottom test late, after flow counted its reads, which reorders the ' +
      "allocator's priorities for the whole function.",
    offeredWhen: {
      when: 'The function has an empty-bodied `do … while`.',
      decidedBy: { symbol: 'pollGuards', file: l3('pollguard') },
    },
    example: {
      compiler: 'agbcc',
      unit: 'void example(volatile u32 *dma, u8 *dst, s32 n) { s32 i; for (i = 0; i < n; i++) { dma[0] = (u32)dst + i; dma[2] = 0x80000020; @ } }',
      before: 'do { } while (dma[2] & 0x80000000);',
      after: 'if (dma[2] & 0x80000000) { do { } while (dma[2] & 0x80000000); }',
    },
    implementedIn: l3('pollguard'),
    seeAlso: ['pollread', 'livebase'],
  },
  pollread: {
    title: 'Wait loop reads in its condition',
    summary: "a poll's value is read inside the loop condition instead of into a variable",
    detail:
      'The structurer names a value re-read at each iteration, with a read before the loop and one per ' +
      'pass. The source may have read it inside the condition of an empty loop. Both read once more than ' +
      "the number of iterations. Applied on top of every other candidate's source.",
    compilerBehavior:
      'The named spelling materializes an extra register and instruction that the in-condition spelling does not.',
    offeredWhen: {
      when: "A loop whose only statement re-reads the local its condition tests, into the function's own non-volatile local.",
      decidedBy: { symbol: 'pollReads', file: l3('pollguard') },
    },
    example: {
      compiler: 'agbcc',
      unit: '#define BUSY 0x80000000\nvoid example(u32 *dma) { u32 v; @ }',
      before: 'v = dma[2]; while ((v & BUSY) != 0) { v = dma[2]; }',
      after: 'while ((dma[2] & BUSY) != 0) {}',
    },
    implementedIn: l3('pollguard'),
    seeAlso: ['pollguard'],
  },

  // ── symbol map ──────────────────────────────────────────────────────────────────────────────
  'raw-globals': {
    title: 'Raw addresses, not map names',
    summary: "the symbol map's shaped spellings are dropped in favour of raw addresses",
    detail:
      'Naming a global changes codegen, and which side matches is per function. The raw candidate still ' +
      "names globals the literal pool or a relocation spells; it drops only the map's shaped spellings. At " +
      'equal score the named spelling wins, so this is published only where it scores better.',
    compilerBehavior: 'On agbcc a named global changes when the address is loaded.',
    offeredWhen: {
      when: 'A symbol map was supplied; a row without one never carries it.',
      decidedBy: { symbol: 'enumerateCandidates', file: RANK },
    },
    example: {
      compiler: 'agbcc',
      unit: 'extern struct { u8 pad[4]; u8 field; } gCounter; s32 example(void) { s32 x; @ return x; }',
      before: 'x = gCounter.field;',
      after: 'x = ((u8 *)0x3003468)[4];',
    },
    implementedIn: RANK,
    seeAlso: ['reread-globals', 'no-bitfield', 'no-ptr-elem'],
  },
};
