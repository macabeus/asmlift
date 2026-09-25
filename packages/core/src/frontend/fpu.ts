// asmlift — the floating-point ABI at a function's boundary, read once for the two frontends that
// lift hardware floating point (frontend/mips.ts, frontend/ppc.ts). The homes are target data
// (`TargetDescription.fpu`); this is where a lift is held to them.
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

/** Settle the entry block's floating-point parameters. Call it after every block is filled and
 *  BEFORE `ssa.finish()`, because it may add a parameter (`ensureParam`).
 *
 *  THREE RULES, each a refusal or a parameter the ABI proves:
 *   1. A register of the FPU file that arrives at the entry is a float ARGUMENT, or the lift is
 *      refused. Nothing else in that file carries a caller's value: a read of `$f4` before any write
 *      is uninitialised storage or code this frontend has not followed, and minting a parameter for
 *      it would fabricate an argument.
 *   2. The float arguments BELOW the highest one read are parameters too, read or not. The homes
 *      are positional — `f3` is the third float argument whatever became of the first two — so a
 *      signature holding only the one that was read would hand its caller's first float to it.
 *   3. Under `'leading'` (MIPS o32), a float argument still takes the INTEGER slot it shadows, so an
 *      integer argument register read in one of those slots is a contradiction the ABI does not
 *      produce, and is refused rather than ranked.
 *
 *  An entry block that is itself a loop header takes its arguments as phis and cannot be given a
 *  parameter or an order (`ensureParam`, `abiSortEntryParams`), so a float argument there refuses.
 *  UNBUILT, not unreachable: nothing in the corpus has the shape. */
export function settleFloatParams(
  name: string,
  ssa: Pick<SsaBuilder, 'irBlocks' | 'keyOf' | 'ensureParam'>,
  fpu: Fpu,
  argRegs: readonly string[],
  isFpKey: (key: string) => boolean,
  entryHasPreds: boolean,
): void {
  const entryKeys = () => ssa.irBlocks[0].params.map((p) => ssa.keyOf(p)).filter((k): k is string => k !== undefined);
  const fpKeys = entryKeys().filter(isFpKey);
  if (fpKeys.length === 0) {
    return;
  }
  for (const k of fpKeys) {
    if (!fpu.argRegs.includes(k)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': ${k} is read before this function writes it, and no floating-point argument ` +
          `arrives there — not modelled`,
      );
    }
  }
  if (entryHasPreds) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': a floating-point argument arrives at an entry block that is a loop header — not modelled`,
    );
  }
  const top = Math.max(...fpKeys.map((k) => fpu.argRegs.indexOf(k)));
  for (let i = 0; i < top; i++) {
    ssa.ensureParam(fpu.argRegs[i], 0);
  }
  if (fpu.slots === 'leading') {
    for (const k of entryKeys()) {
      const slot = argRegs.indexOf(k);
      if (slot >= 0 && slot <= top) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': ${k} and ${fpu.argRegs[slot]} both carry argument ${slot} — a floating-point ` +
            `argument takes the integer slot it shadows, so the ABI does not produce this — not modelled`,
        );
      }
    }
  }
}

/** The ABI rank of an entry parameter's key, for `abiSortEntryParams`: its integer slot, a float
 *  argument's slot under `'leading'`, and under `'separate'` a float argument after every integer one.
 *
 *  THAT LAST ORDER IS A SPELLING, NOT A READING. Under the PowerPC EABI the two files count
 *  independently, so `float g(int *p, float b)` and `float g(float b, int *p)` compile to one object
 *  and nothing in it says which the source wrote. Either spelling reproduces the bytes; this one is
 *  fixed so the output is deterministic. KNOWN GAP: a declaration of the function's own signature
 *  would decide it, and nothing reads one here. A key in neither list ranks first (-1), the tie-break
 *  both of these frontends already give a non-ABI live-in. */
export function floatAwareRank(fpu: Fpu | undefined, argRegs: readonly string[]): (key: string) => number {
  return (key) => {
    const gpr = argRegs.indexOf(key);
    if (gpr >= 0 || fpu === undefined) {
      return gpr;
    }
    const fp = fpu.argRegs.indexOf(key);
    if (fp < 0) {
      return -1;
    }
    return fpu.slots === 'leading' ? fp : argRegs.length + fp;
  };
}

/** Whether a function RETURNS a float: some instruction the frontend decodes writes the float return
 *  register. Decided over the whole function, before any `ret` is emitted, because a function has
 *  one return type on every path — a path that leaves the register untouched returns the float
 *  argument that arrived there (PowerPC's `f1` is both), or refuses by rule 1 above.
 *
 *  And then the INTEGER return register is scratch, even where the function writes it. Both halves
 *  rest on one fact: the arithmetic is ALL the decode admits, so a float reaches nothing but another
 *  float op or the return — every move to memory, to the integer file or through a compare or a
 *  conversion is refused. A write to the float return register that did not feed the return would
 *  therefore be dead in the source, and the compiler does not emit dead arithmetic; an integer
 *  result, meanwhile, could only have come from a float by a conversion, which refuses. IDO's
 *  unrolled `float pw(float a, int n)` is the witness for the second half: it counts in `v0`. */
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
