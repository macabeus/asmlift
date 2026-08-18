// The frame partition (frontend/ssa.ts, FrameModel) is the rule that decides what a def-less
// live-in MEANS, and these exercise it directly on the builder rather than through a frontend.
//
// WHY AT THIS LEVEL. The rule's whole purpose is to be falsifiable INDEPENDENTLY of what a frontend
// believes about its own frame. Driving it through Thumb could only ever confirm that Thumb and the
// rule agree, which is the arrangement the rule replaced: the previous seam took a verdict
// (`'undef' | 'param' | 'refuse'`) from the frontend, so a frontend whose frame bound had silently
// stopped holding kept getting the answer it asserted. Handing the builder ranges and asking it
// directly is the only way to see the rule refuse a frontend that is wrong.
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
  // THE POINT OF THE WHOLE DESIGN. A frontend can be wrong about its own frame: this branch shipped
  // a bug where a `push` after the reservation slid Thumb's window off the reserved area while the
  // frontend went on claiming the slot was a local. Under the old verdict-passing seam the builder
  // had no way to disagree. Here the offset is checked against the declared partition, so a key the
  // frontend should never have minted is refused rather than believed.
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
  // cannot measure the frame. Passing the NUMBER rather than a verdict is what makes that
  // self-limiting: the range collapses to empty and every slot refuses, where a constant `'undef'`
  // would have gone on asserting a bound that had stopped holding.
  expect(() => readDefLess(stackSlotKey(0), () => ({ ownedLocals: { from: 0, to: 0 } }))).toThrow(
    /lies outside this function's frame partition/,
  );
});
