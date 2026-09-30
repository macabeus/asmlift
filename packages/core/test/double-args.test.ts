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
    expect(() => lift('dsplit', F4)).toThrow(/`f4` outside the argument registers — its parameter 4 is 64 bits wide/);
    expect(() => lift('dstack', F5)).toThrow(/`f5` outside the argument registers — its parameter 5 is 64 bits wide/);
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
