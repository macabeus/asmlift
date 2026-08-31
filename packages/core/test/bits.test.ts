// UNIT tests for the shared L2 known-bits analysis (ir/bits.ts) — "how many significant bits can
// this value have". Hand-built ops, no CFG, no pipeline: the end-to-end consequences stay pinned
// by the bitfield-member tests, which consult it through the mask-and-insert fold's truncation
// bound. It is tested here because that is where a wrong answer is CHEAP to see: reached only
// through emitted C, one wrong opcode reads as a wrong address in a row nobody is looking at.
import { describe, expect, test } from 'vitest';

import { type BitsCtx, constMask, provableBits } from '../src/ir/bits';
import { type Op, type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';

const v = (): Value => mkValue(T.s(32));

const def = (
  defs: Map<Value, Op>,
  opcode: string,
  attrs: Record<string, number | string | boolean>,
  operands: Value[] = [],
): Value => {
  const r = v();
  const op = mkOp(opcode as Parameters<typeof mkOp>[0], { operands, results: [r], attrs });
  defs.set(r, op);
  return r;
};

const ctx = (defs: Map<Value, Op>, over: Partial<BitsCtx> = {}): BitsCtx => ({ defs, ...over });

describe('provableBits — what the instruction itself proves', () => {
  test('a value with no def at all is unbounded', () => {
    expect(provableBits(ctx(new Map()), v())).toBe(32);
  });

  test('a zero-fill shift right by n leaves 32 - n', () => {
    const defs = new Map<Value, Op>();
    expect(provableBits(ctx(defs), def(defs, 'shr_u', { imm: 27 }, [v()]))).toBe(5);
  });

  test('an ARITHMETIC shift right proves nothing — it fills from the sign bit', () => {
    const defs = new Map<Value, Op>();
    expect(provableBits(ctx(defs), def(defs, 'shr_s', { imm: 27 }, [v()]))).toBe(32);
  });

  test('an unsigned load leaves its own width', () => {
    const defs = new Map<Value, Op>();
    expect(provableBits(ctx(defs), def(defs, 'load', { width: 1, off: 0, signed: false }, [v()]))).toBe(8);
  });

  test('a SIGN-EXTENDING load of the same width proves nothing', () => {
    const defs = new Map<Value, Op>();
    expect(provableBits(ctx(defs), def(defs, 'load', { width: 1, off: 0, signed: true }, [v()]))).toBe(32);
  });

  test('an `and` with a non-negative constant leaves that constant s top set bit', () => {
    const defs = new Map<Value, Op>();
    const m = def(defs, 'const', { value: 0x1f });
    expect(provableBits(ctx(defs), def(defs, 'and', {}, [v(), m]))).toBe(5);
    expect(provableBits(ctx(defs), def(defs, 'and', { imm: 0xff }, [v()]))).toBe(8);
  });

  test('an `and` with a NEGATIVE mask leaves the top bits set, so it bounds nothing', () => {
    const defs = new Map<Value, Op>();
    const m = def(defs, 'const', { value: -16 });
    expect(provableBits(ctx(defs), def(defs, 'and', {}, [v(), m]))).toBe(32);
  });

  test('a MATERIALIZED mask is a variable at its use, not a literal', () => {
    const defs = new Map<Value, Op>();
    const m = def(defs, 'const', { value: 0x1f });
    const a = def(defs, 'and', {}, [v(), m]);
    expect(provableBits(ctx(defs), a)).toBe(5);
    expect(provableBits(ctx(defs, { materialize: new Set([defs.get(m)!]) }), a)).toBe(32);
  });
});

describe("provableBits — a caller's declaration-backed bound", () => {
  test('a bound wins over the instruction rules, and null defers to them', () => {
    const defs = new Map<Value, Op>();
    const s = def(defs, 'shr_u', { imm: 27 }, [v()]);
    expect(provableBits(ctx(defs, { bound: () => 3 }), s)).toBe(3);
    expect(provableBits(ctx(defs, { bound: () => null }), s)).toBe(5);
  });
});

describe('constMask', () => {
  test('`bic` lifts as neg/not of a constant, and both spellings fold', () => {
    const defs = new Map<Value, Op>();
    const k = def(defs, 'const', { value: 0x1f });
    expect(constMask(ctx(defs), def(defs, 'not', {}, [k]))).toBe(~0x1f);
    expect(constMask(ctx(defs), def(defs, 'neg', {}, [k]))).toBe(-0x1f);
  });

  test('anything else is not a compile-time mask', () => {
    const defs = new Map<Value, Op>();
    expect(constMask(ctx(defs), def(defs, 'add', {}, [v(), v()]))).toBeNull();
    expect(constMask(ctx(defs), v())).toBeNull();
  });
});
