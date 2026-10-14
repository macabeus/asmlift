// `SsaBuilder.everyReachingDef`, the MUST question a recovered jump-table dispatch asks of a base it
// reads from outside its block (frontend/jump-table.ts): every path into the block brings a
// definition the predicate takes, and no call destroyed it on the way.
import { makeSsaBuilder } from '@asmlift/core/frontend/ssa';
import { type Block, type Value, mkOp, mkValue } from '@asmlift/core/ir/core';
import { T } from '@asmlift/core/ir/types';
import { expect, test } from 'vitest';

/** bb0 → bb1 (a loop header) → bb2 (its body, back to bb1) and bb1 → bb3. `write` puts what each
 *  block does to `r5`, in order: a value, or `'call'` for a call that destroys it. Returns the
 *  builder, filled, and the value bb0 wrote. */
const build = (write: Partial<Record<0 | 1 | 2, ReadonlyArray<'def' | 'call'>>>, fill = 4) => {
  const ssa = makeSsaBuilder('f', 4, [[], [0, 2], [1], [1]], () => ({}));
  const b = ssa.irBlocks;
  const br = (to: Block) => mkOp('br', { successors: [{ block: to, args: [] }] });
  const condBr = (x: Block, y: Block) =>
    mkOp('cond_br', {
      operands: [mkValue(T.u())],
      successors: [
        { block: x, args: [] },
        { block: y, args: [] },
      ],
    });
  let first: Value | undefined;
  const terms = [br(b[1]), condBr(b[2], b[3]), br(b[1]), mkOp('ret', { operands: [] })];
  for (let i = 0; i < fill; i++) {
    for (const w of write[i as 0 | 1 | 2] ?? []) {
      if (w === 'call') {
        ssa.noteCall(i, ['r5']);
      } else {
        const v = mkValue(T.unk(32));
        first ??= v;
        ssa.writeVar('r5', i, v);
      }
    }
    b[i].ops.push(terms[i]);
    ssa.markFilled(i);
  }
  return { ssa, first };
};

test('a definition before the loop reaches its header and body on every path', () => {
  const { ssa, first } = build({ 0: ['def'] });
  expect(ssa.everyReachingDef('r5', 1, (v) => v === first)).toBe(true);
  expect(ssa.everyReachingDef('r5', 2, (v) => v === first)).toBe(true);
});

test('a rewrite round the loop, a call that destroys it, or no definition at all answers no', () => {
  const rewrite = build({ 0: ['def'], 2: ['def'] });
  expect(rewrite.ssa.everyReachingDef('r5', 1, (v) => v === rewrite.first)).toBe(false);
  const call = build({ 0: ['def'], 2: ['call'] });
  expect(call.ssa.everyReachingDef('r5', 1, (v) => v === call.first)).toBe(false);
  // a call BEFORE the definition destroys nothing it brings
  const before = build({ 0: ['call', 'def'] });
  expect(before.ssa.everyReachingDef('r5', 1, (v) => v === before.first)).toBe(true);
  const none = build({});
  expect(none.ssa.everyReachingDef('r5', 1, () => true)).toBe(false);
});

test('it is not asked before every block is filled', () => {
  const { ssa, first } = build({ 0: ['def'] }, 2);
  expect(() => ssa.everyReachingDef('r5', 1, (v) => v === first)).toThrow(/before every block is filled/);
});
