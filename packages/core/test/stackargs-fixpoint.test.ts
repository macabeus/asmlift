// THE OUTGOING-ARGUMENT FIXPOINT, tested on its own rather than through a lift.
//
// `frontend/stackargs.ts` reads digested events, so a fixture here is a table of stores, loads and
// calls over a CFG — no Thumb, no prototypes, no decoder. That is the point of the split: the
// fixpoint is the part of the licence most likely to be wrong, and asserting it through
// `decompile()` means regexing a rendered message and reaching only the shapes agbcc happens to
// emit. Every case below states which of the three SETS — may, must, stored — decides it.
import { describe, expect, test } from 'vitest';

import { type StackArgsBlock, type StackArgsEvent, analyzeOutgoingArgs } from '../src/frontend/stackargs';

type Ev = StackArgsEvent<string>;
const st = (off: number): Ev => ({ kind: 'store', off });
const ld = (off: number): Ev => ({ kind: 'load', off });
/** A call taking `n` stack words; `n` 0 means nothing declares it (indirect, or no prototype). */
const call = (name: string, n: number): Ev => ({
  kind: 'call',
  call: name,
  callee: name,
  declared: n === 0 ? null : Array.from({ length: n }, (_, i) => 4 * i),
});
const blk = (events: Ev[]): StackArgsBlock<string> => ({ events });

const run = (blocks: StackArgsBlock<string>[], preds: number[][], localArea: number, capturedWholeFrame = false) =>
  analyzeOutgoingArgs<string>({
    blocks,
    preds,
    live: new Set(blocks.map((_, i) => i)),
    localArea,
    argRegs: 4,
    capturedWholeFrame,
  });
/** A straight line of blocks, each falling through to the next; the last one ends the function. */
const line = (...events: Ev[][]) => events.map(blk);
const chain = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? [] : [i - 1]));

describe('the MUST set decides “nothing missing”, and it is an intersection over predecessors', () => {
  test('a store in both arms of a diamond licenses the call in the join', () => {
    const r = run([blk([]), blk([st(0)]), blk([st(0)]), blk([call('five', 1)])], [[], [0], [0], [1, 2]], 4);
    expect(r.blocker).toBeNull();
    expect(r.blocks.get('five')).toEqual([0]);
    expect(r.area).toBe(4);
  });

  test('…and one arm not storing is a word the callee reads off a path that never wrote it', () => {
    const r = run([blk([]), blk([st(0)]), blk([]), blk([call('five', 1)])], [[], [0], [0], [1, 2]], 4);
    expect(r.blocker).toMatch(/\[sp,#0\] is not stored on every path to the call/);
    expect(r.area).toBe(0);
  });

  test('a store INSIDE a loop is not on every path to a call in the loop header', () => {
    // Iteration 1 reaches the call with nothing staged. The back edge is the only predecessor that
    // stores, so the intersection over predecessors drops the slot — the answer a per-block or
    // flat-listing scan gets wrong.
    const r = run([blk([]), blk([call('five', 1)]), blk([st(0)]), blk([])], [[], [0, 2], [1], [1]], 4);
    expect(r.blocker).toMatch(/\[sp,#0\] is not stored on every path to the call/);
  });

  test('a store BEFORE the loop, with the call inside it, is killed by the first iteration', () => {
    // The call consumes the block, so the second iteration arrives with it unstaged. This is the
    // one place the model already behaves as if the call ended the word's life.
    const r = run([blk([st(0)]), blk([call('five', 1)]), blk([])], [[], [0, 1], [1]], 4);
    expect(r.blocker).toMatch(/\[sp,#0\] is not stored on every path to the call/);
  });
});

describe('the MAY set decides “nothing extra”, and it is a union over predecessors', () => {
  test('a word staged on ONE path only still refuses the declaration that omits it', () => {
    // The variadic hole, path-sensitively: [sp,#4] reaches the call on one arm. The weakest thing
    // that could still be a word this call takes must be inside the declared block.
    const r = run([blk([st(0)]), blk([st(4)]), blk([]), blk([call('five', 1)])], [[], [0], [0], [1, 2]], 8);
    expect(r.blocker).toMatch(/\[sp,#4\] also reaches the call unread/);
  });

  test('…and a load on every path back out of the may set lets the call through', () => {
    const r = run([blk([st(0)]), blk([st(4), ld(4)]), blk([ld(4)]), blk([call('five', 1)])], [[], [0], [0], [1, 2]], 8);
    // The load is also the thing that refuses: [sp,#4] is not licensed, so it is a real local, and
    // the store to [sp,#0] beneath it is licensed. Both are consistent, and the lift is allowed.
    expect(r.blocker).toBeNull();
    expect(r.blocks.get('five')).toEqual([0]);
  });

  test('a load off a LICENSED offset refuses — the callee owns that word across the call', () => {
    const r = run(line([st(0), call('five', 1), ld(0)]), chain(1), 4);
    expect(r.blocker).toMatch(/\[sp,#0\] is an outgoing stack-argument slot .* but this function also LOADS it/);
  });
});

describe('a licensed call consumes its block, which is what lets one frame serve several calls', () => {
  test('two sequential calls each take their own staging store', () => {
    const r = run(line([st(0), call('a', 1), st(0), call('b', 1)]), chain(1), 4);
    expect(r.blocker).toBeNull();
    expect(r.blocks.get('a')).toEqual([0]);
    expect(r.blocks.get('b')).toEqual([0]);
    expect(r.area).toBe(4);
  });

  test('a wider call sets the area for the whole frame', () => {
    const r = run(line([st(0), st(4), st(8), call('wide', 3), st(0), call('five', 1)]), chain(1), 12);
    expect(r.blocker).toBeNull();
    expect(r.area).toBe(12);
  });

  test('a store the second call does not consume is still staged where the function ends', () => {
    const r = run(line([st(0), call('five', 1), st(0)]), chain(1), 4);
    expect(r.blocker).toMatch(/is still staged where this function ends/);
  });

  test('…and the check reads the CFG, not a terminator classification', () => {
    // The exit block ends in no call, no store and no branch; nothing named it a return. What
    // makes it the end is that no live block lists it as a predecessor.
    const r = run([blk([st(0), call('five', 1), st(0)]), blk([])], [[], [0]], 4);
    expect(r.blocker).toMatch(/is still staged where this function ends/);
  });

  test('ESCAPE, pinned: a path that never ends keeps the word pending and nothing here refuses', () => {
    // Every block of an infinite loop has a live successor, so "where the function ends" is
    // nowhere and the leftover store is invisible to this check. The loud answer survives, but it
    // comes from ANOTHER family: lifting `str r1,[sp]` after a licensed `bl` into `.L1: b .L1`
    // declines at L2 with "unrecovered back-edge into block #1". Closing it here needs a backward
    // "can this word still be consumed?" pass, which no row in the corpus asks for.
    const r = run([blk([st(0), call('five', 1), st(0)]), blk([])], [[], [0, 1]], 4);
    expect(r.blocker).toBeNull();
    expect(r.blocks.get('five')).toEqual([0]);
  });
});

describe('an undeclared call can only ever refuse', () => {
  test('a pending store reaching an indirect call refuses rather than guessing its arity', () => {
    // The later load is what keeps the whole-function condition (a) quiet, so this reaches the
    // PATH condition: the word is staged when the indirect call executes, and nothing here can
    // size a block for a callee with no declaration.
    const r = run(line([st(0), call('r3', 0), ld(0)]), chain(1), 4);
    expect(r.blocker).toMatch(/reaches `bl r3` unread with its lower slots supplied/);
  });

  test('…but an indirect call AFTER a licensed one is unaffected', () => {
    const r = run(line([st(0), call('five', 1), call('r3', 0)]), chain(1), 4);
    expect(r.blocker).toBeNull();
    expect(r.blocks.has('r3')).toBe(false);
  });

  test('a function with no call at all licenses nothing and blocks nothing', () => {
    const r = run(line([st(0)]), chain(1), 4);
    expect(r).toEqual({ blocker: null, blocks: new Map(), area: 0 });
  });
});

describe('the contiguity filter, and the frames that refuse outright', () => {
  test('a never-reloaded store whose lower slots are nowhere supplied is a local, not an argument', () => {
    // kleod's ProcessInputAndUpdateEntities shape: a spill at [sp,#4] with offset 0 never stored.
    const r = run(line([st(4), call('one', 0)]), chain(1), 8);
    expect(r.blocker).toBeNull();
  });

  test('…and with the lower slot supplied it is a plausible argument block, so it refuses', () => {
    const r = run([blk([st(0)]), blk([st(4), call('one', 0)])], [[], [0]], 8);
    expect(r.blocker).toMatch(/the store to \[sp,#0\] is never reloaded and its lower slots are supplied/);
  });

  test('a one-word frame that is an addressable object cannot also be a callee’s argument slot', () => {
    const r = run(line([st(0), call('five', 1)]), chain(1), 4, true);
    expect(r.blocker).toMatch(/one-word frame is an object whose address escapes the function/);
  });

  test('a captured one-word frame with no declared 5th argument still lifts', () => {
    const r = run(line([st(0), call('one', 0)]), chain(1), 4, true);
    expect(r).toEqual({ blocker: null, blocks: new Map(), area: 0 });
  });
});

describe('the fixpoint terminates and does not depend on block order', () => {
  test('an irreducible two-headed loop converges, and both orderings agree', () => {
    const blocks = [blk([st(0)]), blk([]), blk([]), blk([call('five', 1)])];
    const preds = [[], [0, 2], [1], [1, 2]];
    const forward = run(blocks, preds, 4);
    // The same CFG with the two arms swapped: a flat-listing scan let BLOCK ORDER decide this.
    const swapped = run([blocks[0], blocks[1], blocks[2], blocks[3]], [[], [2, 0], [1], [2, 1]], 4);
    expect(forward.blocker).toBe(swapped.blocker);
    expect(forward.blocker).toBeNull();
  });

  test('a DEAD call refuses, naming the slot it never saw staged', () => {
    const r = analyzeOutgoingArgs<string>({
      blocks: [blk([st(0), call('five', 1)]), blk([call('five2', 1)])],
      preds: [[], []],
      live: new Set([0]),
      localArea: 4,
      argRegs: 4,
      capturedWholeFrame: false,
    });
    expect(r.blocker).toMatch(/\[sp,#0\] is not stored on every path to the call/);
  });
});
