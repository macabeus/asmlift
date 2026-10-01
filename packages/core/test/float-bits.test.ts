// A double literal: the bit pattern the IR carries (`fconst {bits}`) and the C that spells it — the
// fewest decimal digits that read back as the same double, which agbcc reads back exactly
// (real.c `asctoeg` at 53 bits; the regenerable probe is `agbcc-double-args.s`).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { doubleBits, doubleLiteral, doubleOf } from '../src/ir/float-bits';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';

describe('the bits', () => {
  test('are the high word, then the low word', () => {
    expect(doubleBits(0x3ff80000, 0)).toBe('3ff8000000000000');
    expect(doubleBits(-0x3ffa0000, 0)).toBe('c006000000000000');
    expect(doubleOf('3ff8000000000000')).toBe(1.5);
    expect(doubleOf('c006000000000000')).toBe(-2.75);
  });

  // A number has one value for the two zeros, which is why the IR does not carry one.
  test('tell the two zeros apart', () => {
    expect(Object.is(doubleOf('8000000000000000'), -0)).toBe(true);
    expect(Object.is(doubleOf('0000000000000000'), 0)).toBe(true);
  });
});

describe('the C spelling', () => {
  test.each([
    ['3ff8000000000000', '1.5'],
    ['c006000000000000', '-2.75'],
    ['3fb999999999999a', '0.1'],
    ['4000000000000000', '2.0'],
    ['8000000000000000', '-0.0'],
    ['0000000000000001', '5e-324'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['3fd3333333333334', '0.30000000000000004'],
  ])('%s is %s', (bits, spelled) => {
    expect(doubleLiteral(bits)).toBe(spelled);
    expect(doubleBits(...wordsOf(Number(spelled)))).toBe(bits);
  });

  // An integer-valued double spelled without a point is an `int` in C, and an unprototyped callee
  // is then handed one word, not two.
  test('always reads as a double', () => {
    for (const bits of ['4000000000000000', '4059000000000000', '41cffc0000000000']) {
      expect(doubleLiteral(bits)).toMatch(/[.e]/);
    }
  });

  test('refuses what no C literal spells', () => {
    for (const bits of ['7ff8000000000000', '7ff0000000000000', 'fff0000000000000']) {
      expect(() => doubleLiteral(bits)).toThrow(/is not finite/);
    }
  });

  // A single's eight digits name another number read as a double: `3fc00000` is 1.5 as a float.
  test('refuses a pattern that is not a double', () => {
    for (const bits of ['3fc00000', '3FF8000000000000', '3ff80000000000000']) {
      expect(() => doubleLiteral(bits)).toThrow(/is not a double's bit pattern/);
    }
  });
});

describe('fconst', () => {
  const ret = (bits: string) => `fn f {\n^bb0():\n  %0: f64 = fconst {bits="${bits}"}\n  ret %0\n}\n`;

  test('is a float op, so its result is a float and verifies as one', () => {
    expect(() => verify(parse(ret('3ff8000000000000')))).not.toThrow();
    expect(() => verify(parse('fn f {\n^bb0():\n  %0: s32 = fconst {bits="3ff8000000000000"}\n  ret %0\n}\n'))).toThrow(
      /'fconst' computes on floats only/,
    );
  });

  test('is a double: sixteen hex digits into an f64', () => {
    expect(() => verify(parse(ret('3fc00000')))).toThrow(/'fconst' is a double literal/);
    expect(() => verify(parse('fn f {\n^bb0():\n  %0: f32 = fconst {bits="3ff8000000000000"}\n  ret %0\n}\n'))).toThrow(
      /'fconst' is a double literal/,
    );
  });

  const sfn = (bits: string, negate = false) => ({
    name: 'f',
    params: [],
    locals: [],
    retType: T.f64(),
    body: [
      {
        k: 'return' as const,
        value: negate
          ? { k: 'un' as const, op: 'f-' as const, e: { k: 'fconst' as const, bits } }
          : { k: 'fconst' as const, bits },
      },
    ],
  });

  test('C prints the literal, and a negative one under a prefix operator keeps apart from it', () => {
    expect(cBackend.emit(sfn('3ff8000000000000'))).toContain('return 1.5;');
    expect(cBackend.emit(sfn('c006000000000000', true))).toContain('return -(-2.75);');
  });

  test('Pascal refuses it', () => {
    expect(() => pascalBackend.emit({ ...sfn('3ff8000000000000'), retType: T.s(32) })).toThrow(
      /double literal has no IDO Pascal spelling/,
    );
  });
});

function wordsOf(x: number): [number, number] {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return [v.getUint32(0), v.getUint32(4)];
}
