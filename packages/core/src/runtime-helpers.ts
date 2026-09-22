// asmlift — the COMPILER RUNTIME HELPERS a target's codegen calls, and what each one computes.
//
// A compiler lowers an operation its ISA cannot do to a call into its own runtime: agbcc emits
// `bl __divsi3` for `a / b` because ARMv4T has no divider, and `bl __muldi3` for a 64-bit multiply
// because ARMv4T has no 64-bit anything. Two things are needed to recover either, and they are
// different things:
//   • the SIGNATURE, so the call's arguments are recovered at all (the frontend's arity lookup
//     falls back to this behind any caller-supplied prototype);
//   • the OPERATION, so the call is rewritten to the op it computes and the structurer prints
//     `a / b` rather than the uncompilable `__divsi3(a, b)`.
// The second is optional: a soft-FLOAT helper has a signature here and no `op`, because asmlift has
// no float model to rewrite it into, and the signature alone is what stops its arguments being lost.
//
// WHICH HELPERS A COMPILER EMITS IS A COMPILER FACT, so the table hangs off `TargetDescription`
// rather than off a pass. `proto.ts` holds signatures fixed by the C STANDARD, which a runtime
// helper is precisely not — agbcc calls `__muldi3`, CodeWarrior calls `__div2i`, IDO calls
// `__ll_mul`, and nothing about the C standard predicts any of them. A scan that assumes one
// family reports ZERO on the others.
//
// `params` is a list of C parameter WIDTHS in bits, not a word count, and the difference is the
// whole point of the field: `__ashrdi3` takes a 64-bit value and a 32-bit count — two C parameters
// occupying THREE argument registers. `wordsOf` is the one place that conversion happens.
import type { Opcode } from './ir/opcodes';
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
 *  The soft-FLOAT helpers carry a signature and no op: without one, `bl __addsf3` loses both its
 *  arguments and publishes `__addsf3()`, which scores against a call the machine made with two. */
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
