import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { BinOp, Expr, SFn } from '../src/l3/ast';
import { polished } from '../src/l3/polish';

/** The C backend through the polish, at an optimizing level. */
const pc = polished(cBackend, { literal: false });

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });

const ret = (value: Expr): string =>
  pc.emit({
    name: 'f',
    params: [{ name: 'a0', type: T.int(32, false) }],
    locals: [],
    retType: T.int(32, false),
    body: [{ k: 'return', value }],
  } satisfies SFn);

describe('polish: hex for bits, decimal for counts', () => {
  test('bitwise operands are hex, on either side', () => {
    expect(ret(bin('&', v('a0'), c(64)))).toContain('return a0 & 0x40;');
    expect(ret(bin('|', c(255), v('a0')))).toContain('return 0xff | a0;');
    expect(ret({ k: 'un', op: '~', e: c(255) })).toContain('return ~0xff;');
  });

  test('the shifted value is hex, the shift count stays decimal', () => {
    expect(ret(bin('<<', c(255), v('a0')))).toContain('return 0xff << a0;');
    expect(ret(bin('<<', v('a0'), c(24)))).toContain('return a0 << 24;');
  });

  test('an address is hex', () => {
    const load: Expr = {
      k: 'index',
      base: { k: 'cast', to: T.ptr(T.int(16, false)), e: c(0x4000208) },
      idx: c(0),
      width: 2,
      signed: false,
    };
    expect(ret(load)).toContain('*(u16 *)0x4000208');
    const raw: Expr = { k: 'index', base: c(0x4000208), idx: c(0), width: 2, signed: false };
    expect(ret(raw)).toContain('*(u16 *)0x4000208');
  });

  test('counts, bounds and arithmetic stay decimal', () => {
    expect(ret(bin('<', v('a0'), c(64)))).toContain('a0 < 64');
    expect(ret(bin('+', v('a0'), c(64)))).toContain('a0 + 64');
  });

  test('a literal under 10, a negative one and one past INT_MAX keep their decimal spelling', () => {
    expect(ret(bin('&', v('a0'), c(7)))).toContain('a0 & 7');
    expect(ret(bin('&', v('a0'), c(-4)))).toContain('a0 & -4');
    // 0x80000000 is `unsigned int` where 2147483648 is not: the type would move
    expect(ret(bin('&', v('a0'), c(2147483648)))).toContain('a0 & 2147483648');
  });

  test('the draft keeps decimal', () => {
    const fn: SFn = {
      name: 'f',
      params: [{ name: 'a0', type: T.int(32, false) }],
      locals: [],
      retType: T.int(32, false),
      body: [{ k: 'return', value: bin('&', v('a0'), c(64)) }],
    };
    expect(pc.draft!(fn)).toContain('a0 & 64');
  });
});
