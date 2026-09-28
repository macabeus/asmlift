// A call argument on a function compiled AS C++ (`SFn.declaredArgs`): cast to its declared parameter
// type exactly where C++ makes no implicit conversion — a pointer to another pointee, a non-zero
// integer to a pointer, a pointer to an integer — and nowhere else, and never in C.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn } from '../src/l3/ast';
import { structureOptionsFor, targetFor } from '../src/target';

const a0: Expr = { k: 'var', name: 'a0' };
const a1: Expr = { k: 'var', name: 'a1' };
const call = (fn: string, arg: Expr): Expr => ({ k: 'call', fn, args: [arg] });

const fnWith = (arg: Expr, callee: string, declaredArgs?: SFn['declaredArgs']): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: T.ptr(T.s(32)) },
    { name: 'a1', type: T.s(32) },
  ],
  locals: [],
  retType: T.s(32),
  body: [{ k: 'return', value: call(callee, arg) }],
  ...(declaredArgs ? { declaredArgs } : {}),
});

const DECLARED = {
  toU32p: ['u32 *'],
  toVoidp: ['void *'],
  toConstS32p: ['const s32 *'],
  toS32p: ['s32 *'],
  toS32: ['s32'],
  toStruct: [undefined],
};
const printed = (arg: Expr, callee: keyof typeof DECLARED): string =>
  cBackend
    .emit(fnWith(arg, callee, DECLARED))
    .split('\n')
    .find((l) => l.includes('return'))!
    .trim();

describe('C++ call arguments', () => {
  test('casts the three conversions C++ refuses', () => {
    expect(printed(a0, 'toU32p')).toBe('return toU32p((u32 *)a0);');
    expect(printed(a1, 'toU32p')).toBe('return toU32p((u32 *)a1);');
    expect(printed(a0, 'toS32')).toBe('return toS32((s32)a0);');
  });

  test('leaves every implicit conversion alone', () => {
    expect(printed({ k: 'const', value: 0 }, 'toU32p')).toBe('return toU32p(0);');
    expect(printed(a0, 'toVoidp')).toBe('return toVoidp(a0);');
    expect(printed(a0, 'toConstS32p')).toBe('return toConstS32p(a0);');
    expect(printed(a0, 'toS32p')).toBe('return toS32p(a0);');
    expect(printed(a1, 'toS32')).toBe('return toS32(a1);');
    // a parameter the printer cannot spell is never cast
    expect(printed(a1, 'toStruct')).toBe('return toStruct(a1);');
  });

  test('a function compiled as C prints its arguments as it always did', () => {
    expect(cBackend.emit(fnWith(a0, 'toU32p'))).toContain('return toU32p(a0);');
  });
});

describe('where the dialect comes from', () => {
  test('the build flags', () => {
    expect(targetFor('mwcc_233_163n', ['-O4,p', '-lang=c++']).target.dialect).toBe('c++');
    expect(targetFor('mwcc_233_163n', ['-O4,p', '-lang', 'ec++']).target.dialect).toBe('c++');
    expect(targetFor('mwcc_242_81', ['-O4,p', '-lang=c']).target.dialect).toBeUndefined();
  });

  test('only a C++ target carries declared argument types to the structurer', () => {
    const protos = { g: { params: ['u32 *', 'struct Big'] }, h: { params: 2 } };
    const cpp = targetFor('mwcc_233_163n', ['-O4,p', '-lang=c++']).target;
    expect(structureOptionsFor(cpp, false, protos).declaredArgs).toEqual({ g: ['u32 *', undefined] });
    const c = targetFor('mwcc_242_81', ['-O4,p']).target;
    expect(structureOptionsFor(c, false, protos).declaredArgs).toBeUndefined();
  });
});
