// A call argument on a function compiled AS C++ (`SFn.dialect`): cast to its declared parameter
// type exactly where C++ makes no implicit conversion — a pointer to another pointee, a non-zero
// integer to a pointer, a pointer to an integer — and nowhere else, and never in C, save where the
// C front end refuses the same three (`SFn.strictConversions`, mwcc).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn } from '../src/l3/ast';
import { structureOptionsFor, targetFor } from '../src/target';

const a0: Expr = { k: 'var', name: 'a0' };
const a1: Expr = { k: 'var', name: 'a1' };
const call = (fn: string, arg: Expr): Expr => ({ k: 'call', fn, args: [arg] });

const fnWith = (arg: Expr, callee: string, declaredArgs?: SFn['declaredArgs'], dialect?: SFn['dialect']): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: T.ptr(T.s(32)) },
    { name: 'a1', type: T.s(32) },
  ],
  locals: [],
  retType: T.s(32),
  body: [{ k: 'return', value: call(callee, arg) }],
  ...(declaredArgs ? { declaredArgs } : {}),
  ...(dialect ? { dialect } : {}),
});

const DECLARED = {
  toU32p: ['u32 *'],
  toVoidp: ['void *'],
  toConstS32p: ['const s32 *'],
  toS32p: ['s32 *'],
  toConstPtr: ['s32 * const'],
  toS32: ['s32'],
  toStruct: [undefined],
};
const printed = (arg: Expr, callee: keyof typeof DECLARED): string =>
  cBackend
    .emit(fnWith(arg, callee, DECLARED, 'c++'))
    .split('\n')
    .find((l) => l.includes('return'))!
    .trim();

describe('C++ call arguments', () => {
  test('casts the three conversions C++ refuses', () => {
    expect(printed(a0, 'toU32p')).toBe('return toU32p((u32 *)a0);');
    expect(printed(a1, 'toU32p')).toBe('return toU32p((u32 *)a1);');
    expect(printed(a0, 'toS32')).toBe('return toS32((s32)a0);');
    expect(printed(a1, 'toConstPtr')).toBe('return toConstPtr((s32 * const)a1);');
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

  test('a function compiled as C gets no casts', () => {
    expect(cBackend.emit(fnWith(a0, 'toU32p', DECLARED))).toContain('return toU32p(a0);');
  });

  test('…unless its C front end refuses them too: the same casts, and only those', () => {
    // mwcc's C: "illegal implicit conversion from 'unsigned int' to 'int *'" on an address table's
    // integer element passed to a declared `s32 *` (compiled; the field in target.ts)
    const strict = (arg: Expr, callee: keyof typeof DECLARED) =>
      cBackend.emit({ ...fnWith(arg, callee, DECLARED), strictConversions: true });
    expect(strict(a1, 'toU32p')).toContain('return toU32p((u32 *)a1);');
    expect(strict(a0, 'toS32')).toContain('return toS32((s32)a0);');
    expect(strict(a0, 'toVoidp')).toContain('return toVoidp(a0);');
    expect(strict({ k: 'const', value: 0 }, 'toU32p')).toContain('return toU32p(0);');
  });

  test('…and a pointer of another pointee written into a pointer slot, the same third conversion', () => {
    // mwcc's C: "illegal implicit conversion from 'unsigned int *' to 'int *'" on `return t;` from an
    // `s32 *` function whose `t` is a `const u32[2]` static (compiled)
    const withRet = (value: Expr, extra: Partial<SFn> = {}): string =>
      cBackend
        .emit({
          ...fnWith(a0, 'toS32p'),
          retType: T.ptr(T.s(32)),
          statics: [{ name: 't', type: T.array(T.u(32), 2), const: true, init: [1, 2] }],
          body: [{ k: 'return', value }],
          ...extra,
        })
        .split('\n')
        .find((l) => l.includes('return'))!
        .trim();
    const t: Expr = { k: 'addr', name: 't' };
    const voidp: Expr = { k: 'cast', to: T.ptr(T.void()), e: a1 };
    expect(withRet(t, { strictConversions: true })).toBe('return (s32 *)t;');
    expect(withRet(t, { dialect: 'c++' })).toBe('return (s32 *)t;');
    // the same pointee converts implicitly, and so does a `void *`…
    expect(withRet(a0, { strictConversions: true })).toBe('return a0;');
    expect(withRet(voidp, { strictConversions: true })).toBe('return (void *)a1;');
    // …in C: C++ converts no `void *` to another pointer implicitly
    expect(withRet(voidp, { dialect: 'c++' })).toBe('return (s32 *)(void *)a1;');
    // C converts it implicitly, and a const static's address only loses its qualifier
    expect(withRet(t)).toBe('return (u32 *)t;');
  });
});

describe('where the dialect comes from', () => {
  test('the build flags', () => {
    expect(targetFor('mwcc_233_163n', ['-O4,p', '-lang=c++']).target.dialect).toBe('c++');
    expect(targetFor('mwcc_233_163n', ['-O4,p', '-lang', 'ec++']).target.dialect).toBe('c++');
    expect(targetFor('mwcc_242_81', ['-O4,p', '-lang=c']).target.dialect).toBeUndefined();
  });

  test('only a C++ target is compiled as C++, and every target carries declared argument types', () => {
    const protos = { g: { params: ['u32 *', 'struct Big'] }, h: { params: 2 } };
    const cpp = structureOptionsFor(targetFor('mwcc_233_163n', ['-O4,p', '-lang=c++']).target, false, protos);
    expect(cpp.declaredArgs).toEqual({ g: ['u32 *', undefined] });
    expect(cpp.dialect).toBe('c++');
    const c = structureOptionsFor(targetFor('mwcc_242_81', ['-O4,p']).target, false, protos);
    expect(c.declaredArgs).toEqual({ g: ['u32 *', undefined] });
    expect(c.dialect).toBeUndefined();
  });

  test('every mwcc build refuses the conversions in C too; no other compiler does', () => {
    for (const tc of ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as const) {
      expect(structureOptionsFor(targetFor(tc, ['-O4,p', '-lang=c']).target, false).strictPointerConversions).toBe(
        true,
      );
    }
    for (const tc of ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const) {
      expect(structureOptionsFor(targetFor(tc, []).target, false).strictPointerConversions).toBeUndefined();
    }
  });
});
