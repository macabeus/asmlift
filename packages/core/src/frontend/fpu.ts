// asmlift — the argument ABI at a function's boundary, both register files, read once for the two
// frontends that lift hardware floating point (frontend/mips.ts, frontend/ppc.ts). The homes are
// target data (`TargetDescription.fpu`); this is where a lift is held to them.
//
// WHY A FRONTEND NEEDS THIS AT ALL, and why decoding the arithmetic alone is not a smaller version
// of it: a register of the FPU's file read before any write mints an entry parameter like any other
// key (frontend/ssa.ts), and a value left in the float return register is not the integer one. With
// the decode and neither of these, `float fadd(float a, float b){ return a + b; }` lifts on every
// FPU target as `void fadd(s32 a0, s32 a1) { return; }` — two phantom integer parameters and a dead
// add. `docs/floating-point.md` §2 measures that.
import type { TargetDescription } from '../target';
import { FrontendUnsupportedError } from './errors';
import type { SsaBuilder } from './ssa';

export type Fpu = NonNullable<TargetDescription['fpu']>;

/** THE ARGUMENT SLOTS, read once per target for both register files: which slot an argument register
 *  is, and which register a slot is. Naming is positional (`a0`, `a1`, … in `abiSortEntryParams`
 *  order), so the ORDER below and the HOLES `settleArgSlots` fills are two uses of one reading — kept
 *  in one place because under `'leading'` the files share a slot sequence, and a hole filled from
 *  the wrong file is a signature that compiles and binds its caller's arguments one slot off.
 *
 *  `rank` is the slot, with one exception: under `'separate'` a float argument ranks after every
 *  integer one. THAT ORDER IS A SPELLING, NOT A READING. Under the PowerPC EABI the two files count
 *  independently, so `float g(int *p, float b)` and `float g(float b, int *p)` compile to one object
 *  and nothing in it says which the source wrote. Either spelling reproduces the bytes; this one is
 *  fixed so the output is deterministic. KNOWN GAP: a declaration of the function's own signature
 *  would decide it, and nothing reads one here. A key in neither file ranks first (-1), the
 *  tie-break both of these frontends already give a non-ABI live-in. */
export function argSlots(
  fpu: Fpu | undefined,
  argRegs: readonly string[],
): {
  slotOf(key: string): { slot: number; float: boolean } | null;
  rank(key: string): number;
} {
  const slotOf = (key: string) => {
    const gpr = argRegs.indexOf(key);
    if (gpr >= 0) {
      return { slot: gpr, float: false };
    }
    const fp = fpu?.argRegs.indexOf(key) ?? -1;
    return fp >= 0 ? { slot: fp, float: true } : null;
  };
  return {
    slotOf,
    rank: (key) => {
      const s = slotOf(key);
      return s === null ? -1 : s.float && fpu?.slots === 'separate' ? argRegs.length + s.slot : s.slot;
    },
  };
}

/** Settle the entry block's argument parameters — both files. Call it after every block is filled
 *  and BEFORE `ssa.finish()`, because it may add a parameter (`ensureParam`), and `finish` records
 *  evidence for every entry parameter.
 *
 *  FOUR RULES, each a refusal or a parameter the ABI proves:
 *   1. A register of the FPU file that arrives at the entry is a float ARGUMENT, or the lift is
 *      refused. Nothing else in that file carries a caller's value: a read of `$f4` before any write
 *      is uninitialised storage or code this frontend has not followed, and minting a parameter for
 *      it would fabricate an argument.
 *   2. Every slot below the highest one read is a parameter too, read or not. Arguments take their
 *      registers in order, so `r5` is the third argument whatever became of the first two, and a
 *      signature holding only the registers read would bind every later argument one slot low.
 *   3. …and it is minted from the file the ABI puts that slot in. Under `'separate'` each file fills
 *      its own holes. Under `'leading'` (MIPS o32) a float argument is in `argRegs[k]` only while
 *      arguments 0..k are all floating, so a hole below the highest float read is a float, and one
 *      above it an integer — `float f(float a, float b, int c, int d){ return d ? a : b; }` reads
 *      `$f12`, `$f14` and `a3`, and its third argument is `a2`.
 *   4. Under `'leading'` a float argument still takes the INTEGER slot it shadows, so an integer
 *      argument register read in one of those slots is a contradiction the ABI does not produce,
 *      and is refused rather than ranked.
 *
 *  An entry block that is itself a loop header takes its arguments as phis, which can be neither
 *  completed (`ensureParam`) nor ordered (`abiSortEntryParams`). An integer entry there is left as
 *  it arrived — KNOWN GAP: `int gh(int a, int b, int n){ do b = b * b; while (--n); return b; }` on
 *  mwcc binds `r4` as `a0` — and a float argument there refuses. That is not rare: it is mwcc's
 *  layout for the simplest float do-while (`float lh(float a, int n){ do a = a * a; while (--n);
 *  return a; }`). What closes both is a predecessor-less entry block carrying the parameters. */
export function settleArgSlots(
  name: string,
  ssa: Pick<SsaBuilder, 'irBlocks' | 'keyOf' | 'ensureParam'>,
  fpu: Fpu | undefined,
  argRegs: readonly string[],
  isFpKey: (key: string) => boolean,
  entryHasPreds: boolean,
): void {
  const keys = ssa.irBlocks[0].params.map((p) => ssa.keyOf(p)).filter((k): k is string => k !== undefined);
  const fpKeys = keys.filter(isFpKey);
  for (const k of fpKeys) {
    if (!fpu?.argRegs.includes(k)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': ${k} is read before this function writes it, and no floating-point argument ` +
          `arrives there — not modelled`,
      );
    }
  }
  if (entryHasPreds) {
    if (fpKeys.length > 0) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': a floating-point argument arrives at an entry block that is a loop header — not modelled`,
      );
    }
    return;
  }
  const { slotOf } = argSlots(fpu, argRegs);
  const read = keys.map(slotOf).filter((s) => s !== null);
  const top = (float: boolean) => Math.max(-1, ...read.filter((s) => s.float === float).map((s) => s.slot));
  const floatTop = top(true);
  const intTop = top(false);
  if (fpu?.slots === 'leading') {
    const shadowed = read.find((s) => !s.float && s.slot <= floatTop);
    if (shadowed) {
      const k = shadowed.slot;
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': ${argRegs[k]} and ${fpu.argRegs[k]} both carry argument ${k} — a floating-point ` +
          `argument takes the integer slot it shadows, so the ABI does not produce this — not modelled`,
      );
    }
    for (let k = 0; k < Math.max(floatTop, intTop); k++) {
      ssa.ensureParam(k <= floatTop ? fpu.argRegs[k] : argRegs[k], 0);
    }
    return;
  }
  for (let k = 0; k < floatTop; k++) {
    ssa.ensureParam(fpu!.argRegs[k], 0);
  }
  for (let k = 0; k < intTop; k++) {
    ssa.ensureParam(argRegs[k], 0);
  }
}

/** Whether a function RETURNS a float: some instruction the frontend decodes writes the float return
 *  register, in a block the entry REACHES. Decided over the whole function, before any `ret` is
 *  emitted, because a function has one return type on every path — a path that leaves the register
 *  untouched returns the float argument that arrived there (PowerPC's `f1` is both), or refuses by
 *  `settleArgSlots`' rule 1. Reachable blocks only: `addi r3,r3,1; blr; fmr f1,f2` returns `r3`, and
 *  the `fmr` past the `blr` is on no path of it.
 *
 *  And then the INTEGER return register is scratch, even where the function writes it. Both halves
 *  rest on one fact: the arithmetic is ALL the decode admits, so a float reaches nothing but another
 *  float op or the return — every move to memory, to the integer file or through a compare or a
 *  conversion is refused. A write to the float return register that did not feed the return would
 *  therefore be dead in the source, and the compiler does not emit dead arithmetic; an integer
 *  result, meanwhile, could only have come from a float by a conversion, which refuses. IDO's
 *  unrolled `float pw(float a, int n)` is the witness for the second half: it counts in `v0`.
 *
 *  THAT FACT IS WHAT HOLDS THIS RULE UP, and the next layer removes it. `int st3(float a, float b,
 *  float *p, float *q){ *p = a * b; *q = a + b; return 2; }` writes `$f0` and returns `v0`; only the
 *  `swc1` refusal keeps it from lifting as a float return that drops the `2` (`fpu-lift.test.ts`
 *  pins it). A layer that lets a float reach memory, the integer file or a compare must first decide
 *  the return from the value that reaches each `ret`, not from a mnemonic scan. */
export function writesFloatReturn(
  instrs: readonly { mnemonic: string; ops: string[] }[],
  decodes: ReadonlySet<string>,
  destKey: (tok: string) => string | null,
  fpu: Fpu | undefined,
): boolean {
  return (
    fpu !== undefined &&
    instrs.some((ins) => decodes.has(ins.mnemonic) && ins.ops[0] !== undefined && destKey(ins.ops[0]) === fpu.returnReg)
  );
}
