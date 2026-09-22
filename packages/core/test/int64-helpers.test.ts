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
  // `b` is BOTH the shift count and an addend, so it is a word this function uses as a word.
  test('a parameter used on its own is a word, and is not fused into a pair', () => {
    const src = lift('llhalfuse');
    expect(src).toContain('s64 a0, s32 a1');
    expect(src).not.toContain('s64 a1');
  });

  // THE WIDTH IS THE EPILOGUE'S, and these two functions are the same four instructions apart
  // from which register the scratch pop names. `pop {r2}` cannot touch the return pair; `pop {r1}`
  // fills its high register with the return ADDRESS. Nothing in the value graph can tell them
  // apart, because this frontend models no write for a `pop` at all.
  test('a pair the epilogue pops over is not a 64-bit return', () => {
    expect(lift('lomul')).toBe('s32 lomul(s64 a0, s64 a1) {\n    return (s32)(a0 * a1);\n}\n');
  });

  test('…and the twin that pops elsewhere still is one', () => {
    expect(lift('llmul')).toBe('s64 llmul(s64 a0, s64 a1) {\n    return a0 * a1;\n}\n');
  });

  // A CALL DESTROYS THE HIGH HALF WITHOUT NAMING IT — r1 is caller-saved. agbcc cannot build this
  // shape (a 64-bit return keeps both halves across the call; a 32-bit one carries the epilogue
  // above), so the inhabitant is hand-written asm, which is what the playground lifts. `sink` is
  // declared void-of-nothing so that the call reads no argument register: with an arity to guess
  // it would read the low half and hit the refusal below instead, and then this would be testing
  // that one.
  const handWritten = (mid: string[]) =>
    ['\t.code\t16', '\t.globl\tlokeep', '\t.thumb_func', 'lokeep:', '\tpush\t{r4, lr}', '\tbl\t__muldi3', ...mid]
      .concat(['\tadd\tr0, r4, #0', '\tpop\t{r4}', '\tpop\t{pc}', ''])
      .join('\n');

  test('a call between the pair and the return takes the high half with it', () => {
    const src = decompile('lokeep', handWritten(['\tadd\tr4, r0, #0', '\tbl\tsink']), ARMV4T_AGBCC, {
      prototypes: { sink: { params: 0 } },
    }).source;
    expect(src).toMatch(/^s32 lokeep\(/);
  });

  test('…and with nothing in between, the same shape returns the pair', () => {
    const src = decompile('lokeep', handWritten(['\tadd\tr4, r0, #0']), ARMV4T_AGBCC, {
      prototypes: { sink: { params: 0 } },
    }).source;
    expect(src).toMatch(/^s64 lokeep\(/);
  });

  // THE CALL BOUNDARY IS WHERE THE PAIR STOPS. Handing a half to a callee whose parameter widths
  // nothing states is the wrong answer that recompiles to the right bytes, so it declines.
  test('a half handed to an ordinary callee declines, and names the half', () => {
    expect(() => decompile('lokeep', handWritten(['\tbl\tsink']), ARMV4T_AGBCC)).toThrow(
      /argument 1 of the call to 'sink' is the low half of a 64-bit value/,
    );
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
