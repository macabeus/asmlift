// `SsaBuilder.readSinceWriteOnSomePath`, the per-WRITE question frontend/call-plan.ts `leftover`
// asks of an argument register the call's own block did not write: on some path into the call, did
// an instruction read the register after its last write? A copy (`add r4, r0, #0`) is such a read
// and lowers to no op, so only the frontend's own read (`readVar`) can answer it.
import { makeSsaBuilder } from '@asmlift/core/frontend/ssa';
import { type Block, mkOp, mkValue } from '@asmlift/core/ir/core';
import { T } from '@asmlift/core/ir/types';
import { expect, test } from 'vitest';

type Step = 'def' | 'read' | 'look' | 'call';

/** A diamond: bb0 → bb1 | bb2 → bb3, the call's block. `steps` is what each block does to `r0`, in
 *  order: a write, the frontend's read (`readVar`), a lookup that is no instruction's read
 *  (`readGuessedArg`), or a call that destroys it. bb3 is asked up to its last step. */
const build = (steps: Partial<Record<0 | 1 | 2 | 3, readonly Step[]>>) => {
  const ssa = makeSsaBuilder('f', 4, [[], [0], [0], [1, 2]], () => ({}));
  const b = ssa.irBlocks;
  const br = (to: Block) => mkOp('br', { successors: [{ block: to, args: [] }] });
  const condBr = mkOp('cond_br', {
    operands: [mkValue(T.u())],
    successors: [
      { block: b[1], args: [] },
      { block: b[2], args: [] },
    ],
  });
  const terms = [condBr, br(b[3]), br(b[3])];
  for (let i = 0; i < 4; i++) {
    for (const s of steps[i as 0 | 1 | 2 | 3] ?? []) {
      if (s === 'def') {
        ssa.writeVar('r0', i, mkValue(T.unk(32)));
      } else if (s === 'read') {
        ssa.readVar('r0', i);
      } else if (s === 'look') {
        ssa.readGuessedArg('r0', i);
      } else {
        ssa.noteCall(i, ['r0']);
      }
    }
    if (i < 3) {
      b[i].ops.push(terms[i]);
      ssa.markFilled(i);
    }
  }
  return (accept: () => boolean = () => true) => ssa.readSinceWriteOnSomePath('r0', 3, accept);
};

test('a read after the last write on one path answers yes, a copy at the join included', () => {
  // each case wrote r0 and the join copied it (`add r4, r0, #0`) before the call
  expect(build({ 1: ['def'], 2: ['def'], 3: ['read'] })()).toBe(true);
  // one case read what it wrote (a store of it), the other did not
  expect(build({ 1: ['def', 'read'], 2: ['def'] })()).toBe(true);
  // the entry read the incoming value, which no block on the way wrote
  expect(build({ 0: ['read'] })()).toBe(true);
});

test('a write nothing read since answers no: a copy made for the call in a predecessor', () => {
  expect(build({ 1: ['def'], 2: ['def'] })()).toBe(false);
  // a read before the write is a read of an older write
  expect(build({ 0: ['read'], 1: ['def'], 2: ['def'] })()).toBe(false);
  expect(build({ 1: ['read', 'def'], 2: ['def'] })()).toBe(false);
});

test('a lookup is no read, a call ends the path, and the entry with nothing read answers no', () => {
  expect(build({ 1: ['def', 'look'], 2: ['def'], 3: ['look'] })()).toBe(false);
  expect(build({ 1: ['def', 'read', 'call'], 2: ['def'] })()).toBe(false);
  // what the call left there, read since, was read
  expect(build({ 1: ['call', 'read'], 2: ['def'] })()).toBe(true);
  expect(build({})()).toBe(false);
});

test("the read's value must be one the caller takes", () => {
  expect(build({ 1: ['def'], 2: ['def'], 3: ['read'] })(() => false)).toBe(false);
});
