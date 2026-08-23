// asmlift IR — the opcode signature registry.
//
// A closed table of signatures. The verifier and the parser are driven by it, so a mnemonic
// typo or an operand-count mismatch fails at its source instead of surfacing as wrong output
// several stages later.

export interface OpSig {
  /** exact operand count, or "variadic" (e.g. ret takes 0 or 1). */
  operands: number | 'variadic';
  results: number;
  terminator?: boolean;
  /** required successor count (terminators only), or "variadic" (switch_br: N cases + 1 default). */
  successors?: number | 'variadic';
  requiredAttrs?: readonly string[];
  /** observable side effect (memory write / call): never deleted when dead, never hoisted into
   *  an unconditional position. THE one effect vocabulary — DCE (pattern/engine.ts) and the
   *  short-circuit hoist guard (raise/shortcircuit.ts) both derive from this flag. */
  effects?: boolean;
  /** reads memory. Deletable when dead — nothing observes a load nobody reads — but NOT movable:
   *  a load answers whichever stores ran before it, so crossing one changes the value it yields.
   *  The two questions are separate flags because a load answers them differently. */
  reads?: boolean;
  /** may fault on operands the program never actually gave it — the integer divides, on a zero
   *  divisor. Deletable and movable, but not safe to run on a path that did not run it. */
  traps?: boolean;
}

export const OPCODES = {
  // --- pure integer ops ---
  const: { operands: 0, results: 1, requiredAttrs: ['value'] },
  add: { operands: 2, results: 1 },
  sub: { operands: 2, results: 1 },
  mul: { operands: 2, results: 1 },
  // High word of the 32x32->64 product: `mulh` signed, `mulhu` unsigned. TRANSIENT — emitted by the
  // frontend (MIPS `mfhi` after `mult`/`multu`; PPC `mulhw`/`mulhwu`) and rewritten away by the
  // magic-division recognizer (raise/magicdiv.ts) before recovery. They carry no C spelling: a `mulh`
  // that survives to the structurer hits the `"?"` loud-fail (like a bare `clz`) — never printed.
  // Effect-free (no `effects` flag) so DCE reaps a dead one.
  mulh: { operands: 2, results: 1 },
  mulhu: { operands: 2, results: 1 },
  neg: { operands: 1, results: 1 },
  not: { operands: 1, results: 1 }, // bitwise complement (`mvn`) → ~x
  or: { operands: 2, results: 1 },
  and: { operands: 2, results: 1 },
  xor: { operands: 2, results: 1 },
  // shifts take EITHER 1 operand + `imm` attr (immediate: `lsl rD,rS,#n`) OR 2 operands
  // (register: `lsl rD,rS,rN`). Variadic so both forms verify; the structurer branches on
  // operand count (structure.ts) to print `x << n` vs `x << y`.
  shl: { operands: 'variadic', results: 1 },
  shr_u: { operands: 'variadic', results: 1 },
  shr_s: { operands: 'variadic', results: 1 },
  // Rotates, variadic like the shifts (immediate: PPC `rotlwi`; register: Thumb `ror`, PPC
  // `rotlw`). Lowered by the structurer to the C rotate idiom (`x >> n | x << (32 - n)` /
  // mirrored for rotl), which agbcc AND mwcc compile back to the single rotate instruction —
  // byte-exact round-trip verified both ways before these ops landed.
  rotr: { operands: 'variadic', results: 1 },
  rotl: { operands: 'variadic', results: 1 },
  // Count leading zeros (PPC `cntlzw`). TRANSIENT like mulh: the cntlzw-equality pattern
  // (pattern/engine.ts CNTLZW_EQ0, mwcc-gated) folds `clz(x) >> 5` → `x == 0` (mwcc's spelling
  // of ==0 and `!`); a bare clz that survives has no C spelling → the structurer's loud gap.
  clz: { operands: 1, results: 1 },
  // width-narrowing casts (S4): `zext`/`sext` take one operand and a `width` attr (8/16), and
  // widen back to 32 with zero/sign extension — the recovered form of a compiler's byte/half
  // extend idiom (`(x<<24)>>24` etc.). The backend prints them as a C cast `(u8)x` / `(s8)x`;
  // recompiling the cast reproduces the extend sequence on the compilers that emit it. Produced
  // by the cast idiom patterns (pattern/engine.ts), gated to those compilers.
  zext: { operands: 1, results: 1, requiredAttrs: ['width'] },
  sext: { operands: 1, results: 1, requiredAttrs: ['width'] },
  // Division/remainder. `sdiv` is variadic like the shifts: the immediate form (1 operand +
  // `imm` attr) is the strength-reduced constant divisor an idiom folds to (`sdiv X {imm=2}`);
  // the register form (2 operands) is a real hardware divide (`div`/`divu` + `mflo`/`mfhi` on an
  // ISA with `capabilities.hwDivide`); the structurer branches on count. `udiv`/`smod`/`umod`
  // are 2-operand only. `sdiv`/`udiv` = quotient, `smod`/`umod` = remainder; signedness lives in
  // the op (recovery types the operands to match), so the backend picks `/`/`%` over
  // correctly-typed operands.
  sdiv: { operands: 'variadic', results: 1, traps: true },
  udiv: { operands: 2, results: 1, traps: true },
  smod: { operands: 2, results: 1, traps: true },
  umod: { operands: 2, results: 1, traps: true },
  // signed/equality comparisons (result is a boolean-valued u32)
  icmp_slt: { operands: 2, results: 1 },
  icmp_sle: { operands: 2, results: 1 },
  icmp_sgt: { operands: 2, results: 1 },
  icmp_sge: { operands: 2, results: 1 },
  // unsigned comparisons (MIPS `sltu`/`sltiu`; the operator is the same `<`, unsignedness lives
  // in the operand TYPES — recover types their operands u32, so the backend emits `sltu`).
  icmp_ult: { operands: 2, results: 1 },
  icmp_ule: { operands: 2, results: 1 },
  icmp_ugt: { operands: 2, results: 1 },
  icmp_uge: { operands: 2, results: 1 },
  icmp_eq: { operands: 2, results: 1 },
  icmp_ne: { operands: 2, results: 1 },
  // Short-circuit logical connectives (`&&`/`||`), produced by the boolean short-circuit recognizer
  // (raise/shortcircuit.ts) from a value-merge diamond. Both operands are boolean-valued (0/1); the
  // result is the 0/1 connective. Distinct from bitwise `and`/`or` — the backend prints `&&`/`||`,
  // which recompiles to the branch diamond the source emitted.
  logic_and: { operands: 2, results: 1 },
  logic_or: { operands: 2, results: 1 },
  // --- memory ---
  load: { operands: 1, results: 1, requiredAttrs: ['off', 'width', 'signed'], reads: true },
  store: { operands: 2, results: 0, requiredAttrs: ['off', 'width'], effects: true },
  // Typed element-scaled array access. Unlike load/store's constant `off`, these carry an
  // explicit runtime `index` operand plus the `elemSize` the index scales by, so the base is a
  // genuine `elem *` and no byte-offset arithmetic leaks into the emitted source. Produced by
  // the array-recognition legalization pass (raise/arrays.ts).
  aload: { operands: 2, results: 1, requiredAttrs: ['elemSize', 'signed'], reads: true }, // aload base, index
  astore: { operands: 3, results: 0, requiredAttrs: ['elemSize'], effects: true }, // astore base, index, value
  // --- call: operands are the argument values (r0..), result is the return value (r0),
  //     `target` attr is the callee symbol. Caller-saved clobbering is implicit. ---
  call: { operands: 'variadic', results: 1, requiredAttrs: ['target'], effects: true },
  // The ADDRESS of a named global (agbcc `ldr rD, .Lpool` where the pool word is `.word gSym`).
  // Pure, 0 operands. Globals come from the project headers, so they are referenced by name, never
  // declared as locals. The structurer lowers it three ways (see scalarGlobals in structure.ts):
  //   - a load/store through an off-0 SCALAR gaddr → a bare global `gSym` / `gSym = v`;
  //   - an indexed or non-zero-offset AGGREGATE access → the address-cast `((T *)&gSym)[i]`;
  //   - any other use (e.g. `&gSym` passed to a call) → the `{k:'addr'}` L3 node, printed `&gSym`.
  gaddr: { operands: 0, results: 1, requiredAttrs: ['sym'] },
  // The address of a FRAME-LOCAL object — gaddr's local twin, for the address-taken stack local
  // (`mov rD, sp` feeding a DMA register or a callee). `off` is the byte offset inside the frame's
  // reserved local area; the Thumb frontend's post-lift audit stamps `name`/`width`/`signed` after
  // proving every access agrees, and the structurer declares the local and renders `&name` exactly
  // as it renders a gaddr's `&sym`. Operand-free and pure, so GVN numbers it like gaddr and a dead
  // one is reaped.
  // `width`/`signed` are stamped by the frontend's frame-object AUDIT — requiring them makes
  // "the audit ran" a verifier-checkable fact instead of a convention: a frontend that emits a
  // laddr and skips the audit fails verify loudly instead of rendering `&undefined`.
  laddr: { operands: 0, results: 1, requiredAttrs: ['off', 'width', 'signed'] },
  // An UNDEFINED value: a read of storage that carries no INPUT — nothing was entitled to hand this
  // function a value there, and none of its own stores reached it on this path. Deliberately NOT
  // "storage nobody could have written": a callee-saved register holds the CALLER's value at entry,
  // which is exactly what the prologue pushes it for, and the read is undefined all the same
  // because the ABI gives no caller a way to pass an argument in one. The C declared a local with
  // no initialiser and assigned it only inside some arms of a conditional or `switch` (a `switch`
  // with no `default` being the commonest source), so the read is legal to compile and the compiler
  // emitted the unassigned path faithfully.
  //
  // "No input" is established differently in the two places a local lives, and `frontend/ssa.ts`
  // (LiveInModel) is where each is declared:
  //   • a FRAME SLOT is storage whose only writer is this function's own stores — SOLE WRITER, not
  //     merely "owns the storage", because a frame the function owns can still be written by
  //     someone else once an address into it escapes to a callee, which fills a wider object than
  //     any in-function access reveals. Whoever mints one owes the retraction on escape
  //     (frontend/thumb.ts, after the frame-object audit).
  //   • a REGISTER the ABI does not pass arguments in cannot carry a value a caller handed over,
  //     and has no address for anything else to reach it by, so there is nothing to retract.
  //
  // An opcode rather than a live-in because Braun's construction resolves a def-less read to a
  // live-in, and a live-in of the entry block is a PARAMETER — right for an argument register, a
  // fabricated argument for anything else.
  //
  // Operand-free and pure like `laddr`, and out of raise/gvn.ts's NUMBERABLE set — where numbering
  // it would be VACUOUS rather than harmful, since two undefs in one function always carry
  // different keys. "Same key, therefore same value" is empty for a value that has none.
  //
  // `key` names the storage (`sp@0`, `r4`); the structurer reads it to name the local
  // (`uninit_sp0`) and emits NO assignment — that absence is the recovery, and an edge argument
  // that is one emits no copy either (structure.ts undefCarriesNothing).
  undef: { operands: 0, results: 1, requiredAttrs: ['key'] },
  // --- black-box escape hatch (keeps lifting total) ---
  // `effects: true`: an instruction asmlift could not model may do anything — write memory, trap,
  // touch a system register — and `results[0]` is only the part we can name. So a dead `opaque` is
  // no more reapable than a dead `call`.
  opaque: { operands: 'variadic', results: 1, effects: true },
  // --- terminators ---
  ret: { operands: 'variadic', results: 0, terminator: true, successors: 0 },
  br: { operands: 0, results: 0, terminator: true, successors: 1 },
  cond_br: { operands: 1, results: 0, terminator: true, successors: 2 },
  // Many-way switch dispatch (Regime B, jump table). The single operand is the scrutinee;
  // successors are the N case blocks followed by the default block (the LAST successor);
  // `cases` is the index-aligned list of the first N successors' case values.
  switch_br: { operands: 1, results: 0, terminator: true, successors: 'variadic', requiredAttrs: ['cases'] },
} as const satisfies Record<string, OpSig>;

/** The registered opcode vocabulary as a TYPE — `mkOp("add", …)` compiles, `mkOp("addd", …)`
 *  does not. */
export type Opcode = keyof typeof OPCODES;

/** Signature lookup by RUNTIME opcode string (Op.opcode is a plain string — IR consumers switch
 *  on it); undefined for an unregistered opcode. */
export function opSig(opcode: string): OpSig | undefined {
  return (OPCODES as Record<string, OpSig | undefined>)[opcode];
}

/** The comparison whose result is the logical NEGATION of each `icmp_*` — `!(a < b)` is `a >= b`.
 *
 *  Unlike EFFECTFUL_OPS/HOIST_UNSAFE_OPS below, this is AUTHORED data seated beside the registry,
 *  not a view derived from it: nothing in `OPCODES` states which comparison opposes which. What is
 *  derived is its SYMMETRY — the five involutive pairs are expanded both ways, so `neg(neg(c)) === c`
 *  holds by construction (a hand-written map is one typo away from breaking it, and the symptom is a
 *  plainly inverted condition in the emitted C). Completeness against the icmp family is the part
 *  construction cannot give, so a test asserts it (test/pattern.test.ts) — an eleventh comparison
 *  added to `OPCODES` would otherwise degrade three consumers three different ways.
 *
 *  It lives here for the reason HOIST_UNSAFE_OPS does: every consumer that has to say "the opposite
 *  of this compare" reads THIS one — the MIPS frontend's `slt …; beqz` branch-when-false fold, the
 *  short-circuit recognizer's diamond negation, and the idiom layer's `cmp ^ 1` fold — so they
 *  cannot drift apart the way inline copies did. Two adjacent facts worth knowing: raise/
 *  shortcircuit.ts derives its `BOOL_OPS` from these keys (asserting negatable-icmp == boolean-op,
 *  true today), and l3/ast.ts `NEGATE_REL` is the SAME relation over the neutral L3 operator
 *  vocabulary — deliberately separate, because signedness lives in the operand types there, so the
 *  two tables are not candidates for further consolidation. */
const ICMP_NEGATION_PAIRS: readonly (readonly [Opcode, Opcode])[] = [
  ['icmp_eq', 'icmp_ne'],
  ['icmp_slt', 'icmp_sge'],
  ['icmp_sgt', 'icmp_sle'],
  ['icmp_ult', 'icmp_uge'],
  ['icmp_ugt', 'icmp_ule'],
];
export const NEGATED_ICMP: Readonly<Record<string, Opcode>> = Object.fromEntries(
  ICMP_NEGATION_PAIRS.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]),
);

/** Ops with an observable side effect: the flag on the signature, derived rather than re-listed.
 *  Consumed by `isDceSafe`, by `HOIST_UNSAFE_OPS` below, by structure.ts's `sideEffects` walk (an
 *  effectful op whose result nobody reads is still an execution), by analysis.ts's memory-write
 *  barrier, and by divpow2's bias block, which is DELETED rather than moved. Those last three each
 *  carried a hand-written copy of this membership, which is how the models drifted apart before. */
export const EFFECTFUL_OPS: ReadonlySet<string> = new Set(
  (Object.keys(OPCODES) as Opcode[]).filter((k) => (OPCODES[k] as OpSig).effects),
);

/** Ops that may not be SPECULATED — run on a path that did not run them before. Identical to
 *  `EFFECTFUL_OPS`, and kept as its own name because its call sites ask the speculation question
 *  rather than the deletion one.
 *
 *  A memory read is deliberately absent, and that is the one entry worth arguing: its only consumer
 *  is raise/shortcircuit.ts, which hoists an arm's body into the block above, and the structurer
 *  inlines an unnamed value back into the `&&`/`||` right-hand side, where C's own short-circuit
 *  re-guards it. Adding the two reads
 *  here costs three byte-matches (kleod:UpdateHUDCounterDisplay, synthetic:breakloop,
 *  synthetic:strcmp1), so the argument is load-bearing rather than merely plausible.
 *
 *  KNOWN GAP: the trapping divides are absent too, and there the re-guard argument does NOT carry
 *  — a hoisted `sdiv` that the structurer NAMES becomes an unconditional statement. Left as it is
 *  because closing it is a separate change with its own measurement; `REEVAL_UNSAFE_OPS` does
 *  refuse them, so the pre-update sink is not exposed to it. */
export const HOIST_UNSAFE_OPS: ReadonlySet<string> = EFFECTFUL_OPS;

/** Ops whose answer depends on WHERE they run: an effect (its order against other effects is
 *  observable) or a memory read (it answers whichever stores ran before it). The question a pass
 *  asks before moving a computation to another point on the SAME path. */
export const ORDER_SENSITIVE_OPS: ReadonlySet<string> = new Set(
  (Object.keys(OPCODES) as Opcode[]).filter((k) => {
    const sig = OPCODES[k] as OpSig;
    return sig.effects || sig.reads;
  }),
);

/** Ops that may not be RE-EVALUATED at another program point — order-sensitive, or trapping. The
 *  trap half is what separates this from `ORDER_SENSITIVE_OPS`: it only matters when the new point
 *  can be reached on a path the old one was not, so a consumer that merely re-orders on one path
 *  wants the smaller set. Both are needed because the two consumers differ on exactly the divides:
 *  a collapsed switch re-renders a test block's ops AT THEIR USES, and every use is dominated by
 *  the def, so it evaluates them on a SUBSET of the original paths — a narrowing, never a
 *  speculation. */
export const REEVAL_UNSAFE_OPS: ReadonlySet<string> = new Set(
  (Object.keys(OPCODES) as Opcode[]).filter((k) => {
    const sig = OPCODES[k] as OpSig;
    return sig.effects || sig.reads || sig.traps;
  }),
);

/** May a dead result of this opcode be deleted? Registered, no observable effects, not control
 *  flow. `opaque` is excluded via its `effects` flag — see the note on its signature. */
export function isDceSafe(opcode: string): boolean {
  const sig = opSig(opcode);
  return !!sig && !sig.effects && !sig.terminator;
}
