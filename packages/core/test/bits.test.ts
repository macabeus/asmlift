// UNIT tests for the shared L2 known-bits analysis (ir/bits.ts) — "how many significant bits can
// this value have". Hand-built ops, no CFG, no pipeline: the end-to-end consequences stay pinned
// by the bitfield-member tests, which consult it through the mask-and-insert fold's truncation
// bound. It is tested here because that is where a wrong answer is CHEAP to see: reached only
// through emitted C, one wrong opcode reads as a wrong address in a row nobody is looking at.
import { describe, expect, test } from 'vitest';

import {
  type BitsCtx,
  type WordCtx,
  constMask,
  constWord,
  mayAlwaysHold,
  provableBits,
  storeForwards,
} from '../src/ir/bits';
import { type Block, type Op, type Value, mkOp, mkValue } from '../src/ir/core';
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

describe('constWord — the word a value always holds', () => {
  const W = (defs: Map<Value, Op>, over: Partial<WordCtx> = {}): WordCtx => ({ defs, ...over });

  test('a pool word, and a shifted `mov`, by an immediate or a register amount', () => {
    const defs = new Map<Value, Op>();
    expect(constWord(W(defs), def(defs, 'const', { value: 0x80000000 }))).toBe(-0x80000000);
    const one = def(defs, 'const', { value: 1 });
    expect(constWord(W(defs), def(defs, 'shl', { imm: 31 }, [one]))).toBe(-0x80000000);
    expect(constWord(W(defs), def(defs, 'shl', {}, [one, def(defs, 'const', { value: 4 })]))).toBe(16);
  });

  test('any integer arithmetic over words, by an immediate or a register operand', () => {
    const defs = new Map<Value, Op>();
    const k = (n: number) => def(defs, 'const', { value: n });
    expect(constWord(W(defs), def(defs, 'sub', { imm: 1 }, [k(0x80000001)]))).toBe(-0x80000000);
    expect(constWord(W(defs), def(defs, 'add', {}, [k(0x7fffffff), k(1)]))).toBe(-0x80000000);
    expect(constWord(W(defs), def(defs, 'or', {}, [k(0x80000000), k(0)]))).toBe(-0x80000000);
    expect(constWord(W(defs), def(defs, 'xor', {}, [k(0x80000000), k(0)]))).toBe(-0x80000000);
    expect(constWord(W(defs), def(defs, 'mul', {}, [k(0x10000), k(0x8000)]))).toBe(-0x80000000);
    expect(constWord(W(defs), def(defs, 'neg', {}, [k(0x80000000)]))).toBe(-0x80000000);
  });

  test('an annihilator holds its word whatever the other operand is', () => {
    const defs = new Map<Value, Op>();
    const x = v();
    expect(constWord(W(defs), def(defs, 'and', {}, [x, def(defs, 'const', { value: 0 })]))).toBe(0);
    expect(constWord(W(defs), def(defs, 'and', { imm: 0 }, [x]))).toBe(0);
    expect(constWord(W(defs), def(defs, 'or', {}, [def(defs, 'const', { value: -1 }), x]))).toBe(-1);
    expect(constWord(W(defs), def(defs, 'sub', {}, [x, x]))).toBe(0);
    expect(constWord(W(defs), def(defs, 'xor', {}, [x, x]))).toBe(0);
    expect(constWord(W(defs), def(defs, 'sub', {}, [x, v()]))).toBeNull();
  });

  test('reads through a materialized def, which constMask does not', () => {
    const defs = new Map<Value, Op>();
    const k = def(defs, 'const', { value: 7 });
    expect(constMask(ctx(defs, { materialize: new Set([defs.get(k)!]) }), k)).toBeNull();
    expect(constWord(W(defs), k)).toBe(7);
  });

  test('a variable anywhere in the chain is no word, and nor is a value the caller calls opaque', () => {
    const defs = new Map<Value, Op>();
    expect(constWord(W(defs), v())).toBeNull();
    expect(constWord(W(defs), def(defs, 'shl', { imm: 1 }, [v()]))).toBeNull();
    expect(constWord(W(defs), def(defs, 'add', {}, [def(defs, 'const', { value: 1 }), v()]))).toBeNull();
    const k = def(defs, 'const', { value: 1 });
    expect(constWord(W(defs, { opaque: (x) => x === k }), def(defs, 'shl', { imm: 3 }, [k]))).toBeNull();
  });

  test('the mathematical `neg_s` of INT_MIN is a constant and no word, so it MAY be any word', () => {
    const defs = new Map<Value, Op>();
    const k = def(defs, 'const', { value: 0x80000000 });
    const negS = def(defs, 'neg_s', {}, [k]);
    expect(constWord(W(defs), negS)).toBeNull();
    expect(mayAlwaysHold(W(defs), negS, 0x80000000)).toBe(true);
    expect(constWord(W(defs), def(defs, 'neg_s', {}, [def(defs, 'const', { value: 5 })]))).toBe(-5);
  });

  test('an op it has no rule for is no word, but MAY be one', () => {
    const defs = new Map<Value, Op>();
    const k = def(defs, 'const', { value: 0x80000000 });
    const ext = def(defs, 'zext', { width: 16 }, [k]);
    expect(constWord(W(defs), ext)).toBeNull();
    expect(mayAlwaysHold(W(defs), ext, 0x80000000)).toBe(true);
    // A register shift by 32 or more: Thumb gives 0, MIPS masks the amount to five bits.
    const wide = def(defs, 'shl', {}, [def(defs, 'const', { value: 1 }), def(defs, 'const', { value: 32 })]);
    expect(constWord(W(defs), wide)).toBeNull();
    expect(mayAlwaysHold(W(defs), wide, 0x80000000)).toBe(true);
    expect(mayAlwaysHold(W(defs), def(defs, 'add', {}, [k, v()]), 0x80000000)).toBe(false);
    expect(mayAlwaysHold(W(defs), def(defs, 'const', { value: 5 }), 0x80000000)).toBe(false);
  });

  test('a block param holds a word every in-edge passes, itself included', () => {
    const defs = new Map<Value, Op>();
    const k = def(defs, 'const', { value: 0x80000000 });
    const k2 = def(defs, 'const', { value: 0x80000000 });
    const join = v();
    // A diamond whose two arms each load the pool word.
    expect(constWord(W(defs, { incoming: new Map([[join, [k, k2]]]) }), join)).toBe(-0x80000000);
    // A loop that passes the param back to itself keeps the word it entered with...
    const inv = v();
    expect(constWord(W(defs, { incoming: new Map([[inv, [k, inv]]]) }), inv)).toBe(-0x80000000);
    // ...through a second param too...
    const p = v();
    const q = v();
    const twoParams = new Map<Value, (Value | undefined)[]>([
      [p, [k, q]],
      [q, [p, q]],
    ]);
    expect(constWord(W(defs, { incoming: twoParams }), q)).toBe(-0x80000000);
    // ...but a counter varies, and so do two arms that disagree or an edge that passes nothing.
    const i = v();
    const next = def(defs, 'add', { imm: 1 }, [i]);
    expect(constWord(W(defs, { incoming: new Map([[i, [def(defs, 'const', { value: 0 }), next]]]) }), i)).toBeNull();
    const split = v();
    expect(
      constWord(W(defs, { incoming: new Map([[split, [k, def(defs, 'const', { value: 5 })]]]) }), split),
    ).toBeNull();
    const short = v();
    expect(constWord(W(defs, { incoming: new Map([[short, [k, undefined]]]) }), short)).toBeNull();
    // A param nobody describes is an entry param: no word.
    expect(constWord(W(defs), join)).toBeNull();
  });

  test('the params settle to the same words in either order', () => {
    // p: [INT_MIN, p | (q & x)] and q: [0, q | q]. q is always 0, so `q & x` is 0 and p is always
    // INT_MIN. Read before q settled, `q & x` once answered VAR ahead of its annihilator, and with
    // p first p dropped to VAR for good: mayAlwaysHold false, the structurer's gap bypassed.
    for (const pFirst of [true, false]) {
      const defs = new Map<Value, Op>();
      const p = v();
      const q = v();
      const pArgs = [
        def(defs, 'const', { value: 0x80000000 }),
        def(defs, 'or', {}, [p, def(defs, 'and', {}, [q, v()])]),
      ];
      const qArgs = [def(defs, 'const', { value: 0 }), def(defs, 'or', {}, [q, q])];
      const incoming = new Map<Value, (Value | undefined)[]>(
        pFirst
          ? [
              [p, pArgs],
              [q, qArgs],
            ]
          : [
              [q, qArgs],
              [p, pArgs],
            ],
      );
      expect(mayAlwaysHold(W(defs, { incoming }), p, 0x80000000)).toBe(true);
      expect(constWord(W(defs, { incoming }), p)).toBe(-0x80000000);
      expect(constWord(W(defs, { incoming }), q)).toBe(0);
    }
  });

  test('a load reads the word a forwarded store wrote, and varies without one', () => {
    const defs = new Map<Value, Op>();
    const k = def(defs, 'const', { value: 0x80000000 });
    const load = def(defs, 'load', { off: 0, width: 4, signed: true }, [v()]);
    expect(mayAlwaysHold(W(defs), load, 0x80000000)).toBe(false);
    const forwarded = new Map([[defs.get(load)!, k]]);
    expect(mayAlwaysHold(W(defs, { forwarded }), load, 0x80000000)).toBe(true);
    expect(constWord(W(defs, { forwarded }), def(defs, 'or', { imm: 0 }, [load]))).toBe(-0x80000000);
  });
});

describe('storeForwards — the store a load must read', () => {
  const blk = (ops: Op[]): Block => ({ params: [], ops });
  const k = (n: number) => {
    const r = v();
    return { r, op: mkOp('const', { results: [r], attrs: { value: n } }) };
  };
  const st = (base: Value, val: Value, off = 0, width = 4) =>
    mkOp('store', { operands: [base, val], attrs: { off, width } });
  const ld = (base: Value, off = 0, width = 4) =>
    mkOp('load', { operands: [base], results: [v()], attrs: { off, width, signed: true } });
  const ret = () => mkOp('ret', {});

  test('the last store to the same address, with nothing between that writes memory', () => {
    const base = v();
    const c = k(5);
    const l = ld(base);
    expect(storeForwards([blk([c.op, st(base, c.r), l, ret()])]).get(l)).toBe(c.r);
    const later = k(6);
    const l2 = ld(base);
    expect(storeForwards([blk([c.op, later.op, st(base, c.r), st(base, later.r), l2, ret()])]).get(l2)).toBe(later.r);
  });

  test('another address, another width, a store elsewhere or a call between: no forward', () => {
    const base = v();
    const c = k(5);
    for (const [ops, l] of (() => {
      const a = ld(base, 4);
      const b = ld(base, 0, 2);
      const d = ld(base);
      const e = ld(base);
      return [
        [[st(base, c.r), a], a],
        [[st(base, c.r), b], b],
        [[st(base, c.r), st(v(), c.r), d], d],
        [[st(base, c.r), mkOp('call', { operands: [], results: [v()], attrs: { target: 'g' } }), e], e],
      ] as [Op[], Op][];
    })()) {
      expect(storeForwards([blk([c.op, ...ops, ret()])]).has(l)).toBe(false);
    }
  });

  test("two `gaddr`s of one symbol are one base, and a block's only predecessor is every path", () => {
    const g1 = v();
    const g2 = v();
    const c = k(5);
    const l = ld(g2, 4);
    const tail = blk([l, ret()]);
    const head = blk([
      c.op,
      mkOp('gaddr', { results: [g1], attrs: { sym: 'gX' } }),
      mkOp('gaddr', { results: [g2], attrs: { sym: 'gX' } }),
      st(g1, c.r, 4),
      mkOp('br', { successors: [{ block: tail, args: [] }] }),
    ]);
    expect(storeForwards([head, tail]).get(l)).toBe(c.r);
    // A second way in is a path the store may not be on.
    const other = blk([mkOp('br', { successors: [{ block: tail, args: [] }] })]);
    expect(storeForwards([head, other, tail]).has(l)).toBe(false);
  });
});
