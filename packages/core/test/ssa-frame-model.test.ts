// The live-in partition (frontend/ssa.ts, LiveInModel) is the rule that decides what a def-less
// live-in MEANS — the frame in slot-key offsets, the register file by key — and these exercise it
// directly on the builder rather than through a frontend.
//
// AT THIS LEVEL because the rule's purpose is to be falsifiable INDEPENDENTLY of what a frontend
// believes about its own frame. Driving it through Thumb could only confirm that Thumb and the rule
// agree; handing the builder ranges directly is the only way to see it refuse a frontend that is
// wrong.
import { makeSsaBuilder, stackSlotKey } from '@asmlift/core/frontend/ssa';
import { mkOp } from '@asmlift/core/ir/core';
import { expect, test } from 'vitest';

/** One block, no predecessors, that reads `key` with nothing ever written — the def-less live-in. */
const readDefLess = (key: string, frame: Parameters<typeof makeSsaBuilder>[3]) => {
  const ssa = makeSsaBuilder('f', 1, [[]], frame);
  const v = ssa.readVar(key, 0);
  ssa.irBlocks[0].ops.push(mkOp('ret', { operands: [v] }));
  ssa.markFilled(0);
  ssa.finish();
  return ssa;
};

const definedBy = (ssa: ReturnType<typeof makeSsaBuilder>, key: string) => {
  const undefs = ssa.irBlocks.flatMap((b) => b.ops).filter((o) => o.opcode === 'undef');
  return {
    undefKeys: undefs.map((o) => o.attrs.key),
    paramKeys: ssa.irBlocks[0].params.map((p) => ssa.paramReg.get(p)).filter((k) => k === key),
  };
};

test('a slot inside ownedLocals is an uninitialised local', () => {
  const ssa = readDefLess(stackSlotKey(4), () => ({ ownedLocals: { from: 0, to: 8 } }));
  expect(definedBy(ssa, stackSlotKey(4))).toEqual({ undefKeys: ['sp@4'], paramKeys: [] });
});

test('a slot inside callerParams is a PARAMETER, not an undefined local', () => {
  // The O32 shape: incoming stack arguments live above the frame and the caller wrote them, so
  // "no store of ours reaches it" says nothing about whether it holds a value.
  const ssa = readDefLess(stackSlotKey(20), () => ({ callerParams: { from: 16, to: 64 } }));
  expect(definedBy(ssa, stackSlotKey(20))).toEqual({ undefKeys: [], paramKeys: ['sp@20'] });
});

test('a slot in NEITHER range is refused — the rule does not trust the frontend that minted it', () => {
  // THE POINT OF THE DESIGN. A frontend can be wrong about its own frame — a `push` after the
  // reservation slides Thumb's window off the reserved area while it goes on claiming the slot is a
  // local. Checking the offset against the declared partition refuses a key the frontend should
  // never have minted, rather than believing it.
  expect(() => readDefLess(stackSlotKey(64), () => ({ ownedLocals: { from: 0, to: 8 } }))).toThrow(
    /sp@64 is read on a path that never stores it, and lies outside this function's frame partition/,
  );
  // …and the O32 hole the partition exists to express: the register-parameter home area is
  // CALLER-owned and is neither a local nor a stack parameter, so it falls in no range and refuses.
  expect(() =>
    readDefLess(stackSlotKey(8), () => ({ ownedLocals: { from: -32, to: 0 }, callerParams: { from: 16, to: 64 } })),
  ).toThrow(/lies outside this function's frame partition/);
});

test('claiming no partition refuses every slot, and leaves REGISTERS alone', () => {
  // The default, and what MIPS takes today. A frontend that has not made the argument gets the
  // decline; it does not get a silent reclassification of its registers as a side effect.
  expect(() => readDefLess(stackSlotKey(0), undefined)).toThrow(/lies outside this function's frame partition/);
  const ssa = readDefLess('a0', undefined);
  expect(definedBy(ssa, 'a0')).toEqual({ undefKeys: [], paramKeys: ['a0'] });
});

test('an EMPTY ownedLocals range refuses, so an unmeasurable frame cannot assert ownership', () => {
  // Thumb passes `{ from: 0, to: localArea }`, and `localArea` is 0 whenever the prologue walk
  // cannot measure the frame — so an unmeasurable frame collapses the range to empty and refuses
  // every slot, without the frontend having to notice.
  expect(() => readDefLess(stackSlotKey(0), () => ({ ownedLocals: { from: 0, to: 0 } }))).toThrow(
    /lies outside this function's frame partition/,
  );
});

// ── the REGISTER half ────────────────────────────────────────────────────────────────────────
// The same question in the other coordinate. What reaches the builder is one list, and the rule
// over it is flat: a key in `uninitRegs` read before any write is an uninitialised local. The two
// facts that put a key on that list — the ABI passes no argument there, and this function's
// prologue saved it — are the FRONTEND's to establish (thumb.ts `savedRegs`), for the same reason
// `ownedLocals` is a range and not a verdict. An unlisted register keeps its existing treatment;
// what DOES refuse is a partition that contradicts itself or declares only one side.
const ARM_ARGS = ['r0', 'r1', 'r2', 'r3'];

test('a register the ABI does not pass arguments in is an uninitialised local', () => {
  const ssa = readDefLess('r4', () => ({ uninitRegs: ['r4', 'r5'], argRegs: ARM_ARGS }));
  expect(definedBy(ssa, 'r4')).toEqual({ undefKeys: ['r4'], paramKeys: [] });
});

test('an ARGUMENT register is still a parameter', () => {
  const ssa = readDefLess('r0', () => ({ uninitRegs: ['r4', 'r5'], argRegs: ARM_ARGS }));
  expect(definedBy(ssa, 'r0')).toEqual({ undefKeys: [], paramKeys: ['r0'] });
});

test('a VIRTUAL key is never listed, so an incoming stack argument stays a parameter', () => {
  // Why the partition LISTS the uninitialised registers instead of deriving them as "everything
  // outside argRegs": the complement holds the frontends' virtual keys too, and Thumb's `@sarg<k>`
  // is a real incoming argument. A derived rule would have to know a key grammar this module does
  // not own; a list cannot make that mistake.
  const ssa = readDefLess('@sarg4', () => ({ uninitRegs: ['r4', 'r5'], argRegs: ARM_ARGS }));
  expect(definedBy(ssa, '@sarg4')).toEqual({ undefKeys: [], paramKeys: ['@sarg4'] });
});

test('an unlisted register keeps its existing treatment, so the list is safe to grow', () => {
  // `lr` is what ARMv4T leaves out — the return address, not a value a source could have declared.
  const ssa = readDefLess('lr', () => ({ uninitRegs: ['r4', 'r5'], argRegs: ARM_ARGS }));
  expect(definedBy(ssa, 'lr')).toEqual({ undefKeys: [], paramKeys: ['lr'] });
});

test('a key in BOTH halves is a target contradicting itself, and refuses', () => {
  // THE POINT OF DECLARING BOTH SIDES. `uninitRegs` asserts "no caller could have handed a value
  // over here"; `argRegs` is where callers hand values over. A key in both is not a hard case, it
  // is a target that cannot be true — and until the second list existed the silent outcome was a
  // DELETED PARAMETER: `r1` written where `r11` was meant emits `s32 uninit_r1;` in its place, and
  // nothing anywhere says so. `readRecursive` cannot catch it alone, because a read of an argument
  // register reaches the parameter path by falling through every other case.
  expect(() => readDefLess('r0', () => ({ uninitRegs: ['r0', 'r4'], argRegs: ARM_ARGS }))).toThrow(
    /lists r0 as BOTH an argument register and one the ABI does not pass arguments in/,
  );
  // …and it refuses on ANY function lifted with that target, not only one that reads the mis-listed
  // register: the model is checked where it is materialised, which every parameter read reaches.
  expect(() => readDefLess('r4', () => ({ uninitRegs: ['r0', 'r4'], argRegs: ARM_ARGS }))).toThrow(/BOTH/);
});

test('a register partition with only one side declared cannot be checked, and refuses', () => {
  expect(() => readDefLess('r4', () => ({ uninitRegs: ['r4'] }))).toThrow(
    /lists registers the ABI does not pass arguments in but not the ones it does/,
  );
  // Claiming NEITHER side is still fine — that is what MIPS takes, and it leaves registers alone.
  const ssa = readDefLess('r4', () => ({}));
  expect(definedBy(ssa, 'r4')).toEqual({ undefKeys: [], paramKeys: ['r4'] });
});
