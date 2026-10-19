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

// A compare helper returns libgcc's three-way answer, and the caller tests it against 0: the test is
// what names the compare, read off the helper's contract (its sign orders the operands, and it
// returns `unordered` on a NaN), so the negated test is the unordered compare and never the integer
// flip of the relation.
describe('a compare helper is the compare its test computes', () => {
  const merged = (name: string, args: string, cond: string) =>
    `s32 ${name}(${args}) {\n    s32 v0;\n    if (${cond}) {\n        v0 = 1;\n    } else {\n        v0 = 0;\n    }\n    return v0;\n}\n`;
  const ff = 'float a0, float a1';

  // `cmp r0, #0` and a branch over a 0/1 merge.
  test.each([
    ['fgt', 'a0 > a1'],
    ['fle', 'a0 <= a1'],
    ['feq', 'a0 == a1'],
  ])('%s, a test before a branch', (name, cond) => {
    expect(lift(name)).toBe(merged(name, ff, cond));
  });

  // agbcc's three sign-bit spellings of a value: `r >> 31`, `~r >> 31`, `(-r | r) >> 31`.
  test.each([
    ['flt', 'a0 < a1'],
    ['fge', 'a0 >= a1'],
    ['fne', 'a0 != a1'],
  ])('%s, a test of the sign bit', (name, value) => {
    expect(lift(name)).toBe(`s32 ${name}(${ff}) {\n    return ${value};\n}\n`);
  });

  test.each([
    ['dgt', 'a0 > a1'],
    ['dle', 'a0 <= a1'],
  ])('%s, over doubles', (name, cond) => {
    expect(lift(name)).toBe(merged(name, 'double a0, double a1', cond));
  });

  // `!(a > b)` is `__gtsf2` tested `> 0` and the 0/1 flipped after; `!(a < b)` the same over `>> 31`,
  // whose flip of the folded compare is its negation, the unordered compare (pattern/engine.ts
  // `NOT_FCMP_PATTERNS`, run again once the helper has folded).
  test('a negation the source wrote stays a negation of the compare', () => {
    expect(lift('fngt')).toContain('return v0 ^ 1;');
    expect(lift('fnlt')).toBe(`s32 fnlt(${ff}) {\n    return !(a0 < a1);\n}\n`);
  });

  test('a branch on the compare', () => {
    expect(lift('fbr')).toBe(`void fbr(${ff}) {\n    if (a0 > a1) gI = 1;\n}\n`);
  });

  // `if (!(a < b))` branches past the store when `__ltsf2` is negative: the test is `>= 0`, which is
  // true on a NaN (`__ltsf2` returns 1 there), so it is `!(a < b)` and never `a >= b`.
  test('a branch on a negated compare is the unordered compare', () => {
    expect(lift('fbrn')).toBe(`void fbrn(${ff}) {\n    if (!(a0 < a1)) gI = 1;\n}\n`);
  });
});

describe('what a compare refuses', () => {
  // The result reaches the return as a word: it is no test, and its value is libgcc's, not C's.
  test('a result read as the integer it is', () => {
    expect(() => lift('fraw')).toThrow("no model for the runtime helper '__gtsf2'");
  });

  // Against any constant but 0 a test reads more of the result than its sign, which the contract
  // states nothing about.
  test('a test against anything but 0', () => {
    expect(() => lift('fone')).toThrow("no model for the runtime helper '__gtsf2'");
  });

  // A single-precision literal is one constant word, which nothing reads as a float.
  test('a single-precision literal operand', () => {
    expect(() => lift('fzero')).toThrow("no model for the runtime helper '__gtsf2'");
  });
});
