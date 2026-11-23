// agbcc's single-precision runtime where a float crosses something other than a helper: an argument
// the function hands back (`raise/floathelpers.ts`). The corpus is compiled at agbcc -O2 from the
// sources its header lists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-soft-float-rt.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC).source;

describe('an argument the function returns', () => {
  // `return a;` moves the word whole into r0, so the compare's operand is the float it returns.
  test('returned beside the compare that reads it', () => {
    expect(lift('fkeep')).toBe('float fkeep(float a0, float a1) {\n    if (a0 < a1) gI = 1;\n    return a0;\n}\n');
    expect(lift('fkeep2')).toBe('float fkeep2(float a0, float a1) {\n    if (!(a0 < a1)) gI = 1;\n    return a0;\n}\n');
  });

  // The other return hands back the word 5, which a float function would convert to 5.0f.
  test('returned beside an integer return refuses', () => {
    expect(() => lift('fkeepi')).toThrow("no model for the runtime helper '__ltsf2'");
  });
});
