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
const rangeAt = (blocks: Block[], x: Value, at: Block) => literalAddresses(blocks, undefined).addressRangeOf(x, at);

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
    // a mask that is not 2^n - 1 is bounded by the mask alone: 0x0e & {0, 0x10} is {0}, under 0x0e
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

  test('what bounds nothing: a test on another value, a not-equal, a back edge left untested; and a test on the counter itself', () => {
    const other = loop(0, (h) => h.op('icmp_ule', {}, [h.op('load', { off: 0, width: 4 }, [v()]), k(h, 7)]));
    expect(rangeIn(other.blocks, other.q)).toBeUndefined();
    expect(rangeIn(other.blocks, u8Of(other.head, other.q))).toEqual({ lo: 0, hi: 255, stride: 1 });
    const ne = loop(0, (h, next) => h.op('icmp_ne', {}, [next, k(h, 8)]));
    expect(rangeIn(ne.blocks, ne.q)).toBeUndefined();
    // a test against the counter itself, `k + 1 < k`, holds only where `k + 1` wraps: from 0 it
    // never does, so the back edge is never taken and the counter is its start alone
    const carried = loop(0, (h, next, q) => h.op('icmp_ult', {}, [next, q]));
    expect(rangeIn(carried.blocks, carried.q)).toEqual({ lo: 0, hi: 0, stride: 0 });
    // a second back edge, from the block the latch's false edge enters, passes `q + 1` past it:
    // `next > 7` is all that edge proves, so the counter may be every word
    const entry = block();
    const q = v();
    const head = block([q]);
    const side = block();
    const exit = block();
    br(entry, head, [k(entry, 0)]);
    const next = head.op('add', {}, [q, k(head, 1)]);
    condBr(head, head.op('icmp_ule', {}, [next, k(head, 7)]), [head, [next]], [side, []]);
    condBr(side, side.op('load', { off: 0, width: 1 }, [v()]), [head, [next]], [exit, []]);
    expect(rangeIn([entry, head, side, exit], q)).toEqual({ lo: 0, hi: 2 ** 32 - 1, stride: 1 });
  });

  test("agbcc's far latch: the test's edge enters a block that jumps back, and what it proves holds there", () => {
    // `bhi .LCB; b .Lhead @long jump`: the body is past a short branch's reach
    const relayed = (into: (relay: Block, head: Block, next: Value) => Block[] = (r, h, n) => (br(r, h, [n]), [])) => {
      const entry = block();
      const q = v();
      const head = block([q]);
      const relay = block();
      const exit = block();
      br(entry, head, [k(entry, 0)]);
      const next = head.op('add', {}, [q, k(head, 1)]);
      condBr(head, head.op('icmp_ule', {}, [next, k(head, 7)]), [relay, []], [exit, []]);
      return { blocks: [entry, head, relay, exit, ...into(relay, head, next)], relay, q };
    };
    const far = relayed();
    expect(rangeIn(far.blocks, far.q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    // two hops
    const hops = relayed((relay, head, next) => {
      const hop = block();
      br(relay, hop);
      br(hop, head, [next]);
      return [hop];
    });
    expect(rangeIn(hops.blocks, hops.q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    // a relay that another edge also enters proves nothing of that edge's way in
    const other = block();
    const shared = relayed((relay, head, next) => (br(relay, head, [next]), br(other, relay), [other]));
    expect(rangeIn(shared.blocks, shared.q)).toBeUndefined();
  });

  test('a test at the top of the loop bounds what its body passes back', () => {
    // `for (q = 0; q < 8; q++) body`: head tests q, the body adds one and jumps back
    const entry = block();
    const q = v();
    const head = block([q]);
    const body = block();
    const exit = block();
    br(entry, head, [k(entry, 0)]);
    condBr(head, head.op('icmp_ult', {}, [q, k(head, 8)]), [body, []], [exit, []]);
    br(body, head, [body.op('add', {}, [q, k(body, 1)])]);
    expect(rangeIn([entry, head, body, exit], q)).toEqual({ lo: 0, hi: 8, stride: 1 });
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

  test('an arm whose test no value of the counter meets is never taken, and the join is the other arm', () => {
    // `for (k = 0; k < 16; k++) { t = k; if (t < 0) t += 7; use(t); }`: signed rounding on a counter
    // that never goes negative; the `+ 7` arm's edge carries `k < 0`, which [0, 15] cannot meet
    const entry = block();
    const q = v();
    const head = block([q]);
    const arm = block();
    const t = v();
    const join = block([t]);
    const exit = block();
    br(entry, head, [k(entry, 0)]);
    condBr(head, head.op('icmp_slt', {}, [q, k(head, 0)]), [arm, []], [join, [q]]);
    br(arm, join, [arm.op('add', {}, [q, k(arm, 7)])]);
    const next = join.op('add', {}, [q, k(join, 1)]);
    condBr(join, join.op('icmp_sle', {}, [next, k(join, 15)]), [head, [next]], [exit, []]);
    const blocks = [entry, head, arm, join, exit];
    expect(rangeIn(blocks, q)).toEqual({ lo: 0, hi: 15, stride: 1 });
    expect(rangeIn(blocks, t)).toEqual({ lo: 0, hi: 15, stride: 1 });
    // the arm a counter from -4 does take is in the join: [-4, 15] with the `+ 7` arm's [3, 6]
    const e2 = block();
    const q2 = v();
    const h2 = block([q2]);
    const a2 = block();
    const t2 = v();
    const j2 = block([t2]);
    const x2 = block();
    br(e2, h2, [k(e2, -4)]);
    condBr(h2, h2.op('icmp_slt', {}, [q2, k(h2, 0)]), [a2, []], [j2, [q2]]);
    br(a2, j2, [a2.op('add', {}, [q2, k(a2, 7)])]);
    const n2 = j2.op('add', {}, [q2, k(j2, 1)]);
    condBr(j2, j2.op('icmp_sle', {}, [n2, k(j2, 15)]), [h2, [n2]], [x2, []]);
    expect(rangeIn([e2, h2, a2, j2, x2], t2)).toEqual({ lo: 0, hi: 15, stride: 1 });
  });

  test('a test above the latch on another value does not widen the counter it carries', () => {
    // `for (k = 0; k < 8; k++) { use(k); if (gG > 1000) break; }`, k an s32: the back edge carries
    // `gG <= 1000` beside `k + 1 <= 7`, and only the second bounds where the counter settles
    const entry = block();
    const q = v();
    const head = block([q]);
    const latch = block();
    const exit = block();
    br(entry, head, [k(entry, 0)]);
    const g = head.op('load', { off: 0, width: 4, signed: true }, [v()]);
    condBr(head, head.op('icmp_sgt', {}, [g, k(head, 1000)]), [exit, []], [latch, []]);
    const next = latch.op('add', {}, [q, k(latch, 1)]);
    condBr(latch, latch.op('icmp_sle', {}, [next, k(latch, 7)]), [head, [next]], [exit, []]);
    const blocks = [entry, head, latch, exit];
    expect(rangeIn(blocks, q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    expect(rangeIn(blocks, u8Of(head, q))).toEqual({ lo: 0, hi: 7, stride: 1 });
    // the latch tests a join of `k + 2` and `k + 1`, which is computed from the counter though its
    // own form names only itself: `for (k = 0; k < 27; ) { if (gA[k & 15] & 1) { k += 2; continue; } k++; }`
    const e2 = block();
    const q2 = v();
    const h2 = block([q2]);
    const t2 = v();
    const j2 = block([t2]);
    const x2 = block();
    br(e2, h2, [k(e2, 0)]);
    const odd = h2.op('load', { off: 0, width: 4 }, [h2.op('and', { imm: 15 }, [q2])]);
    condBr(h2, odd, [j2, [h2.op('add', {}, [q2, k(h2, 2)])]], [j2, [h2.op('add', {}, [q2, k(h2, 1)])]]);
    condBr(j2, j2.op('icmp_sle', {}, [t2, k(j2, 26)]), [h2, [t2]], [x2, []]);
    expect(rangeIn([e2, h2, j2, x2], q2)).toEqual({ lo: 0, hi: 26, stride: 1 });
  });

  test('a test at the top of the body still holds past an if/else that joins before the latch', () => {
    // `for (k = 0; k < n; k++) { if (k >= 7) return; if (gF) x(); else y(); z(k); }`: the latch tests
    // a parameter, and only `k <= 6` on the way into the body bounds what the back edge passes
    const entry = block([v()]);
    const n = entry.params[0];
    const q = v();
    const head = block([q]);
    const body = block();
    const [arm, other] = [block(), block()];
    const join = block();
    const exit = block();
    br(entry, head, [k(entry, 0)]);
    condBr(head, head.op('icmp_ule', {}, [q, k(head, 6)]), [body, []], [exit, []]);
    condBr(body, body.op('load', { off: 0, width: 4 }, [v()]), [arm, []], [other, []]);
    br(arm, join);
    br(other, join);
    const next = join.op('add', {}, [q, k(join, 1)]);
    condBr(join, join.op('icmp_ult', {}, [next, n]), [head, [next]], [exit, []]);
    const blocks = [entry, head, body, arm, other, join, exit];
    expect(rangeIn(blocks, q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    // and asked in the join, the counter is what holds there
    expect(rangeAt(blocks, q, join)).toEqual({ lo: 0, hi: 6, stride: 1 });
  });

  test('a join of two updates that a signed latch tests is bounded, whichever param is asked first', () => {
    // `k = 0; do { if (gx) k += 1; else k += 2; m = (u8)k; a[m]; } while (k < 8)`: the latch and the
    // index read the join `k2 = phi(k + 1, k + 2)`, not the header's `k`. Asked first, `k2` opens
    // the cycle, and `k` read inside it must still be proven from its own start
    const build = (n: number, second: 'add' | 'load') => {
      const entry = block();
      const q = v();
      const head = block([q]);
      const [one, two] = [block(), block()];
      const t = v();
      const join = block([t]);
      const exit = block();
      br(entry, head, [k(entry, 0)]);
      condBr(head, head.op('load', { off: 0, width: 4 }, [v()]), [one, []], [two, []]);
      br(one, join, [one.op('add', {}, [q, k(one, 1)])]);
      br(two, join, [
        second === 'add'
          ? two.op('add', {}, [q, k(two, 2)])
          : two.op('load', { off: 0, width: 4, signed: true }, [v()]),
      ]);
      condBr(join, join.op('icmp_slt', {}, [t, k(join, n)]), [head, [t]], [exit, []]);
      return { blocks: [entry, head, one, two, join, exit], q, t, m: u8Of(join, t) };
    };
    const g = build(8, 'add');
    expect(rangeIn(g.blocks, g.t)).toEqual({ lo: 1, hi: 9, stride: 1 });
    expect(rangeIn(g.blocks, g.m)).toEqual({ lo: 1, hi: 9, stride: 1 });
    expect(rangeIn(g.blocks, g.q)).toEqual({ lo: 0, hi: 7, stride: 1 });
    // one context asked in either order answers the same
    const both = literalAddresses(g.blocks, undefined);
    expect([both.addressRangeOf(g.t), both.addressRangeOf(g.q)]).toEqual([
      { lo: 1, hi: 9, stride: 1 },
      { lo: 0, hi: 7, stride: 1 },
    ]);
    // the control `k < 15` reaches 16, past a 16-byte array
    const x = build(15, 'add');
    expect(rangeIn(x.blocks, x.t)).toEqual({ lo: 1, hi: 16, stride: 1 });
    // an arm that passes a loaded word: the latch bounds the join on one side only, and nothing
    // bounds the other, so neither param is proven
    const w = build(8, 'load');
    expect(rangeIn(w.blocks, w.t)).toBeUndefined();
    expect(rangeIn(w.blocks, w.q)).toBeUndefined();
  });

  test('a down-counter through a join every edge passes it to: the latch meets its word-straddling step', () => {
    // `k = 10; do { if (gx) {} else {} d = k - 1; } while (d <=u 10)` with both arms passing `k`:
    // the join's own range [0, 10] makes `d` the integers [-1, 9], words on both sides of 0; the
    // latch meets that as [0, 9], not [-1, 9] kept over it, or the hull with the start crosses a word
    const build = (latch: 'icmp_ule' | 'icmp_sle') => {
      const entry = block();
      const q = v();
      const head = block([q]);
      const t = v();
      const join = block([t]);
      const exit = block();
      br(entry, head, [k(entry, 10)]);
      condBr(head, head.op('load', { off: 0, width: 4 }, [v()]), [join, [q]], [join, [q]]);
      const d = join.op('add', {}, [t, k(join, -1)]);
      condBr(join, join.op(latch, {}, [d, k(join, 10)]), [head, [d]], [exit, []]);
      return { blocks: [entry, head, join, exit], q, t };
    };
    const g = build('icmp_ule');
    expect(rangeIn(g.blocks, g.q)).toEqual({ lo: 0, hi: 10, stride: 1 });
    expect(rangeIn(g.blocks, g.t)).toEqual({ lo: 0, hi: 10, stride: 1 });
    // the control `d <=s 10` passes -1 back, and the counter runs down to INT_MIN: no word interval
    const s = build('icmp_sle');
    expect(rangeIn(s.blocks, s.q)).toBeUndefined();
    expect(rangeIn(s.blocks, s.t)).toBeUndefined();
  });

  test('one context answers the same whatever was asked in it first', () => {
    // `k = 2; j = -2; do { k2 = k + 1; j2 = j + 2; } while (k2 >s -2)`: `k` runs up to INT_MAX and
    // `k2` to 2^31. Asked after `k` in one context, `k2` read the own range `k`'s question kept
    // while `k2`'s was under way (and answered nothing to it): [0, 2^31] where asked alone it is
    // [1, 2^31]. Every answer was sound; which one came back depended on what was asked first
    const entry = block();
    const [q, j] = [v(), v()];
    const head = block([q, j]);
    const [t, j2] = [v(), v()];
    const latch = block([t, j2]);
    const exit = block();
    br(entry, head, [k(entry, 2), k(entry, -2)]);
    br(head, latch, [head.op('add', {}, [q, k(head, 1)]), head.op('add', {}, [j, k(head, 2)])]);
    condBr(latch, latch.op('icmp_sle', {}, [t, k(latch, -2)]), [exit, []], [head, [t, j2]]);
    const blocks = [entry, head, latch, exit];
    const params = [q, j, t, j2];
    const fresh = params.map((x) => rangeIn(blocks, x));
    expect(fresh[2]).toEqual({ lo: 1, hi: 2 ** 31, stride: 1 });
    const shared = literalAddresses(blocks, undefined);
    expect(params.map((x) => shared.addressRangeOf(x))).toEqual(fresh);
    const reversed = literalAddresses(blocks, undefined);
    expect(
      [...params]
        .reverse()
        .map((x) => reversed.addressRangeOf(x))
        .reverse(),
    ).toEqual(fresh);
  });

  test('asked at a block, a value is read under the tests on the way in', () => {
    // `void q(u32 i) { if (i < 8) a[i * 2 + 1]; }`: a parameter bounds nothing, but not in the arm
    const entry = block([v()]);
    const i = entry.params[0];
    const arm = block();
    const out = block();
    condBr(entry, entry.op('icmp_ult', {}, [i, k(entry, 8)]), [arm, []], [out, []]);
    br(arm, out);
    const at = arm.op('add', {}, [arm.op('shl', { imm: 1 }, [i]), k(arm, 1)]);
    const blocks = [entry, arm, out];
    expect(rangeIn(blocks, at)).toBeUndefined();
    expect(rangeAt(blocks, at, arm)).toEqual({ lo: 1, hi: 15, stride: 2 });
    // the join below both ways in proves nothing of `i`, and nor does the entry itself
    expect(rangeAt(blocks, at, out)).toBeUndefined();
    expect(rangeAt(blocks, i, entry)).toBeUndefined();
    // `if (i >= 8) return;` is the false edge, negated, and the control `i < 9` reaches 17
    const e2 = block([v()]);
    const [ret, rest] = [block(), block()];
    condBr(e2, e2.op('icmp_uge', {}, [e2.params[0], k(e2, 8)]), [ret, []], [rest, []]);
    expect(rangeAt([e2, ret, rest], e2.params[0], rest)).toEqual({ lo: 0, hi: 7, stride: 1 });
    expect(rangeAt([e2, ret, rest], e2.params[0], ret)).toEqual({ lo: 8, hi: 2 ** 32 - 1, stride: 1 });
    const e3 = block([v()]);
    const [in3, out3] = [block(), block()];
    condBr(e3, e3.op('icmp_ult', {}, [e3.params[0], k(e3, 9)]), [in3, []], [out3, []]);
    const at3 = in3.op('add', {}, [in3.op('shl', { imm: 1 }, [e3.params[0]]), k(in3, 1)]);
    expect(rangeAt([e3, in3, out3], at3, in3)).toEqual({ lo: 1, hi: 17, stride: 2 });
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

describe('addressRangeOf — a signed remainder by a power of two', () => {
  const k = (b: ReturnType<typeof block>, value: number) => b.op('const', { value });
  /** agbcc's (and gcc's) `x % 2^n` of a signed `x`: `t = x; if (x < 0) t = x + 2^n - 1; x - (t >> n
   *  << n)`, the arm `bias` passes on the negative edge and `x` on the other; `x` is `of(entry)`. */
  const srem = (
    of: (entry: ReturnType<typeof block>, p: Value) => Value,
    {
      n = 3,
      bias = 2 ** n - 1,
      positiveBias = 0,
      scale = 2 ** n,
      test = 'icmp_slt',
    }: { n?: number; bias?: number; positiveBias?: number; scale?: number; test?: string } = {},
  ) => {
    const p = v();
    const entry = block([p]);
    const x = of(entry, p);
    const neg = block();
    const t = v();
    const join = block([t]);
    const zero = k(entry, 0);
    condBr(
      entry,
      entry.op(test, {}, [x, zero]),
      [neg, []],
      [join, [positiveBias === 0 ? x : entry.op('add', {}, [x, k(entry, positiveBias)])]],
    );
    br(neg, join, [neg.op('add', {}, [x, k(neg, bias)])]);
    const floor = join.op('mul', {}, [join.op('shr_s', { imm: n }, [t]), k(join, scale)]);
    const r = join.op('sub', {}, [x, floor]);
    return { blocks: [entry, neg, join], join, r, x };
  };
  const plus = (b: ReturnType<typeof block>, x: Value, c: number) => b.op('add', {}, [x, k(b, c)]);

  test('of an unknown sign it is exactly [-7, 7]: one past it fits an array, a narrowing of it does not', () => {
    const { blocks, join, r } = srem((_e, p) => p);
    // [-7, 7] holds words on both sides of zero: no one interval names them
    expect(rangeIn(blocks, r)).toBeUndefined();
    expect(rangeIn(blocks, plus(join, r, 8))).toEqual({ lo: 1, hi: 15, stride: 1 });
    expect(rangeIn(blocks, plus(join, r, 7))).toEqual({ lo: 0, hi: 14, stride: 1 });
    // `(u8)(x % 8)` of a negative x is 249..255, so the narrowing keeps its whole width
    expect(rangeIn(blocks, u8Of(join, r))).toEqual({ lo: 0, hi: 255, stride: 1 });
    // the bias on the edge `x >= 0` proves is no remainder: x + 7 there may wrap past INT_MAX
    const ge = srem((_e, p) => p, { test: 'icmp_sge' });
    expect(rangeIn(ge.blocks, plus(ge.join, ge.r, 8))).toBeUndefined();
  });

  test('of a value known not negative it is [0, 7], exact where the floor is one constant', () => {
    // a u8: the `x < 0` arm is never taken
    const u8 = srem((e, p) => u8Of(e, p));
    expect(rangeIn(u8.blocks, u8.r)).toEqual({ lo: 0, hi: 7, stride: 1 });
    expect(rangeIn(u8.blocks, u8Of(u8.join, u8.r))).toEqual({ lo: 0, hi: 7, stride: 1 });
    // `(u8)(x % 8) * 2`, agbcc's `lsl #24; lsr #23`
    const twice = u8.join.op('shr_u', { imm: 23 }, [u8.join.op('shl', { imm: 24 }, [u8.r])]);
    expect(rangeIn(u8.blocks, twice)).toEqual({ lo: 0, hi: 14, stride: 2 });
    // x in [0, 3] is its own remainder
    const small = srem((e, p) => e.op('and', { imm: 3 }, [p]));
    expect(rangeIn(small.blocks, small.r)).toEqual({ lo: 0, hi: 3, stride: 1 });
    // a remainder by 32, scaled by 2 in the form: `2 * (x % 32)`
    const scaled = srem((e, p) => u8Of(e, p), { n: 5 });
    const by2 = scaled.join.op('shl', { imm: 1 }, [scaled.r]);
    expect(rangeIn(scaled.blocks, by2)).toEqual({ lo: 0, hi: 62, stride: 2 });
  });

  test('a bias with no branch: `x - (x >> 3 << 3)` of any x, and `x + 7` of a u8', () => {
    const p = v();
    const b = block([p]);
    const floorOf = (t: Value) => b.op('shl', { imm: 3 }, [b.op('shr_s', { imm: 3 }, [t])]);
    expect(rangeIn([b], b.op('sub', {}, [p, floorOf(p)]))).toEqual({ lo: 0, hi: 7, stride: 1 });
    const x = u8Of(b, p);
    // x - 8 * floor((x + 7) / 8) is 0 at x = 0 and -7 at x = 1: [-7, 0]
    const r = b.op('sub', {}, [x, floorOf(plus(b, x, 7))]);
    expect(rangeIn([b], plus(b, r, 8))).toEqual({ lo: 1, hi: 8, stride: 1 });
    // of any x, `x + 7` may wrap past INT_MAX, where the floor is no longer `(x + 7) / 8`
    expect(rangeIn([b], plus(b, b.op('sub', {}, [p, floorOf(plus(b, p, 7))]), 8))).toBeUndefined();
  });

  test('what is no remainder pair: a bias out of range, a wrap, another x, other coefficients, the `x % 2` bias', () => {
    const plus8 = (s: ReturnType<typeof srem>) => rangeIn(s.blocks, plus(s.join, s.r, 8));
    // a bias of 8 is not below 2^3
    expect(plus8(srem((_e, p) => p, { bias: 8 }))).toBeUndefined();
    // biasing the non-negative edge: x + 7 of an x up to INT_MAX may wrap
    expect(plus8(srem((_e, p) => p, { positiveBias: 7, bias: 0 }))).toBeUndefined();
    // 4 * (t >> 3) is not 2^3 times it
    expect(plus8(srem((_e, p) => p, { scale: 4 }))).toBeUndefined();
    // an edge that passes another value
    const p = v();
    const entry = block([p]);
    const y = entry.op('load', { off: 0, width: 4 }, [v()]);
    const neg = block();
    const t = v();
    const join = block([t]);
    condBr(entry, entry.op('icmp_slt', {}, [p, k(entry, 0)]), [neg, []], [join, [p]]);
    br(neg, join, [neg.op('add', {}, [y, k(neg, 7)])]);
    const r = join.op('sub', {}, [p, join.op('shl', { imm: 3 }, [join.op('shr_s', { imm: 3 }, [t])])]);
    expect(rangeIn([entry, neg, join], plus(join, r, 8))).toBeUndefined();
    // two arms no compare on x separates: `x + 7` on an edge that proves nothing of x may wrap
    const q = v();
    const e2 = block([q, p]);
    const n2 = block();
    const t2 = v();
    const j2 = block([t2]);
    condBr(e2, e2.op('load', { off: 0, width: 1 }, [v()]), [n2, []], [j2, [p]]);
    br(n2, j2, [n2.op('add', {}, [p, k(n2, 7)])]);
    const r2 = j2.op('sub', {}, [p, j2.op('shl', { imm: 3 }, [j2.op('shr_s', { imm: 3 }, [t2])])]);
    expect(rangeIn([e2, n2, j2], plus(j2, r2, 8))).toBeUndefined();
    // agbcc's `x % 2` is `x - ((x + (x >>> 31)) >> 1 << 1)`: its bias is a term, not a constant
    const b = block([p]);
    const t3 = b.op('add', {}, [p, b.op('shr_u', { imm: 31 }, [p])]);
    const r3 = b.op('sub', {}, [p, b.op('shl', { imm: 1 }, [b.op('shr_s', { imm: 1 }, [t3])])]);
    expect(rangeIn([b], plus(b, r3, 2))).toBeUndefined();
  });
});
