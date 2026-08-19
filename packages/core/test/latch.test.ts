// Unit tests for empty-latch folding (src/raise/latch.ts) — the CFG cleanup that splices out a
// back-edge block SSA construction emptied by turning its register copy into an edge argument.
// Pure over the CFG: no frontend, no type recovery, no toolchain. Every refusal here has a POSITIVE
// CONTROL — an accepted fixture one fact away from it — so a test cannot pass because the fold was
// never reachable in the first place.
import { expect, test } from 'vitest';

import { dominators } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { foldEmptyLatches } from '../src/raise/latch';

/** `^bb2` is the empty latch: no params, one `br` back to the header `^bb1`, carrying the update. */
const LATCH = `fn f {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %1, %2
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb3(%3)
^bb2():
  br ^bb1(%3)
^bb3(%5: s32):
  ret %5
}
`;

test('an empty latch is spliced out and its edge args ride the predecessor edge', () => {
  const fn = parse(LATCH);
  expect(foldEmptyLatches(fn)).toBe(1);
  verify(fn);
  expect(fn.blocks.length).toBe(3);
  expect(print(fn)).toContain('cond_br %4, ^bb1(%3), ^bb2(%3)');
});

test('a PREHEADER is the same empty block and is refused — it dominates the header, not the reverse', () => {
  // ^bb1 guards the loop; ^bb2 is the empty preheader feeding the self-looping header ^bb3 its init.
  const fn = parse(`fn g {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %1, %0
  cond_br %2, ^bb2(), ^bb3(%1)
^bb2():
  br ^bb1(%1)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %5, %0
  cond_br %6, ^bb1(%5), ^bb3(%5)
^bb3(%7: s32):
  ret %7
}
`);
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('a block branching to ITSELF is refused — every block dominates itself', () => {
  const fn = parse(`fn h {
^bb0(%0: s32):
  br ^bb1()
^bb1():
  br ^bb1()
}
`);
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('a latch with a param is refused — its args are a join, not this edge’s copy', () => {
  const fn = parse(
    LATCH.replace('^bb2():\n  br ^bb1(%3)', '^bb2(%6: s32):\n  br ^bb1(%6)').replace('^bb2(), ', '^bb2(%3), '),
  );
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('a latch that does WORK is refused — the ops would be lost with the block', () => {
  const fn = parse(LATCH.replace('^bb2():\n  br ^bb1(%3)', '^bb2():\n  %6: s32 = const {value=9}\n  br ^bb1(%6)'));
  expect(foldEmptyLatches(fn)).toBe(0);
});

test('chained latches fold to a fixpoint, and every removal keeps dominance sound', () => {
  const fn = parse(`fn k {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %1, %2
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb4(%3)
^bb2():
  br ^bb3()
^bb3():
  br ^bb1(%3)
^bb4(%5: s32):
  ret %5
}
`);
  expect(foldEmptyLatches(fn)).toBe(2);
  verify(fn);
  expect(fn.blocks.length).toBe(3);
  // ^bb2 was not a latch on entry — its target ^bb3 does not dominate it. It becomes one only once
  // ^bb3 is gone, which is what iterating to a fixpoint buys.
  expect(print(fn)).toContain('cond_br %4, ^bb1(%3), ^bb2(%3)');
});

test('two edges into one block after a fold: loop recovery still declines, it does not emit', () => {
  // ^bb2's predecessor ^bb1 already branches to the target ^bb1, so folding leaves a terminator with
  // both edges continuing the loop — a block with no exit, which loop recovery refuses either way.
  const fn = parse(`fn dup {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=1}
  %3: s32 = add %1, %2
  %4: s32 = const {value=2}
  %5: s32 = add %1, %4
  %6: u32 = icmp_slt %3, %0
  cond_br %6, ^bb1(%3), ^bb2()
^bb2():
  br ^bb1(%5)
}
`);
  expect(foldEmptyLatches(fn)).toBe(1);
  verify(fn); // the args are still dominating defs — the fold cannot break SSA
  expect(print(fn)).toContain('cond_br %6, ^bb1(%3), ^bb1(%5)');
});

test('dominators: a latch is dominated by its header, a preheader is not', () => {
  const fn = parse(LATCH);
  const dom = dominators(fn);
  const [entry, header, latch] = fn.blocks;
  expect(dom.get(latch)!.has(header)).toBe(true);
  expect(dom.get(header)!.has(latch)).toBe(false);
  expect(dom.get(header)!.has(entry)).toBe(true);
});
