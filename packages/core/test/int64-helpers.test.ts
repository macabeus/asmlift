// A 64-bit value coming out of a COMPILER RUNTIME HELPER, which is the only way one enters the IR
// today: agbcc has no 64-bit instruction, so it calls `__muldi3` and the pair lives in registers on
// either side of the call.
//
// Three things have to hold together for that to become `a * b`, and each has its own test below:
// the helper table states each C parameter's WIDTH so the frontend reads a register pair as one
// value; the call's own result is split back into the pair and the two halves are named, which is
// the ACCEPTANCE arm of the refusal in `frontend/ssa.ts`; and the parameters the pair came from are
// fused into one, which is what makes the signature `s64` rather than four words.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { AGBCC_RUNTIME_HELPERS, helperPrototypes, isWideHelper, wordsOf } from '../src/runtime-helpers';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-int64-helpers.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC).source;

describe('a register pair read as one value', () => {
  test('a 64-bit helper recovers the operation, not the call', () => {
    expect(lift('llmul')).toBe('s64 llmul(s64 a0, s64 a1) {\n    return a0 * a1;\n}\n');
  });

  test('the WIDEN is a pair shape, and it says which extension the machine performed', () => {
    // `asr rN,rM,#31` per half is the signed one. The callee name cannot say: agbcc's libgcc has
    // no `__umuldi3`, so the unsigned spelling calls this very helper.
    expect(lift('llmulw')).toBe('s64 llmulw(s32 a0, s32 a1) {\n    return (s64)a0 * (s64)a1;\n}\n');
  });
});

describe('what refuses', () => {
  // Both refusals fire on this one function, which is why it is one function: a parameter that is
  // also used on its own, and an epilogue whose scratch is the high half of the return pair.
  test('a parameter used on its own is a word, and is not fused into a pair', () => {
    const src = lift('llhalfuse');
    expect(src).toContain('s64 a0, s32 a1');
    expect(src).not.toContain('s64 a1');
  });

  test('a 64-bit return whose high half the epilogue overwrote is not widened', () => {
    // `pop {r1}; bx r1` leaves r1 holding the return ADDRESS, so it is not the product's high
    // half and the return stays a word. The witness refutes itself — nothing else has to check.
    expect(lift('llhalfuse')).toMatch(/^s32 llhalfuse\(/);
  });
});

describe('the table says what a helper takes, in widths and not in words', () => {
  test('a 64-bit parameter is one C parameter and two argument registers', () => {
    expect(wordsOf([64, 32])).toBe(3);
    expect(wordsOf([32, 32])).toBe(2);
    expect(helperPrototypes(AGBCC_RUNTIME_HELPERS).__ashrdi3).toEqual({ params: 3 });
    expect(helperPrototypes(AGBCC_RUNTIME_HELPERS).__divsi3).toEqual({ params: 2 });
  });

  test('the 32-bit soft divisions are not wide, and the 64-bit family is', () => {
    expect(isWideHelper(AGBCC_RUNTIME_HELPERS.__divsi3)).toBe(false);
    expect(isWideHelper(AGBCC_RUNTIME_HELPERS.__muldi3)).toBe(true);
    expect(isWideHelper(AGBCC_RUNTIME_HELPERS.__negdi2)).toBe(true);
  });

  test('the DIVISIONS split on the name and the MULTIPLY does not', () => {
    expect(AGBCC_RUNTIME_HELPERS.__divdi3.op).toBe('sdiv');
    expect(AGBCC_RUNTIME_HELPERS.__udivdi3.op).toBe('udiv');
    // One multiply libfunc, both spellings — so there is no `__umuldi3` entry to disagree with.
    expect(AGBCC_RUNTIME_HELPERS.__muldi3.op).toBe('mul');
    expect(AGBCC_RUNTIME_HELPERS.__umuldi3).toBeUndefined();
  });
});
