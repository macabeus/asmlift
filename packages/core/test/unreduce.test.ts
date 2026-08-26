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
import { unreduceAccumulators } from '../src/l3/unreduce';

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

const emit = (s: SFn | null): string => (s === null ? '<declined>' : cBackend.emit(s));

test('a shift-scaled accumulator becomes the closed form in the counter', () => {
  const out = unreduceAccumulators(fill(), GBA);
  expect(emit(out)).toContain('*(s32 *)67109080 = (i << 6) + a1;');
  // the accumulator, its init and its step are all gone
  expect(emit(out)).not.toContain('acc');
  expect(out!.locals.map((l) => l.name)).toEqual(['i']);
  // read-only: the input tree is not mutated
  expect(emit(fill())).toContain('*(s32 *)67109080 = acc;');
});

test('a PRODUCT-scaled accumulator relates through an invariant multiplier', () => {
  // kleod:LoadBGTilemapData's own shape: the stride is an expression, not a constant, and the
  // init carries it as the counter start's multiplier.
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

test('a closed form that reads no memory needs no window at all', () => {
  expect(emit(unreduceAccumulators(fill(), undefined))).toContain('(i << 6) + a1');
});

test('a nested loop is out of scope — the counter start must stand above the loop', () => {
  const s = fill();
  const inner = s.body[2];
  expect(
    unreduceAccumulators(fill({}, [s.body[0], s.body[1], { k: 'while', cond: c(1), body: [inner] }]), GBA),
  ).toBeNull();
});
