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
import type { Fn, Op, Value } from '../ir/core';
import { FLOAT_OPS, FLOAT_TO_INT, INT_TO_FLOAT, NEGATED_FCMP } from '../ir/opcodes';
import { pruneDeadParams } from '../ir/simplify';
import { type IrType, T } from '../ir/types';
import { declaresAggregateReturn, declaresVoidReturn, floatingSpelling, isFloatingSpelling } from '../proto';
import type { TargetDescription } from '../target';
import { computedOnlyToReturn } from './dead-reads';
import { FrontendUnsupportedError } from './errors';
import type { OwnDeclaration } from './frontend';
import type { ArgSlots, SsaBuilder } from './ssa';

export type Fpu = NonNullable<TargetDescription['fpu']>;

/** The one float type a function's FPU registers hold: double where it decodes a double op, single
 *  where it decodes a single one, of no stated precision (`T.fUnstated`) where every op it decodes
 *  carries none, and null where it decodes both. `widthOf` is the frontend's reading of a mnemonic
 *  (null for one that carries no precision, undefined for one it does not decode). */
export function fpPrecision(
  instrs: readonly { mnemonic: string }[],
  widthOf: (mnemonic: string) => 32 | 64 | null | undefined,
): IrType | null {
  const widths = new Set(instrs.map((ins) => widthOf(ins.mnemonic)).filter((w) => w !== null && w !== undefined));
  return widths.size > 1 ? null : widths.has(64) ? T.f64() : widths.has(32) ? T.f32() : T.fUnstated();
}

/** The precision a function's OWN DECLARATION states for the floats it computes on, where none of
 *  its instructions states one (`T.fUnstated`): `double` where every floating parameter and a
 *  floating return are spelled `double`. PowerPC's `fcmpo`, `fctiwz`, `fmr` and `fneg` are one
 *  object over a float and a double, so `int d2i(double x){ return (int)x; }` is the bytes of the
 *  `float` function too, and only a declaration that may prove (`OwnDeclaration.proves`) tells them
 *  apart. A declaration spelling both is a function in both precisions, null, which refuses where a
 *  float instruction is decoded (`refuseBothPrecisions`). Any other leaves the precision unstated,
 *  which C spells `float`: a `float` parameter of an old-style definition arrives as a double. */
export function declaredPrecision(lifted: IrType | null, own: OwnDeclaration | undefined): IrType | null {
  if (lifted?.kind !== 'float' || lifted.width !== null || !own?.proves) {
    return lifted;
  }
  const { params, returns } = own.proto;
  const spelled = [...(Array.isArray(params) ? params : []), ...(returns === undefined ? [] : [returns])]
    .map(floatingSpelling)
    .filter((f) => f !== undefined);
  if (spelled.length === 0 || spelled.some((f) => f === 'long double')) {
    return lifted;
  }
  return spelled.every((f) => f === 'double') ? T.f64() : spelled.every((f) => f === 'float') ? lifted : null;
}

/** Refuse a function computing in both precisions, where the frontend DECODES a float instruction of
 *  it, so a refusal the stream reaches first keeps its own reason. The SSA builder types a register
 *  per key, not per value, and the rounding between the precisions (a conversion, PowerPC's `frsp`,
 *  or a single op over a double operand) is not modelled. It throws here, so its throw site is the
 *  one `declines.test.ts` harvests. */
export function refuseBothPrecisions(name: string, mnemonic: string): never {
  throw new FrontendUnsupportedError(
    `cannot lift '${name}': '${mnemonic}' is in a function that computes in ` +
      'both single and double precision, and the rounding between them is not modelled',
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
        // The last integer slot the floats read shadow; a double shadows two.
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

/** Whether a function RETURNS a float, where no float reaches the integer file: some instruction the
 *  frontend decodes writes the float return register, in a block the entry REACHES. Decided over the
 *  whole function, before any `ret` is emitted, because a function has one return type on every
 *  path — a path that leaves the register untouched returns the float argument that arrived there
 *  (PowerPC's `f1` is both), or refuses by `fpuArgSlots`' rule 1. Reachable blocks only: `addi
 *  r3,r3,1; blr; fmr f1,f2` returns `r3`, and the `fmr` past the `blr` is on no path of it.
 *
 *  And then the INTEGER return register is scratch, even where the function writes it. Both halves
 *  rest on one fact: in such a function a float reaches nothing but another float op or the return
 *  — every move to memory is refused. A write to the float return register that did not feed the
 *  return would therefore be dead in the source, and the compiler does not emit dead arithmetic.
 *  IDO's unrolled `float pw(float a, int n)` counts in `v0`.
 *
 *  THE FACT FAILS ONCE A FLOAT REACHES THE INTEGER FILE through a compare or a conversion: a float
 *  temporary in the home then feeds the compare, not the return (`void vb(float a, float b, int *p)
 *  { float c = a * b; if (c < a) *p = 1; }` multiplies into `$f0` on KMC). Such a function is
 *  settled once lifted (`settleReturnHome`), never by this. A layer that lets a float reach MEMORY
 *  removes the fact for every function, and must settle them all that way (`fpu-lift.test.ts` pins
 *  the function that breaks it, `docs/floating-point.md` §6). */
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

/** Which home a function returns in, as far as can be said BEFORE its blocks are filled: the float
 *  home, the integer one (which covers a `void` function), or `undecided`, which `settleReturnHome`
 *  answers once the lift is done. The function's OWN DECLARATION decides first, where it may prove
 *  (`OwnDeclaration.proves`): a floating return type is the float home, any other return the integer
 *  one. Without it, a function where no float reaches the integer file (`crosses` false) is
 *  decided by `writesFloatReturn`. One where a float does is undecided: a write to the float home
 *  no longer says it is the result, and a value in the integer home may be one computed from a
 *  float. */
export interface ReturnHomeRule {
  readonly home: 'float' | 'integer' | 'undecided';
  /** whether the own declaration decided it */
  readonly declared: boolean;
}
export function returnHomeRule(
  own: OwnDeclaration | undefined,
  crosses: boolean,
  writesFloat: () => boolean,
): ReturnHomeRule {
  const p = own?.proves ? own.proto : undefined;
  if (p !== undefined && (declaresVoidReturn(p) || declaresAggregateReturn(p) || p.returns !== undefined)) {
    return { home: p.returns !== undefined && isFloatingSpelling(p.returns) ? 'float' : 'integer', declared: true };
  }
  return { home: crosses ? 'undecided' : writesFloat() ? 'float' : 'integer', declared: false };
}

/** What the float return home holds at a return, read WITHOUT a read: every definition that reaches
 *  it, and whether one does on every path (a path that brings none brings the caller's register).
 *  A read would leave a definition behind, and where the entry reaches it an entry parameter. Asked
 *  once every block is filled. */
export interface HomeAtReturn {
  readonly every: boolean;
  readonly defs: readonly Value[];
}
export function floatHomeAt(ssa: Pick<SsaBuilder, 'everyReachingDef'>, home: string, bi: number): HomeAtReturn {
  const defs: Value[] = [];
  const every = ssa.everyReachingDef(home, bi, (v) => {
    defs.push(v);
    return true;
  });
  return { every, defs };
}

/** Whether an undecided function's float home holds a FLOAT on every path into every return, so
 *  that `settleReturnHome` may weigh it: then the frontend reads it at each return before the SSA is
 *  finished, and hands it on as the `ret`'s LAST operand, where the SSA's own clean-up keeps it
 *  current (a join it resolves away is replaced there, and one nothing read would be pruned). */
export function carriesFloatHome(rule: ReturnHomeRule, homes: readonly HomeAtReturn[]): boolean {
  return rule.home === 'undecided' && homes.every((h) => h.every && h.defs.every((v) => v.type.kind === 'float'));
}

/** SETTLE THE RETURN HOME of a lifted function, and refuse where the bytes do not decide it.
 *  `sites` are its returns, each reading what the INTEGER home rule gave it (the operand a `ret`
 *  reads where the function returns a word), plus, where `carriesFloat`, the float home's value
 *  last; `homes` is what the float home holds at each (`floatHomeAt`). Run after the SSA is
 *  finished.
 *
 *  An INTEGER WORD in the float home at a return refuses, unless the integer home proves itself
 *  (below) or the own declaration says the return is no float: `mtc1 $zero,$f0` is how IDO, KMC and
 *  GCC 2.7.2 return `0.0f`, and `mtc1 a1,$f0` how they return a float that arrived in a GPR, and
 *  either is the word's bits as a float, which is not modelled. KMC's `trunc.w.s $f0,$f12; mfc1
 *  v0,$f0` leaves a word there too, and returns it in `v0`. A float return whose `ret` reads a word
 *  refuses as well.
 *
 *  An UNDECIDED function returns the home whose value at every return was computed only to be
 *  returned (frontend/dead-reads.ts `computedOnlyToReturn`): an optimizing compiler emits no write
 *  whose value nothing reads, so a value that survives with only a return to read it is the
 *  result. `int vi2(float a, float b){ float c = a + b; if (c < a) return 3; … }` adds into `$f0`,
 *  which the compares read, and returns the `li` in `v0`. Where the float home holds no float at
 *  some return, the function returns none — unless the home is an argument register (`f1`), whose
 *  float may be the caller's, and then the integer home must prove itself. Where neither home
 *  proves, or both do, the lift refuses: `void vb(float a, float b, int *p){ float c = a * b; if (c
 *  < a) *p = 1; }` and `float vb(…){ …; return c; }` are one object, and so are `float mx(float a,
 *  float b, int *p){ if (a < b) *p = 1; return a; }` and the same function returning `p`. The own
 *  declaration decides those (`returnHomeRule`). */
export function settleReturnHome(
  name: string,
  fn: Fn,
  rule: ReturnHomeRule,
  sites: readonly { op: Op }[],
  homes: readonly HomeAtReturn[],
  carriesFloat: boolean,
  fpu: Fpu,
  intReg: string,
): void {
  const floatAt = carriesFloat ? sites.map(({ op }) => op.operands.pop()!) : undefined;
  const isFloat = (v: Value) => v.type.kind === 'float';
  if (rule.home === 'float') {
    if (sites.some(({ op }) => !op.operands.every(isFloat))) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': a return reads an integer word from ${fpu.returnReg}, the float return register`,
      );
    }
    return;
  }
  const computed = computedOnlyToReturn(fn.blocks);
  const intProven = sites.every(({ op }) => op.operands.length === 1 && computed(op.operands[0]));
  if (!rule.declared && !intProven && homes.some((h) => !h.defs.every(isFloat))) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': ${fpu.returnReg}, the float return register, holds an integer word at a return, ` +
        `and ${intReg} holds no value computed only to be returned — the word's bits as a float are not modelled`,
    );
  }
  if (rule.home === 'integer' || (floatAt === undefined && !fpu.argRegs.includes(fpu.returnReg))) {
    if (floatAt !== undefined) {
      pruneDeadParams(fn);
    }
    return;
  }
  const floatProven = floatAt !== undefined && floatAt.every(computed);
  if (floatProven !== intProven) {
    if (floatProven) {
      sites.forEach(({ op }, i) => {
        op.operands = [floatAt![i]];
      });
    }
    // the home not returned may have left a join nothing reads now
    pruneDeadParams(fn);
    return;
  }
  throw new FrontendUnsupportedError(
    `cannot lift '${name}': a float reaches the integer file (a compare or a conversion), and then whether it ` +
      `returns ${fpu.returnReg}, ${intReg} or nothing is not decided by the bytes — ` +
      (floatProven
        ? 'each holds a value computed only to be returned'
        : 'neither holds a value computed only to be returned') +
      ', and no declaration of its own says',
  );
}

/** Refuse a function where an FPU register's INTEGER WORD meets a float, or its float meets an
 *  integer, across a block boundary. Within a block each read is checked as it is decoded; a read
 *  that reaches an earlier block comes back as a block parameter, which the builder types as the
 *  file's float before it knows what flows in (`makeSsaBuilder`'s `keyType`). So the check runs
 *  again over the finished function: a float op, a compare or a conversion out of a float over
 *  anything but a float, a conversion into one over a float, and an edge passing a word to a float
 *  parameter or the reverse. `float g(float a, float b, float c)` on O32 hands `c` over in `a2`,
 *  which `mtc1` moves in as a word: computing on it as a float is a bit cast this does not model. */
export function refuseFpWordCrossings(name: string, fn: Fn): void {
  const fail = (what: string): never => {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': ${what} — an FPU register holds a float or an integer word, and this one meets the other`,
    );
  };
  const isFloat = (v: Value) => v.type.kind === 'float';
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const takesFloats =
        (FLOAT_OPS.has(op.opcode) && op.opcode !== 'fconst') ||
        FLOAT_TO_INT.has(op.opcode) ||
        NEGATED_FCMP[op.opcode] !== undefined;
      if (takesFloats && !op.operands.every(isFloat)) {
        fail(`'${op.opcode}' is handed an integer word`);
      }
      if (INT_TO_FLOAT.has(op.opcode) && op.operands.some(isFloat)) {
        fail(`'${op.opcode}' is handed a float`);
      }
      for (const s of op.successors) {
        s.args.forEach((a, i) => {
          if (isFloat(a) !== (s.block.params[i]?.type.kind === 'float')) {
            fail('a block boundary passes one where the other arrives');
          }
        });
      }
    }
  }
}
