// A BLOCK PARAMETER EVERY EDGE HANDS ONE PURE EXPRESSION (raise/unpre.ts) — agbcc's gcse PRE puts a
// loop's `i + 1` on the switch edge and keeps a falling arm's own sum in the same register, so the
// case fallen into takes `i + 1` from both edges. The fold recomputes it in the block.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { PRE_STRUCTURE_FOLDS } from '../src/raise/pre-structure';
import { recomputeRedundantParams } from '../src/raise/unpre';
import { structure } from '../src/structure/structure';

// `case 0:` falls into `case 1:`; the dispatch hands `case 1:` `a0` and `a0 + 1`, and `case 0:` hands
// it what `fallArgs` names. `%5` is `case 0:`'s own `a0 + 1`, `%6` the constant 9, `%11` a load.
const fallIr = (fallArgs: string, dispatchSum = '%3') => `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %0, %2
  %10: s32 = load %0 {off=0, signed=true, width=4}
  switch_br %1, ^bb1(), ^bb2(%0, ${dispatchSum}), ^bb3() {cases=[0;1]}
^bb1():
  %4: s32 = const {value=1}
  %5: s32 = add %0, %4
  %6: s32 = const {value=9}
  %11: s32 = load %0 {off=0, signed=true, width=4}
  br ^bb2(${fallArgs})
^bb2(%7: s32, %8: s32):
  %9: s32 = call %7, %8 {target="side2"}
  br ^bb3()
^bb3():
  ret
}
`;
const fold = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = recomputeRedundantParams(fn);
  verify(fn);
  return { n, fn, emit: () => cBackend.emit(structure(fn, { returnsVoid: true })) };
};

test('both edges hand the parameter `a0 + 1`: it is recomputed in the block and the fall-through lifts', () => {
  const { n, fn, emit } = fold(fallIr('%0, %5'));
  expect(n).toBe(1);
  expect(fn.blocks[2].params).toHaveLength(1);
  expect(emit()).toMatch(/case 0:\s*case 1:\s*side2\(a0, a0 \+ 1\);/);
});

test('a different value from one edge is a real join, and the switch-edge copy still refuses', () => {
  const { n, emit } = fold(fallIr('%0, %6'));
  expect(n).toBe(0);
  expect(emit).toThrow(/takes a value from the switch edge/);
});

test('equal loads are not recomputed: memory may change between the edge and the block', () => {
  const { n, emit } = fold(fallIr('%0, %11', '%10'));
  expect(n).toBe(0);
  expect(emit).toThrow(/takes a value from the switch edge/);
});

test('a recomputed leaf keeps its own name where the falling edge sets the parameter beside it', () => {
  // `case 0:` hands the first parameter 9: the recomputed `a0 + 1` reads `a0`, which is live beside
  // that parameter in `case 1:`, so the parameter needs a name of its own — whose switch-edge copy
  // `v = a0;` the fall path would re-run over the 9. That refusal is the one the structurer owes.
  const { n, emit } = fold(fallIr('%6, %5'));
  expect(n).toBe(1);
  expect(emit).toThrow(/takes a value from the switch edge/);
});

test('a case parameter both edges hand one constant is left to the passes that spell merges of constants', () => {
  const { n } = fold(fallIr('%0, %6', '%2'));
  expect(n).toBe(0);
});

// The two arms of an `if` each compute `a0 << 2` and merge it, as agbcc does where the source wrote
// the sum in each arm (pointer-word-temp.test.ts's pokeemerald shape). Recomputed at every join, the
// full bench loses two MATCHes (raise/unpre.ts's header has the measurement).
const IF_JOIN = `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: s32 = const {value=2}
  %5: s32 = shl %0, %4
  br ^bb3(%5)
^bb2():
  %6: s32 = const {value=2}
  %7: s32 = shl %0, %6
  br ^bb3(%7)
^bb3(%8: s32):
  %9: s32 = call %8 {target="side1"}
  ret
}
`;

test('an ordinary join is not a case fallen into, and keeps its parameter (the scope gate)', () => {
  expect(fold(IF_JOIN).n).toBe(0);
  // the same IR with the gate lifted: the fold's own precondition holds there
  const fn = parse(IF_JOIN);
  expect(recomputeRedundantParams(fn, { everyJoin: true })).toBe(1);
  verify(fn);
});

test('the fold runs last in the pre-structure record', () => {
  expect(PRE_STRUCTURE_FOLDS.map((f) => f.id).at(-1)).toBe('unpre');
});
