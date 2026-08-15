// UNIT tests for the shared L2 memory-disjointness query (ir/alias.ts) — the predicate that
// answers "could this write change what that read sees". Hand-built ops, no CFG, no pipeline:
// the end-to-end consequences stay pinned by the bitfield-member tests (which consult it through
// the fold) and by the structurer's own tests.
import { describe, expect, test } from 'vitest';

import { globalCellOf, mayWriteGlobal } from '../src/ir/alias';
import { type Op, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';

const v = (): Value => mkValue(T.s(32));

/** an op producing one fresh value, registered in `defs` */
const def = (defs: Map<Value, Op>, opcode: string, attrs: Record<string, number | string>, operands: Value[] = []) => {
  const r = v();
  const op = mkOp(opcode as Parameters<typeof mkOp>[0], { operands, results: [r], attrs });
  defs.set(r, op);
  return r;
};

describe('globalCellOf', () => {
  test('a bare gaddr resolves to its symbol at the access offset', () => {
    const defs = new Map<Value, Op>();
    const g = def(defs, 'gaddr', { sym: 'gValue' });
    expect(globalCellOf(defs, g, 0)).toEqual({ name: 'gValue', byte: 0 });
    expect(globalCellOf(defs, g, 8)).toEqual({ name: 'gValue', byte: 8 });
  });

  test('gaddr + const resolves in either operand order, summing the offsets', () => {
    const defs = new Map<Value, Op>();
    const g = def(defs, 'gaddr', { sym: 'gStruct' });
    const k = def(defs, 'const', { value: 12 });
    const fwd = def(defs, 'add', {}, [g, k]);
    const rev = def(defs, 'add', {}, [k, g]);
    expect(globalCellOf(defs, fwd, 4)).toEqual({ name: 'gStruct', byte: 16 });
    expect(globalCellOf(defs, rev, 4)).toEqual({ name: 'gStruct', byte: 16 });
  });

  test('an address that does not reduce to a name is unknown, not a guess', () => {
    const defs = new Map<Value, Op>();
    const g = def(defs, 'gaddr', { sym: 'gArray' });
    const idx = def(defs, 'shl', { imm: 2 }, [v()]); // a runtime index, not a constant
    expect(globalCellOf(defs, def(defs, 'add', {}, [g, idx]), 0)).toBeNull();
    expect(globalCellOf(defs, v(), 0)).toBeNull(); // a block parameter: no defining op at all
  });
});

describe('mayWriteGlobal', () => {
  test('a store through a DIFFERENT named global cannot reach the read', () => {
    const defs = new Map<Value, Op>();
    const other = def(defs, 'gaddr', { sym: 'gOut' });
    const store = mkOp('store', { operands: [other, v()], attrs: { off: 0, width: 4 } });
    expect(mayWriteGlobal(defs, 'gValue')(store)).toBe(false);
  });

  test('a store through the SAME global bars — offsets are not compared here', () => {
    const defs = new Map<Value, Op>();
    const same = def(defs, 'gaddr', { sym: 'gValue' });
    const store = mkOp('store', { operands: [same, v()], attrs: { off: 4, width: 4 } });
    expect(mayWriteGlobal(defs, 'gValue')(store)).toBe(true);
  });

  test('a store through an UNRESOLVABLE base bars — unknown memory is not disjoint memory', () => {
    const defs = new Map<Value, Op>();
    const store = mkOp('store', { operands: [v(), v()], attrs: { off: 0, width: 4 } });
    expect(mayWriteGlobal(defs, 'gValue')(store)).toBe(true);
  });

  test('an astore is judged by the same rule as a store', () => {
    const defs = new Map<Value, Op>();
    const other = def(defs, 'gaddr', { sym: 'gOut' });
    const mine = def(defs, 'gaddr', { sym: 'gValue' });
    const to = (base: Value) => mkOp('astore', { operands: [base, v(), v()], attrs: { elemSize: 4 } });
    expect(mayWriteGlobal(defs, 'gValue')(to(other))).toBe(false);
    expect(mayWriteGlobal(defs, 'gValue')(to(mine))).toBe(true);
  });

  test('a call or an opaque may write anything', () => {
    const defs = new Map<Value, Op>();
    expect(mayWriteGlobal(defs, 'gValue')(mkOp('call', { attrs: { target: 'f' } }))).toBe(true);
    expect(mayWriteGlobal(defs, 'gValue')(mkOp('opaque', { attrs: { text: 'svc 5' } }))).toBe(true);
  });

  test('a pure op and a load never write', () => {
    const defs = new Map<Value, Op>();
    expect(mayWriteGlobal(defs, 'gValue')(mkOp('add', { results: [v()] }))).toBe(false);
    expect(mayWriteGlobal(defs, 'gValue')(mkOp('load', { operands: [v()], results: [v()] }))).toBe(false);
  });
});
