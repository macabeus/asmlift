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
import { type IrType, T } from '../ir/types';
import type { TargetDescription } from '../target';
import { FrontendUnsupportedError } from './errors';
import type { ArgSlots } from './ssa';

export type Fpu = NonNullable<TargetDescription['fpu']>;

/** The one float type a function's FPU registers hold: double where it decodes a double op, single
 *  otherwise, and null where it decodes both. `widthOf` is the frontend's reading of a mnemonic (null
 *  for one that carries no precision, undefined for one it does not decode). */
export function fpPrecision(
  instrs: readonly { mnemonic: string }[],
  widthOf: (mnemonic: string) => 32 | 64 | null | undefined,
): IrType | null {
  const widths = new Set(instrs.map((ins) => widthOf(ins.mnemonic)).filter((w) => w !== null && w !== undefined));
  return widths.size > 1 ? null : widths.has(64) ? T.f64() : T.f32();
}

/** The refusal of a function computing in both precisions, thrown where the frontend DECODES a float
 *  instruction of it, so a refusal the stream reaches first keeps its own reason. The SSA builder
 *  types a register per key, not per value, and the rounding between the precisions (a conversion,
 *  PowerPC's `frsp`, or a single op over a double operand) is not modelled. */
export function bothPrecisionsError(name: string, mnemonic: string): FrontendUnsupportedError {
  return new FrontendUnsupportedError(
    `cannot lift '${name}': '${mnemonic}' is in a function that computes in both single and double ` +
      'precision, and the rounding between them is not modelled',
  );
}

/** THE ARGUMENT SLOTS OF BOTH REGISTER FILES, as the one `ArgSlots` the MIPS and PowerPC frontends
 *  hand to `mintArgSlotHoles` and `abiSortEntryParams` (frontend/ssa.ts). Naming is positional
 *  (`a0`, `a1`, … in sort order), so the ORDER `slotOf` gives and the HOLES `holes` fills are two
 *  uses of one reading — kept in one place because under `'leading'` the files share a slot
 *  sequence, and a hole filled from the wrong file is a signature that compiles and binds its
 *  caller's arguments one slot off.
 *
 *  `slotOf` is the slot, with one exception: under `'separate'` a float argument ranks after every
 *  integer one. THAT ORDER IS A SPELLING, NOT A READING. Under the PowerPC EABI the two files count
 *  independently, so `float g(int *p, float b)` and `float g(float b, int *p)` compile to one object
 *  and nothing in it says which the source wrote. Either spelling reproduces the bytes in a unit
 *  that does not declare the function; this one is fixed so the output is deterministic. KNOWN GAP:
 *  a unit that does declare it — a project context — decides the order, and only the C++ backend
 *  reads that declaration (`bindSpecParams`). In C the int-first spelling of
 *  `float mix(float a, int n);` is a redeclaration mwcc refuses: a noncompile, not a wrong program.
 *  Ranking by the function's own declared parameters here would close it, once `proto.ts` can
 *  size a float. A key in neither file is no slot (null), and sorts after every argument.
 *
 *  `holes` applies FOUR RULES to the keys the entry reads, each a refusal or a parameter the ABI
 *  proves:
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
 *      `$f12`, `$f14` and `a3`, and its third argument is `a2`. Which file a hole comes from thus
 *      depends on what the function reads, which is why `ArgSlots` asks for the holes of a read
 *      set rather than for the key of a slot: `int ib(int a, int b){ return b; }` reads only `a1`,
 *      and its first argument is `a0`, not `$f12`.
 *   4. Under `'leading'` a float argument still takes the INTEGER slots it shadows — one for a
 *      single, two for a double (`floatType`) — so an integer argument register read in one of those
 *      slots is a contradiction the ABI does not produce, and is refused rather than ranked. */
export function fpuArgSlots(
  name: string,
  fpu: Fpu | undefined,
  argRegs: readonly string[],
  isFpKey: (key: string) => boolean,
  floatType: IrType | null = T.f32(),
): ArgSlots {
  // How many integer slots a float argument takes under `'leading'`: IDO reads the integer after a
  // double two slots on (`double di(double a, int b)` reads b from a2).
  const words = floatType?.kind === 'float' && floatType.width === 64 ? 2 : 1;
  const slotOf = (key: string): { slot: number; float: boolean } | null => {
    const gpr = argRegs.indexOf(key);
    if (gpr >= 0) {
      return { slot: gpr, float: false };
    }
    const fp = fpu?.argRegs.indexOf(key) ?? -1;
    return fp >= 0 ? { slot: fpu?.slots === 'leading' ? fp * words : fp, float: true } : null;
  };
  return {
    slotOf: (key) => {
      const s = slotOf(key);
      return s === null ? null : s.float && fpu?.slots === 'separate' ? argRegs.length + s.slot : s.slot;
    },
    holes: (readKeys) => {
      for (const k of readKeys.filter(isFpKey)) {
        if (!fpu?.argRegs.includes(k)) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': ${k} is read before this function writes it, and no floating-point argument ` +
              `arrives there — not modelled`,
          );
        }
      }
      const read = readKeys.map(slotOf).filter((s) => s !== null);
      const top = (float: boolean) => Math.max(-1, ...read.filter((s) => s.float === float).map((s) => s.slot));
      const floatTop = top(true);
      const intTop = top(false);
      if (fpu?.slots === 'leading') {
        // The last integer slot the floats read shadow: a double's second word is its too.
        const floatEnd = floatTop < 0 ? -1 : floatTop + words - 1;
        const shadowed = read.find((s) => !s.float && s.slot <= floatEnd);
        if (shadowed) {
          const k = shadowed.slot;
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': ${argRegs[k]} and ${fpu.argRegs[Math.floor(k / words)]} both carry argument ` +
              `slot ${k} — a floating-point argument takes the integer slots it shadows, so the ABI does not ` +
              'produce this — not modelled',
          );
        }
        return [
          ...fpu.argRegs.slice(0, Math.max(0, floatTop / words)),
          ...argRegs.slice(floatEnd + 1, Math.max(floatEnd + 1, intTop)),
        ];
      }
      return [...(fpu?.argRegs.slice(0, Math.max(0, floatTop)) ?? []), ...argRegs.slice(0, Math.max(0, intTop))];
    },
  };
}

/** Whether a function RETURNS a float: some instruction the frontend decodes writes the float return
 *  register, in a block the entry REACHES. Decided over the whole function, before any `ret` is
 *  emitted, because a function has one return type on every path — a path that leaves the register
 *  untouched returns the float argument that arrived there (PowerPC's `f1` is both), or refuses by
 *  `fpuArgSlots`' rule 1. Reachable blocks only: `addi r3,r3,1; blr; fmr f1,f2` returns `r3`, and
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
 *  THAT FACT IS WHAT HOLDS THIS RULE UP, and the next layer removes it: a layer that lets a float
 *  reach memory, the integer file or a compare must first decide the return from the value that
 *  reaches each `ret`, not from a mnemonic scan (`fpu-lift.test.ts` pins the function that breaks
 *  it, `docs/floating-point.md` §6). */
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
