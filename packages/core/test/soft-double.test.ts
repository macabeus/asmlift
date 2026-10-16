// agbcc's `double`: no instruction computes on one, so its arithmetic is a libgcc call over the
// register pairs a long long travels in (`runtime-helpers.ts` AGBCC_RUNTIME_HELPERS), and
// `raise/floathelpers.ts` folds the call to the float op over `double`s.
//
// WHAT REFUSES IS EVERY PAIR NOT MOVED WHOLE. agbcc puts a double's HIGH word in the lower register
// (thumb.h:335 FLOAT_WORDS_BIG_ENDIAN), the opposite of a long long, so only a pair moved whole from
// an argument or a helper may be read as a double. Each refusal below declines naming a helper
// rather than passing the call through as `__adddf3()`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { AGBCC_RUNTIME_HELPERS, isFloatHelper } from '../src/runtime-helpers';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS, targetFor } from '../src/target';
import { decompileTraced } from '../src/trace';

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

  // Each argument register is read by two pairs of the same two slots, which are one parameter.
  test('an argument passed twice', () => {
    expect(lift('dsq')).toBe('double dsq(double a0) {\n    return a0 * a0;\n}\n');
  });

  // Without `g`'s declaration its guessed arity reads the pair the helper left in r0:r1, and the
  // refusal says that a declaration is what settles it.
  test('a guessed arity that reads a double names the declaration that settles it', () => {
    expect(() => lift('dkeep')).toThrow(`lifts once a prototype states them (\`{"g": {"params": [...]}}\`)`);
  });

  // The helper runs where the asm called it, before `g` (runtime-helpers.ts `helperOp`): inline at
  // the return, `a0 + a1` recompiles with `bl g` first.
  test('a result held across a call in callee-saved registers is computed before the call', () => {
    expect(lift('dkeep', { g: { params: 0 } })).toBe(
      'double dkeep(double a0, double a1) {\n    double v0;\n    v0 = a0 + a1;\n    g();\n    return v0;\n}\n',
    );
  });
});

// `a + 1.5` stages r2=0x3ff80000, r3=0: two constant words, read high word first as the double
// they spell — a long long's naming of that pair is a different number.
test('a literal operand is the double its words spell', () => {
  expect(lift('dconst')).toBe('double dconst(double a0) {\n    return a0 + 1.5;\n}\n');
});

// The fold is its own pass and its own trace stage, ahead of the 64-bit integer helpers: the stage
// that first shows the doubles is the float one, and the 64-bit one changes nothing after it.
test('the double parameters appear at the soft-float stage', () => {
  const { report } = decompileTraced('dadd', asm, targetFor('agbcc', TOOLCHAIN_TARGETS.agbcc.canonicalFlags));
  const first = report.trace.find((s) => s.irDump?.includes('%0: f64'));
  expect(first?.id).toBe('stage:floathelpers');
  expect(first?.title).toBe('Soft-float lower (bl __adddf3 → float op, a declared double, a literal)');
  const at = (id: string) => report.trace.find((s) => s.id === id)?.irDump;
  expect(at('stage:widehelpers') ?? at('stage:floathelpers')).toBe(at('stage:floathelpers'));
});

describe('what refuses', () => {
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

  // A declaration that the callee takes a long long builds the pair, and it is still not a double;
  // one that it takes a double hands it the double (`double-args.test.ts`).
  test('a result passed to an ordinary callee declared to take a long long', () => {
    expect(() => lift('dpass', { use: { params: ['s64'] } })).toThrow(/no model for the runtime helper '__adddf3'/);
    expect(lift('dpass', { use: { params: ['double'], returnsVoid: true } })).toBe(
      'void dpass(double a0, double a1) {\n    use(a0 + a1);\n}\n',
    );
  });

  // A double into a compare or a conversion is a call to a helper the table SIGNS: its pair is
  // built off the signature, the fold refuses the arithmetic that feeds it, and the helper itself
  // has no op to fold into, so both decline naming the runtime.
  test.each([
    ['d2i', '__fixdfsi', '__muldf3'],
    ['dgt', '__gtdf2', '__adddf3'],
    ['d2f', '__truncdfsf2', '__subdf3'],
  ])('%s: a double into %s', (name, callee, producer) => {
    expect(() => lift(name)).toThrow(
      `no model for the runtime helper '${producer}'; no model for the runtime helper '${callee}'`,
    );
  });

  // A double into an ordinary callee is no long long, and the refusal says so rather than asking
  // for a prototype that states one: with one, the pair is built and the fold refuses it (`a result
  // passed to an ordinary callee declared to take a long long` above).
  test('dpass: a double into use', () => {
    expect(() => lift('dpass')).toThrow(
      "argument 1 of the call to 'use' is the low half of a 64-bit value, the double '__adddf3' returned",
    );
    expect(() => lift('dpass')).not.toThrow(/long long/);
  });
});

// THE FOLD READS EACH VALUE'S WIDTH OFF THE HELPER'S SIGNATURE, so the single-precision arithmetic
// is a table entry and nothing else, over agbcc's own listings of the same shapes.
describe('the single-precision arithmetic helpers are the float ops', () => {
  const single = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-soft-single.s'), 'utf8');
  const liftSingle = (name: string, prototypes: Prototypes = {}) =>
    decompile(name, single, ARMV4T_AGBCC, { prototypes }).source;

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

  // A RESULT NOTHING READS IS ONE A GUESSED ARITY CUT. The call after the helper guesses its arity,
  // and a register a call wrote is not one it counts, so `fuse(a + b)` reads as `fuse()`. Folded,
  // the sum would be dead and `dce` would delete it; the helper stays a call, and the function
  // declines naming it.
  test('fpass: a result nothing reads refuses', () => {
    expect(() => liftSingle('fpass')).toThrow("no model for the runtime helper '__addsf3'");
  });

  // A result into a conversion is a result passed to a call, and the conversion is a helper the
  // table signs and cannot fold: both decline.
  test('fconv: a result into a conversion refuses', () => {
    expect(() => liftSingle('fconv')).toThrow(
      "no model for the runtime helper '__addsf3'; no model for the runtime helper '__fixsfsi'",
    );
  });
});

describe('what the table names', () => {
  // The IR has no int<->float op to fold a compare or a conversion into, so the table SIGNS each
  // and states no op: a call to one refuses, where unnamed its arity would be guessed and the argument
  // it is handed unchanged dropped (`(int)x` as `__fixsfsi()`).
  test('every compare and conversion, signed and with no op', () => {
    const signed = {
      __gtsf2: [[32, 32], 32],
      __fixsfsi: [[32], 32],
      __floatsisf: [[32], 32],
      __gtdf2: [[64, 64], 32],
      __eqdf2: [[64, 64], 32],
      __floatsidf: [[32], 64],
      __fixdfsi: [[64], 32],
      __extendsfdf2: [[32], 64],
      __truncdfsf2: [[64], 32],
      __floatdisf: [[64], 32],
    } as const;
    for (const [name, [params, returns]] of Object.entries(signed)) {
      expect(AGBCC_RUNTIME_HELPERS[name], name).toEqual({ params, returns });
    }
  });

  test.each([
    ['f2i', '__fixsfsi'],
    ['i2f', '__floatsisf'],
    ['fcmp', '__gtsf2'],
  ])('%s: a call to %s refuses', (name, helper) => {
    const single = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-soft-single.s'), 'utf8');
    expect(() => decompile(name, single, ARMV4T_AGBCC).source).toThrow(`no model for the runtime helper '${helper}'`);
  });

  test('the float arithmetic is float helpers, and nothing else in the table is', () => {
    const floats = Object.keys(AGBCC_RUNTIME_HELPERS).filter((name) => isFloatHelper(AGBCC_RUNTIME_HELPERS[name]));
    expect(floats).toEqual([
      '__adddf3',
      '__subdf3',
      '__muldf3',
      '__divdf3',
      '__negdf2',
      '__addsf3',
      '__subsf3',
      '__mulsf3',
      '__divsf3',
      '__negsf2',
    ]);
  });
});
