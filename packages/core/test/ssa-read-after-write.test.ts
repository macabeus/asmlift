// `SsaBuilder.readAfterEveryReachingWrite`, the per-WRITE question frontend/call-plan.ts `leftover`
// asks of an argument register the call's own block did not write: did an instruction read the
// register after each write of it that reaches the call, on any path out of that write but the ones
// into the call? A copy (`add r4, r0, #0`) is such a read and lowers to no op, so only the frontend's
// own read (`readVar`) can answer it.
import { makeSsaBuilder } from '@asmlift/core/frontend/ssa';
import { type Block, mkOp, mkValue } from '@asmlift/core/ir/core';
import { T } from '@asmlift/core/ir/types';
import { expect, test } from 'vitest';

type Step = 'def' | 'read' | 'look' | 'arg' | 'call';

/** Blocks with these predecessors, the last one the call's, asked up to its last step. `steps` is
 *  what each block does to `r0`, in order: a write, the frontend's read (`readVar`), a lookup that is
 *  no instruction's read (`readGuessedArg`), a guessed call's argument read (`noteGuessedArgRead`),
 *  or a call that destroys it. Blocks are filled in order, but for the `unfilled` ones. */
const build = (
  preds: number[][],
  steps: Partial<Record<number, readonly Step[]>>,
  unfilled: readonly number[] = [],
) => {
  const n = preds.length;
  const ssa = makeSsaBuilder('f', n, preds, () => ({}));
  const b = ssa.irBlocks;
  const run = (i: number) => {
    for (const s of steps[i] ?? []) {
      if (s === 'def') {
        ssa.writeVar('r0', i, mkValue(T.unk(32)));
      } else if (s === 'read') {
        ssa.readVar('r0', i);
      } else if (s === 'look') {
        ssa.readGuessedArg('r0', i);
      } else if (s === 'arg') {
        ssa.noteGuessedArgRead('r0', i, ssa.readGuessedArg('r0', i));
      } else {
        ssa.noteCall(i, ['r0']);
      }
    }
  };
  for (let i = 0; i < n - 1; i++) {
    if (unfilled.includes(i)) {
      continue;
    }
    run(i);
    const to = b.filter((_, s) => preds[s].includes(i));
    b[i].ops.push(
      to.length === 1
        ? mkOp('br', { successors: [{ block: to[0], args: [] }] })
        : mkOp('cond_br', {
            operands: [mkValue(T.u())],
            successors: to.map((block: Block) => ({ block, args: [] })),
          }),
    );
    ssa.markFilled(i);
  }
  run(n - 1);
  return (passes: () => boolean = () => true, accept: () => boolean = () => true, unlowered = () => false) =>
    ssa.readAfterEveryReachingWrite('r0', n - 1, { passes, accept, unlowered });
};

// bb0 → bb1 | bb2 → bb3 → bb4, the call's block
const join = [[], [0], [0], [1, 2], [3]];

test('each case wrote r0 and the join copied it before the call: read after every write', () => {
  expect(build(join, { 1: ['def'], 2: ['def'], 3: ['read'] })()).toBe(true);
  expect(build(join, { 1: ['def', 'read'], 2: ['def', 'read'] })()).toBe(true);
  // the entry read the incoming value, which no block on the way wrote
  expect(build(join, { 0: ['read'] })()).toBe(true);
  // the entry's value, unread on the path that brings it, was written for nothing: bb1's read decides
  expect(build(join, { 1: ['def', 'read'] })()).toBe(true);
  expect(build(join, { 0: ['read'], 1: ['def'] })()).toBe(false);
});

test('a write nothing read since answers no: a copy made for the call in a predecessor', () => {
  expect(build(join, { 1: ['def'], 2: ['def'] })()).toBe(false);
  // one case read what it wrote (a store of it), the other wrote it for the call
  expect(build(join, { 1: ['def', 'read'], 2: ['def'] })()).toBe(false);
  // a read before the write is a read of an older write
  expect(build(join, { 0: ['read'], 1: ['def'], 2: ['def'] })()).toBe(false);
  expect(build(join, { 1: ['read', 'def'], 2: ['def'] })()).toBe(false);
  expect(build(join, {})()).toBe(false);
});

test("the call's own block is not asked: a save there says something different per compiler", () => {
  expect(build(join, { 1: ['def'], 2: ['def'], 4: ['read'] })()).toBe(false);
});

// bb0 → bb1 (another call) | bb2 (the call): bb0 sets r0 in the branch's delay slot for bb1's call
const sibling = [[], [0], [0]];

test("a sibling path's read counts, a guessed call's argument read included, a lookup not", () => {
  expect(build(sibling, { 0: ['def'], 1: ['read'] })()).toBe(true);
  expect(build(sibling, { 0: ['def'], 1: ['arg', 'call'] })()).toBe(true);
  expect(build(sibling, { 0: ['def'], 1: ['look'] })()).toBe(false);
  expect(build(sibling, { 0: ['def'], 1: ['def', 'read'] })()).toBe(false);
});

test('a call destroying r0 neither counts nor answers; a write the caller does not pass is skipped', () => {
  // what the call left there, read since, says nothing: bb2's own write decides
  expect(build(join, { 1: ['call', 'read'], 2: ['def', 'read'] })()).toBe(true);
  expect(build(join, { 1: ['call'], 2: ['def'] })()).toBe(false);
  expect(build(join, { 1: ['call'], 2: ['call'] })()).toBe(false);
  // bb2's write is one the caller never passes (a dispatch's marker): bb1's read decides
  let k = 0;
  expect(build(join, { 1: ['def', 'read'], 2: ['def'] })(() => k++ === 0)).toBe(true);
});

// bb0 → bb1 (a loop body that branches back to itself) → bb2, the call's block
test("a loop's back edge reads its own write at the body's top", () => {
  // `sh v0, 168(a1); …; bnez v0, top; addiu a1, a1, 16`: the bump is read round the loop
  expect(build([[], [0, 1], [1]], { 1: ['read', 'def'] })()).toBe(true);
  expect(build([[], [0, 1], [1]], { 1: ['def'] })()).toBe(false);
});

test("the read's value must be one the caller takes", () => {
  expect(build(join, { 1: ['def'], 2: ['def'], 3: ['read'] })(undefined, () => false)).toBe(false);
});

// bb0 → bb1 (a rotated loop's test, laid out after its body) → bb2 (the body, the call) → bb1
test('a block not filled yet is passed through looking for the write', () => {
  const rotated = [[], [0, 2], [1]];
  expect(build(rotated, { 0: ['def', 'read'] }, [1])()).toBe(true);
  expect(build(rotated, { 0: ['def'] }, [1])()).toBe(false);
  // …and a path out of a write into one has reads nobody has seen yet: the write's value answers
  expect(build(rotated, { 0: ['def'] }, [1])(undefined, undefined, () => true)).toBe(true);
  // bb0's write reaches the call (bb2) and an arm (bb1) not lowered yet, unread on the way to the call
  expect(build([[], [0], [0]], { 0: ['def'] }, [1])(undefined, undefined, () => true)).toBe(true);
});
