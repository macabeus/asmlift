import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn } from '../src/l3/ast';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const at = (base: Expr, idx: number, width = 1): Expr => ({ k: 'index', base, idx: c(idx), width, signed: false });
const add = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '+', l, r });

const fnOf = (value: Expr, paramType = T.ptr(T.int(8, false))): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: paramType }],
  locals: [],
  retType: T.int(32, true),
  body: [{ k: 'return', value }],
});

describe('polish: p[0] beside a constant subscript of the same p', () => {
  test('a pointer read at 0 and at 2 spells both as elements', () => {
    const fn = fnOf(add(at(v('a0'), 0), at(v('a0'), 2)));
    expect(cBackend.emit(fn)).toContain('return a0[0] + a0[2];');
    expect(cBackend.draft!(fn)).toContain('return *a0 + a0[2];');
  });

  test('a lone `*p` stays a dereference', () => {
    expect(cBackend.emit(fnOf(add(at(v('a0'), 0), c(1))))).toContain('return *a0 + 1;');
  });

  test('a different width is a different base as printed, and is left alone', () => {
    // `*(u16 *)a0` beside `a0[2]`: the two do not print the same base
    const out = cBackend.emit(fnOf(add(at(v('a0'), 0, 2), at(v('a0'), 2))));
    expect(out).toContain('*(u16 *)a0');
  });

  test('a global is left alone even where the tree types it a pointer: its header may say array', () => {
    const fn: SFn = {
      ...fnOf(add(at(v('gTbl'), 0), at(v('gTbl'), 2))),
      params: [],
      globals: [{ name: 'gTbl', type: T.ptr(T.int(8, false)) }],
    };
    expect(cBackend.emit(fn)).toContain('*gTbl + gTbl[2]');
  });

  test('an untyped name may be an array, and is left alone', () => {
    const fn: SFn = { ...fnOf(add(at(v('gArr'), 0), at(v('gArr'), 2))), params: [] };
    expect(cBackend.emit(fn)).toContain('*(u8 *)gArr + ((u8 *)gArr)[2]');
  });

  test('a pointer cast base counts as a pointer', () => {
    const base: Expr = { k: 'cast', to: T.ptr(T.int(8, false)), e: c(0x4000000) };
    expect(cBackend.emit(fnOf(add(at(base, 0), at(base, 2)), T.int(32, true)))).toContain(
      'return ((u8 *)67108864)[0] + ((u8 *)67108864)[2];',
    );
  });
});
