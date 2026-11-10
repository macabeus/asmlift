// `dominance` (src/ir/core.ts) is the bitset form of `dominators`: the same data-flow to the same
// greatest fixed point. raise/shortcircuit.ts's loop-exit gate reads it in place of the sets, so the
// two must answer alike on every CFG — reducible or not, with unreachable blocks and blocks no edge
// enters, at sizes past one 32-bit word.
import { expect, test } from 'vitest';

import { type Block, dominance, dominators, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';

/** A deterministic CFG of `n` blocks: each ends in a `ret`, a `br` or a `cond_br` to random blocks. */
function randomCfg(n: number, seed: number): { blocks: Block[] } {
  let state = seed;
  const rand = (k: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % k;
  };
  const blocks: Block[] = Array.from({ length: n }, () => ({ params: [], ops: [] }));
  for (const b of blocks) {
    const kind = rand(6);
    if (kind === 0) {
      b.ops.push(mkOp('ret'));
    } else if (kind <= 2) {
      b.ops.push(mkOp('br', { successors: [{ block: blocks[rand(n)], args: [] }] }));
    } else {
      b.ops.push(
        mkOp('cond_br', {
          operands: [mkValue(T.unk(32))],
          successors: [
            { block: blocks[rand(n)], args: [] },
            { block: blocks[rand(n)], args: [] },
          ],
        }),
      );
    }
  }
  return { blocks };
}

test('dominance answers every pair exactly as the dominator sets do', () => {
  let pairs = 0;
  for (const n of [1, 2, 3, 5, 8, 31, 32, 33, 64, 65, 97]) {
    for (let seed = 1; seed <= 12; seed++) {
      const fn = randomCfg(n, seed * 7919 + n);
      const sets = dominators(fn);
      const dominates = dominance(fn);
      for (const t of fn.blocks) {
        for (const h of fn.blocks) {
          expect(dominates(h, t)).toBe(sets.get(t)!.has(h));
          pairs++;
        }
      }
    }
  }
  expect(pairs).toBeGreaterThan(50_000);
});

test('a block outside the function dominates nothing and is dominated by nothing', () => {
  const fn = randomCfg(4, 3);
  const stranger: Block = { params: [], ops: [mkOp('ret')] };
  const dominates = dominance(fn);
  expect(dominates(stranger, fn.blocks[0])).toBe(false);
  expect(dominates(fn.blocks[0], stranger)).toBe(false);
});
