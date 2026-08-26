// The `/vol-store` lever (l3/volstore.ts): a store whose whole address is a constant inside the
// target's declared device-register window is spelled through a `volatile` lvalue. What these
// tests pin is the gate table — the window is the eligibility predicate and not a hint, a runtime
// address names no cell, a constant subscript is part of the address, and an access that already
// asserts volatility is left alone. Reads are out of scope by design.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import { type Expr, type SFn, type Stmt } from '../src/l3/ast';
import { deviceStoreCount, volatileDeviceStores } from '../src/l3/volstore';

/** the GBA I/O page, as target.ts declares it */
const GBA: readonly [number, number] = [0x04000000, 0x04000400];

const fn = (body: Stmt[], locals: SFn['locals'] = []): SFn => ({
  name: 'f',
  params: [],
  locals,
  retType: T.void(),
  body,
});

/** `*(s32 *)addr` as the structurer leaves it: a bare const base, width carried by the node */
const cell = (addr: number, idx = 0): Expr => ({
  k: 'index',
  base: { k: 'const', value: addr },
  idx: { k: 'const', value: idx },
  width: 4,
  signed: true,
});

const store = (lval: Expr, v = 1): Stmt => ({ k: 'store', lval, value: { k: 'const', value: v } });

test('a store at a constant address inside the device window is qualified', () => {
  const s = fn([store(cell(0x040000d4))]);
  const out = volatileDeviceStores(s, GBA);
  expect(cBackend.emit(out!)).toContain('*(volatile s32 *)67109076 = 1;');
  // read-only: the input tree is not mutated
  expect(cBackend.emit(s)).toContain('*(s32 *)67109076 = 1;');
});

test('a store to ordinary memory declines — the window is the eligibility predicate', () => {
  // synthetic:ucmp:agbcc is a shipped byte-exact match whose loop stores to 0x3001048 (IWRAM);
  // pinning that address costs the row 15 points, which is what this gate buys.
  expect(volatileDeviceStores(fn([store(cell(0x03001048))]), GBA)).toBeNull();
});

test('a target that declares no device window declines', () => {
  expect(volatileDeviceStores(fn([store(cell(0x040000d4))]), undefined)).toBeNull();
});

test('a runtime address declines — it names no cell', () => {
  const s = fn(
    [store({ k: 'index', base: { k: 'var', name: 'p' }, idx: { k: 'const', value: 0 }, width: 4, signed: true })],
    [{ name: 'p', type: T.ptr(T.s(32)) }],
  );
  expect(volatileDeviceStores(s, GBA)).toBeNull();
});

test('a constant subscript is part of the address, in both directions', () => {
  // `((s32 *)0x40000d4)[1]` is 0x40000d8 — inside the window
  expect(deviceStoreCount(fn([store(cell(0x040000d4, 1))]), GBA)).toBe(1);
  // `((s32 *)0x40003fc)[4]` is 0x400040c — one word past it
  expect(deviceStoreCount(fn([store(cell(0x040003fc, 4))]), GBA)).toBe(0);
});

test('an already-volatile store declines rather than nesting a second cast', () => {
  const qualified: Expr = {
    k: 'index',
    base: { k: 'cast', to: T.ptr(T.s(32)), volatile: true, e: { k: 'const', value: 0x040000d4 } },
    idx: { k: 'const', value: 0 },
    width: 4,
    signed: true,
  };
  expect(volatileDeviceStores(fn([store(qualified)]), GBA)).toBeNull();
});

test('an existing scalar pointer cast takes the qualifier in place', () => {
  const cast: Expr = {
    k: 'index',
    base: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: 0x040000d4 } },
    idx: { k: 'const', value: 0 },
    width: 4,
    signed: true,
  };
  expect(cBackend.emit(volatileDeviceStores(fn([store(cast)]), GBA)!)).toContain('*(volatile s32 *)67109076 = 1;');
});

test('a READ of a device register is out of scope — only stores are qualified', () => {
  const s = fn([{ k: 'assign', name: 'v', value: cell(0x040000d4) }], [{ name: 'v', type: T.s(32) }]);
  expect(volatileDeviceStores(s, GBA)).toBeNull();
});

test('stores nested in loops and arms are reached', () => {
  const s = fn([
    {
      k: 'while',
      cond: { k: 'const', value: 1 },
      body: [
        { k: 'if', cond: { k: 'const', value: 1 }, then: [store(cell(0x040000d4))], else: [store(cell(0x040000d8))] },
      ],
    },
  ]);
  expect(deviceStoreCount(s, GBA)).toBe(2);
  expect(cBackend.emit(volatileDeviceStores(s, GBA)!).match(/volatile s32 \*/g)?.length).toBe(2);
});
