// UNIT tests for `addressRangeOf` (frontend/device-pins.ts): every address a value may hold, as
// an unsigned interval, over hand-built IR. The frame-object audit asks it whether a store
// through a computed pointer can reach a DMA channel's control halfword (frame-objects.ts
// `readWindow`); an answer narrower than the machine's values there turns a refusal into a
// frame word modelled as unread, so each refusal below is pinned as firmly as each answer.
import { describe, expect, test } from 'vitest';

import { literalAddresses } from '../src/frontend/device-pins';
import { type Block, type Op, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { SymbolMap } from '../src/symbols';

const v = (): Value => mkValue(T.s(32));

/** A block under construction: `op` appends an op and returns its result. */
function block(params: Value[] = []): Block & { op(opcode: string, attrs?: Op['attrs'], operands?: Value[]): Value } {
  const b: Block = { params, ops: [] };
  return Object.assign(b, {
    op(opcode: string, attrs: Op['attrs'] = {}, operands: Value[] = []): Value {
      const r = v();
      b.ops.push(mkOp(opcode as Parameters<typeof mkOp>[0], { operands, results: [r], attrs }));
      return r;
    },
  });
}

const br = (from: Block, to: Block, args: Value[] = []) =>
  from.ops.push(mkOp('br', { successors: [{ block: to, args }] }));
const condBr = (from: Block, cond: Value, t: [Block, Value[]], f: [Block, Value[]]) =>
  from.ops.push(
    mkOp('cond_br', {
      operands: [cond],
      successors: [
        { block: t[0], args: t[1] },
        { block: f[0], args: f[1] },
      ],
    }),
  );

/** `(u8)p` as agbcc's Thumb spells it: `lsl #24; lsr #24`. */
const u8Of = (b: ReturnType<typeof block>, x: Value) => b.op('shr_u', { imm: 24 }, [b.op('shl', { imm: 24 }, [x])]);

const rangeIn = (blocks: Block[], x: Value, symbols?: SymbolMap) => literalAddresses(blocks, symbols).addressRangeOf(x);

describe('addressRangeOf — what a computed address may be', () => {
  test('a literal base plus a u8 index scaled by 8, merged by a block param over both arms', () => {
    // the shape of synthetic:dmasret's tail store: `gEnts[i].f`, i a u8 parameter
    const p = v();
    const entry = block([p]);
    const i = u8Of(entry, p);
    const left = block();
    const right = block();
    const q = v();
    const join = block([q]);
    condBr(entry, p, [left, []], [right, []]);
    br(left, join, [left.op('shl', { imm: 3 }, [i])]);
    br(right, join, [right.op('shl', { imm: 3 }, [i])]);
    const addr = join.op('add', {}, [q, join.op('const', { value: 0x3003440 })]);
    expect(rangeIn([entry, left, right, join], addr)).toEqual({ lo: 0x3003440, hi: 0x3003440 + 255 * 8 });
  });

  test('a block param whose in-edges pass a constant and a u8 is their union', () => {
    // the shape of kleod sub_080202D4's index: phi(0, (u8)x) << 3, added to a placed name
    const p = v();
    const entry = block([p]);
    const zero = entry.op('const', { value: 0 });
    const right = block();
    const q = v();
    const join = block([q]);
    condBr(entry, p, [join, [zero]], [right, []]);
    br(right, join, [u8Of(right, p)]);
    const base = join.op('gaddr', { sym: 'gUnk_03003590' });
    const addr = join.op('add', {}, [join.op('shl', { imm: 3 }, [q]), base]);
    const symbols: SymbolMap = new Map([[0x3003590, [{ name: 'gUnk_03003590', kind: 'data' }]]]);
    expect(rangeIn([entry, right, join], addr, symbols)).toEqual({ lo: 0x3003590, hi: 0x3003590 + 255 * 8 });
    // the same name unplaced is an unresolved pointer, and so is a name placed at two addresses
    expect(rangeIn([entry, right, join], addr)).toBeUndefined();
    const twice: SymbolMap = new Map([
      [0x3003590, [{ name: 'gUnk_03003590', kind: 'data' }]],
      [0x40000dc, [{ name: 'gUnk_03003590', kind: 'data' }]],
    ]);
    expect(rangeIn([entry, right, join], addr, twice)).toBeUndefined();
  });

  test('a function parameter bounds nothing, even where a back edge passes it a bounded value', () => {
    const p = v();
    const entry = block([p]);
    const addr = entry.op('add', {}, [p, entry.op('const', { value: 0x3003440 })]);
    expect(rangeIn([entry], addr)).toBeUndefined();
    // a loop back to the entry block: its param also arrives from the caller, unbounded
    const latch = block();
    condBr(entry, p, [latch, []], [latch, []]);
    br(latch, entry, [latch.op('const', { value: 4 })]);
    expect(rangeIn([entry, latch], addr)).toBeUndefined();
  });

  test('a loaded word and a sign-extending narrow load bound nothing; an unsigned narrow load does', () => {
    const p = v();
    const entry = block([p]);
    expect(rangeIn([entry], entry.op('load', { off: 0, width: 4, signed: false }, [p]))).toBeUndefined();
    expect(rangeIn([entry], entry.op('load', { off: 0, width: 1, signed: true }, [p]))).toBeUndefined();
    expect(rangeIn([entry], entry.op('load', { off: 0, width: 2, signed: false }, [p]))).toEqual({ lo: 0, hi: 0xffff });
    expect(rangeIn([entry], entry.op('zext', { width: 8 }, [p]))).toEqual({ lo: 0, hi: 0xff });
  });

  test('a mask and a zero-fill shift bound their result whatever they take; a shift left carries it', () => {
    const p = v();
    const entry = block([p]);
    const m = entry.op('const', { value: 0x1f });
    expect(rangeIn([entry], entry.op('and', {}, [p, m]))).toEqual({ lo: 0, hi: 0x1f });
    expect(rangeIn([entry], entry.op('and', { imm: 0xff }, [p]))).toEqual({ lo: 0, hi: 0xff });
    expect(rangeIn([entry], entry.op('shr_u', { imm: 28 }, [p]))).toEqual({ lo: 0, hi: 15 });
    expect(rangeIn([entry], entry.op('shr_s', { imm: 28 }, [p]))).toBeUndefined();
    // a shift left of an unbounded value bounds nothing
    expect(rangeIn([entry], entry.op('shl', { imm: 3 }, [p]))).toBeUndefined();
  });

  test('a sum or a difference that may leave the word bounds nothing', () => {
    const p = v();
    const entry = block([p]);
    const i = u8Of(entry, p);
    const high = entry.op('const', { value: 0xfffffff0 });
    expect(rangeIn([entry], entry.op('add', {}, [high, i]))).toBeUndefined();
    const low = entry.op('const', { value: 0x10 });
    expect(rangeIn([entry], entry.op('sub', {}, [low, i]))).toBeUndefined();
    const k = entry.op('const', { value: 0x100 });
    expect(rangeIn([entry], entry.op('sub', {}, [k, i]))).toEqual({ lo: 1, hi: 0x100 });
    // shifted out of the word
    expect(rangeIn([entry], entry.op('shl', { imm: 28 }, [i]))).toBeUndefined();
  });

  test('a value whose range depends on itself through a loop bounds nothing', () => {
    // for (q = 0; ; q++) — every iteration adds one, and no interval over the loop holds that
    const p = v();
    const entry = block([p]);
    const q = v();
    const head = block([q]);
    br(entry, head, [entry.op('const', { value: 0 })]);
    const next = head.op('add', {}, [q, head.op('const', { value: 1 })]);
    condBr(head, p, [head, [next]], [head, [next]]);
    expect(rangeIn([entry, head], next)).toBeUndefined();
    expect(rangeIn([entry, head], q)).toBeUndefined();
  });
});
