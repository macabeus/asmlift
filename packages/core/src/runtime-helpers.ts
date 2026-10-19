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
// here: `wordsOf` (proto.ts, because a C declaration asks the same question) counts the argument
// REGISTERS the list occupies, and `irWidthOf` gives the IR width one parameter ARRIVES at once a
// frontend has paired those registers up.
import { type Op, type Value, mkOp } from './ir/core';
import { FLOAT_COMPUTING, FLOAT_TO_INT, INT_TO_FLOAT, NEGATED_FCMP, type Opcode, WIDE_BITS } from './ir/opcodes';
import { type IrType, intWidth } from './ir/types';
import { type Prototypes, wordsOf } from './proto';
import type { TargetDescription } from './target';

export interface RuntimeHelper {
  /** the op this helper computes, where asmlift has one. Absent for a helper it can only SIGN. */
  op?: Opcode;
  /** each C parameter's width in bits, in argument order. */
  params: readonly number[];
  /** the returned width: 0 (void), 32, or 64 (a register PAIR). */
  returns: 0 | 32 | 64;
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

/** The op a recognised helper call is rewritten to, STAMPED with the helper it was: `helper` names
 *  the callee. An integer helper's op takes the call's own operands and the SAME result value, so
 *  every use already points at it; a float helper's takes them re-typed as floats
 *  (`raise/floathelpers.ts`). `raise/softdiv.ts`, `raise/widehelpers.ts` and `raise/floathelpers.ts`
 *  build every one through here.
 *
 *  The stamp carries the one fact the op's opcode loses: the asm CALLED something here. A
 *  `sdiv` is a `divw` on mwcc and a `bl __divsi3` on agbcc, and an `shr_s` is a shift everywhere
 *  but a `bl __ashrdi3` where it is 64-bit on agbcc — which ops a compiler calls a helper for is a
 *  compiler fact, not an ISA one, and it was known exactly once, at the rewrite. What reads it is
 *  every rule that places a call: a call runs once, where the asm ran it (ir/discipline.ts
 *  `placedAt`), and a pass that moves the op elsewhere drops the stamp (`forgetHelperPlacement`). */
export function helperOp(opcode: Opcode, helper: string, operands: readonly Value[], result: Value): Op {
  return mkOp(opcode, { operands: [...operands], results: [result], attrs: { helper } });
}

/** Whether a helper computes on floats: its op is a float op, a conversion or a compare, so the
 *  operands and the result that op takes as floats are floats of the widths its signature states,
 *  carried in integer registers by a soft-float runtime. Every reader of the table asks this and
 *  not the width, because the two families fold into different IR: an integer helper into its op
 *  over the same values, a float helper into its op over values re-typed as floats where the op
 *  takes one (`raise/floathelpers.ts`). */
export function isFloatHelper(h: RuntimeHelper): boolean {
  return h.op !== undefined && FLOAT_COMPUTING.has(h.op);
}

/** Which sides of a float helper are floats: its operands (one kind for all of them, in every op
 *  here) and its result. A conversion has an integer on one side; a compare returns one. */
export function floatSidesOf(h: RuntimeHelper): { operands: boolean; result: boolean } {
  const op = h.op ?? '';
  return {
    operands: !INT_TO_FLOAT.has(op),
    result: !FLOAT_TO_INT.has(op) && NEGATED_FCMP[op] === undefined,
  };
}

/** Signatures for a target's helpers, in the WORD arity the frontend's prototype lookup speaks.
 *  Consumed behind any caller-supplied prototype — the project's own headers win. */
export function helperPrototypes(
  target: Pick<TargetDescription, 'runtimeHelpers' | 'evenWordAlignedArgs'>,
): Prototypes {
  return Object.fromEntries(
    Object.entries(target.runtimeHelpers ?? {}).map(([sym, h]) => [sym, { params: wordsOf(h.params, target) }]),
  );
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
 *  THE FLOAT ARITHMETIC OF BOTH PRECISIONS IS HERE, AND FOLDS. `optabs.c:4022`
 *  `init_floating_libfuncs` names each mode's add, sub, mul, div (4129-4140) and neg (4155), and
 *  `thumb.md` has no SF or DF pattern but the move, so every one of them is a call; a single
 *  travels as an int's word and a double as a long long's pair (thumb.h:632, 655).
 *  `raise/floathelpers.ts` folds them to the float ops over a `float` or a `double`.
 *
 *  NAMING THEM IS A TRADE, and these ten make it: a call the fold refuses declines where an unnamed
 *  helper would publish as a pass-through. So a function whose float arithmetic feeds a compare, a
 *  conversion or an ordinary call declines, where unnamed it would print `__muldf3(); g();`. For
 *  the singles that pass-through is wrong C: unnamed, `__mulsf3`'s arity is GUESSED (frontend/ssa.ts
 *  `fallbackArgc`), and a guess drops what the function passes on unchanged — `a * b + c` as
 *  `__addsf3(__mulsf3(), a2)`, `a + b` as `__addsf3()`.
 *
 *  THE CONVERSIONS FOLD TOO, to the cast each computes (`fptosi`, `sitofp`, `fpext` …), with an
 *  integer on one side that `raise/floathelpers.ts` takes as any integer. THE COMPARES ONLY SIGN:
 *  each carries no `op` and refuses (`refuseUnmodelledHelpers`), as `IDO_RUNTIME_HELPERS` signs its
 *  conversions. Unnamed, each would be the same guess, dropping the argument passed on unchanged and
 *  matching byte for byte: `(int)x` as `__fixsfsi()`, `(float)i` as `__floatsisf()`, `a > b` as
 *  `__gtsf2() > 0`. The names are the ones agbcc
 *  emits for every compare, every conversion between `int`, `unsigned`, `long long` and either
 *  precision, and every widening and narrowing between the two precisions (compiled evidence: one
 *  function per operation at the canonical flags). There is no conversion of an unsigned integer
 *  INTO a float: agbcc open-codes `(float)u` around `__floatsisf` and `__addsf3`. `__cmpdi2`, which
 *  it also calls converting an `unsigned long long`, is an integer compare and outside this
 *  family. */
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
  // Double arithmetic, which the same pair carries (`raise/floathelpers.ts`).
  __adddf3: { op: 'fadd', params: [64, 64], returns: 64 },
  __subdf3: { op: 'fsub', params: [64, 64], returns: 64 },
  __muldf3: { op: 'fmul', params: [64, 64], returns: 64 },
  __divdf3: { op: 'fdiv', params: [64, 64], returns: 64 },
  __negdf2: { op: 'fneg', params: [64], returns: 64 },
  // Single arithmetic, one float in one register each way (thumb.h:632's word).
  __addsf3: { op: 'fadd', params: [32, 32], returns: 32 },
  __subsf3: { op: 'fsub', params: [32, 32], returns: 32 },
  __mulsf3: { op: 'fmul', params: [32, 32], returns: 32 },
  __divsf3: { op: 'fdiv', params: [32, 32], returns: 32 },
  __negsf2: { op: 'fneg', params: [32], returns: 32 },
  // The compares, one int out of two floats of either precision: its sign against 0 is the answer.
  __eqsf2: { params: [32, 32], returns: 32 },
  __nesf2: { params: [32, 32], returns: 32 },
  __gtsf2: { params: [32, 32], returns: 32 },
  __gesf2: { params: [32, 32], returns: 32 },
  __ltsf2: { params: [32, 32], returns: 32 },
  __lesf2: { params: [32, 32], returns: 32 },
  __eqdf2: { params: [64, 64], returns: 32 },
  __nedf2: { params: [64, 64], returns: 32 },
  __gtdf2: { params: [64, 64], returns: 32 },
  __gedf2: { params: [64, 64], returns: 32 },
  __ltdf2: { params: [64, 64], returns: 32 },
  __ledf2: { params: [64, 64], returns: 32 },
  // The conversions: to and from a word, to and from a long long, and between the precisions.
  // `__fix*` truncates toward zero, as C's conversion out of a float does.
  __fixsfsi: { op: 'fptosi', params: [32], returns: 32 },
  __fixunssfsi: { op: 'fptoui', params: [32], returns: 32 },
  __floatsisf: { op: 'sitofp', params: [32], returns: 32 },
  __fixdfsi: { op: 'fptosi', params: [64], returns: 32 },
  __fixunsdfsi: { op: 'fptoui', params: [64], returns: 32 },
  __floatsidf: { op: 'sitofp', params: [32], returns: 64 },
  __fixsfdi: { op: 'fptosi', params: [32], returns: 64 },
  __fixunssfdi: { op: 'fptoui', params: [32], returns: 64 },
  __floatdisf: { op: 'sitofp', params: [64], returns: 32 },
  __fixdfdi: { op: 'fptosi', params: [64], returns: 64 },
  __fixunsdfdi: { op: 'fptoui', params: [64], returns: 64 },
  __floatdidf: { op: 'sitofp', params: [64], returns: 64 },
  __extendsfdf2: { op: 'fpext', params: [32], returns: 64 },
  __truncdfsf2: { op: 'fptrunc', params: [64], returns: 32 },
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
 *  its own.
 *
 *  ⚠ WHAT THIS TABLE DOES ON THIS TARGET TODAY IS REFUSE, and the `op` column is not reachable
 *  from a lift. `frontend/ppc.ts` reads guessed argument registers and fuses none of them into a
 *  pair, so no value on this target is ever 64 bits wide, so `arrivesAsDeclared` can never be
 *  satisfied here and `recognizeWideHelpers` cannot fold. THAT absent pairing is the gate bounding
 *  the path — not anything in this file, and not `refuseUnmodelledHelpers`, which is what these
 *  names reach instead. The ops below are measured off the vendored `runtime.c` and asserted
 *  directly by `runtime-helper-refusal.test.ts`, because a claim no lift can reach is a claim no
 *  lift can check either; naming which operation each helper computes is the half of the frontend
 *  work that is done. */
export const PPC_MWCC_RUNTIME_HELPERS: Readonly<Record<string, RuntimeHelper>> = {
  __div2i: { op: 'sdiv', params: [64, 64], returns: 64 },
  __div2u: { op: 'udiv', params: [64, 64], returns: 64 },
  __mod2i: { op: 'smod', params: [64, 64], returns: 64 },
  __mod2u: { op: 'umod', params: [64, 64], returns: 64 },
  __shl2i: { op: 'shl', params: [64, 32], returns: 64 },
  __shr2i: { op: 'shr_s', params: [64, 32], returns: 64 },
  __shr2u: { op: 'shr_u', params: [64, 32], returns: 64 },
};

/** A compiler runtime's OUT-OF-LINE REGISTER SAVE AND RESTORE ROUTINES: a prologue that saves a run
 *  of callee-saved registers by calling into the runtime instead of storing each one inline. A
 *  compiler fact, like the table above, and it hangs off `TargetDescription` for the same reason:
 *  which compiler emits the family, at which level, is measured per build, and a frontend that
 *  hard-coded the names would recognise them on a target whose runtime has no such routine.
 *
 *  A call to one is FRAME BOOKKEEPING, not a call: it writes no register but the link register, and
 *  the frame address in `frameReg` is the only thing it reads (frontend/ppc.ts `saveRoutine`). */
export interface RegisterSaveRoutines {
  /** the register a routine takes its frame address in. The save area is the words just BELOW it. */
  frameReg: string;
  /** every routine name, with three groups: `save` or `rest`, the register file (`gpr`/`fpr`), and
   *  the first register the routine moves — it moves that one up to the file's last, 31. */
  name: RegExp;
}

/** The routine a callee symbol names under `routines`, or null when it names none. */
export function registerSaveRoutineOf(
  routines: RegisterSaveRoutines | undefined,
  sym: string,
): { sym: string; restore: boolean; fpr: boolean; first: number } | null {
  const m = routines?.name.exec(sym);
  return m ? { sym: m[0], restore: m[1] === 'rest', fpr: m[2] === 'fpr', first: Number(m[3]) } : null;
}

/** CodeWarrior's `_savegpr_NN` / `_restgpr_NN` and `_savefpr_NN` / `_restfpr_NN`, called after
 *  `addi r11,r1,N`. `_savegpr_NN` stores rNN..r31 into the 4*(32-NN) bytes just below r11, and
 *  `_savefpr_NN` stores fNN..f31 into the 8*(32-NN) bytes below it.
 *
 *  COMPILED, per build: 2.4.2 and 2.4.7 emit the family at every level (`-O4,p`, `-O4,s`, `-O0,p`).
 *  2.3.3 never does at Pikmin's `-O4,p`, where it saves with `stmw` and inline `stfd`, but does at
 *  `-O0,p` and `-O4,s`; all three builds share `PPC_MWCC`, so the description carries it. The bench's
 *  feature tagger reads this same pattern (apps/benchmark `features.ts`). */
export const PPC_MWCC_SAVE_ROUTINES: RegisterSaveRoutines = {
  frameReg: 'r11',
  name: /^_(save|rest)(gpr|fpr)_(\d+)$/,
};

/** IDO 7.1's runtime for the 64-bit operations MIPS II has no instruction for, a family of its own
 *  (`__ll_*` for signed, `__ull_*` for unsigned): a scan for `__*di3` reports zero on it.
 *
 *  Compiled at `-mips2 -O2 -32 -non_shared -G 0` (compiled evidence only): `a * b` calls `__ll_mul`
 *  for both signednesses, the divisions and remainders split, and a left shift is one helper while
 *  the right shift splits. A SHIFT'S COUNT TRAVELS AS A PAIR: `a << n` with `int n` builds
 *  `a2 = n >> 31, a3 = n` before `jal __ll_lshift`, so both parameters are 64 bits wide.
 *
 *  EVERY CONVERSION BETWEEN A 64-BIT INTEGER AND A FLOAT IS A CALL TOO, one per direction, precision
 *  and signedness. The float side travels in the FPU's registers (`$f12` in, `$f0` out), so these
 *  carry no op: a guessed call to one passes and returns nothing it can see.
 *
 *  SO IS A 64-BIT BITFIELD: a read hands the word's address, start bit and length to
 *  `__ll_bit_extract` (`__ull_bit_extract` unsigned), and a write of either signedness calls
 *  `__ll_bit_insert` with the value as a fourth parameter. No op folds either.
 *
 *  THE NAMES ARE THE COMPILER'S OWN: these are every `__ll_*`, `__ull_*` and `__*_to_*ll` that a pass
 *  of IDO 7.1 carries in its string table (`cfe` carries them all). Its libc defines more
 *  (`__ll_mod`, `__ull_divremi`, `__ull_divrem_*`), which no pass names, so no compiled code calls them.
 *
 *  ⚠ WHAT THIS TABLE DOES ON THIS TARGET IS REFUSE, as `PPC_MWCC_RUNTIME_HELPERS` does and for the
 *  same reason: `frontend/mips.ts` fuses no register pair, so a call to one of these arrives with
 *  word operands and `refuseUnmodelledHelpers` gaps it by name. */
export const IDO_RUNTIME_HELPERS: Readonly<Record<string, RuntimeHelper>> = {
  __ll_mul: { op: 'mul', params: [64, 64], returns: 64 },
  __ll_div: { op: 'sdiv', params: [64, 64], returns: 64 },
  __ull_div: { op: 'udiv', params: [64, 64], returns: 64 },
  __ll_rem: { op: 'smod', params: [64, 64], returns: 64 },
  __ull_rem: { op: 'umod', params: [64, 64], returns: 64 },
  __ll_lshift: { op: 'shl', params: [64, 64], returns: 64 },
  __ll_rshift: { op: 'shr_s', params: [64, 64], returns: 64 },
  __ull_rshift: { op: 'shr_u', params: [64, 64], returns: 64 },
  __ll_to_d: { params: [64], returns: 64 },
  __ll_to_f: { params: [64], returns: 32 },
  __ull_to_d: { params: [64], returns: 64 },
  __ull_to_f: { params: [64], returns: 32 },
  __d_to_ll: { params: [64], returns: 64 },
  __f_to_ll: { params: [32], returns: 64 },
  __d_to_ull: { params: [64], returns: 64 },
  __f_to_ull: { params: [32], returns: 64 },
  __ll_bit_extract: { params: [32, 32, 32], returns: 64 },
  __ull_bit_extract: { params: [32, 32, 32], returns: 64 },
  __ll_bit_insert: { params: [32, 32, 32, 64], returns: 64 },
};

/** GCC's libgcc for MIPS, as KMC GCC and GCC 2.7.2 call it at the N64 projects' `-mips3 -mgp32`
 *  (compiled evidence only, both toolchains agreeing): the four divisions are calls, while a
 *  64-bit multiply is `mult`/`multu` and a shift is open-coded, so neither has an entry. The
 *  conversions between a 64-bit integer and a float are calls, with no `__floatundi*`: an unsigned
 *  one converts as signed and corrects the result when `__cmpdi2` finds the value negative. The
 *  conversions carry no op, for the reason `IDO_RUNTIME_HELPERS` gives. It refuses on this target
 *  for that table's reason too. */
export const MIPS_GCC_RUNTIME_HELPERS: Readonly<Record<string, RuntimeHelper>> = {
  __divdi3: { op: 'sdiv', params: [64, 64], returns: 64 },
  __udivdi3: { op: 'udiv', params: [64, 64], returns: 64 },
  __moddi3: { op: 'smod', params: [64, 64], returns: 64 },
  __umoddi3: { op: 'umod', params: [64, 64], returns: 64 },
  __floatdidf: { params: [64], returns: 64 },
  __floatdisf: { params: [64], returns: 32 },
  __fixdfdi: { params: [64], returns: 64 },
  __fixsfdi: { params: [32], returns: 64 },
  __fixunsdfdi: { params: [64], returns: 64 },
  __fixunssfdi: { params: [32], returns: 64 },
  __cmpdi2: { params: [64, 64], returns: 32 },
};
