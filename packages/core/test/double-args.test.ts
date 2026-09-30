// A `double` handed to a declared callee on agbcc. It crosses the call in the two general argument
// words a `long long` takes, wherever they fall, with its HIGH word first
// (`compilerBehaviors.softDoubleWords`), so the pair read as an integer is another number —
// `g(1.5)` as `g(1073217536, 0)`. The asm is agbcc's own (`scripts/regen-double-arg-probes.ts`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC, type TargetDescription } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-double-args.s'), 'utf8');
const lift = (name: string, prototypes: Prototypes = {}, target: TargetDescription = ARMV4T_AGBCC) =>
  decompile(name, asm, target, { prototypes }).source;

const takes = (callee: string, params: string[]): Prototypes => ({ [callee]: { params, returnsVoid: true } });
const G = takes('g', ['double']);
const F4 = takes('f4', ['int', 'int', 'int', 'double']);
const F5 = takes('f5', ['int', 'int', 'int', 'int', 'double']);

describe('a declared double argument', () => {
  const own = (callee: Prototypes, name: string): Prototypes => ({ ...callee, [name]: { returnsVoid: true } });

  // The pair is a double moved whole — this function's own parameter, or a helper's result — in
  // each of agbcc's three placements.
  test.each([
    ['dpass', G, 'void dpass(double a0) {\n    g(a0);\n}\n'],
    ['dmove', F4, 'void dmove(s32 a0, double a1) {\n    f4(a0, a0, a0, a1);\n}\n'],
    ['dmove5', F5, 'void dmove5(double a0, s32 a1) {\n    f5(a1, a1, a1, a1, a0);\n}\n'],
    ['dsum', G, 'void dsum(double a0, double a1) {\n    g(a0 + a1);\n}\n'],
  ])('%s', (name, callee, source) => {
    expect(lift(name, own(callee, name))).toBe(source);
  });

  // A double parameter has no fallback: its words handed on as integers are another number, so a
  // pair that is not a double moved whole declines the function.
  test.each([
    ['dreg', G, 1, 'g'],
    ['dsplit', F4, 4, 'f4'],
    ['dstack', F5, 5, 'f5'],
    ['dmem', G, 1, 'g'],
  ])('%s: a literal or a load declines', (name, callee, arg, fn) => {
    expect(() => lift(name, own(callee, name))).toThrow(
      `argument ${arg} of the call to '${fn}' is a floating-point argument its callee declares \`double\``,
    );
  });

  // agbcc keeps a double's high word first, so the halves of this function's own parameter handed
  // on in the other order are another number, and no double of this function's.
  test('a parameter handed on with its halves swapped declines', () => {
    const swapped =
      'f:\n\tpush\t{lr}\n\tadd\tr2, r0, #0\n\tadd\tr0, r1, #0\n\tadd\tr1, r2, #0\n\tbl\tg\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('f', swapped, ARMV4T_AGBCC, { prototypes: own(G, 'f') })).toThrow(
      "argument 1 of the call to 'g' is a floating-point argument",
    );
  });

  // …and a word handed to the same call beside it is a word read of it.
  test('a parameter also passed as a word declines', () => {
    const twice = 'f:\n\tpush\t{lr}\n\tadd\tr2, r0, #0\n\tbl\th\n\tpop\t{r0}\n\tbx\tr0\n';
    const h = { h: { params: ['double', 'int'], returnsVoid: true }, f: { returnsVoid: true } };
    expect(() => decompile('f', twice, ARMV4T_AGBCC, { prototypes: h })).toThrow(
      "argument 1 of the call to 'h' is a floating-point argument",
    );
  });

  // An FPU target passes a double in a float register and no general word, so the declaration
  // states no layout there and the call is lifted as a callee nobody declared is.
  test('on a target that does not claim soft doubles the declaration abstains', () => {
    const { softDoubleWords, ...rest } = ARMV4T_AGBCC.compilerBehaviors;
    expect(softDoubleWords).toBe('high-first');
    const fpu = { ...ARMV4T_AGBCC, compilerBehaviors: rest };
    expect(lift('dreg', G, fpu)).toBe(lift('dreg'));
  });
});

// agbcc places a 64-bit argument in the next two words wherever they fall, with no even alignment
// (thumb.h:632/636/647): the low half of a `long long` in r3 and its high half at [sp,#0], or both
// in the outgoing block, behind a word at [sp,#0] when one is there.
describe('a declared 64-bit argument past the registers', () => {
  const L = {
    ...takes('l4', ['int', 'int', 'int', 'long long']),
    ...takes('l5', ['int', 'int', 'int', 'int', 'long long']),
    ...takes('l6', ['int', 'int', 'int', 'int', 'int', 'long long']),
  };
  const own = (name: string): Prototypes => ({ ...L, [name]: { returnsVoid: true } });

  test('split across r3 and [sp,#0]', () => {
    expect(lift('lmove', own('lmove'))).toBe('void lmove(s32 a0, s64 a1) {\n    l4(a0, a0, a0, a1);\n}\n');
  });

  test('in two words of the outgoing block', () => {
    expect(lift('lmove5', own('lmove5'))).toBe('void lmove5(s64 a0, s32 a1) {\n    l5(a1, a1, a1, a1, a0);\n}\n');
  });

  // The pair is read from the words the call staged, so a literal is the two words agbcc loaded from
  // its pool — a 64-bit literal, which has no spelling and says so, in every placement.
  test.each(['lsplit', 'lstack', 'lgap'])('%s: a literal pair is read from where it was staged', (name) => {
    expect(() => lift(name, own(name))).toThrow(/no lowering for op 'concat'/);
  });
});
