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
 *  `declaredArgWidths` sums the list's widths into the argument registers the call occupies.
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
   *  every parameter fits in a register, and `declaredArgWidths` is what converts the first into
   *  the second. Omit — or spell a parameter that conversion cannot size — to let the frontend
   *  fall back to its contiguous-arg-register heuristic. */
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
  /** The declared return type, as its C type text — the same vocabulary `params` is written in and
   *  read through the same {@link declaredWidth}, because a return and a parameter spell a width
   *  the same way and two spellings of one vocabulary is where they start to disagree.
   *
   *  WHAT IT BUYS THAT `returnsVoid` CANNOT: how many registers the callee hands BACK. A value
   *  wider than a register comes home in a register PAIR, so after a `bl` the second register holds
   *  the returned high half — a legitimate definition — where for every other callee it holds the
   *  callee's leftovers and reading it is the wrong value `frontend/ssa.ts` refuses. Those two are
   *  the same instructions, so nothing in the assembly tells them apart and the caller must be
   *  TOLD, exactly as `returnsVoid` must be.
   *
   *  A SPELLING THIS CANNOT SIZE IS SILENCE, never a word: `declaredWidth` answers `undefined` for
   *  a project typedef, and the frontend then lifts the call the way it lifts an undeclared one.
   *  Under-declaring stays the safe direction here too — a return wrongly declared 64-bit names a
   *  register the callee really did destroy, which is the defect the refusal exists for.
   *
   *  A HEADER STATES IT AND NOTHING DERIVES IT. `prototypesFromSymbols` does not fill this in:
   *  `typeSpelling` sizes 1, 2 and 4 bytes, so a DWARF-derived entry could only ever spell a return
   *  that already fits a register, where the field changes nothing. */
  returns?: ParamType;
}

/** symbol → prototype. The function under decompilation and its callees share one table. */
export type Prototypes = Record<string, FnProto>;

/** How many argument REGISTERS a list of parameter WIDTHS occupies: a parameter wider than a
 *  machine word travels in a register pair, every other one in a single register.
 *
 *  The rule lives here rather than beside either caller because it has two, and they are the two
 *  vocabularies a declaration is written in. `runtime-helpers.ts` states a compiler's own helper
 *  signatures as widths (`__ashrdi3` is `[64, 32]` — two C parameters, three registers), and
 *  `declaredArgWidths` below reads the same widths off a project's C types. One ABI fact, one
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

/** What a declaration says about the argument registers a call occupies — the width each declared
 *  parameter travels in, in argument order — or `undefined` when it says nothing this can act on.
 *
 *  THREE WAYS TO SAY NOTHING, AND THEY ARE ONE ANSWER. `params` omitted; `params` malformed (a
 *  bare `"u8"` string, the shape the untyped CLI `--proto` JSON admits); and a list holding a
 *  spelling `declaredWidth` cannot read — a project typedef (`bool8`, `Direction`, `TaskFunc`), a
 *  by-value struct, a floating type. The first two are not a reading of the list at all. The third
 *  is a list read to the end that cannot be CONVERTED: a parameter of unknown width occupies one
 *  argument register or two, the choice moves every later argument's home, and nothing a
 *  declaration holds settles it.
 *
 *  SO IT ABSTAINS, AND ABSTAINING IS NEITHER A REFUSAL NOR A GUESS. The caller falls back to its
 *  own contiguous-arg-register scan — exactly what it does for a callee the project never declared
 *  — and that scan names itself a guess: `SsaBuilder.readGuessedArg` ASKS whether a register was
 *  set up, and `finish()` retracts the ones an intervening call destroyed. Refusing instead would
 *  be a function that lifts when told nothing and declines when told more. Returning
 *  one-register-each instead would be a layout nothing could know to be right, and the frontend
 *  would then ASSERT those registers rather than ask for them.
 *
 *  THE MACHINE IS NOT A WITNESS FOR A WIDTH NOBODY STATED, which is the reading this replaces. The
 *  contiguous scan is wrong in both directions and neither is recoverable here. It OVER-counts:
 *  it is read before `frontend/ssa.ts` `narrowToSetupArgs` trims the registers a call sat between,
 *  so `bl __muldi3` leaves r2 and r3 counted as arguments of the NEXT call. It UNDER-counts: an
 *  incoming argument register this function passes straight through has no definition here at all,
 *  so it counts zero — measured on agbcc, `void g(MyU64); void f(MyU64 x){ g(x|1); }` leaves the
 *  high half in r1 untouched and the scan answers 1 for a call the ABI hands a pair. An equality
 *  between that scan and the one-register-each reading is therefore as likely to be a miscounted
 *  pair as a confirmation of anything, and a witness that cannot fail is not a witness.
 *
 *  The COUNT form is the user's word for argument REGISTERS and says so at its declaration, so it
 *  expands to that many words and can never abstain. It is the way past a header this cannot size. */
export function declaredArgWidths(p: FnProto | undefined): readonly number[] | undefined {
  if (typeof p?.params === 'number') {
    return Array.from({ length: p.params }, () => 32);
  }
  if (!Array.isArray(p?.params)) {
    return undefined;
  }
  const widths: number[] = [];
  for (const t of p.params) {
    const w = declaredWidth(t);
    if (w === undefined) {
      return undefined;
    }
    widths.push(w);
  }
  return widths;
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
 *  caller can act on. Every other reader of this table — `declaredArgWidths`, and `declaredCall`
 *  through it — answers "nothing is declared" for such an entry, and so does this. */
export function returnsWithoutHiddenPointer(callee: string, prototypes: Prototypes): boolean {
  // Nothing at all, a value in registers, or a spelling nobody here can size — the last of which is
  // the only one that leaves the hidden pointer open. A pair is `declaredWidth` 64 and still
  // travels in registers, so a width wider than a word is an answer here and not an overflow.
  const travelsInRegisters = (spelling: string): boolean => {
    const t = spelling.trim();
    return t === 'void' || declaredWidth(t) !== undefined;
  };
  const own = Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined;
  if (own?.returnsVoid === true) {
    return true;
  }
  // A PROJECT'S OWN `returns` ANSWERS THIS THROUGH THE SAME READING A STANDARD SIGNATURE'S DOES,
  // and it ranks above the table for the same reason `declaredCall` ranks a re-declaration above
  // one: a project that spells the return has told you about the function it is building.
  if (own?.returns !== undefined) {
    return travelsInRegisters(own.returns);
  }
  return Object.hasOwn(STANDARD_SIGNATURES, callee) && travelsInRegisters(STANDARD_SIGNATURES[callee].returns);
}

/** Bit width per C89 base type on every target asmlift lifts (all ILP32 with a 64-bit `long long`).
 *  `long` is 32 here and would not be on an LP64 host, so it is a target fact rather than a
 *  language one.
 *
 *  THE FLOATING TYPES ARE ABSENT, and that is a measured ABI fact rather than a hole in the table.
 *  How many argument registers a `float` or a `double` occupies is a property of the TARGET and
 *  not of the spelling: `target.ts` declares `hwFloat` on three of its four descriptions, and on a
 *  PowerPC EABI with an FPU a floating argument travels in f1..f8 and occupies NO general argument
 *  register at all — compiled with the benchmark's own mwcc, `void g(int, double); void fa(int a,
 *  double b){ g(a,b); }` sets up r3 and nothing else. The one consumer that lays out argument
 *  registers would read a width here as "one register" or "a pair", and on those targets both are
 *  wrong; `long double` is absent for the neighbouring reason, 8 bytes on these ABIs and 10 or 16
 *  on others with nothing having measured which one a target's compiler means. A spelling this
 *  table does not hold costs a caller nothing it was owed: `declaredArgWidths` abstains and the
 *  machine's own guess stands, which is what the declaration replaced.
 *
 *  THE FIXED-WIDTH NAMES ARE FIXED BY THE STANDARD, not by a project, which is the same reason
 *  `STANDARD_SIGNATURES` exists: `int32_t` is 32 bits wherever it compiles at all, and reading it
 *  as "a project typedef" put `size_t` and `int64_t` — the spellings a header extraction produces
 *  most — into the population that cannot be sized. */
const BASE_WIDTHS: ReadonlyMap<string, number> = new Map([
  ['char', 8],
  ['short', 16],
  ['short int', 16],
  ['int', 32],
  ['long', 32],
  ['long int', 32],
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
 *  read — a project typedef, a by-value struct, a floating type. UNDEFINED IS "NO OPINION", never
 *  "wide": a consumer treats a width it can read as authority and a width it cannot as absence, so
 *  an unrecognized spelling leaves the asm's own inference standing. Its two readers differ in how
 *  far the absence spreads, and that is a property of what they are asking rather than of this
 *  answer: raise/paramwidth.ts abstains for that one parameter, and `declaredArgWidths` abstains
 *  for the whole list, because one unknown width moves every later argument's home.
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

/** The bit width a declaration states its callee RETURNS, or `undefined` when it states nothing a
 *  reader can size — `returns` omitted, or a spelling {@link declaredWidth} does not read.
 *
 *  `returnsVoid` is not consulted and must not be: a void return is not a width of zero, it is the
 *  absence of a returned value, and the one consumer here asks how many registers come back with a
 *  value in them. `validatePrototypes` is what keeps the two from contradicting each other.
 *
 *  A DESIGNATED SAFE READER, the way `declaredArgWidths` is one: a frontend indexes `prototypes` by a
 *  callee's name, and a callee named `toString` reads a `Function` off `Object.prototype` — which
 *  has no `returns`, so it answers here what an undeclared callee answers. */
export function declaredReturnWidth(p: FnProto | undefined): number | undefined {
  return p?.returns === undefined ? undefined : declaredWidth(p.returns);
}

/** Problems with a HAND-WRITTEN prototype table — empty when it is well formed.
 *
 *  `declaredArgWidths` above falls back to the arg-register heuristic on a `params` it cannot
 *  read, which is right when `params` is omitted and silent when it is mistyped: `params: "2"` then
 *  decompiles at a guessed arity, and a misspelled `returnsVoid` does nothing at all. Neither is
 *  visible in the output, so a table that came from outside is checked before it reaches either. */
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
      if (key !== 'params' && key !== 'returnsVoid' && key !== 'returns') {
        problems.push(`${sym}: unknown key "${key}" (expected "params", "returnsVoid" or "returns")`);
      }
    }
    const { params, returnsVoid, returns } = proto as {
      params?: unknown;
      returnsVoid?: unknown;
      returns?: unknown;
    };
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
    if (returns !== undefined && typeof returns !== 'string') {
      problems.push(`${sym}: "returns" must be a type string, e.g. "long long"`);
    }
    // The two return keys are one fact spelled two ways, and a table that says both is a table
    // whose author meant one of them. Neither reading is safe to pick: honouring `returnsVoid`
    // would silently drop a pair the other key says comes back, and honouring `returns` would
    // license an out-parameter frame the `void` was there to rule out.
    if (returnsVoid === true && typeof returns === 'string' && returns.trim() !== 'void') {
      problems.push(`${sym}: "returnsVoid" is true but "returns" says "${returns}"`);
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
