import type { SymbolMap, SymbolTypeFacts } from './symbols';

// asmlift — function prototypes: the single carrier for the caller-supplied facts a
// matching-decomp project reads from its headers (arg counts, parameter widths, void-ness). One
// `Prototypes` map, keyed by symbol, is threaded through every entry point and resolved at the
// point of use — a callee's `params` gives the registers its call occupies, a function's own entry gives its
// `returnsVoid` and the widths raise/paramwidth.ts checks against. It also keeps the frontend seam
// honest: a frontend receives prototypes, not a grab-bag of ISA-specific options.

/** One declared parameter, as its C type text (`"u8"`, `"s32"`, `"void *"`, `"int"`). ONE fact is
 *  read off it and everything else is derived from that fact: the WIDTH it spells
 *  (`declaredWidth`). raise/paramwidth.ts checks its inference against that width, and
 *  `declaredArgLayout` sums the list's widths into the argument registers the call occupies.
 *
 *  A DECLARED WIDTH ONLY VETOES, never pins. Where the asm carries a prologue extension the
 *  declaration contradicts, the declaration wins — it is a fact from the project's headers, where
 *  the extension is an inference off an encoding two different C sources produce. Where the asm
 *  carries no extension, this list is NOT consulted: pinning there would type every parameter of
 *  every row from the declaration, and a declared `u32` kills rank.ts's signed arm before the
 *  differ ever sees it. That half is a variation question and is not answered here. */
export type ParamType = string;

/** What the headers know about one function. All fields optional: a partial table (only
 *  callee arities, or only the current function's void-ness) is the common case. */
export interface FnProto {
  /** declared parameters — either the typed parameter list a header extraction produces
   *  (`["u8", "s32"]`), which is a list of C PARAMETERS, or a bare COUNT, which is the user's word
   *  for how many argument REGISTERS the call occupies. The two are the same number only while
   *  every parameter fits in a register, and `declaredArgLayout` is what converts the first into
   *  the second. Omit to let the frontend fall back to its contiguous-arg-register heuristic. */
  params?: number | ParamType[];
  /** The declared return type is `void`. Read for the function under decompilation, where a
   *  trailing `bx lr` leaves a meaningless return register that must not surface as a `return`
   *  value — and, since the out-parameter path landed, for a CALLEE, where it is the only thing
   *  that tells an out-parameter frame from a hidden struct-return pointer.
   *
   *  THAT SECOND READER IS LOAD-BEARING AND THE FIELD IS UNCHECKED DATA, which is worth knowing
   *  before authoring one. `validatePrototypes` type-checks the boolean and can check no more:
   *  nothing in the assembly distinguishes the two frames, which is why the refusal exists. So a
   *  callee wrongly declared `void` turns a loud decline into a compiling, plausible, wrong
   *  program — measured on the shape the guard is for, `struct S4 mk(int); struct S4 s = mk(x);`
   *  lifts as `mk(&sp0); return (u8)sp0;` when `mk` is declared `returnsVoid` — where a callee
   *  wrongly declared NON-void, or left undeclared, only costs the lift. Under-declaring is the
   *  safe direction and this project has already shipped one wrong entry (a dataset row declaring
   *  `returnsVoid: true` for a function whose own reference returns `void *`).
   *
   *  Both readers see one field through two trust levels: caller-supplied on `--proto`, and
   *  machine-derived from DWARF through `prototypesFromSymbols`. Neither is distinguished here. */
  returnsVoid?: boolean;
}

/** symbol → prototype. The function under decompilation and its callees share one table. */
export type Prototypes = Record<string, FnProto>;

/** How many argument REGISTERS a list of parameter WIDTHS occupies: a parameter wider than a
 *  machine word travels in a register pair, every other one in a single register.
 *
 *  The rule lives here rather than beside either caller because it has two, and they are the two
 *  vocabularies a declaration is written in. `runtime-helpers.ts` states a compiler's own helper
 *  signatures as widths (`__ashrdi3` is `[64, 32]` — two C parameters, three registers), and
 *  `declaredArgLayout` below reads the same widths off a project's C types. One ABI fact, one
 *  copy of it; a second copy is a rule that can disagree with itself.
 *
 *  NO EVEN-REGISTER ALIGNMENT, and that is a measured agbcc fact rather than an omission: its
 *  `thumb.h` computes an argument's register from a plain byte counter with no rounding, so
 *  `void f(s32, long long)` passes the pair in r1:r2 where AAPCS would pad to r2:r3.
 *
 *  AN ABI THAT DOES ALIGN HAS NO READER HERE YET, which is why the rule is flat rather than a
 *  knob on `TargetDescription` beside `argRegs` and `stagesOutgoingArgsInFrame`. MIPS o32 aligns a
 *  64-bit argument to an even register pair and is the target that will want one — and
 *  `frontend/mips.ts` takes `_prototypes` and reads none of them, so the knob would be a
 *  per-target setting with zero consumers and nothing measuring it. The round that teaches MIPS to
 *  read a prototype is the round that owes the rule a home; adding it now would be a second ABI
 *  fact nobody could be wrong about. */
export function wordsOf(params: readonly number[]): number {
  return params.reduce((n, w) => n + (w > 32 ? 2 : 1), 0);
}

/** Whether a proto states a parameter list at all — readably or not. The tier question, asked
 *  before the layout question: a project that declares a callee has re-declared it, and falling
 *  through to a compiler's runtime table or to the C standard's signatures behind a declaration
 *  nobody could SIZE would answer with a different function's shape. */
export function declaresParams(p: FnProto | undefined): boolean {
  return typeof p?.params === 'number' || Array.isArray(p?.params);
}

/** The argument-register layout one declaration states, as far as the declaration can state it.
 *  ONE WALK OF THE PARAMETER LIST answers both halves, because they are two readings of the same
 *  `declaredWidth` call and a second walk is a rule that can disagree with itself. */
export interface DeclaredArgLayout {
  /** the width each declared parameter occupies, in argument order — `null` where `declaredWidth`
   *  cannot read the spelling, which is "either one register or a pair" and not "one word" */
  readonly widths: readonly (number | null)[];
  /** the spellings that answered `null`, in argument order, in the words the user wrote them */
  readonly unsizable: readonly ParamType[];
}

/** What a declaration says about the argument registers a call occupies, or `undefined` when
 *  `params` was omitted or malformed (a bare `"u8"` string, the shape the untyped CLI `--proto`
 *  JSON admits) — the two readings that failed before any parameter was looked at.
 *
 *  A SPELLING THIS CANNOT SIZE IS NOT A FAILED READING OF THE LIST, and that is the whole of what
 *  this type exists to keep apart. A project typedef — `size_t`, `bool8`, `Direction`, `TaskFunc`,
 *  `int64_t` — reads as `null` exactly as `struct Foo` does, and the question a caller is asking
 *  is not "how wide is it" but "does it occupy one argument register or two". Answering "one" is a
 *  layout nothing could know to be right; refusing the WHOLE list over it is a function the caller
 *  lifts when told nothing and refuses when told more, which is worse than either. So the freedom
 *  is carried here per parameter and `resolveArgLayout` spends it against the machine.
 *
 *  The COUNT form already speaks argument registers and says so at its declaration, so it expands
 *  to that many words and can never be unsizable. */
export function declaredArgLayout(p: FnProto | undefined): DeclaredArgLayout | undefined {
  if (typeof p?.params === 'number') {
    return { widths: Array.from({ length: p.params }, () => 32), unsizable: [] };
  }
  if (!Array.isArray(p?.params)) {
    return undefined;
  }
  const widths: (number | null)[] = [];
  const unsizable: ParamType[] = [];
  for (const t of p.params) {
    const w = declaredWidth(t);
    widths.push(w ?? null);
    if (w === undefined) {
      unsizable.push(t);
    }
  }
  return { widths, unsizable };
}

/** The argument-register widths a declaration resolves to once the MACHINE has been consulted, or
 *  `null` when nothing decides between the readings it leaves open.
 *
 *  A list with `u` unsizable spellings spans between `known + u` argument registers (every one of
 *  them a single register) and `known + 2u` (every one of them a pair). `argRegsSetUp` is the
 *  count the caller actually set up, read off the instructions by the same contiguous scan a
 *  callee with no prototype at all is lifted by — an INDEPENDENT witness, in the vocabulary the
 *  declaration has to be converted into anyway. When it equals the MINIMUM, the only reading that
 *  fits is the one where every unsizable parameter is a single register, and that reading is
 *  returned. When it does not, two readings survive and they disagree about where every later
 *  argument lives, so this refuses and the caller says so.
 *
 *  THE SCAN IS A LOWER BOUND AND THAT IS THE SAFE DIRECTION: it under-counts a pass-through
 *  parameter (frontend/ssa.ts `fallbackArgc`), and an under-count lands below the minimum and
 *  refuses. It is also capped at the argument registers the target has, so a declaration that
 *  spans more words than there are registers can never be resolved this way — a pair in the
 *  outgoing stack block is a placement nothing here assembles in any case.
 *
 *  A FULLY READABLE LIST IS AUTHORITY AND THE MACHINE IS NOT CONSULTED FOR IT. The declaration is
 *  a fact from the project's headers; the scan is an inference, and it loses. */
export function resolveArgLayout(layout: DeclaredArgLayout, argRegsSetUp: number): readonly number[] | null {
  const narrow = layout.widths.map((w) => w ?? 32);
  if (layout.unsizable.length === 0) {
    return narrow;
  }
  return wordsOf(narrow) === argRegsSetUp ? narrow : null;
}

/** The fewest argument registers a declaration can occupy: every spelling it could not size read
 *  as a single register. It is the bound {@link resolveArgLayout} accepts on, and a caller laying
 *  out an outgoing stack block reads it to find the declarations no count could ever settle —
 *  above the target's argument registers, the machine's own scan is capped and can never reach it. */
export function minArgRegs(layout: DeclaredArgLayout): number {
  return wordsOf(layout.widths.map((w) => w ?? 32));
}

/** Why {@link resolveArgLayout} could not answer, as the sentence a frontend refuses with — ONE
 *  copy of it, because the two frontends that ask this question must not answer it differently and
 *  a second spelling is where that starts. The caller supplies `cannot lift '<fn>': ` and its own
 *  error class. */
export function unresolvedArgLayout(callee: string, layout: DeclaredArgLayout, argRegsSetUp: number): string {
  const narrow = layout.widths.map((w) => w ?? 32);
  return (
    `callee \`${callee}\` is declared with ${layout.widths.length} parameter(s), of which ` +
    `\`${layout.unsizable[0]}\` is a spelling asmlift cannot size — so it occupies either one argument ` +
    `register or the two a 64-bit value travels in, and the call sets up ${argRegsSetUp} argument ` +
    `register(s) where reading every such spelling as one accounts for ${wordsOf(narrow)}. Nothing here ` +
    `decides which it is, and the choice moves every later argument's home. Declare the call's ` +
    `argument-REGISTER count instead (\`{"${callee}": {"params": ${argRegsSetUp}}}\`), which is taken ` +
    'at its word'
  );
}

/** A signature the C standard fixes is a COMPLETE one, which an `FnProto` is not: a project
 *  prototype is a lower bound assembled from whatever a header extraction could read, and omits
 *  what it could not. The standard omits nothing, so the RETURN is spelled here and is required —
 *  it is the fact `returnsWithoutHiddenPointer` needs and the fact no header ever supplied. */
interface StandardSignature extends FnProto {
  /** the return type, as its C spelling (`"void *"`, `"u32"`, `"void"`) */
  returns: ParamType;
}

/** Signatures FIXED BY THE C STANDARD, so they are not a project fact and need no header to be
 *  known. Consumed by a frontend's arity lookup behind both the caller-supplied prototype and the
 *  compiler's own runtime helpers (raise/softdiv.ts) — a project that declares one of these wins,
 *  because a decomp may legitimately be building against its own re-declaration.
 *
 *  WHAT AN ENTRY BUYS, which is not the same as what it changes: the arity a call recovers is
 *  usually the same number the arg-register heuristic already guessed, so an entry moves no code.
 *  What it moves is what is KNOWN — a guess cannot witness anything, and an entry can. The
 *  frame-object audit reads the `returns` of one to rule out a hidden struct-return pointer
 *  (`returnsWithoutHiddenPointer`, consumed in frontend/thumb.ts).
 *
 *  THE LIST IS SHORT ON PURPOSE. `memcpy` is here because a corpus row exercises it and its price
 *  was measured. `memset`, `strcpy` and the rest of the standard library are equally fixed by the
 *  standard and equally addable, and they are absent because nothing measures them — a table
 *  grown by appetite would be a table nobody priced. */
export const STANDARD_SIGNATURES: Record<string, StandardSignature> = {
  memcpy: { params: ['void *', 'const void *', 'u32'], returns: 'void *' },
};

/** Whether a call to `callee` is KNOWN not to be handed a hidden struct-return pointer in
 *  argument 0. A callee that returns nothing has no such pointer to be given; neither has one
 *  whose return travels in a register. Every other answer — including silence — is `false`,
 *  because this is a fact a caller must be TOLD: the two frames are the same instructions in the
 *  same order, so there is nothing in the assembly to read it off.
 *
 *  A RETURN WIDER THAN A REGISTER STILL TRAVELS IN REGISTERS — it travels in a PAIR, which is
 *  still not a hidden pointer the caller supplied — so `declaredWidth` answering 64 is the right
 *  answer here rather than a width that slipped through a test meant for words. Nothing reaches
 *  it: `STANDARD_SIGNATURES` has one entry and it returns `void *`.
 *
 *  TWO SOURCES AND NEITHER RANKS ABOVE THE OTHER, because on this one question they cannot
 *  disagree: `returnsVoid` from the project's own headers, and the `returns` of a signature the C
 *  standard fixes, which is as known as its parameters. That a project may re-declare a standard
 *  function differently is real and is why `declaredCall` ranks the two for ARITY — but a
 *  re-declaration that changed `memcpy` into a struct-returning function would not be `memcpy`.
 *
 *  `Object.hasOwn`, not `in`: `prototypes` is caller-supplied JSON and the table is an object
 *  literal, so `in` would answer for `toString` and every other name on `Object.prototype`. The
 *  ENTRY is read through `?.` for the other half of the same fact: `decompile` is a published
 *  entry point that runs no `validatePrototypes`, so a `null` entry out of parsed JSON reaches
 *  here, and a raw TypeError would leave through neither the decline channel nor anything a
 *  caller can act on. Every other reader of this table — `declaredArgLayout`, and `declaredCall`
 *  through it — answers "nothing is declared" for such an entry, and so does this. */
export function returnsWithoutHiddenPointer(callee: string, prototypes: Prototypes): boolean {
  if (Object.hasOwn(prototypes, callee) && prototypes[callee]?.returnsVoid === true) {
    return true;
  }
  if (!Object.hasOwn(STANDARD_SIGNATURES, callee)) {
    return false;
  }
  const t = STANDARD_SIGNATURES[callee].returns.trim();
  return t === 'void' || declaredWidth(t) !== undefined;
}

/** Bit width per C89 base type on every target asmlift lifts (all ILP32 with a 64-bit `long long`).
 *  `long` is 32 here and would not be on an LP64 host, so it is a target fact rather than a
 *  language one.
 *
 *  THE FLOATING TYPES ARE HERE BECAUSE THE QUESTION IS HOW MANY REGISTERS, NOT WHICH ONES. Every
 *  target asmlift lifts is soft-float: a `float` travels in one core register and a `double` in a
 *  pair, exactly as a `s32` and a `long long` do. Leaving `double` unreadable was the worse answer
 *  and it was measurably wrong rather than merely cautious — `resolveArgLayout` can only spend an
 *  unreadable spelling's freedom by finding that ONE register fits the machine's count, and for a
 *  `double` that reading is known false. A spelling whose width is known belongs here even where
 *  the VALUE is one this pipeline would render as an integer; the layout is right, and a pair it
 *  cannot spell stops at the loud `concat` gap rather than at a wrong argument list.
 *
 *  THE FIXED-WIDTH NAMES ARE FIXED BY THE STANDARD, not by a project, which is the same reason
 *  `STANDARD_SIGNATURES` exists: `int32_t` is 32 bits wherever it compiles at all, and reading it
 *  as "a project typedef" put `size_t` and `int64_t` — the spellings a header extraction produces
 *  most — into the population that cannot be sized. `long double` is NOT here: it is 8 bytes on
 *  these ABIs and 10 or 16 on others, and nothing has measured which one a target's compiler
 *  means. */
const BASE_WIDTHS: ReadonlyMap<string, number> = new Map([
  ['char', 8],
  ['short', 16],
  ['short int', 16],
  ['float', 32],
  ['int', 32],
  ['long', 32],
  ['long int', 32],
  ['double', 64],
  ['long long', 64],
  ['long long int', 64],
  ['int8_t', 8],
  ['uint8_t', 8],
  ['int16_t', 16],
  ['uint16_t', 16],
  ['int32_t', 32],
  ['uint32_t', 32],
  ['int64_t', 64],
  ['uint64_t', 64],
  ['size_t', 32],
  ['ssize_t', 32],
  ['ptrdiff_t', 32],
  ['intptr_t', 32],
  ['uintptr_t', 32],
]);

/** The bit width one declared parameter type spells, or `undefined` for a spelling this does not
 *  read — a project typedef, a by-value struct, a `long double`. UNDEFINED IS "NO OPINION", never
 *  "wide": a
 *  consumer treats a width it can read as authority and a width it cannot as absence, so an
 *  unrecognized spelling leaves the asm's own inference standing. `declaredArgLayout` is the one
 *  reader that cannot live with "no opinion" — it is laying out registers — and it carries the
 *  absence per parameter rather than resolving it here.
 *
 *  A pointer is register-wide whatever it points at, which is the fact the `*` test carries.
 *
 *  A WIDTH WIDER THAN A REGISTER IS A READABLE ANSWER, not an absence. `long long` and `s64`/`u64`
 *  answer 64, and that is a different fact from silence even though both refuse a narrowing: an
 *  unreadable spelling MIGHT be wide, where a `long long` IS — which is what a reader asking how
 *  many argument registers a parameter occupies has to be able to tell apart. */
export function declaredWidth(t: ParamType): number | undefined {
  const s = t
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (s.endsWith('*')) {
    return 32;
  }
  const own = /^([su])(8|16|32|64)$/.exec(s);
  if (own) {
    return Number(own[2]);
  }
  // `unsigned`/`signed` alone is `unsigned int`/`signed int`; the signedness itself is not a width.
  const base = s
    .replace(/\b(?:signed|unsigned)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return BASE_WIDTHS.get(base === '' && s !== '' ? 'int' : base);
}

/** Problems with a HAND-WRITTEN prototype table — empty when it is well formed.
 *
 *  `declaredArgLayout` above falls back to the arg-register heuristic on a `params` it cannot read,
 *  which is right when `params` is omitted and silent when it is mistyped: `params: "2"` then decompiles
 *  at a guessed arity, and a misspelled `returnsVoid` does nothing at all. Neither is visible in
 *  the output, so a table that came from outside is checked before it reaches either. */
export function validatePrototypes(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['must be an object mapping a symbol name to its prototype'];
  }
  const problems: string[] = [];
  for (const [sym, proto] of Object.entries(value)) {
    if (typeof proto !== 'object' || proto === null || Array.isArray(proto)) {
      problems.push(`${sym}: must be an object, e.g. {"params": 2}`);
      continue;
    }
    for (const key of Object.keys(proto)) {
      if (key !== 'params' && key !== 'returnsVoid') {
        problems.push(`${sym}: unknown key "${key}" (expected "params" or "returnsVoid")`);
      }
    }
    const { params, returnsVoid } = proto as { params?: unknown; returnsVoid?: unknown };
    if (params !== undefined) {
      const countOk = typeof params === 'number' && Number.isInteger(params) && params >= 0;
      const listOk = Array.isArray(params) && params.every((t) => typeof t === 'string');
      if (!countOk && !listOk) {
        problems.push(`${sym}: "params" must be a non-negative integer or a list of type strings`);
      }
    }
    if (returnsVoid !== undefined && typeof returnsVoid !== 'boolean') {
      problems.push(`${sym}: "returnsVoid" must be a boolean`);
    }
  }
  return problems;
}

/** The C type spelling for one declared parameter/return, or null when the facts do not
 *  determine one. A pointer is `void *` — address-identical to any object pointer, and asmlift
 *  makes every stride explicit — so nothing is guessed about what it points at. A richer spelling
 *  would also be INERT: `declaredWidth` answers 32 for every `*`, and a CALLEE's parameter types
 *  are read for the register widths they sum to alone (test/param-pointee-variation.test.ts). */
function typeSpelling(t: SymbolTypeFacts): ParamType | null {
  if (t.pointer) {
    return 'void *';
  }
  if (t.size === 1 || t.size === 2 || t.size === 4) {
    // A signless 4-byte type is the C89 enum idiom (int); a signless NARROW one has no honest
    // spelling, and the width alone would not fix its load, so it is refused.
    if (t.signed === null) {
      return t.size === 4 ? 's32' : null;
    }
    return `${t.signed ? 's' : 'u'}${t.size * 8}`;
  }
  return null;
}

/**
 * Prototypes the project's own DWARF states, merged UNDER the caller's.
 *
 * A caller-supplied proto always wins: it comes from the user's headers or the benchmark
 * manifest, and it is the thing a real user actually has for the function they are decompiling.
 * The map fills the rest — in practice the CALLEES, since a function still written in assembly
 * has no signature in its project's ELF (see SymbolSignature).
 *
 * Every parameter must spell faithfully or the whole entry is dropped: a partly-typed list would
 * be read for its LENGTH and give the right arity with the wrong widths, which is worse than the
 * arg-register heuristic it would replace.
 */
export function prototypesFromSymbols(symbols: SymbolMap | undefined, base: Prototypes = {}): Prototypes {
  if (!symbols) {
    return base;
  }
  const out: Prototypes = { ...base };
  for (const infos of symbols.values()) {
    for (const info of infos) {
      if (info.kind !== 'code' || !info.signature || out[info.name] !== undefined) {
        continue;
      }
      const params = info.signature.params.map(typeSpelling);
      if (params.some((p) => p === null)) {
        continue;
      }
      out[info.name] = {
        params: params as ParamType[],
        ...(info.signature.returns === null ? { returnsVoid: true } : {}),
      };
    }
  }
  return out;
}
