// The frame-object audit takes the frame partition as ranges, so a frame whose locals do not start
// at the frame base — O32's register-parameter home area at [0,16), PowerPC's linkage words at
// [0,8) — is judged by the same rules as Thumb's. Built IR, because no frontend but Thumb emits a
// `laddr` yet; the audit asks nothing of the frontend beyond these fields.
import { describe, expect, test } from 'vitest';

import { returnsWithoutHiddenPointer } from '../src/aggregate';
import { auditFrameObjects } from '../src/frontend/frame-objects';
import { type Block, type Op, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { ARMV4T_AGBCC, blockTransferRead, sourceControlRead, sourceReach } from '../src/target';

// `g` is declared to return nothing, so no hidden return pointer rides in its argument 0
const declaresNoHiddenPointer = (callee: string): boolean =>
  returnsWithoutHiddenPointer(callee, { g: { params: 1, returnsVoid: true } }, ARMV4T_AGBCC);

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
    returnsWithoutHiddenPointer: declaresNoHiddenPointer,
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

// `gp = &obj; g(&obj); p = c ? &obj : gOther; while (*p == 0);` — the access reaches the object
// through a phi, which the declaration's qualifier does not reach: the phi is a pointer local
// typed from the access. A holder of `gp` may set the byte, so the access carries the qualifier.
describe('an access through a phi that carries a published capture is volatile', () => {
  const published = (width: number): { blocks: Block[]; access: Op } => {
    const a = mkValue(T.unk(32));
    const gp = mkValue(T.unk(32));
    const p = mkValue(T.unk(32));
    const access = mkOp('load', { operands: [p], results: [mkValue(T.unk(32))], attrs: { off: 0, width } });
    const join: Block = { params: [p], ops: [access, mkOp('ret')] };
    const entry: Block = {
      params: [],
      ops: [
        mkOp('laddr', { results: [a], attrs: { off: 0 } }),
        mkOp('const', { results: [gp], attrs: { value: 0x03000000 } }),
        mkOp('store', { operands: [gp, a], attrs: { off: 0, width: 4 } }),
        mkOp('call', { operands: [a], attrs: { target: 'g' } }),
        mkOp('br', { successors: [{ block: join, args: [a] }] }),
      ],
    };
    return { blocks: [entry, join], access };
  };
  const run = (blocks: Block[], declared: number, oneObject?: { from: number; to: number }) =>
    auditFrameObjects({
      name: 'f',
      irBlocks: blocks,
      ownedLocals: { from: 0, to: declared },
      declaredLocals: { from: 0, to: declared },
      usedSlotOffsets: new Set(),
      capturedObjectIsTheWholeFrame: false,
      movedCaptures: new Set(),
      returnsWithoutHiddenPointer: declaresNoHiddenPointer,
      symbols: undefined,
      target: ARMV4T_AGBCC,
      oneObject,
    });

  test('kept as one object', () => {
    const { blocks, access } = published(1);
    expect(run(blocks, 8, { from: 0, to: 8 })).toEqual({ policy: 'one-object', sinks: [] });
    expect(access.attrs.volatile).toBe(true);
  });

  test('as its own object', () => {
    const { blocks, access } = published(4);
    expect(run(blocks, 4)).toEqual({ policy: 'per-object', sinks: [] });
    expect(blocks[0].ops[0].attrs.volatile).toBe(true);
    expect(access.attrs.volatile).toBe(true);
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
      returnsWithoutHiddenPointer: declaresNoHiddenPointer,
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
    expect(run(blk, [], { from: 0, to: 8 })).toEqual({ policy: 'one-object', sinks: [0x040000d4] });
    const object = blk.ops[0];
    expect(object.attrs).toMatchObject({ off: 0, width: 1, signed: false, count: 8 });
    // every member is spelled through a cast, which a qualifier on the array would not reach
    expect(object.attrs.volatile).toBeUndefined();
    const members = blk.ops.filter((op) => op.opcode === 'store' && op.operands[0] === object.results[0]);
    expect(members).toHaveLength(2);
    // a device that only reads changes no byte a re-read of the object returns
    expect(members.every((op) => op.attrs.volatile === undefined)).toBe(true);
  });

  // `vu8 buf[8]; gp = buf; g(buf); while (buf[0] == 0);` — the members are spelled through casts,
  // which drop the array's qualifier, so the qualifier a holder of `gp` needs is on each access
  test('kept, each access is volatile where the address is stored where a writer may hold it', () => {
    const { blk } = published([{ off: 0, width: 1 }]);
    const a = blk.ops[0].results[0];
    const gp = mkValue(T.unk(32));
    const ret = blk.ops.pop()!;
    blk.ops.push(
      mkOp('const', { results: [gp], attrs: { value: 0x03000000 } }),
      mkOp('store', { operands: [gp, a], attrs: { off: 0, width: 4 } }),
      mkOp('call', { operands: [a], attrs: { target: 'g' } }),
      mkOp('load', { operands: [a], results: [mkValue(T.unk(32))], attrs: { off: 0, width: 1, signed: false } }),
      ret,
    );
    expect(run(blk, [], { from: 0, to: 8 })).toEqual({ policy: 'one-object', sinks: [0x040000d4] });
    const object = blk.ops[0];
    const members = blk.ops.filter(
      (op) => (op.opcode === 'load' || op.opcode === 'store') && op.operands[0] === object.results[0],
    );
    expect(members.map((op) => op.opcode)).toEqual(['store', 'load']);
    expect(members.every((op) => op.attrs.volatile === true)).toBe(true);
  });

  test('a byte two widths reach is refused, since agbcc reads through casts by type', () => {
    const { blk } = published([
      { off: 0, width: 4 },
      { off: 2, width: 2 },
    ]);
    expect(() => run(blk, [], { from: 0, to: 8 })).toThrow('accessed 4 and 2 bytes wide');
  });

  // The device's source register is a reader, so the store into it adds no writer to the callee's
  test('an address a callee may write through, also handed to a device, is what the one object keeps', () => {
    const call = mkOp('call', { operands: [mkValue(T.unk(32))], attrs: { target: 'g' } });
    const { blk } = published([{ off: 0, width: 2 }], [call]);
    expect(run(blk, [], { from: 0, to: 8 })).toEqual({ policy: 'one-object', sinks: [0x040000d4] });
  });

  // …while an address stored to an ordinary global and handed to no callee has no holder to name
  test('an address stored to memory and passed to no callee is not what the one object keeps', () => {
    const { blk } = published([{ off: 0, width: 2 }]);
    const a = blk.ops[0].results[0];
    const gp = mkValue(T.unk(32));
    const ret = blk.ops.pop()!;
    blk.ops.push(
      mkOp('const', { results: [gp], attrs: { value: 0x03000000 } }),
      mkOp('store', { operands: [gp, a], attrs: { off: 0, width: 4 } }),
      ret,
    );
    expect(() => run(blk, [], { from: 0, to: 8 })).toThrow(
      'cannot hold every writer — the captured address at [sp,#0): the address is published rather than passed ' +
        'as an argument',
    );
  });
});

// The whole-area argument holds a store of the address only beside a callee that may write through
// it: a block transfer reading its source names no writer, so with or without one the frame decides
// as it does with none.
describe('a block transfer reading the object holds no published address', () => {
  const { CpuSet } = ARMV4T_AGBCC.capabilities.blockTransferCalls!;
  const declared = (callee: string): boolean =>
    returnsWithoutHiddenPointer(
      callee,
      { g: { params: 1, returnsVoid: true }, CpuSet: { params: 3, returnsVoid: true } },
      ARMV4T_AGBCC,
    );
  // `u8 buf[16]; gp = buf; <callee>(buf, gDst, 0x05000004);`
  const storedAndHanded = (callee: string): Block => {
    const a = mkValue(T.unk(32));
    const gp = mkValue(T.unk(32));
    const dst = mkValue(T.unk(32));
    const control = mkValue(T.unk(32));
    return {
      params: [],
      ops: [
        mkOp('laddr', { results: [a], attrs: { off: 0 } }),
        mkOp('const', { results: [gp], attrs: { value: 0x03000000 } }),
        mkOp('store', { operands: [gp, a], attrs: { off: 0, width: 4 } }),
        mkOp('const', { results: [dst], attrs: { value: 0x02000000 } }),
        mkOp('const', { results: [control], attrs: { value: 0x05000004 } }),
        mkOp('call', { operands: [a, dst, control], attrs: { target: callee } }),
        mkOp('ret'),
      ],
    };
  };
  const run = (blk: Block) =>
    auditFrameObjects({
      name: 'f',
      irBlocks: [blk],
      ownedLocals: { from: 0, to: 16 },
      declaredLocals: { from: 0, to: 16 },
      usedSlotOffsets: new Set(),
      capturedObjectIsTheWholeFrame: false,
      movedCaptures: new Set(),
      returnsWithoutHiddenPointer: declared,
      symbols: undefined,
      target: ARMV4T_AGBCC,
    });

  test('a published address a block transfer reads is not the whole area', () => {
    expect(CpuSet).toBeDefined();
    expect(() => run(storedAndHanded('CpuSet'))).toThrow(
      'the address is published, and the only callee handed it is a block transfer that reads through it',
    );
  });

  test('a published address a callee may write through is the whole area', () => {
    const blk = storedAndHanded('g');
    run(blk);
    expect(blk.ops[0].attrs).toMatchObject({ off: 0, width: 1, count: 16, volatile: true });
  });
});

// The GBA BIOS block transfers, decoded from the control words the vendored projects' `CPU_FILL`,
// `CPU_COPY` and `CPU_FAST_FILL` macros build (sa3 include/gba/cpuset_macros.h).
describe('a block-transfer call reads as far as its control word says', () => {
  const { CpuSet, CpuFastSet } = ARMV4T_AGBCC.capabilities.blockTransferCalls!;
  test.each([
    ['a 32-bit CpuSet fill of eight words reads one word', CpuSet, 0x05000008, { unit: 4, walk: 'fixed' }],
    ['a 16-bit CpuSet fill reads one halfword', CpuSet, 0x01000010, { unit: 2, walk: 'fixed' }],
    ['a 32-bit CpuSet copy reads every word it copies', CpuSet, 0x04000002, { unit: 4, walk: 'increment', bytes: 8 }],
    [
      'a 16-bit CpuSet copy reads every halfword it copies',
      CpuSet,
      0x00000003,
      { unit: 2, walk: 'increment', bytes: 6 },
    ],
    ['bits above the count are not a count', CpuSet, 0x04e00001, { unit: 4, walk: 'increment', bytes: 4 }],
    ['a CpuFastSet fill reads one word', CpuFastSet, 0x01000008, { unit: 4, walk: 'fixed' }],
    [
      'a CpuFastSet copy rounds its count up to eight words',
      CpuFastSet,
      0x00000009,
      { unit: 4, walk: 'increment', bytes: 64 },
    ],
  ] as const)('%s', (_, call, control, read) => {
    expect(blockTransferRead(call, control)).toEqual(read);
  });
});

// …and the DMA channel's control halfword decodes into the same read, so one rule turns either
// into frame bytes: the unit-aligned address at or below the object's, then the way it walks.
describe('a source read reaches the frame bytes its walk and unit say', () => {
  const control = ARMV4T_AGBCC.capabilities.readSourceControl!;
  const { CpuSet } = ARMV4T_AGBCC.capabilities.blockTransferCalls!;
  test.each([
    ['a 16-bit fixed DMA source reads its own halfword', 0x8100, 2, { lo: 0, hi: 2 }],
    ['a 32-bit fixed DMA source reads the word holding it', 0x8500, 2, { lo: -2, hi: 4 }],
    ['an incrementing DMA source reads every byte above it', 0x8000, 0, { lo: 0, hi: Infinity }],
    ['a decrementing DMA source reads every byte below it', 0x8080, 0, { lo: -Infinity, hi: 2 }],
  ] as const)('%s', (_, half, off, reach) => {
    expect(sourceReach(sourceControlRead(control, half)!, off)).toEqual(reach);
  });
  test('a prohibited DMA source mode bounds nothing', () => {
    expect(sourceControlRead(control, 0x8180)).toBeNull();
  });
  test('a CpuSet copy reads its count from the unit-aligned address', () => {
    expect(sourceReach(blockTransferRead(CpuSet, 0x04000002), 2)).toEqual({ lo: -2, hi: 8 });
  });
});
