// The frame-object audit's stages, each driven on built IR through the real stages before it —
// the inputs `auditFrameObjects` hands each one. `frame-objects.test.ts` drives the audit whole.
import { describe, expect, test } from 'vitest';

import { returnsWithoutHiddenPointer } from '../src/aggregate';
import { type FrameRange, __testing, auditFrameObjects } from '../src/frontend/frame-objects';
import { type Block, type Op, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { ARMV4T_AGBCC } from '../src/target';

const {
  addressFlow,
  chooseFrameModel,
  classifyFrameUses,
  escapeWindows,
  foldMovedCaptures,
  frameAddressFacts,
  frameEscapes,
  frameObjects,
  frameRefusal,
  objectShapes,
  opPositions,
  readWindow,
  splitAddressingCopies,
} = __testing;

const DMA3SAD = 0x040000d4;
const DMA3CNT_H = DMA3SAD + 0xa;
// `g` is declared to return nothing, so no hidden return pointer rides in its argument 0
const declaresNoHiddenPointer = (callee: string): boolean =>
  returnsWithoutHiddenPointer(callee, { g: { params: 1, returnsVoid: true } }, ARMV4T_AGBCC);

const value = (): Value => mkValue(T.unk(32));
const laddr = (off: number): Op => mkOp('laddr', { results: [value()], attrs: { off } });
const konst = (n: number): Op => mkOp('const', { results: [value()], attrs: { value: n } });
const store = (addr: Value, v: Value, off: number, width: number): Op =>
  mkOp('store', { operands: [addr, v], attrs: { off, width } });
const load = (addr: Value, off: number, width: number): Op =>
  mkOp('load', { operands: [addr], results: [value()], attrs: { off, width } });
const call = (callee: string, ...args: Value[]): Op => mkOp('call', { operands: args, attrs: { target: callee } });
const ret = (): Op => mkOp('ret');

// Every stage up to the use classification, in the audit's order.
const classify = (
  irBlocks: Block[],
  { owned = { from: 0, to: 8 }, oneObject }: { owned?: FrameRange; oneObject?: FrameRange } = {},
) => {
  const fail = frameRefusal('f');
  const { laddrs: captures, foldedHere } = foldMovedCaptures(irBlocks, new Set());
  const facts = frameAddressFacts(irBlocks, undefined, ARMV4T_AGBCC);
  const { laddrs, splitRefusal } = splitAddressingCopies(irBlocks, captures, foldedHere);
  const objects = frameObjects(laddrs, owned, fail);
  const flow = addressFlow(irBlocks, objects, facts, fail);
  const uses = classifyFrameUses({
    irBlocks,
    objects,
    flow,
    facts,
    splitRefusal,
    oneObject,
    target: ARMV4T_AGBCC,
    fail,
  });
  return { fail, facts, objects, flow, uses };
};

// …and on through the model choice and the shapes.
const shape = (
  irBlocks: Block[],
  slots: number[],
  range: FrameRange = { from: 0, to: 8 },
  declared: FrameRange = range,
) => {
  const { fail, facts, objects, flow, uses } = classify(irBlocks, { owned: range });
  const windows = escapeWindows(irBlocks, uses, flow, facts, ARMV4T_AGBCC);
  const model = chooseFrameModel(undefined, uses, windows, fail);
  const usedSlotOffsets = new Set(slots);
  const args = { objects, uses, owned: range, declared, usedSlotOffsets };
  const shapes = objectShapes({ ...args, returnsWithoutHiddenPointer: declaresNoHiddenPointer, model, fail });
  return { uses, windows, model, shapes, usedSlotOffsets };
};

// `laddr 0` stored through at `width`, then published to DMA3SAD, with `armed` the control
// halfword written to DMA3CNT_H after it
const published = (width: number, armed?: number): Block => {
  const v = value();
  const a = laddr(0);
  const sad = konst(DMA3SAD);
  const cnt = konst(DMA3CNT_H);
  const ctl = konst(armed ?? 0);
  return {
    params: [v],
    ops: [
      a,
      store(a.results[0], v, 0, width),
      sad,
      store(sad.results[0], a.results[0], 0, 4),
      ...(armed === undefined ? [] : [cnt, ctl, store(cnt.results[0], ctl.results[0], 0, 2)]),
      ret(),
    ],
  };
};

describe('foldMovedCaptures', () => {
  test('re-mints a capture moved by a constant as the capture at the sum, and drops the moved-from one', () => {
    const a = laddr(4);
    const k = konst(8);
    const sum = mkOp('add', { operands: [a.results[0], k.results[0]], results: [value()] });
    const blk: Block = { params: [], ops: [a, k, sum, load(sum.results[0], 0, 2), ret()] };
    const { laddrs, foldedHere } = foldMovedCaptures([blk], new Set());
    expect(laddrs.map((op) => op.attrs.off)).toEqual([12]);
    expect(laddrs[0].results).toEqual(sum.results);
    expect(foldedHere.has(laddrs[0])).toBe(true);
    expect(blk.ops).not.toContain(a);
  });

  test('keeps a capture nothing reads that no constant moved', () => {
    const a = laddr(0);
    const { laddrs, foldedHere } = foldMovedCaptures([{ params: [], ops: [a, ret()] }], new Set());
    expect(laddrs).toEqual([a]);
    expect(foldedHere.size).toBe(0);
  });
});

describe('splitAddressingCopies', () => {
  test('splits a copy of sp addressed only by sub-word accesses into one object per offset', () => {
    const v = value();
    const a = laddr(0);
    const half = store(a.results[0], v, 0x30, 2);
    const byte = load(a.results[0], 4, 1);
    const blk: Block = { params: [v], ops: [a, half, byte, ret()] };
    const foldedHere = new Set<Op>([a]);
    const { laddrs, splitRefusal } = splitAddressingCopies([blk], [a], foldedHere);
    expect(laddrs.map((op) => op.attrs.off)).toEqual([0x30, 4]);
    expect(blk.ops).not.toContain(a);
    expect(half.operands[0]).toBe(laddrs[0].results[0]);
    expect([half.attrs.off, byte.attrs.off]).toEqual([0, 0]);
    expect(laddrs.every((op) => foldedHere.has(op))).toBe(true);
    expect(splitRefusal.size).toBe(0);
  });

  test('keeps a copy with a word access, and says why it was not split', () => {
    const v = value();
    const a = laddr(0);
    const blk: Block = { params: [v], ops: [a, store(a.results[0], v, 4, 4), ret()] };
    const { laddrs, splitRefusal } = splitAddressingCopies([blk], [a], new Set());
    expect(laddrs).toEqual([a]);
    expect(splitRefusal.get(a.results[0])).toContain('a WORD access through the copy');
  });
});

describe('frameAddressFacts', () => {
  test('reads the IR as it stands when asked, so no object the split mints after has a definition', () => {
    const v = value();
    const a = laddr(0);
    const blk: Block = { params: [v], ops: [a, store(a.results[0], v, 4, 2), ret()] };
    const facts = frameAddressFacts([blk], undefined, ARMV4T_AGBCC);
    const { laddrs } = splitAddressingCopies([blk], [a], new Set());
    expect(facts.defOf.get(a.results[0])).toBe(a);
    expect(facts.defOf.has(laddrs[0].results[0])).toBe(false);
  });
});

describe('addressFlow', () => {
  // block 0 hands `laddr 0` to block 1's parameter, or on a test either it or `other`
  const phi = (other?: Value) => {
    const p = value();
    const c = value();
    const a = laddr(0);
    const exit: Block = { params: [p], ops: [load(p, 0, 4), ret()] };
    const toExit = (v: Value) => ({ block: exit, args: [v] });
    const branch = other
      ? mkOp('cond_br', { operands: [c], successors: [toExit(a.results[0]), toExit(other)] })
      : mkOp('br', { successors: [toExit(a.results[0])] });
    const entry: Block = { params: other ? [c, other] : [], ops: [a, branch] };
    return { blocks: [entry, exit], p };
  };
  const flowOf = (blocks: Block[]) => {
    const fail = frameRefusal('f');
    const facts = frameAddressFacts(blocks, undefined, ARMV4T_AGBCC);
    const { laddrs } = foldMovedCaptures(blocks, new Set());
    return addressFlow(blocks, frameObjects(laddrs, { from: 0, to: 8 }, fail), facts, fail);
  };

  test('taints a block parameter a frame address reaches, and holds it on every path when only that reaches it', () => {
    const { blocks, p } = phi();
    const flow = flowOf(blocks);
    expect(flow.taint.get(p)).toBe(0);
    expect(flow.frameOnEveryPath.has(p)).toBe(true);
  });

  test('does not hold a parameter on every path when a pointer from outside the frame reaches it too', () => {
    const { blocks, p } = phi(value());
    const flow = flowOf(blocks);
    expect(flow.taint.get(p)).toBe(0);
    expect(flow.frameOnEveryPath.has(p)).toBe(false);
  });
});

describe('classifyFrameUses', () => {
  test('reads a word store to a DMA source register as a publish only a device reads through', () => {
    const { uses } = classify([published(2)]);
    expect([...uses.escaped]).toEqual([0]);
    expect(uses.mayWrite.size).toBe(0);
    expect(uses.sourceStores.get(0)?.map((s) => s.sink)).toEqual([DMA3SAD]);
    expect([...uses.published, ...uses.publishedOutward]).toEqual([0, 0]);
    expect(uses.accesses.get(0)).toEqual([{ width: 2, signed: false, isLoad: false }]);
  });

  test('reads an address handed to a callee at argument 0 as a writer, naming the callee', () => {
    const a = laddr(0);
    const { uses } = classify([{ params: [], ops: [a, call('g', a.results[0]), ret()] }]);
    expect([...uses.mayWrite]).toEqual([0]);
    expect([...uses.passedToCallee]).toEqual([0]);
    expect([...uses.arg0Callees.get(0)!]).toEqual(['g']);
    expect(uses.useCount.get(0)).toBe(1);
  });

  test('defers a member through the captured address to the model choice, or records it under one object', () => {
    const blocks = () => {
      const a = laddr(0);
      const v = value();
      return [{ params: [v], ops: [a, store(a.results[0], v, 0, 4), store(a.results[0], v, 4, 4), ret()] }];
    };
    expect(classify(blocks()).uses.memberRefusal).toContain('a store at [+4] through the captured address');
    const kept = classify(blocks(), { oneObject: { from: 0, to: 8 } }).uses;
    expect(kept.memberRefusal).toBeUndefined();
    expect(kept.members).toEqual([
      { at: 0, width: 4 },
      { at: 4, width: 4 },
    ]);
  });

  test('records a runtime index apart from the accesses that type the object', () => {
    const i = value();
    const a = laddr(0);
    const at = mkOp('add', { operands: [a.results[0], i], results: [value()] });
    const { uses } = classify([{ params: [i], ops: [a, at, load(at.results[0], 0, 1), ret()] }]);
    expect(uses.indexed.get(0)).toEqual([{ width: 1, signed: false }]);
    expect(uses.accesses.get(0)).toEqual([]);
  });
});

describe('readWindow', () => {
  const windowOf = (blk: Block) => {
    const { facts, flow, uses } = classify([blk]);
    return readWindow(0, { at: opPositions([blk]), uses, flow, facts, target: ARMV4T_AGBCC });
  };

  test('bounds a device read by the control halfword armed after the publish', () => {
    expect(windowOf(published(2, 0x8100))).toEqual({ lo: 0, hi: 2, why: 'that reads through it' });
  });

  test('leaves a transfer this function never arms unbounded, and says so', () => {
    expect(windowOf(published(2))).toEqual({ lo: -Infinity, hi: Infinity, why: 'this function never arms' });
  });
});

describe('chooseFrameModel', () => {
  test('offers the one-object answer where every escape only reads and one reads without bound', () => {
    const blk = published(2);
    const { fail, facts, flow, uses } = classify([blk]);
    const model = chooseFrameModel(undefined, uses, escapeWindows([blk], uses, flow, facts, ARMV4T_AGBCC), fail);
    expect(model.onOffer).toBe(true);
    model.shapeRefused('two widths');
    expect(model.refused).toBe(true);
  });

  test('refuses a shape where it stands when a writer holds the address', () => {
    const a = laddr(0);
    const blk: Block = { params: [], ops: [a, call('g', a.results[0]), ret()] };
    const { fail, facts, flow, uses } = classify([blk]);
    const model = chooseFrameModel(undefined, uses, escapeWindows([blk], uses, flow, facts, ARMV4T_AGBCC), fail);
    expect(model.onOffer).toBe(false);
    expect(() => model.shapeRefused('two widths')).toThrow("cannot lift 'f': address-taken stack local — two widths");
  });
});

describe('objectShapes', () => {
  test('types a scalar by the one width its accesses agree on', () => {
    const v = value();
    const a = laddr(4);
    const blk: Block = { params: [v], ops: [a, store(a.results[0], v, 0, 2), call('g', a.results[0]), ret()] };
    expect(shape([blk], []).shapes.extent.get(4)).toEqual({ width: 2, count: 1 });
  });

  test('sizes a buffer only a callee fills by the declared range', () => {
    const a = laddr(0);
    const blk: Block = { params: [], ops: [a, call('g', a.results[0]), ret()] };
    expect(shape([blk], [], { from: 0, to: 16 }).shapes.extent.get(0)).toEqual({ width: 1, count: 16 });
  });

  // [sp,#0..#0xc] are a licensed outgoing block's argument words, keyed as slots, and the
  // declared range starts above them
  test('sizes a buffer above the outgoing block by the declared range', () => {
    const a = laddr(0x10);
    const blk: Block = { params: [], ops: [a, call('g', a.results[0]), ret()] };
    const { shapes } = shape([blk], [0, 4, 8, 0xc], { from: 0, to: 0x18 }, { from: 0x10, to: 0x18 });
    expect(shapes.extent.get(0x10)).toEqual({ width: 1, count: 8 });
  });

  test('sets a buffer above the outgoing block over a slot in the declared range aside for the last refusal', () => {
    const a = laddr(0x10);
    const blk: Block = { params: [], ops: [a, call('g', a.results[0]), ret()] };
    const { shapes } = shape([blk], [0, 4, 8, 0xc, 0x14], { from: 0, to: 0x18 }, { from: 0x10, to: 0x18 });
    expect(shapes.overSlot).toEqual([[0x10, 8]]);
  });

  test('sets an object over a slot aside for the last refusal', () => {
    const v = value();
    const a = laddr(4);
    const blk: Block = { params: [v], ops: [a, store(a.results[0], v, 0, 4), call('g', a.results[0]), ret()] };
    expect(shape([blk], [4]).shapes.overSlot).toEqual([[4, 4]]);
  });

  test('refuses two widths where the one-object answer is not on offer', () => {
    const v = value();
    const a = laddr(0);
    const blk: Block = {
      params: [v],
      ops: [a, store(a.results[0], v, 0, 2), load(a.results[0], 0, 4), call('g', a.results[0]), ret()],
    };
    expect(() => shape([blk], [])).toThrow('disagree on width (2 vs 4)');
  });
});

describe('frameEscapes', () => {
  test('reads a writer escape as reaching the whole frame, and the first slot above the object', () => {
    const v = value();
    const a = laddr(0);
    const blk: Block = { params: [v], ops: [a, store(a.results[0], v, 0, 4), call('g', a.results[0]), ret()] };
    const { uses, windows, shapes, usedSlotOffsets } = shape([blk], [4]);
    const range = { from: 0, to: 8 };
    const escapes = frameEscapes({
      irBlocks: [blk],
      uses,
      windows,
      shapes,
      owned: range,
      declared: range,
      usedSlotOffsets,
    });
    expect(escapes).toEqual([
      {
        off: 0,
        lo: -Infinity,
        hi: Infinity,
        writes: true,
        how: 'is passed to a callee',
        objectReached: undefined,
        slotReached: { slot: 4, above: true },
        undefReached: undefined,
        unaccountedWord: undefined,
      },
    ]);
  });
});

// The second audit, which judges the bytes a first one asked to keep as one object.
describe('keepAsOneObject', () => {
  const kept = (blk: Block) =>
    auditFrameObjects({
      name: 'f',
      irBlocks: [blk],
      ownedLocals: { from: 0, to: 8 },
      declaredLocals: { from: 0, to: 8 },
      usedSlotOffsets: new Set(),
      capturedObjectIsTheWholeFrame: false,
      movedCaptures: new Set(),
      returnsWithoutHiddenPointer: declaresNoHiddenPointer,
      symbols: undefined,
      target: ARMV4T_AGBCC,
      oneObject: { from: 0, to: 8 },
    });
  // `u8 sp[4]; u32 sp4; h(x, sp, &sp4); return sp[0];` — two out-parameters of one callee, at
  // arguments 1 and 2, with `callee` taking the first at argument 0 instead when given
  const outParams = (callee?: string): Block => {
    const x = value();
    const a = laddr(0);
    const b = laddr(4);
    const args = callee === undefined ? [x, a.results[0], b.results[0]] : [a.results[0], b.results[0]];
    return { params: [x], ops: [a, b, call(callee ?? 'h', ...args), load(a.results[0], 0, 1), ret()] };
  };

  test('keeps two addresses a callee may write through as one byte array', () => {
    const blk = outParams();
    expect(kept(blk)).toEqual({ policy: 'one-object', sinks: [] });
    const [object] = blk.ops;
    expect(object.attrs).toMatchObject({ off: 0, width: 1, signed: false, count: 8 });
    expect(blk.ops.find((op) => op.opcode === 'call')!.operands[1]).toBe(object.results[0]);
  });

  test('refuses a writer whose address is stored to memory', () => {
    const p = value();
    const a = laddr(0);
    const blk: Block = { params: [p], ops: [a, store(p, a.results[0], 0, 4), call('h', p), ret()] };
    expect(() => kept(blk)).toThrow('the captured address at [sp,#0) is stored to memory');
  });

  test('refuses an address a callee takes at argument 0 with nothing said of what it returns', () => {
    expect(() => kept(outParams('k'))).toThrow('`k` takes it at argument 0 and nothing says what that callee returns');
  });

  test('refuses the storage a callee returns its struct through', () => {
    const a = laddr(0);
    const s = mkValue(T.struct('S8', [], 8));
    const sret = mkOp('call', { operands: [a.results[0]], results: [s], attrs: { target: 'mk', sret: true } });
    expect(() => kept({ params: [], ops: [a, sret, ret()] })).toThrow('is where `mk` returns its struct');
  });
});
