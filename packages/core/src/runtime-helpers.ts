// asmlift — the COMPILER RUNTIME HELPERS a target's codegen calls, and what each one computes.
//
// A compiler lowers an operation its ISA cannot do to a call into its own runtime: agbcc emits
// `bl __divsi3` for `a / b` because ARMv4T has no divider, and `bl __muldi3` for a 64-bit multiply
// because ARMv4T has no 64-bit anything. Two things are needed to recover either, and they are
// different things:
//   • the SIGNATURE, so the call's arguments are recovered at all (the frontend's arity lookup
//     falls back to this behind any caller-supplied prototype);
//   • the OPERATION, so the call is rewritten to the op it computes and the structurer prints
//     `a / b` rather than `__divsi3(a, b)`.
//
// AN ENTRY HERE IS ALSO A REFUSAL. Where no recogniser folds a call to a name in this table,
// `raise/widehelpers.ts` turns it into a gap instead of letting the backend spell it. Re-emitting
// the compiler's own runtime call as source is not a recovery — it is the one shape that MATCHES
// for free, because a compiler handed `__div2i(a, b)` emits the `bl __div2i` it was lifted from.
// A helper nothing here can fold therefore declines; a helper nothing here NAMES still passes
// through, which is what makes adding a name a decision rather than a note.
//
// WHICH HELPERS A COMPILER EMITS IS A COMPILER FACT, so the table hangs off `TargetDescription`
// rather than off a pass. `proto.ts` holds signatures fixed by the C STANDARD, which a runtime
// helper is precisely not — agbcc calls `__muldi3`, CodeWarrior calls `__div2i`, IDO calls
// `__ll_mul`, and nothing about the C standard predicts any of them. A scan that assumes one
// family reports ZERO on the others.
//
// `params` is a list of C parameter WIDTHS in bits, not a word count, and the difference is the
// whole point of the field: `__ashrdi3` takes a 64-bit value and a 32-bit count — two C parameters
// occupying THREE argument registers. A stated width is read two ways and both conversions live
// here: `wordsOf` counts the argument REGISTERS the list occupies, and `irWidthOf` gives the IR
// width one parameter ARRIVES at once a frontend has paired those registers up.
import { type Opcode, WIDE_BITS } from './ir/opcodes';
import { type IrType, intWidth } from './ir/types';
import type { Prototypes } from './proto';

export interface RuntimeHelper {
  /** the op this helper computes, where asmlift has one. Absent for a helper it can only SIGN. */
  op?: Opcode;
  /** each C parameter's width in bits, in argument order. */
  params: readonly number[];
  /** the returned width: 0 (void), 32, or 64 (a register PAIR). */
  returns: 0 | 32 | 64;
}

/** How many argument REGISTERS a parameter list occupies. `protoArity` counts words and a C
 *  parameter list does not, so the two vocabularies meet here and nowhere else. */
export function wordsOf(params: readonly number[]): number {
  return params.reduce((n, w) => n + (w > 32 ? 2 : 1), 0);
}

/** The entry a target's table holds for `callee`, or undefined. THE ONE READER, because the table
 *  is an object literal and a C function may be named `toString`: a bare index or an `in` answers
 *  with a member of `Object.prototype` for eight names, and what each caller then does with that
 *  `Function` differs — one reads `params` off it and throws a TypeError, another refuses while
 *  naming a runtime helper the target does not have. `Object.hasOwn` is stated here so that no
 *  caller can be the one that forgot it. (`proto.ts` states the same rule for the prototype
 *  tables, which are read the same way for the same reason.) */
export function lookupHelper(
  table: Readonly<Record<string, RuntimeHelper>> | undefined,
  callee: string,
): RuntimeHelper | undefined {
  return table && Object.hasOwn(table, callee) ? table[callee] : undefined;
}

/** The IR width a C parameter of `bits` arrives at: one 64-bit value for anything wider than a
 *  register, because a frontend that reads such a parameter fuses its registers into a single
 *  value; a machine word for everything else, whatever narrower width the C type carries. The
 *  counterpart of `wordsOf` — same threshold, different vocabulary. */
export function irWidthOf(bits: number): number {
  return bits > 32 ? WIDE_BITS : 32;
}

/** Whether a call ARRIVED in the shape this helper's signature states: one result at the returned
 *  width, and each operand at the IR width its C parameter carries.
 *
 *  A COUNT IS NOT A WIDTH, and the gap between them is where a 64-bit operation gets invented over
 *  two 32-bit words. Two ordinary shapes reach a fold with the right operand count and the wrong
 *  contents: a call whose arity came off a caller-supplied prototype rather than off this table, so
 *  no frontend ever built the pair; and a call on a target whose frontend does not pair registers
 *  at all, where an argument register that is not live at the call gets trimmed and the survivors
 *  happen to number what the table states. Either one folded publishes an operation over one half
 *  of each value, at exit 0 and with no gap — so the pair construction IS the precondition, and a
 *  shape that lacks it belongs to `refuseUnmodelledHelpers`.
 *
 *  AN OPERAND THAT CARRIES NO INTEGER WIDTH REFUSES, which is `intWidth` returning null for a
 *  pointer or an aggregate. `ir/verify.ts` reads that same null as "does not take part in the width
 *  rule"; here it means there is no width to check the claim against, and a fold may not proceed on
 *  a claim it cannot check.
 *
 *  A `returns: 0` entry can never satisfy this, because no result carries width 0. A void helper
 *  computing on a 64-bit value is a shape there is no operation to fold it into. */
export function arrivesAsDeclared(
  helper: RuntimeHelper,
  operands: readonly IrType[],
  results: readonly IrType[],
): boolean {
  if (results.length !== 1 || intWidth(results[0]) !== helper.returns) {
    return false;
  }
  return (
    operands.length === helper.params.length && operands.every((t, i) => intWidth(t) === irWidthOf(helper.params[i]))
  );
}

/** Whether a helper computes on a value wider than a register — the ones the 64-bit representation
 *  is for, and the ones no hardware capability can make unnecessary. */
export function isWideHelper(h: RuntimeHelper): boolean {
  return h.returns > 32 || h.params.some((w) => w > 32);
}

/** Signatures for a target's helpers, in the WORD arity the frontend's prototype lookup speaks.
 *  Consumed behind any caller-supplied prototype — the project's own headers win. */
export function helperPrototypes(table: Readonly<Record<string, RuntimeHelper>> | undefined): Prototypes {
  return Object.fromEntries(Object.entries(table ?? {}).map(([sym, h]) => [sym, { params: wordsOf(h.params) }]));
}

/** agbcc's runtime, which is GCC 2.9's libgcc for ARM.
 *
 *  THE 64-BIT MULTIPLY IS SIGNEDNESS-BLIND, and that is a fact about this libgcc rather than a
 *  simplification here: `optabs.c` initialises the only integer multiply libfunc from the MODE
 *  alone, and `expmed.c` routes every `MULT` through it whatever the operands' signedness, so
 *  `__umuldi3` does not exist and both spellings emit `bl __muldi3`. Signedness comes from the
 *  operand SET-UP instead — `asr rN,rM,#31` per half for signed, `mov rN,#0` for unsigned. The
 *  DIVISIONS do split, and their entries say so.
 *
 *  THE SOFT-FLOAT HELPERS ARE NOT HERE, deliberately. asmlift has no float model to fold one into,
 *  so naming `__addsf3` would decline every function that adds two floats where today it publishes
 *  `__addsf3()` — a pass-through, and one that scores against a call the machine made with two
 *  arguments. That is a trade to make with a measurement of the float rows, not on the way past. */
export const AGBCC_RUNTIME_HELPERS: Readonly<Record<string, RuntimeHelper>> = {
  // 32-bit software division — the ops `raise/softdiv.ts` rewrites, gated on the target having no
  // hardware divider, which is what those four are about.
  __divsi3: { op: 'sdiv', params: [32, 32], returns: 32 },
  __udivsi3: { op: 'udiv', params: [32, 32], returns: 32 },
  __modsi3: { op: 'smod', params: [32, 32], returns: 32 },
  __umodsi3: { op: 'umod', params: [32, 32], returns: 32 },
  // 64-bit arithmetic. NOT gated on a hardware capability: no ISA this repo targets has 64-bit
  // integer arithmetic at all, so a call here is software on every one of them.
  __muldi3: { op: 'mul', params: [64, 64], returns: 64 },
  __divdi3: { op: 'sdiv', params: [64, 64], returns: 64 },
  __udivdi3: { op: 'udiv', params: [64, 64], returns: 64 },
  __moddi3: { op: 'smod', params: [64, 64], returns: 64 },
  __umoddi3: { op: 'umod', params: [64, 64], returns: 64 },
  __ashldi3: { op: 'shl', params: [64, 32], returns: 64 },
  __ashrdi3: { op: 'shr_s', params: [64, 32], returns: 64 },
  __lshrdi3: { op: 'shr_u', params: [64, 32], returns: 64 },
  __negdi2: { op: 'neg', params: [64], returns: 64 },
};

/** CodeWarrior's PowerPC runtime (`Runtime.PPCEABI.H`), as the GameCube projects vendor it.
 *
 *  A DIFFERENT FAMILY ENTIRELY, which is the reason this table is per target and not per repo: a
 *  scan for `__*di3` reports zero on every one of these. These seven are the integer set, agreed
 *  on by all three PPC checkouts' own vendored `runtime.c` (each at a different path), where every
 *  one is an `ASM` function whose body states its register contract: `__div2i` takes r3:r4 and
 *  r5:r6 and returns r3:r4, `__shl2i` takes r3:r4 and a count in r5.
 *
 *  ONE SHIFT LEFT AND TWO RIGHT, which is the same signedness rule agbcc's `__ashldi3` follows:
 *  the bits a left shift brings in are zero whatever the operand is, so there is nothing for a
 *  `__shl2u` to do differently.
 *
 *  NO MULTIPLY, and that is a fact about this compiler rather than a hole here: mwcc open-codes a
 *  64-bit multiply. `synthetic:llmul:mwcc_242_81` is the evidence and it is in the corpus — its
 *  target is 28 bytes of `mulhwu` and two `mullw` with no relocation at all, against 32 bytes and
 *  an `R_PPC_REL24` to `__div2i` for `lldivs` beside it. The float and decimal helpers of the same
 *  runtime (`__cvt_sll_flt`, `__num2dec`) are left out for the reason the agbcc table leaves out
 *  its own. */
export const PPC_MWCC_RUNTIME_HELPERS: Readonly<Record<string, RuntimeHelper>> = {
  __div2i: { op: 'sdiv', params: [64, 64], returns: 64 },
  __div2u: { op: 'udiv', params: [64, 64], returns: 64 },
  __mod2i: { op: 'smod', params: [64, 64], returns: 64 },
  __mod2u: { op: 'umod', params: [64, 64], returns: 64 },
  __shl2i: { op: 'shl', params: [64, 32], returns: 64 },
  __shr2i: { op: 'shr_s', params: [64, 32], returns: 64 },
  __shr2u: { op: 'shr_u', params: [64, 32], returns: 64 },
};
