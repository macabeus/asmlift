// The /nearbase lever (l3/nearbase.ts): neighbor absolute deref addresses re-spell as offsets
// from one shared u8* base local holding the cluster's lowest address; the differ referees.
import { expect, test } from 'vitest';

import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { nearBaseClusters } from '../src/l3/nearbase';
import { sinkInitsToFirstUse } from '../src/l3/sinkinit';

const nearBaseClusters255 = (sfn: SFn) => nearBaseClusters(sfn, 255);

const s32 = { kind: 'int', width: 32, signed: true } as const;
const c = (value: number): Expr => ({ k: 'const', value });
const deref = (addr: number, width: number): Expr => ({ k: 'index', base: c(addr), idx: c(0), width, signed: false });
const v_ = (): Expr => ({ k: 'var', name: 'i0' });
const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], retType: s32, body });

test('two neighbor cells and an in-span word share one base local', () => {
  const r = nearBaseClusters255(
    fn([
      { k: 'assign', name: 'x', value: deref(0x03001048, 2) },
      { k: 'exprstmt', value: deref(0x0300104a, 2) },
      { k: 'return', value: deref(0x03001070, 4) },
    ]),
  );
  expect(r).not.toBeNull();
  expect(r!.locals.map((l) => l.name)).toContain('p0');
  const init = r!.body[0] as Extract<Stmt, { k: 'assign' }>;
  expect(init.name).toBe('p0');
  // base = the lowest MEMBER; the others carry their distances from it
  const src = JSON.stringify(r!.body);
  expect(src).toContain('"value":50335816'); // the base init holds the lowest address
  expect(src).toContain('"value":40'); // 0x03001070 as base + 40
});

test('the lowest member derefs the bare base, the rest carry their offsets', () => {
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: deref(100, 2) },
      { k: 'exprstmt', value: deref(102, 2) },
    ]),
  )!;
  const [a, b] = r.body.slice(1) as Extract<Stmt, { k: 'exprstmt' }>[];
  expect((a.value as Extract<Expr, { k: 'index' }>).base).toEqual({ k: 'var', name: 'p0' });
  expect((b.value as Extract<Expr, { k: 'index' }>).base).toEqual({
    k: 'bin',
    op: '+',
    l: { k: 'var', name: 'p0' },
    r: { k: 'const', value: 2 },
  });
});

test('declined: a single address forms no cluster', () => {
  expect(nearBaseClusters255(fn([{ k: 'exprstmt', value: deref(0x03001048, 2) }]))).toBeNull();
});

test('declined: addresses beyond the 255-byte span stay independent', () => {
  expect(
    nearBaseClusters255(
      fn([
        { k: 'exprstmt', value: deref(1000, 4) },
        { k: 'exprstmt', value: deref(1256, 4) },
      ]),
    ),
  ).toBeNull();
});

test('a bare const VALUE inside a formed window re-spells as (s32)(base + off); outside it never does', () => {
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: deref(100, 2) },
      { k: 'exprstmt', value: deref(102, 2) },
      { k: 'assign', name: 'y', value: { k: 'bin', op: '+', l: c(112), r: c(1) } },
    ]),
  );
  const y = r!.body[3] as Extract<Stmt, { k: 'assign' }>;
  // 112 sits in the window (100..355): the derived spelling, value-equal by construction.
  // 1 does not: a plain integer stays a plain integer.
  expect(y.value).toEqual({
    k: 'bin',
    op: '+',
    l: {
      k: 'cast',
      to: { kind: 'int', width: 32, signed: true },
      e: { k: 'bin', op: '+', l: { k: 'var', name: 'p0' }, r: c(12) },
    },
    r: c(1),
  });
});

test('a const inside a struct-pointer cast never value-rewrites — the dot-form base keeps its spelling', () => {
  const structCast: Expr = {
    k: 'cast',
    to: { kind: 'ptr', to: { kind: 'struct', name: 'S' } } as never,
    e: c(104),
  };
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: deref(100, 2) },
      { k: 'exprstmt', value: deref(102, 2) },
      { k: 'assign', name: 'y', value: structCast },
    ]),
  );
  const y = r!.body[3] as Extract<Stmt, { k: 'assign' }>;
  expect(y.value).toEqual(structCast);
});

test('no cluster, no value rewrite: a lone deref plus an in-reach const still declines', () => {
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: deref(100, 2) },
      { k: 'assign', name: 'y', value: c(104) },
    ]),
  );
  expect(r).toBeNull(); // membership is deref-only — a value never forms or joins a cluster
});

test('a struct-pointer cast base is never a cluster member (the dot-form stride)', () => {
  const structDeref: Expr = {
    k: 'index',
    base: { k: 'cast', to: { kind: 'ptr', to: { kind: 'struct', name: 'S' } } as never, e: c(100) },
    idx: v_(),
    width: 4,
    signed: false,
  };
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: structDeref },
      { k: 'exprstmt', value: deref(102, 2) },
    ]),
  );
  expect(r).toBeNull(); // one scalar member is no cluster
});

test('derefs UNDER a struct-pointer cast never seed a cluster either — collect and rewrite agree', () => {
  // rewrite refuses these subtrees, so collecting beneath them would mint a base local with
  // zero uses: a dead-local candidate that can never match and still costs a compile
  const under = (addr: number): Expr => ({
    k: 'cast',
    to: { kind: 'ptr', to: { kind: 'struct', name: 'S' } } as never,
    e: deref(addr, 4),
  });
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: under(100) },
      { k: 'exprstmt', value: under(104) },
    ]),
  );
  expect(r).toBeNull();
});

test('a field subtree is never entered: its interior deref keeps its spelling', () => {
  const fieldExpr: Expr = { k: 'field', base: deref(100, 4), name: 'field_0', width: 4, signed: false } as never;
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: fieldExpr },
      { k: 'exprstmt', value: deref(102, 2) },
    ]),
  );
  expect(r).toBeNull();
});

test('declined: a hostile span (negative or NaN) instead of a stalled cluster window', () => {
  const body = [
    { k: 'exprstmt' as const, value: deref(100, 2) },
    { k: 'exprstmt' as const, value: deref(102, 2) },
  ];
  expect(nearBaseClusters(fn(body), -1)).toBeNull();
  expect(nearBaseClusters(fn(body), Number.NaN)).toBeNull();
});

// WHERE the cluster base goes. This is the THIRD pass that places into the leading base-init run
// (`l3/basecse.ts` and `l3/sinkinit.ts` are the others) and it now shares their body rebuild —
// `l3/hoist.ts`'s `placeBaseLocals` — instead of a private prepend that had already drifted.
//
// Its POLICY stays its own, and it is `prepend`: the cluster base goes ABOVE a run already there,
// not merged into it in first-use order. That is not an oversight to correct against basecse's
// "blindly prepending is wrong" note — it is this lever's DEFAULT, and its demanding row is what
// picked it: re-placing the cluster bases in first-use order was measured on 2026-08-26 and turns
// `synthetic:dmafield` (won by `signed/livebase/volatile/nearbase/initfirst`) from a MATCH into
// diff:5. A row and not a mechanism, so `rank.ts` offers the other ordering beside it
// (`/nearbase/sinkinit`) and the differ settles it — the test below that.
test('the cluster base is spelled ABOVE a base-init run already at the head', () => {
  const u8p = { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } } as const;
  const existing: Stmt = { k: 'assign', name: 'q0', value: { k: 'cast', to: u8p, e: c(0x04000000) } as never };
  const useQ0: Stmt = {
    k: 'exprstmt',
    value: { k: 'index', base: { k: 'var', name: 'q0' }, idx: c(0), width: 1, signed: false },
  };
  const sfn: SFn = {
    name: 'f',
    params: [],
    locals: [{ name: 'q0', type: u8p as never }],
    retType: s32,
    body: [
      existing,
      useQ0,
      { k: 'assign', name: 'x', value: deref(0x03001048, 2) },
      { k: 'exprstmt', value: deref(0x0300104a, 2) },
    ],
  };
  const r = nearBaseClusters255(sfn);
  expect(r).not.toBeNull();
  // p0 (the cluster base, first USED third) leads; q0 (used first) keeps its place beneath it.
  expect(r!.body.map((st) => (st.k === 'assign' ? st.name : st.k))).toEqual(['p0', 'q0', 'exprstmt', 'x', 'exprstmt']);
});

// The OTHER ordering, which the roster now offers (`/nearbase/sinkinit`). Wired here rather than
// only in rank.ts, because the value of offering it is that the two trees DIFFER — a version of
// this that quietly emitted the same body would pass every enumeration count and referee nothing.
test('the sunk sibling places each cluster init at its own first use instead', () => {
  const u8p = { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } } as const;
  const existing: Stmt = { k: 'assign', name: 'q0', value: { k: 'cast', to: u8p, e: c(0x04000000) } as never };
  const useQ0: Stmt = {
    k: 'exprstmt',
    value: { k: 'index', base: { k: 'var', name: 'q0' }, idx: c(0), width: 1, signed: false },
  };
  const sfn: SFn = {
    name: 'f',
    params: [],
    locals: [{ name: 'q0', type: u8p as never }],
    retType: s32,
    body: [
      existing,
      useQ0,
      { k: 'assign', name: 'x', value: deref(0x03001048, 2) },
      { k: 'exprstmt', value: deref(0x0300104a, 2) },
    ],
  };
  const prepended = nearBaseClusters255(sfn)!;
  const sunk = sinkInitsToFirstUse(prepended);
  expect(sunk).not.toBeNull();
  // q0 stays at the head (its first use is the statement right below it); p0 drops to its own.
  expect(sunk!.body.map((st) => (st.k === 'assign' ? st.name : st.k))).toEqual([
    'q0',
    'exprstmt',
    'p0',
    'x',
    'exprstmt',
  ]);
  expect(sunk!.body).not.toEqual(prepended.body);
});
