// THE ENTRY-STATE EQUALITY (ir/entry.ts `sameAtEntry`), which guard fusion and the peeled-test re-roll
// both read: is a test placed ahead of a loop the loop's own test on the loop's entry values?
import { expect, test } from 'vitest';

import { Op, Value } from '../src/ir/core';
import { sameAtEntry } from '../src/ir/entry';
import { parse } from '../src/ir/parse';

const FN = `fn entry {
^bb0(%0: u8*, %1: s32):
  %2: s32 = const {value=0}
  %3: s32 = load %0 {off=0, signed=false, width=1}
  %4: s32 = const {value=1}
  %5: s32 = add %1, %4
  %6: s32 = add %2, %4
  %7: u32 = icmp_ne %3, %2
  br ^bb1(%2)
^bb1(%8: s32):
  %9: u8* = add %8, %0
  %10: s32 = load %9 {off=0, signed=false, width=1}
  %11: u32 = icmp_eq %10, %2
  cond_br %11, ^bb2(), ^bb1(%8)
^bb2():
  ret %2
}`;

const setup = () => {
  const fn = parse(FN);
  const defs = new Map<Value, Op>();
  fn.blocks.forEach((b) => b.ops.forEach((op) => op.results.forEach((r) => defs.set(r, op))));
  const [b0, b1] = fn.blocks;
  const at = (b: typeof b0, k: number) => b.ops[k].results[0];
  return {
    defs,
    n: b0.params[1],
    zero: at(b0, 0),
    str0: at(b0, 1),
    nPlus1: at(b0, 3),
    zeroPlus1: at(b0, 4),
    str0ne: at(b0, 5),
    i: b1.params[0],
    strI: at(b1, 1),
    strIeq: at(b1, 2),
  };
};

test('`str[i]` at `i = 0` is `str[0]` once the identities are on, and not before', () => {
  const v = setup();
  const entry = new Map([[v.i, v.zero]]);
  expect(sameAtEntry(v.defs, v.strI, v.str0, { entry, normalize: true })).toBe(true);
  // guard fusion's reading: the `+ 0` folds only when the zero is written in the expression
  expect(sameAtEntry(v.defs, v.strI, v.str0, { entry })).toBe(false);
});

test('a test spelled the other way round is the loop’s own when negated', () => {
  const v = setup();
  const entry = new Map([[v.i, v.zero]]);
  expect(sameAtEntry(v.defs, v.strIeq, v.str0ne, { entry, normalize: true }, true)).toBe(true);
  expect(sameAtEntry(v.defs, v.strIeq, v.str0ne, { entry, normalize: true })).toBe(false);
});

test('a value outside `through` compares by identity: two loads elsewhere may read other memory', () => {
  const v = setup();
  const entry = new Map([[v.i, v.zero]]);
  expect(sameAtEntry(v.defs, v.strI, v.str0, { entry, normalize: true, through: () => false })).toBe(false);
});

test('the entry map applies on the loop side only, not again inside the value it substituted', () => {
  // `i` enters as `n + 1`; `n` is also mapped (a loop-invariant back-edge arg entering as 0). Read
  // again inside `n + 1`, it would make `i` at entry look like `0 + 1`.
  const v = setup();
  const entry = new Map([
    [v.i, v.nPlus1],
    [v.n, v.zero],
  ]);
  expect(sameAtEntry(v.defs, v.i, v.zeroPlus1, { entry })).toBe(false);
  expect(sameAtEntry(v.defs, v.i, v.nPlus1, { entry })).toBe(true);
});
