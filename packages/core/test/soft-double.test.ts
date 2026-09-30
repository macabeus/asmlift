// agbcc's `double`: no instruction computes on one, so its arithmetic is a libgcc call over the
// register pairs a long long travels in (`runtime-helpers.ts` AGBCC_RUNTIME_HELPERS), and
// `raise/widehelpers.ts` `foldFloatHelpers` folds the call to the float op over `double`s.
//
// WHAT REFUSES IS EVERY PLACE THE PAIR'S WORD ORDER WOULD SHOW. agbcc puts a double's HIGH word in
// the lower register (thumb.h:335 FLOAT_WORDS_BIG_ENDIAN), the opposite of a long long, so only a
// pair moved whole may be read as a double. Each refusal below declines naming the helper rather
// than passing the call through as `__adddf3()`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { AGBCC_RUNTIME_HELPERS, isFloatHelper } from '../src/runtime-helpers';
import { ARMV4T_AGBCC, type TargetDescription } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-soft-double.s'), 'utf8');
const lift = (name: string, prototypes: Prototypes = {}) => decompile(name, asm, ARMV4T_AGBCC, { prototypes }).source;

describe('the double arithmetic helpers are the float ops', () => {
  test.each([
    ['dadd', '+'],
    ['dsub', '-'],
    ['dmul', '*'],
    ['ddiv', '/'],
  ])('%s', (name, op) => {
    expect(lift(name)).toBe(`double ${name}(double a0, double a1) {\n    return a0 ${op} a1;\n}\n`);
  });

  test('__negdf2 is a negation', () => {
    expect(lift('dneg')).toBe('double dneg(double a0) {\n    return -a0;\n}\n');
  });

  // The stack words are the next two argument slots, so the pair agbcc loads from them is the third
  // parameter, and the first helper's result is the second one's operand without a register copy.
  test("a helper's result feeds the next helper, and a double past the registers is a parameter", () => {
    expect(lift('dchain')).toBe('double dchain(double a0, double a1, double a2) {\n    return (a0 + a1) * a2;\n}\n');
  });

  test('a result held across a call in callee-saved registers is returned', () => {
    expect(lift('dkeep', { g: { params: 0 } })).toBe(
      'double dkeep(double a0, double a1) {\n    g();\n    return a0 + a1;\n}\n',
    );
  });
});

describe('what refuses', () => {
  // `a + 1.5` stages r2=0x3ff80000, r3=0: a long long's naming of that pair is a different number.
  test('a literal operand', () => {
    expect(() => lift('dconst')).toThrow(/no model for the runtime helper '__adddf3'/);
  });

  test('an operand loaded from memory', () => {
    expect(() => lift('dld')).toThrow(/no model for the runtime helper '__adddf3'/);
  });

  // `*(int *)&c` is the double's HIGH word, which agbcc returns out of r0.
  test('a result read as a word', () => {
    expect(() => lift('dhalf')).toThrow(/no model for the runtime helper '__adddf3'/);
  });

  test('a result stored as two words', () => {
    expect(() => lift('dst1')).toThrow(/no model for the runtime helper '__negdf2'/);
  });

  // A declaration that the callee takes a long long builds the pair, and it is still not a double.
  test('a result passed to an ordinary callee', () => {
    expect(() => lift('dpass', { use: { params: ['s64'] } })).toThrow(/no model for the runtime helper '__adddf3'/);
  });

  // Each argument register is read by two pairs, so neither pair is the argument alone. The 64-bit
  // integer fusion refuses the same shape (`s64 sq(s64 a){ return a * a; }`).
  test('an argument passed twice', () => {
    expect(() => lift('dsq')).toThrow(/no model for the runtime helper '__muldf3'/);
  });

  // A double into a compare, a conversion or an ordinary callee is no long long, and the refusal
  // says so rather than asking for a prototype that states one: with one, the pair is built and the
  // fold refuses it (`a result passed to an ordinary callee` above).
  test.each([
    ['d2i', '__fixdfsi', '__muldf3'],
    ['dgt', '__gtdf2', '__adddf3'],
    ['d2f', '__truncdfsf2', '__subdf3'],
    ['dpass', 'use', '__adddf3'],
  ])('%s: a double into %s', (name, callee, producer) => {
    expect(() => lift(name)).toThrow(
      `argument 1 of the call to '${callee}' is the low half of a 64-bit value, the double '${producer}' returned`,
    );
    expect(() => lift(name)).not.toThrow(/long long/);
  });
});

// THE FOLD READS EACH VALUE'S WIDTH OFF THE HELPER'S SIGNATURE, so a single-precision row is a
// table entry and nothing else. The shipped table leaves the singles out (its note says why), so
// these rows are stated here, over agbcc's own listings of the same four shapes.
describe('a single-precision helper folds through the same path', () => {
  const single = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-soft-single.s'), 'utf8');
  const withSingles: TargetDescription = {
    ...ARMV4T_AGBCC,
    runtimeHelpers: {
      ...AGBCC_RUNTIME_HELPERS,
      __addsf3: { op: 'fadd', params: [32, 32], returns: 32 },
      __mulsf3: { op: 'fmul', params: [32, 32], returns: 32 },
      __negsf2: { op: 'fneg', params: [32], returns: 32 },
    },
  };
  const liftSingle = (name: string, prototypes: Prototypes = {}) =>
    decompile(name, single, withSingles, { prototypes }).source;

  test.each([
    ['fadd', 'float fadd(float a0, float a1) {\n    return a0 + a1;\n}\n'],
    ['fchain', 'float fchain(float a0, float a1, float a2) {\n    return (a0 + a1) * a2;\n}\n'],
    ['fneg', 'float fneg(float a0) {\n    return -a0;\n}\n'],
  ])('%s', (name, source) => {
    expect(liftSingle(name)).toBe(source);
  });

  // The declaration is what makes `fuse` read r0 at all: a guessed arity after a call reads none.
  test('a result passed to an ordinary callee refuses', () => {
    expect(() => liftSingle('fpass', { fuse: { params: 1 } })).toThrow(/no model for the runtime helper '__addsf3'/);
  });
});

describe('what the table names', () => {
  // The IR has no int<->float op to fold a compare or a conversion into, and nothing folds a single.
  test('only the double arithmetic', () => {
    for (const name of ['__addsf3', '__mulsf3', '__gtdf2', '__eqdf2', '__floatsidf', '__fixdfsi', '__extendsfdf2']) {
      expect(AGBCC_RUNTIME_HELPERS[name], name).toBeUndefined();
    }
  });

  test('the double arithmetic is float helpers, and nothing else in the table is', () => {
    const floats = Object.keys(AGBCC_RUNTIME_HELPERS).filter((name) => isFloatHelper(AGBCC_RUNTIME_HELPERS[name]));
    expect(floats).toEqual(['__adddf3', '__subdf3', '__muldf3', '__divdf3', '__negdf2']);
  });
});
