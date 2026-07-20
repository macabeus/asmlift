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
  sdiv: { operands: 'variadic', results: 1 },
  udiv: { operands: 2, results: 1 },
  smod: { operands: 2, results: 1 },
  umod: { operands: 2, results: 1 },
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
  load: { operands: 1, results: 1, requiredAttrs: ['off', 'width', 'signed'] },
  store: { operands: 2, results: 0, requiredAttrs: ['off', 'width'], effects: true },
  // Typed element-scaled array access. Unlike load/store's constant `off`, these carry an
  // explicit runtime `index` operand plus the `elemSize` the index scales by, so the base is a
  // genuine `elem *` and no byte-offset arithmetic leaks into the emitted source. Produced by
  // the array-recognition legalization pass (raise/arrays.ts).
  aload: { operands: 2, results: 1, requiredAttrs: ['elemSize', 'signed'] }, // aload base, index
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
  // --- black-box escape hatch (keeps lifting total) ---
  opaque: { operands: 'variadic', results: 1 },
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

/** Ops with an observable side effect — the derived view raise/shortcircuit.ts consumes. */
export const EFFECTFUL_OPS: ReadonlySet<string> = new Set(
  (Object.keys(OPCODES) as Opcode[]).filter((k) => (OPCODES[k] as OpSig).effects),
);

/** May a dead result of this opcode be deleted? Registered, no observable effects, not control
 *  flow. Deliberately includes `opaque` — a dead opaque vanishing is designed behavior. */
export function isDceSafe(opcode: string): boolean {
  const sig = opSig(opcode);
  return !!sig && !sig.effects && !sig.terminator;
}
