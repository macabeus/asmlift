import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { hoistReusedGlobalBases } from '../src/l3/basecse';

const idx = (name: string, i: Expr, width = 1): Expr => ({
  k: 'index',
  base: { k: 'addr', name },
  idx: i,
  width,
  signed: false,
});
const cidx = (value: number, i: Expr, width = 4): Expr => ({
  k: 'index',
  base: { k: 'const', value },
  idx: i,
  width,
  signed: true,
});
const c = (value: number): Expr => ({ k: 'const', value });
const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], retType: T.void(), body });

describe('reused-global-base hoisting', () => {
  test('a numeric pointer CONSTANT (MMIO/RAM base) indexed at ≥2 distinct offsets is hoisted', () => {
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(2)), value: c(0) },
      ]),
    );
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.s(32)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: 0x40000d4 } },
    });
    expect(out.body[1]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(0), width: 4, signed: true },
      value: c(0),
    });
  });

  test('a const base at the SAME single constant offset (MMIO read-modify-write) is NOT hoisted', () => {
    // `*(u16 *)0x4000200 |= 2; *(u16 *)0x4000200 &= 0xFFFD` — a scalar RMW the compiler
    // re-materializes; hoisting it mismatches (it broke ProcessHBlankWait). Both accesses at idx 0.
    const body: Stmt[] = [
      { k: 'store', lval: cidx(0x4000200, c(0), 2), value: c(2) },
      { k: 'store', lval: cidx(0x4000200, c(0), 2), value: c(16) },
    ];
    const out = hoistReusedGlobalBases(fn(body));
    expect(out.body).toEqual(body);
    expect(out.locals).toEqual([]);
  });

  test('a global at the SAME variable index at ≥2 sites IS hoisted (not a fixed-offset scalar)', () => {
    const vi: Expr = { k: 'var', name: 'a0' };
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'assign', name: 't', value: idx('gSin', vi) },
        { k: 'assign', name: 'u', value: idx('gSin', vi) },
      ]),
    );
    expect(out.locals.map((l) => l.name)).toEqual(['p0']);
  });

  test('a global indexed at ≥2 sites is hoisted into a typed local pointer', () => {
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: idx('gTable', c(5)), value: c(0) },
        { k: 'store', lval: idx('gTable', c(6)), value: c(0) },
      ]),
    );
    // a `u8 *p0 = (u8 *)&gTable` local is introduced, and both accesses point at it.
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.int(8, false)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.int(8, false)), e: { k: 'addr', name: 'gTable' } },
    });
    expect(out.body[1]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(5), width: 1, signed: false },
      value: c(0),
    });
    expect(out.body[2]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(6), width: 1, signed: false },
      value: c(0),
    });
  });

  test('a global indexed ONCE is left inline (no hoist)', () => {
    const body: Stmt[] = [{ k: 'store', lval: idx('gTable', c(5)), value: c(0) }];
    const out = hoistReusedGlobalBases(fn(body));
    expect(out.body).toEqual(body);
    expect(out.locals).toEqual([]);
  });

  test('two DIFFERENT globals each indexed twice both hoist, in first-use order', () => {
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: idx('gA', c(0)), value: c(1) },
        { k: 'store', lval: idx('gB', c(0)), value: c(1) },
        { k: 'store', lval: idx('gA', c(4)), value: c(1) },
        { k: 'store', lval: idx('gB', c(4)), value: c(1) },
      ]),
    );
    expect(out.locals.map((l) => l.name)).toEqual(['p0', 'p1']); // gA first, gB second
    expect((out.body[0] as { value: { e: { name: string } } }).value.e.name).toBe('gA');
    expect((out.body[1] as { value: { e: { name: string } } }).value.e.name).toBe('gB');
  });

  test('a base used INSIDE a loop is NOT hoisted (avoids callee-saved push/pop)', () => {
    const body: Stmt[] = [
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '!=', l: idx('gTable', c(0)), r: c(0) },
        body: [{ k: 'store', lval: idx('gTable', c(4)), value: c(0) }],
      },
    ];
    const out = hoistReusedGlobalBases(fn(body));
    expect(out.body).toEqual(body); // unchanged
    expect(out.locals).toEqual([]);
  });

  test('same global at DIFFERENT widths is not merged (distinct pointer types)', () => {
    // gTable read as u8 once and as a u16 once → neither key reaches 2, nothing hoists.
    const out = hoistReusedGlobalBases(
      fn([
        { k: 'store', lval: idx('gTable', c(0), 1), value: c(0) },
        { k: 'store', lval: idx('gTable', c(0), 2), value: c(0) },
      ]),
    );
    expect(out.locals).toEqual([]);
  });
});
