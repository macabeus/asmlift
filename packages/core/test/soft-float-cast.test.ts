// agbcc's conversions: one libgcc call each (`runtime-helpers.ts` AGBCC_RUNTIME_HELPERS), folded by
// `raise/floathelpers.ts` into the cast it computes. The float side of each keeps the closed-set rule
// the arithmetic follows; the integer side is any integer value.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-soft-cast.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC).source;

describe('a conversion helper is the cast it computes', () => {
  test.each([
    ['f2i', 's32 f2i(float a0) {\n    return (s32)a0;\n}\n'],
    ['f2u', 's32 f2u(float a0) {\n    return (u32)a0;\n}\n'],
    ['i2f', 'float i2f(s32 a0) {\n    return (float)a0;\n}\n'],
    ['d2i', 's32 d2i(double a0) {\n    return (s32)a0;\n}\n'],
    ['d2u', 's32 d2u(double a0) {\n    return (u32)a0;\n}\n'],
    ['i2d', 'double i2d(s32 a0) {\n    return (double)a0;\n}\n'],
    ['f2d', 'double f2d(float a0) {\n    return (double)a0;\n}\n'],
    ['d2f', 'float d2f(double a0) {\n    return (float)a0;\n}\n'],
  ])('%s', (name, source) => {
    expect(lift(name)).toBe(source);
  });

  // The 64-bit side is the long long the frontend pairs, in a long long's word order.
  test.each([
    ['f2ll', 's64 f2ll(float a0) {\n    return (s64)a0;\n}\n'],
    ['f2ull', 's64 f2ull(float a0) {\n    return (u64)a0;\n}\n'],
    ['ll2f', 'float ll2f(s64 a0) {\n    return (float)a0;\n}\n'],
    ['d2ll', 's64 d2ll(double a0) {\n    return (s64)a0;\n}\n'],
    ['ll2d', 'double ll2d(s64 a0) {\n    return (double)a0;\n}\n'],
  ])('%s: a long long on the integer side', (name, source) => {
    expect(lift(name)).toBe(source);
  });
});

describe('the integer side is any integer', () => {
  // `(short)x` truncates the converted word; `(float)x` of a short converts the int it promotes to.
  test('a narrow integer on either side', () => {
    expect(lift('f2s')).toBe('s32 f2s(float a0) {\n    return (s16)(s32)a0;\n}\n');
    expect(lift('s2f')).toBe('float s2f(s16 a0) {\n    return (float)a0;\n}\n');
  });

  test('a conversion feeding a conversion, and an integer read on', () => {
    expect(lift('fround')).toBe('float fround(float a0) {\n    return (float)(s32)a0;\n}\n');
    expect(lift('f2iadd')).toBe('s32 f2iadd(float a0, s32 a1) {\n    return (s32)a0 + a1;\n}\n');
  });

  // A global of a type the headers state renders with no signedness here, so the operand is pinned:
  // C converts an unsigned integer with the unsigned conversion, a different program.
  test('a loaded integer is converted as a signed one', () => {
    expect(lift('gi2f')).toBe('float gi2f(void) {\n    return (float)(s32)gI;\n}\n');
  });
});

describe('what refuses', () => {
  // `x` is read as a word too, so it is no float the ABI handed over whole.
  test('a float side the function also reads as a word', () => {
    expect(() => lift('fbits')).toThrow("no model for the runtime helper '__fixsfsi'");
  });

  // The guessed call after the conversion does not count r0, so the result is read by nothing;
  // folded, `dce` would delete the conversion and print `return g1();`.
  test('an integer result nothing reads', () => {
    expect(() => lift('f2ipass')).toThrow("no model for the runtime helper '__fixsfsi'");
  });

  // agbcc has no unsigned-to-float helper: `(float)u` is open-coded around `__floatsisf`, whose
  // result is halved and doubled through `__addsf3` across a branch.
  test('an unsigned integer into a float, which agbcc open-codes', () => {
    expect(() => lift('u2f')).toThrow("no model for the runtime helper '__floatsisf'");
  });
});
