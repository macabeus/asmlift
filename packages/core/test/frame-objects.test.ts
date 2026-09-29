// The frame-object audit takes the frame partition as ranges, so a frame whose locals do not start
// at the frame base — O32's register-parameter home area at [0,16), PowerPC's linkage words at
// [0,8) — is judged by the same rules as Thumb's. Built IR, because no frontend but Thumb emits a
// `laddr` yet; the audit asks nothing of the frontend beyond these fields.
import { describe, expect, test } from 'vitest';

import { auditFrameObjects } from '../src/frontend/frame-objects';
import { type Block, type Op, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { ARMV4T_AGBCC } from '../src/target';

// `laddr off` handed to `callee` at argument 0, stored through first when `written`
const frame = (off: number, callee: string, written: boolean): { blk: Block; object: Op } => {
  const a = mkValue(T.unk(32));
  const v = mkValue(T.unk(32));
  const object = mkOp('laddr', { results: [a], attrs: { off } });
  const store = mkOp('store', { operands: [a, v], attrs: { off: 0, width: 4 } });
  const blk: Block = {
    params: [v],
    ops: [object, ...(written ? [store] : []), mkOp('call', { operands: [a], attrs: { target: callee } }), mkOp('ret')],
  };
  return { blk, object };
};

const audit = (blk: Block, owned: [number, number], declared: [number, number]) =>
  auditFrameObjects({
    name: 'f',
    irBlocks: [blk],
    ownedLocals: { from: owned[0], to: owned[1] },
    declaredLocals: { from: declared[0], to: declared[1] },
    usedSlotOffsets: new Set(),
    capturedObjectIsTheWholeFrame: false,
    movedCaptures: new Set(),
    prototypes: { g: { params: 1, returnsVoid: true } },
    symbols: undefined,
    target: ARMV4T_AGBCC,
  });

describe('the audit reads the frame partition as ranges', () => {
  // `s32 x; x = a0; g(&x);` — the writer-escape arm, which accounts for every owned word
  test.each([
    ['at the frame base', 0, [0, 4]],
    ['above an O32 home area', 16, [16, 20]],
  ] as const)('a scalar handed to a writer %s is one word', (_, off, range) => {
    const { blk, object } = frame(off, 'g', true);
    audit(blk, [...range], [...range]);
    expect(object.attrs).toMatchObject({ off, width: 4, count: 1 });
  });

  // `u8 buf[16]; fill(buf);` — the untyped arm, sized by the declared range
  test.each([
    ['at the frame base', 0, [0, 16]],
    ['above PowerPC linkage words', 8, [8, 24]],
  ] as const)('a buffer only a callee fills %s is the declared range', (_, off, range) => {
    const { blk, object } = frame(off, 'g', false);
    audit(blk, [...range], [...range]);
    expect(object.attrs).toMatchObject({ off, width: 1, count: 16 });
  });

  test('an address below the owned range is not a local', () => {
    const { blk } = frame(8, 'g', true);
    expect(() => audit(blk, [16, 24], [16, 24])).toThrow('the object at [sp,#8) of width 4 lies outside');
  });
});

// A device READ nothing bounds keeps the local area in memory rather than refusing: the audit
// answers with the bytes to keep, and judges them as one object when the frontend lifts again.
describe('an unbounded device read keeps the local area as one object', () => {
  // `laddr 0` published to DMA3SAD with no control word written: the device may read anything
  const published = (accesses: { off: number; width: number }[], extra: Op[] = []): { blk: Block; object: Op } => {
    const a = mkValue(T.unk(32));
    const sad = mkValue(T.unk(32));
    const v = mkValue(T.unk(32));
    const object = mkOp('laddr', { results: [a], attrs: { off: 0 } });
    const blk: Block = {
      params: [v],
      ops: [
        object,
        ...accesses.map(({ off, width }) => mkOp('store', { operands: [a, v], attrs: { off, width } })),
        mkOp('const', { results: [sad], attrs: { value: 0x040000d4 } }),
        mkOp('store', { operands: [sad, a], attrs: { off: 0, width: 4 } }),
        ...extra.map((op) => ({ ...op, operands: op.operands.map(() => a) })),
        mkOp('ret'),
      ],
    };
    return { blk, object };
  };
  const run = (blk: Block, slots: number[], oneObject?: { from: number; to: number }) =>
    auditFrameObjects({
      name: 'f',
      irBlocks: [blk],
      ownedLocals: { from: 0, to: 8 },
      declaredLocals: { from: 0, to: 8 },
      usedSlotOffsets: new Set(slots),
      capturedObjectIsTheWholeFrame: false,
      movedCaptures: new Set(),
      prototypes: { g: { params: 1, returnsVoid: true } },
      symbols: undefined,
      target: ARMV4T_AGBCC,
      oneObject,
    });

  test('a slot the read reaches asks for the local area to be kept', () => {
    expect(run(published([{ off: 0, width: 2 }]).blk, [4])).toEqual({ oneObject: { from: 0, to: 8 } });
  });

  test('kept, the accesses are members of one byte array', () => {
    const { blk } = published([
      { off: 0, width: 2 },
      { off: 4, width: 4 },
    ]);
    expect(run(blk, [], { from: 0, to: 8 })).toBeUndefined();
    const object = blk.ops[0];
    expect(object.attrs).toMatchObject({ off: 0, width: 1, signed: false, count: 8, volatile: true });
    expect(blk.ops.filter((op) => op.opcode === 'store' && op.operands[0] === object.results[0])).toHaveLength(2);
  });

  test('a byte two widths reach is refused, since agbcc reads through casts by type', () => {
    const { blk } = published([
      { off: 0, width: 4 },
      { off: 2, width: 2 },
    ]);
    expect(() => run(blk, [], { from: 0, to: 8 })).toThrow('accessed 4 and 2 bytes wide');
  });

  test('an address a callee may write through is not what the one object keeps', () => {
    const call = mkOp('call', { operands: [mkValue(T.unk(32))], attrs: { target: 'g' } });
    const { blk } = published([{ off: 0, width: 2 }], [call]);
    expect(() => run(blk, [], { from: 0, to: 8 })).toThrow('a callee or a store may write through');
  });
});
