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
  test('declines naming the callee rather than passing its words as integers', () => {
    expect(() => lift('dreg', G)).toThrow(
      '`g` is declared to take a double as argument word 1, and a floating-point argument to a declared callee is not modelled',
    );
    expect(() => lift('dsplit', F4)).toThrow('`f4` is declared to take a double as argument word 4');
    expect(() => lift('dstack', F5)).toThrow('`f5` is declared to take a double as argument word 5');
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
