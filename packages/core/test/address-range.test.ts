// UNIT tests for `addressRangeOf` (frontend/device-pins.ts over ir/bits.ts `stridedRange`): every
// address a value may hold, as a strided unsigned interval, over hand-built IR. The frame-object
// audit asks it whether a store through a computed pointer can reach a DMA channel's control
// halfword (frame-objects.ts `readWindow`); an answer narrower than the machine's values there
// turns a refusal into a frame word modelled as unread, so each refusal below is pinned as firmly
// as each answer.
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
    expect(rangeIn([entry, left, right, join], addr)).toEqual({ lo: 0x3003440, hi: 0x3003440 + 255 * 8, stride: 8 });
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
    expect(rangeIn([entry, right, join], addr, symbols)).toEqual({ lo: 0x3003590, hi: 0x3003590 + 255 * 8, stride: 8 });
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
    expect(rangeIn([entry], entry.op('load', { off: 0, width: 2, signed: false }, [p]))).toEqual({
      lo: 0,
      hi: 0xffff,
      stride: 1,
    });
    expect(rangeIn([entry], entry.op('zext', { width: 8 }, [p]))).toEqual({ lo: 0, hi: 0xff, stride: 1 });
  });

  test('a signed narrow index straddles zero: alone it names no interval, off a placed base it does', () => {
    const p = v();
    const entry = block([p]);
    const i = entry.op('load', { off: 0, width: 1, signed: true }, [p]);
    const base = entry.op('const', { value: 0x3003440 });
    const addr = entry.op('add', {}, [base, entry.op('shl', { imm: 3 }, [i])]);
    expect(rangeIn([entry], addr)).toEqual({ lo: 0x3003440 - 1024, hi: 0x3003440 + 1016, stride: 8 });
    expect(rangeIn([entry], entry.op('add', {}, [base, entry.op('sext', { width: 16 }, [p])]))).toEqual({
      lo: 0x3003440 - 0x8000,
      hi: 0x3003440 + 0x7fff,
      stride: 1,
    });
    // a sign-extending arm merged by a param keeps its integers until the base moves them
    const left = block();
    const right = block();
    const q = v();
    const join = block([q]);
    condBr(entry, p, [left, []], [right, []]);
    br(left, join, [left.op('load', { off: 0, width: 1, signed: true }, [p])]);
    br(right, join, [right.op('load', { off: 0, width: 1, signed: false }, [p])]);
    const at = join.op('add', {}, [q, join.op('const', { value: 0x3003440 })]);
    expect(rangeIn([entry, left, right, join], at)).toEqual({ lo: 0x3003440 - 128, hi: 0x3003440 + 255, stride: 1 });
    expect(rangeIn([entry, left, right, join], q)).toBeUndefined();
  });

  test('a mask and a zero-fill shift bound their result whatever they take; a shift left carries it', () => {
    const p = v();
    const entry = block([p]);
    const m = entry.op('const', { value: 0x1f });
    expect(rangeIn([entry], entry.op('and', {}, [p, m]))).toEqual({ lo: 0, hi: 0x1f, stride: 1 });
    expect(rangeIn([entry], entry.op('and', { imm: 0xff }, [p]))).toEqual({ lo: 0, hi: 0xff, stride: 1 });
    expect(rangeIn([entry], entry.op('shr_u', { imm: 28 }, [p]))).toEqual({ lo: 0, hi: 15, stride: 1 });
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
    expect(rangeIn([entry], entry.op('sub', {}, [k, i]))).toEqual({ lo: 1, hi: 0x100, stride: 1 });
    // shifted out of the word
    expect(rangeIn([entry], entry.op('shl', { imm: 28 }, [i]))).toBeUndefined();
  });

  test('the stride is the gcd of every term, the same value counted once, and of where merged arms start', () => {
    // agbcc's `ch * 12`, `((ch << 1) + ch) << 2`: the two `ch` terms add before the shift scales them
    const p = v();
    const entry = block([p]);
    const ch = u8Of(entry, p);
    const twelve = entry.op('shl', { imm: 2 }, [entry.op('add', {}, [entry.op('shl', { imm: 1 }, [ch]), ch])]);
    const base = entry.op('const', { value: 0x40000b0 });
    expect(rangeIn([entry], entry.op('add', {}, [base, twelve]))).toEqual({
      lo: 0x40000b0,
      hi: 0x40000b0 + 255 * 12,
      stride: 12,
    });
    // a constant that was negative is the same word: the sum moves into the word it fits
    const back = entry.op('const', { value: -8 });
    expect(rangeIn([entry], entry.op('add', {}, [entry.op('add', {}, [base, twelve]), back]))).toEqual({
      lo: 0x40000a8,
      hi: 0x40000a8 + 255 * 12,
      stride: 12,
    });
    // two channels merged by a branch: DMA1 or DMA2's source register, 12 apart
    const q = v();
    const join = block([q]);
    const left = block();
    condBr(entry, p, [left, []], [join, [entry.op('const', { value: 0x40000c8 })]]);
    br(left, join, [left.op('const', { value: 0x40000bc })]);
    expect(rangeIn([entry, left, join], q)).toEqual({ lo: 0x40000bc, hi: 0x40000c8, stride: 12 });
  });

  test('merged arms that straddle zero as integers are moved into one word arm by arm', () => {
    // {-1, 0} is no word interval as integers; arm by arm it is {0, 0xffffffff}, every word it holds
    const p = v();
    const entry = block([p]);
    const q = v();
    const join = block([q]);
    const left = block();
    condBr(entry, p, [left, []], [join, [entry.op('const', { value: 0 })]]);
    br(left, join, [left.op('const', { value: -1 })]);
    expect(rangeIn([entry, left, join], q)).toEqual({ lo: 0, hi: 0xffffffff, stride: 0xffffffff });
    // arms on one side of zero name the same words either way
    const r = v();
    const join2 = block([r]);
    const left2 = block();
    condBr(entry, p, [left2, []], [join2, [entry.op('const', { value: -3 })]]);
    br(left2, join2, [left2.op('const', { value: -1 })]);
    expect(rangeIn([entry, left2, join2], r)).toEqual({ lo: 0xfffffffd, hi: 0xffffffff, stride: 2 });
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

describe('addressRangeOf — what a shift or a mask leaves of its operand', () => {
  /** `q` merges two constants: `p ? lo : hi`. */
  const merged = (lo: number, hi: number) => {
    const p = v();
    const entry = block([p]);
    const left = block();
    const q = v();
    const join = block([q]);
    condBr(entry, p, [left, []], [join, [entry.op('const', { value: hi })]]);
    br(left, join, [left.op('const', { value: lo })]);
    return { blocks: [entry, left, join], join, q };
  };

  test("agbcc's `(u8)q`, a mask and a zext keep the range of a value that fits their width", () => {
    const { blocks, join, q } = merged(0, 5);
    expect(rangeIn(blocks, u8Of(join, q))).toEqual({ lo: 0, hi: 5, stride: 5 });
    expect(rangeIn(blocks, join.op('and', { imm: 0xff }, [q]))).toEqual({ lo: 0, hi: 5, stride: 5 });
    expect(rangeIn(blocks, join.op('and', {}, [join.op('const', { value: 7 }), q]))).toEqual({
      lo: 0,
      hi: 5,
      stride: 5,
    });
    expect(rangeIn(blocks, join.op('zext', { width: 8 }, [q]))).toEqual({ lo: 0, hi: 5, stride: 5 });
    // scaled, as an index: `(u8)q * 2 + 1`
    const at = join.op('add', {}, [join.op('shl', { imm: 1 }, [u8Of(join, q)]), join.op('const', { value: 1 })]);
    expect(rangeIn(blocks, at)).toEqual({ lo: 1, hi: 11, stride: 10 });
  });

  test('a value past the width, or one that wraps into it, keeps only the width bound', () => {
    const wide = merged(0, 300);
    expect(rangeIn(wide.blocks, u8Of(wide.join, wide.q))).toEqual({ lo: 0, hi: 255, stride: 1 });
    // -1 is 0xffffffff: (u8)-1 is 255, never -1
    const neg = merged(-1, 0);
    expect(rangeIn(neg.blocks, u8Of(neg.join, neg.q))).toEqual({ lo: 0, hi: 255, stride: 1 });
    expect(rangeIn(neg.blocks, neg.join.op('and', { imm: 0xff }, [neg.q]))).toEqual({ lo: 0, hi: 255, stride: 1 });
    expect(rangeIn(neg.blocks, neg.join.op('shr_u', { imm: 1 }, [neg.q]))).toEqual({
      lo: 0,
      hi: 2 ** 31 - 1,
      stride: 1,
    });
    // a mask that is not 2^n - 1 keeps no range: 0x0e & {0, 0x10} is {0}, under both 0x0e and 0x10
    const gap = merged(0, 0x10);
    expect(rangeIn(gap.blocks, gap.join.op('and', { imm: 0x0e }, [gap.q]))).toEqual({ lo: 0, hi: 0x0e, stride: 1 });
  });

  test('a zero-fill shift right divides the range it shifts, a shift left multiplies it', () => {
    const s = merged(0, 5);
    // {0, 5 << 16} >> 24 is {0}
    const odd = s.join.op('shr_u', { imm: 24 }, [s.join.op('shl', { imm: 16 }, [s.q])]);
    expect(rangeIn(s.blocks, odd)).toEqual({ lo: 0, hi: 0, stride: 0 });
    const r = merged(0, 7);
    expect(rangeIn(r.blocks, r.join.op('shr_u', { imm: 1 }, [r.q]))).toEqual({ lo: 0, hi: 3, stride: 1 });
    // agbcc's `(u8)q * 2`, `lsl #24; lsr #23`: narrowed, then doubled, keeping the stride
    const twice = r.join.op('shr_u', { imm: 23 }, [r.join.op('shl', { imm: 24 }, [r.q])]);
    expect(rangeIn(r.blocks, twice)).toEqual({ lo: 0, hi: 14, stride: 14 });
    // past the width, `lsl #24` leaves the word: only the 9 bits `lsr #23` keeps bound it
    const wide = merged(0, 300);
    const wideTwice = wide.join.op('shr_u', { imm: 23 }, [wide.join.op('shl', { imm: 24 }, [wide.q])]);
    expect(rangeIn(wide.blocks, wideTwice)).toEqual({ lo: 0, hi: 511, stride: 1 });
  });
});

describe('addressRangeOf — what a loop latch proves of the counter its back edge passes', () => {
  /** `for (q = init; ; ) { body; next = step(q); if (test(next)) continue; else break; }`, the latch
   *  a `cond_br` on the compare `latch` builds from `next`: its true edge goes back unless `exitOnTrue`. */
  const loop = (
    init: number,
    latch: (head: ReturnType<typeof block>, next: Value, q: Value) => Value,
    { exitOnTrue = false, step = 1 } = {},
  ) => {
    const entry = block();
    const q = v();
    const head = block([q]);
    const exit = block();
    br(entry, head, [entry.op('const', { value: init })]);
    const next = head.op('add', {}, [q, head.op('const', { value: step })]);
    const c = latch(head, next, q);
    if (exitOnTrue) {
      condBr(head, c, [exit, []], [head, [next]]);
    } else {
      condBr(head, c, [head, [next]], [exit, []]);
    }
    return { blocks: [entry, head, exit], head, q, next };
  };
  const k = (b: ReturnType<typeof block>, value: number) => b.op('const', { value });

  test("agbcc's `for (k = 0; k < 8; k++) a[(u8)k * 2 + 1]`: the latch `k + 1 <= 7` bounds the index", () => {
    const { blocks, head, q } = loop(0, (h, next) => h.op('icmp_ule', {}, [next, k(h, 7)]));
    expect(rangeIn(blocks, q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    const at = head.op('add', {}, [head.op('shl', { imm: 1 }, [u8Of(head, q)]), k(head, 1)]);
    expect(rangeIn(blocks, at)).toEqual({ lo: 1, hi: 15, stride: 2 });
  });

  test('the control `k < 9` reaches 8, past a 16-byte array at `k * 2 + 1`', () => {
    const { blocks, head, q } = loop(0, (h, next) => h.op('icmp_ule', {}, [next, k(h, 8)]));
    const at = head.op('add', {}, [head.op('shl', { imm: 1 }, [u8Of(head, q)]), k(head, 1)]);
    expect(rangeIn(blocks, at)).toEqual({ lo: 1, hi: 17, stride: 2 });
  });

  test('a test on the false edge is negated, and swapped operands read the other way round', () => {
    const neg = loop(0, (h, next) => h.op('icmp_ugt', {}, [next, k(h, 7)]), { exitOnTrue: true });
    expect(rangeIn(neg.blocks, neg.q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    const swapped = loop(0, (h, next) => h.op('icmp_uge', {}, [k(h, 63), next]));
    expect(rangeIn(swapped.blocks, swapped.q)).toEqual({ lo: 0, hi: 63, stride: 1 });
    // a bound on a value that is itself bounded: `next < n`, n a u8 reload, is `next <= 254`
    const byLoad = loop(0, (h, next) => h.op('icmp_ult', {}, [next, h.op('load', { off: 0, width: 1 }, [v()])]));
    expect(rangeIn(byLoad.blocks, byLoad.q)).toEqual({ lo: 0, hi: 254, stride: 1 });
  });

  test("MIPS's `andi` passed, the unmasked sum tested: the bound reaches the term it names", () => {
    // gcc2.7.2's `for (k = 0; k < 64; k++) b[(u8)k]`: `v = k + 1; if (v < 64) goto head(v & 255, v)`
    const entry = block();
    const [q, kk] = [v(), v()];
    const head = block([q, kk]);
    const exit = block();
    br(entry, head, [entry.op('and', { imm: 0xff }, [k(entry, 0)]), k(entry, 0)]);
    const next = head.op('add', {}, [kk, k(head, 1)]);
    const c = head.op('icmp_ult', {}, [next, k(head, 64)]);
    condBr(head, c, [head, [head.op('and', { imm: 0xff }, [next]), next]], [exit, []]);
    expect(rangeIn([entry, head, exit], q)).toEqual({ lo: 0, hi: 63, stride: 1 });
    expect(rangeIn([entry, head, exit], kk)).toEqual({ lo: 0, hi: 63, stride: 1 });
  });

  test('what bounds nothing: a test on another value, a not-equal, a back edge left untested', () => {
    const other = loop(0, (h) => h.op('icmp_ule', {}, [h.op('load', { off: 0, width: 4 }, [v()]), k(h, 7)]));
    expect(rangeIn(other.blocks, other.q)).toBeUndefined();
    expect(rangeIn(other.blocks, u8Of(other.head, other.q))).toEqual({ lo: 0, hi: 255, stride: 1 });
    const ne = loop(0, (h, next) => h.op('icmp_ne', {}, [next, k(h, 8)]));
    expect(rangeIn(ne.blocks, ne.q)).toBeUndefined();
    // a test against a value the loop carries unbounded proves nothing of the counter
    const carried = loop(0, (h, next, q) => h.op('icmp_ult', {}, [next, q]));
    expect(rangeIn(carried.blocks, carried.q)).toBeUndefined();
    // a second back edge, from a block the latch does not guard, passes `q + 1` unbounded
    const entry = block();
    const q = v();
    const head = block([q]);
    const side = block();
    const exit = block();
    br(entry, head, [k(entry, 0)]);
    const next = head.op('add', {}, [q, k(head, 1)]);
    condBr(head, head.op('icmp_ule', {}, [next, k(head, 7)]), [head, [next]], [side, []]);
    condBr(side, side.op('load', { off: 0, width: 1 }, [v()]), [head, [next]], [exit, []]);
    expect(rangeIn([entry, head, side, exit], q)).toBeUndefined();
  });

  test('a signed latch bounds one side; the start bounds the other, by induction', () => {
    // s32 k: `k + 1 <= 7` signed holds of every negative k too, but k starts at 0 and only grows
    const { blocks, head, q } = loop(0, (h, next) => h.op('icmp_sle', {}, [next, k(h, 7)]));
    expect(rangeIn(blocks, q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    expect(rangeIn(blocks, u8Of(head, q))).toEqual({ lo: 0, hi: 7, stride: 1 });
    // the latch tests the counter, not what it passes: `if (k < 7) goto head(k + 1)`
    const before = loop(0, (h, _next, q) => h.op('icmp_slt', {}, [q, k(h, 7)]));
    expect(rangeIn(before.blocks, before.q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    // counting down: `for (k = 7; k - 1 >= 0; k--)`
    const down = loop(7, (h, next) => h.op('icmp_sge', {}, [next, k(h, 0)]), { step: -1 });
    expect(rangeIn(down.blocks, down.q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    // a step of two keeps it in [0, 7] too
    const two = loop(0, (h, next) => h.op('icmp_sle', {}, [next, k(h, 7)]), { step: 2 });
    expect(rangeIn(two.blocks, two.q)).toEqual({ lo: 0, hi: 7, stride: 1 });
  });

  test("kleod's sub_0804D0B0 loop: from 13 while `k + 1 < n`, n a u8 reload, is [13, 254]", () => {
    const { blocks, q } = loop(13, (h, next) =>
      h.op('icmp_slt', {}, [next, h.op('load', { off: 0, width: 1, signed: false }, [v()])]),
    );
    expect(rangeIn(blocks, q)).toEqual({ lo: 13, hi: 254, stride: 1 });
  });

  test('what no induction proves: an unbounded start, a counter that may wrap, a second update', () => {
    // `for (k = gS; k < 8; k++)`: the start is any word
    const entry = block();
    const q = v();
    const head = block([q]);
    const exit = block();
    br(entry, head, [entry.op('load', { off: 0, width: 4, signed: true }, [v()])]);
    const next = head.op('add', {}, [q, k(head, 1)]);
    condBr(head, head.op('icmp_sle', {}, [next, k(head, 7)]), [head, [next]], [exit, []]);
    expect(rangeIn([entry, head, exit], q)).toBeUndefined();
    expect(rangeIn([entry, head, exit], u8Of(head, q))).toEqual({ lo: 0, hi: 255, stride: 1 });
    // `for (k = 1; k + 1 > 0; k++)` runs until k + 1 wraps to INT_MIN: the latch alone bounds what
    // its edge passes, every positive word, and no induction narrows it (nothing settles below)
    const wraps = loop(1, (h, next) => h.op('icmp_sgt', {}, [next, k(h, 0)]));
    expect(rangeIn(wraps.blocks, wraps.q)).toEqual({ lo: 1, hi: 2 ** 31 - 1, stride: 1 });
    // a signed latch beside a second back edge that adds two and is not tested
    const e2 = block();
    const q2 = v();
    const h2 = block([q2]);
    const side = block();
    const x2 = block();
    br(e2, h2, [k(e2, 0)]);
    const n1 = h2.op('add', {}, [q2, k(h2, 1)]);
    condBr(h2, h2.op('icmp_sle', {}, [n1, k(h2, 7)]), [h2, [n1]], [side, []]);
    condBr(side, side.op('load', { off: 0, width: 1 }, [v()]), [h2, [side.op('add', {}, [q2, k(side, 2)])]], [x2, []]);
    expect(rangeIn([e2, h2, side, x2], q2)).toBeUndefined();
  });
});
