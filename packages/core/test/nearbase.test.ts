// The /nearbase lever (l3/nearbase.ts): neighbor absolute deref addresses re-spell as offsets
// from one shared u8* base local holding the cluster's lowest address; the differ referees.
import { expect, test } from 'vitest';

import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { nearBaseClusters } from '../src/l3/nearbase';

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
