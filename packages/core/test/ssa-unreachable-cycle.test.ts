// A cycle of blocks each with ONE predecessor, the other's: no edge enters it, so no path from the
// entry does. agbcc leaves one behind a loop it proved never runs (`while (u & 1)` with `u` a known
// even constant). A read that reaches it from a live join walks round it (frontend/ssa.ts,
// `readRecursive`'s single-predecessor case), and the key is the uninitialised read's `undef` there.
import { makeSsaBuilder } from '@asmlift/core/frontend/ssa';
import { type Block, mkOp, mkValue, reachableBlocks } from '@asmlift/core/ir/core';
import { T } from '@asmlift/core/ir/types';
import { verify } from '@asmlift/core/ir/verify';
import { expect, test } from 'vitest';

/** bb0 → bb3; bb1 ⇄ bb2, each also branching to bb3; bb3 reads `r0`. With `entryInCycle`, bb0 is
 *  bb2's predecessor instead of bb1, so the cycle runs through the entry. */
const build = (entryInCycle = false) => {
  const preds = entryInCycle ? [[2], [0], [1], [1, 2]] : [[], [2], [1], [0, 1, 2]];
  const ssa = makeSsaBuilder('f', 4, preds, () => ({}));
  const b = ssa.irBlocks;
  const br = (to: Block) => mkOp('br', { successors: [{ block: to, args: [] }] });
  const condBr = (x: Block, y: Block, from: number) => {
    const c = mkValue(T.u());
    b[from].ops.push(mkOp('icmp_eq', { operands: [ssa.readVar('r1', from), ssa.readVar('r2', from)], results: [c] }));
    return mkOp('cond_br', {
      operands: [c],
      successors: [
        { block: x, args: [] },
        { block: y, args: [] },
      ],
    });
  };
  b[0].ops.push(entryInCycle ? br(b[1]) : br(b[3]));
  ssa.markFilled(0);
  b[1].ops.push(condBr(b[3], b[2], 1));
  ssa.markFilled(1);
  b[2].ops.push(entryInCycle ? condBr(b[3], b[0], 2) : condBr(b[3], b[1], 2));
  ssa.markFilled(2);
  b[3].ops.push(mkOp('ret', { operands: [ssa.readVar('r0', 3)] }));
  ssa.markFilled(3);
  ssa.finish();
  return ssa;
};

test('a read that walks round an unreachable single-predecessor cycle is undef there', () => {
  const ssa = build();
  verify(ssa.fn);
  const undefs = ssa.irBlocks.flatMap((bb) => bb.ops).filter((o) => o.opcode === 'undef');
  expect(undefs.map((o) => o.attrs.key)).toEqual(['r0']);
  expect(reachableBlocks(ssa.fn).has(ssa.irBlocks.find((bb) => bb.ops.includes(undefs[0]))!)).toBe(false);
  expect(ssa.irBlocks[0].params.map((p) => ssa.paramReg.get(p))).toContain('r0');
});

test('the same walk through the entry block declines, naming the read', () => {
  expect(() => build(true)).toThrow(/r0 is read in a cycle through the entry block/);
});
