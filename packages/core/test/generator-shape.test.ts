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

test('depth 2 reaches a loop inside a loop', () => {
  const { structured, loops } = census(2, 2);
  expect(structured).toBeGreaterThan(3000); // measured 3,776
  expect(loops).toBeGreaterThan(2000); // measured 3,776
});

// The shape depth 3 exists for. `latchInnerSub` filters a do-while's child loops and then applies
// their back-edge substitutions IN AN ORDER; with one child, the filter has nothing to exclude and
// the order is not an order. Depth 2 produces exactly one child on every seed that structures
// (measured: 4,000 calls with one child, 0 with two). Depth 3 produces two on every one of them.
test('depth 3 reaches a do-while with SEVERAL child loops', () => {
  const { structured, loops } = census(3, 3);
  expect(structured).toBeGreaterThan(3000); // measured 3,449 of 4,000
  expect(loops).toBeGreaterThan(3000); // measured 3,449 — every seed that structures at all
});
