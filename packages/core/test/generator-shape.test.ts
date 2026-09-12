// THE SHAPES `generateSsaFn` ACTUALLY REACHES — the assertion a differential fuzz cannot make about
// itself.
//
// A fuzz that never reaches a shape proves nothing about the rules that read it, and it says so in
// exactly the same green tick as a fuzz that reaches it 4,000 times. This project has paid for that
// twice: a `carrier-write` sweep fired 0 times in 10,427 functions, and the enclosing loop's
// multi-child latch was reached 2 times in 187,117 generator calls — which is why three rules of
// `latchInnerSub` could each be deleted with the whole core suite green.
//
// So the generator's own reach is a test. The numbers below are floors measured on this stream, not
// targets: they exist so that a change to the generator that quietly stops producing a shape
// reddens here rather than turning a sibling fuzz into a green no-op.
//
// REACH IS NOT COVERAGE, and this file reports the larger of the two numbers. `structured` counts
// the seeds that produce a tree at all; how many any ASSERTION is then made about is the `judged`
// count the fuzz arms pin, and at depth 3 that is 647 of 4,000 — 5.3x below the 3,449 asserted
// here, because the tree interpreter's step cap eats 2,802 of them. Cite 647, not 3,449, for what
// the multi-child sweeps actually judge. Nor does reaching a rule witness it: all three
// `latchInnerSub` child rules are reached on every depth-3 seed and are byte-inert under mutation
// (`helpers.ts`'s generator docblock carries the measurement).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { count, generateSsaFn } from './helpers';

const SEEDS = 4000;

/** How many of `SEEDS` structure at all, and of those how many emit `want` bottom-tested loops. */
const census = (depth: 0 | 1 | 2 | 3, want: number): { structured: number; loops: number } => {
  let structured = 0;
  let loops = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    let src: string;
    try {
      const fn = generateSsaFn(seed, depth);
      verify(fn);
      recoverTypes(fn);
      src = cBackend.emit(structure(fn, {}));
    } catch {
      continue; // a decline is not a shape
    }
    structured++;
    if (count(src, 'do {') >= want) {
      loops++;
    }
  }
  return { structured, loops };
};

// PINNED, not floored, and that is the point of the file. The consumers one level downstream pin
// `judged` to the unit; a producer asserted at `> 3000` against a measured 3,776 has 13% of slack in
// which the generator can quietly stop building a shape while every sibling fuzz stays green with a
// smaller population — the exact vacuity this file exists to refuse, held to a looser bar at the
// place it is PRODUCED than at the place it is read. Re-derive by running this file: the assertion
// message carries the number.
test('depth 2 reaches a loop inside a loop', () => {
  const { structured, loops } = census(2, 2);
  expect(structured, 'seeds that structure at depth 2').toBe(3776);
  expect(loops, 'of those, seeds emitting >= 2 bottom-tested loops').toBe(3776);
});

// The shape depth 3 exists for. `latchInnerSub` filters a do-while's child loops and then applies
// their back-edge substitutions IN AN ORDER; with one child, the filter has nothing to exclude and
// the order is not an order. Depth 2 produces exactly one child on every seed that structures
// (measured: 4,000 calls with one child, 0 with two). Depth 3 produces two on every one of them —
// which is reach, and reach only: see this file's header.
test('depth 3 reaches a do-while with SEVERAL child loops', () => {
  const { structured, loops } = census(3, 3);
  expect(structured, 'seeds that structure at depth 3').toBe(3449);
  expect(loops, 'of those, seeds emitting >= 3 bottom-tested loops — every one').toBe(3449);
});
