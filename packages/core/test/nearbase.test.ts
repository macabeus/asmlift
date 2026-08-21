// The /nearbase lever (l3/nearbase.ts): neighbor absolute deref addresses re-spell as offsets
// from one shared u8* base local holding the cluster's lowest address; the differ referees.
import { expect, test } from 'vitest';

import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { nearBaseClusters } from '../src/l3/nearbase';

const nearBaseClusters255 = (sfn: SFn) => nearBaseClusters(sfn, 255);

const s32 = { kind: 'int', width: 32, signed: true } as const;
const c = (value: number): Expr => ({ k: 'const', value });
const deref = (addr: number, width: number): Expr => ({ k: 'index', base: c(addr), idx: c(0), width, signed: false });
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

test('a const used in arithmetic is not an address and never rewrites', () => {
  const r = nearBaseClusters255(
    fn([
      { k: 'exprstmt', value: deref(100, 2) },
      { k: 'exprstmt', value: deref(102, 2) },
      { k: 'assign', name: 'y', value: { k: 'bin', op: '+', l: c(100), r: c(1) } },
    ]),
  );
  const y = r!.body[3] as Extract<Stmt, { k: 'assign' }>;
  expect(y.value).toEqual({ k: 'bin', op: '+', l: c(100), r: c(1) });
});
