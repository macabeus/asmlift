// The `/unreduce` lever (l3/unreduce.ts): a loop-carried accumulator is deleted and each read
// spelled as its closed form in the counter. What these tests pin is the pair of claims the
// rewrite rests on — that the closed form is RELATED to the counter's own start by the
// accumulator's stride (checked structurally, in all three accepted shapes), and that every way
// the `acc == g(ctr)` invariant could be broken DECLINES rather than approximating. Each gate in
// UNREDUCE_GATES is one accepted fixture with one fact edited.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import { type Expr, type SFn, type Stmt } from '../src/l3/ast';
import { type UnreduceResult, unreduceAccumulators } from '../src/l3/unreduce';
import { ARMV4T_AGBCC } from '../src/target';

/** the GBA I/O page, as target.ts declares it */
const GBA: readonly [number, number] = [0x04000000, 0x04000400];

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const cell = (addr: number): Expr => ({
  k: 'index',
  base: c(addr),
  idx: c(0),
  width: 4,
  signed: true,
});
const plus = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '+', l, r });
const shl = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '<<', l, r });
const mul = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '*', l, r });
const set = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const st = (lval: Expr, value: Expr): Stmt => ({ k: 'store', lval, value });

/** synthetic:dmafill's own shape: `acc = (a0 << 6) + a1` stepped by 64 against a counter by 1 */
const fill = (over: Partial<SFn> = {}, body?: Stmt[]): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: T.s(32) },
    { name: 'a1', type: T.s(32) },
  ],
  locals: [
    { name: 'acc', type: T.s(32) },
    { name: 'i', type: T.s(32) },
  ],
  retType: T.void(),
  body: body ?? [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ],
  ...over,
});

const emit = (r: UnreduceResult | null): string => (r === null ? '<declined>' : cBackend.emit(r.sfn));

test('a shift-scaled accumulator becomes the closed form in the counter', () => {
  const out = unreduceAccumulators(fill(), GBA);
  expect(emit(out)).toContain('*(s32 *)67109080 = (i << 6) + a1;');
  // the accumulator, its init and its step are all gone
  expect(emit(out)).not.toContain('acc');
  expect(out!.sfn.locals.map((l) => l.name)).toEqual(['i']);
  // read-only: the input tree is not mutated
  expect(cBackend.emit(fill())).toContain('*(s32 *)67109080 = acc;');
});

test('a PRODUCT-scaled accumulator relates through an invariant multiplier', () => {
  // klonoa's LoadBGTilemapData (a checkout function, not a benchmark row) has this shape: the
  // stride is an expression rather than a constant, carried in the init as the start's multiplier.
  const stride = shl(c(16), v('a1'));
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(mul(stride, v('a0')), c(8))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), stride)), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(emit(unreduceAccumulators(s, GBA))).toContain('*(s32 *)67109080 = (16 << a1) * i + 8;');
});

test('a bare counter relates when the two strides agree', () => {
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(v('a0'), c(8))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(1))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(emit(unreduceAccumulators(s, GBA))).toContain('*(s32 *)67109080 = i + 8;');
});

test('a `for` loop reads its counter out of init and inc', () => {
  const s = fill({}, [
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'for',
      init: set('i', v('a0')),
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      inc: set('i', plus(v('i'), c(1))),
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64)))],
    },
  ]);
  expect(emit(unreduceAccumulators(s, GBA))).toContain('*(s32 *)67109080 = (i << 6) + a1;');
});

test('a stride that does not match the init’s scale declines', () => {
  // the init scales the counter by 2^6 but the accumulator walks by 32 — no linear relation
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(32))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an init that never names the counter declines', () => {
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', v('a1')),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a third assignment to the accumulator declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift(set('acc', c(0)));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an address-taken accumulator declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift(st(cell(0x040000d4), { k: 'addr', name: 'acc' }));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a volatile or frame-homed accumulator declines', () => {
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.s(32), volatile: true },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.s(32), frame: { loads: 1, stores: 1 } },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
  // …and a POINTER-to-volatile accumulator, which is the fourth pin `SFn.locals` carries. Deleting
  // one re-spells `*p = 0` as a raw cast with no qualifier on it: a volatile store silently made
  // plain, which is the one wrongness the differ cannot referee. Every peer lever in l3/ tests both
  // flags; this one used to test three of four.
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.ptr(T.u(16)), pointeeVolatile: true },
          { name: 'i', type: T.s(32) },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
});

test('a volatile counter declines', () => {
  // Substitution puts the counter where every accumulator read stood, so a counter read once per
  // iteration is read once per USE. For a volatile object the access COUNT is the semantics.
  expect(
    unreduceAccumulators(
      fill({
        locals: [
          { name: 'acc', type: T.s(32) },
          { name: 'i', type: T.s(32), volatile: true },
        ],
      }),
      GBA,
    ),
  ).toBeNull();
});

test('an accumulator read after the loop declines', () => {
  const s = fill();
  s.body.push(st(cell(0x040000dc), v('acc')));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a read below the step declines', () => {
  // below its own step the accumulator is one stride ahead of the counter, so the closed form
  // would spell a value one iteration early
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.splice(2, 0, st(cell(0x040000dc), v('acc')));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a counter assigned inside an arm declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift({ k: 'if', cond: c(1), then: [set('i', c(0))], else: [] });
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an address-taken counter declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift(st(cell(0x040000d4), { k: 'addr', name: 'i' }));
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a `continue` in the body declines', () => {
  const s = fill();
  const loop = s.body[2] as Extract<Stmt, { k: 'while' }>;
  loop.body.unshift({ k: 'if', cond: c(1), then: [{ k: 'continue' }], else: [] });
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a call in the init declines', () => {
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), { k: 'call', fn: 'g', args: [] })),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a volatile read in the init declines', () => {
  const volatileRead: Expr = {
    k: 'index',
    base: { k: 'cast', to: T.ptr(T.s(32)), volatile: true, e: c(0x03001048) },
    idx: c(0),
    width: 4,
    signed: true,
  };
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), volatileRead)),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a moved read declines unless the loop writes only device cells', () => {
  const read = { ...cell(0x03001048) };
  const loopWith = (write: Expr): SFn =>
    fill({}, [
      set('i', v('a0')),
      set('acc', plus(shl(v('a0'), c(6)), read)),
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [st(write, v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
      },
    ]);
  // every write inside the declared device window, the read rooted outside it: admitted
  expect(emit(unreduceAccumulators(loopWith(cell(0x040000d8)), GBA))).toContain('(i << 6) + *(s32 *)50335816');
  // one write to ordinary memory, and the loop could have changed what the read sees
  expect(unreduceAccumulators(loopWith(cell(0x03001100)), GBA)).toBeNull();
  // …and with no declared window there is nothing to place either address in
  expect(unreduceAccumulators(loopWith(cell(0x040000d8)), undefined)).toBeNull();
});

test('a read whose ROOT is outside the window but whose CELL is inside it declines', () => {
  // `((s32 *)0x03FFFFF0)[8]` denotes 0x04000010 — BG0HOFS. Resolving only the chain's root places
  // it in EWRAM and admits it for duplication, which is exactly what the read-side half exists to
  // prevent. The write side always resolved the whole address; now both do, where they can.
  const read: Expr = { k: 'index', base: c(0x03fffff0), idx: c(8), width: 4, signed: true };
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), read)),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an effect the loop evaluates OUTSIDE its body still bars a moved read', () => {
  // The aliasing walk used to scan `loop.body` alone. A `for` evaluates its inc every iteration and
  // its cond before every one, so a call there writes just as much as a call in the body does.
  const read = { ...cell(0x03001048) };
  const withCond = (cond: Expr, inc: Stmt): SFn =>
    fill({ locals: [{ name: 'acc', type: T.s(32) }] }, [
      set('acc', plus(shl(v('a1'), c(6)), read)),
      {
        k: 'for',
        init: set('a0', v('a1')),
        cond,
        inc,
        body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64)))],
      },
    ]);
  const plainCond: Expr = { k: 'bin', op: '<=', l: v('a0'), r: plus(v('a1'), c(3)) };
  const plainInc = set('a0', plus(v('a0'), c(1)));
  // the same loop with no effect outside the body is admitted, so the two below isolate the scan
  expect(emit(unreduceAccumulators(withCond(plainCond, plainInc), GBA))).toContain('(a0 << 6) + *(s32 *)50335816');
  expect(
    unreduceAccumulators(withCond({ k: 'bin', op: '<=', l: { k: 'call', fn: 'g', args: [] }, r: c(3) }, plainInc), GBA),
  ).toBeNull();
  expect(unreduceAccumulators(withCond(plainCond, st(cell(0x03001100), c(1))), GBA)).toBeNull();
});

test('a moved read over a loop that ARMS A TRANSFER is offered only under proof', () => {
  // The gates place every write the C performs. What they cannot place is the write the DEVICE
  // performs in answer to one: storing to DMA3CNT starts a transfer into ordinary memory, so the
  // loop CAN change what the moved read sees. The candidate still exists — its one corpus
  // inhabitant is a byte-exact match — but it carries `needsProof`, and rank.ts publishes such a
  // spelling only at a byte-exact score.
  const read = { ...cell(0x03003430) };
  const loopWriting = (addr: number, width = 4): SFn =>
    fill({}, [
      set('i', v('a0')),
      set('acc', plus(shl(v('a0'), c(6)), read)),
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [
          st({ k: 'index', base: c(addr), idx: c(0), width, signed: true }, v('acc')),
          set('acc', plus(v('acc'), c(64))),
          set('i', plus(v('i'), c(1))),
        ],
      },
    ]);
  const DMA_TRIGGERS = ARMV4T_AGBCC.capabilities.deviceMemoryWriters;
  // DMA3DAD stages a transfer and starts nothing — no proof needed
  expect(unreduceAccumulators(loopWriting(0x040000d8), GBA, DMA_TRIGGERS)!.needsProof).toBe(false);
  // the 32-bit DMA3CNT write every GBA DMA macro ends with REACHES the enable halfword at +2
  expect(unreduceAccumulators(loopWriting(0x040000dc), GBA, DMA_TRIGGERS)!.needsProof).toBe(true);
  // …and a HALFWORD write to DMA3CNT_L does not
  expect(unreduceAccumulators(loopWriting(0x040000dc, 2), GBA, DMA_TRIGGERS)!.needsProof).toBe(false);
  // a target that declares no trigger list claims nothing: every device write may be one
  expect(unreduceAccumulators(loopWriting(0x040000d8), GBA, undefined)!.needsProof).toBe(true);
  // and a closed form that reads no memory has nothing to prove whatever the loop arms
  expect(unreduceAccumulators(fill(), GBA, undefined)!.needsProof).toBe(false);
});

test('a closed form that reads no memory needs no window at all', () => {
  expect(emit(unreduceAccumulators(fill(), undefined))).toContain('(i << 6) + a1');
});

test('a nested loop is out of scope — the pass walks TOP-LEVEL loops only', () => {
  // The reason is the SCAN, not the fixture: the init and the counter start here stand above the
  // loop exactly as they do in the accepted case, and the pass still never looks. 91 of the 189
  // loop-bearing corpus trees are in this position (see the file header). A decline here names no
  // gate, which is why the scope is written down rather than inferred from a table that answers
  // for a smaller population than it appears to.
  const s = fill();
  const inner = s.body[2];
  expect(
    unreduceAccumulators(fill({}, [s.body[0], s.body[1], { k: 'while', cond: c(1), body: [inner] }]), GBA),
  ).toBeNull();
});

test('an init reading a name the loop writes declines, a `for`’s counter included', () => {
  // `w` is loop-carried, so evaluating the init inside the loop reads a different value
  const s = fill(
    {
      locals: [
        { name: 'acc', type: T.s(32) },
        { name: 'i', type: T.s(32) },
        { name: 'w', type: T.s(32) },
      ],
    },
    [
      set('i', v('a0')),
      set('w', c(0)),
      set('acc', plus(shl(v('a0'), c(6)), v('w'))),
      {
        k: 'while',
        cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
        body: [
          st(cell(0x040000d8), v('acc')),
          set('w', plus(v('w'), c(1))),
          set('acc', plus(v('acc'), c(64))),
          set('i', plus(v('i'), c(1))),
        ],
      },
    ],
  );
  expect(unreduceAccumulators(s, GBA)).toBeNull();

  // …AND THE `for` CASE, which asking `loop.body` alone could not see: a `for`'s counter is
  // stepped in `loop.inc`, so the ONE name this gate exists to catch was invisible on exactly the
  // loop kind whose stepper lives outside the body. Here `a0` is both the counter AND a name the
  // init reads; the closed form `(a0 << 6) + a0` re-reads it after it has moved, and diverges from
  // the first iteration on. Executed both ways at four input vectors, all four diverge.
  const forCtr = fill({ locals: [{ name: 'acc', type: T.s(32) }] }, [
    set('acc', plus(shl(v('a1'), c(6)), v('a0'))),
    {
      k: 'for',
      init: set('a0', v('a1')),
      cond: { k: 'bin', op: '<=', l: v('a0'), r: plus(v('a1'), c(3)) },
      inc: set('a0', plus(v('a0'), c(1))),
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64)))],
    },
  ]);
  expect(unreduceAccumulators(forCtr, GBA)).toBeNull();
});

test('a scale between the counter and the sum must carry the WHOLE stride', () => {
  // `(a0 << 6) + a1` walked by 1: the counter's own stride through that shift is 64, so no
  // substitution relates the two. A rule that fell back to the bare counter here would spell a
  // closed form 64× too fast — and would compile, and would score.
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', plus(shl(v('a0'), c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(1))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('an enclosing operator that is not a sum declines', () => {
  // `8 - a0` walks by -1 per step of the counter, not +1: only a `+` spine preserves the stride
  const s = fill({}, [
    set('i', v('a0')),
    set('acc', { k: 'bin', op: '-', l: c(8), r: v('a0') }),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(1))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});

test('a call inside the counter start declines — the init statement is deleted, not moved', () => {
  const call: Expr = { k: 'call', fn: 'g', args: [] };
  const s = fill({}, [
    set('i', call),
    set('acc', plus(shl(call, c(6)), v('a1'))),
    {
      k: 'while',
      cond: { k: 'bin', op: '<=', l: v('i'), r: c(31) },
      body: [st(cell(0x040000d8), v('acc')), set('acc', plus(v('acc'), c(64))), set('i', plus(v('i'), c(1)))],
    },
  ]);
  expect(unreduceAccumulators(s, GBA)).toBeNull();
});
