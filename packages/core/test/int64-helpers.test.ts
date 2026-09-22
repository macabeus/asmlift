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
import type { FnProto } from '../src/proto';
import { enumerateCandidates } from '../src/rank';
import { AGBCC_RUNTIME_HELPERS, helperPrototypes, isWideHelper, wordsOf } from '../src/runtime-helpers';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-int64-helpers.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC).source;

/** Callers of callees whose names are members of `Object.prototype`, which a C symbol may be. */
const objectProtoCallers = (...names: string[]) =>
  names
    .map((sym) =>
      ['\t.code\t16', `\t.globl\tcalls_${sym}`, '\t.thumb_func', `calls_${sym}:`, '\tpush\t{lr}']
        .concat([`\tbl\t${sym}`, '\tpop\t{r2}', '\tbx\tr2'])
        .join('\n'),
    )
    .join('\n');

describe('a register pair read as one value', () => {
  test('a 64-bit helper recovers the operation, not the call', () => {
    expect(lift('llmul')).toBe('s64 llmul(s64 a0, s64 a1) {\n    return a0 * a1;\n}\n');
  });

  test('the WIDEN is a pair shape, and it says which extension the machine performed', () => {
    // `asr rN,rM,#31` per half is the signed one. The callee name cannot say: agbcc's libgcc has
    // no `__umuldi3`, so the unsigned spelling calls this very helper.
    expect(lift('llmulw')).toBe('s64 llmulw(s32 a0, s32 a1) {\n    return (s64)a0 * (s64)a1;\n}\n');
  });

  // …AND THE `asr` KEEPS SAYING IT WHEN THE DECLARATION DISAGREES. The signedness variation
  // declares the parameters `u32`, and a widen that renders as `(s64)a0` over one of those says
  // ZERO-extend — reading the extension off the declaration instead of off the instruction. Both
  // candidates of the pair must spell the same machine fact, so the cast is pinned where the
  // operand does not already carry it, exactly as the compare operands are.
  test('the extension survives a signedness variation that contradicts it', () => {
    const spelt = new Map(
      enumerateCandidates('llmulw', asm, ARMV4T_AGBCC, {}).map((c) => [c.variations.join('+'), c.source]),
    );
    expect(spelt.get('signed')).toContain('(s64)a0 * (s64)a1');
    expect(spelt.get('unsigned')).toContain('(s64)(s32)a0 * (s64)(s32)a1');
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

// A COUNT IS NOT A WIDTH. The evidence a fold rests on is the register PAIR the frontend built,
// and a call can carry the right number of operands without one — here because the arity came off
// a caller-supplied prototype, so no pair was ever built. Folding it publishes a 32-bit multiply
// of two words for a 64-bit multiply of two register pairs, which compiles and scores.
describe('a 64-bit fold needs the widths, not the arity', () => {
  test('a prototype for a wide helper declines; it does not silently narrow the operation', () => {
    // Two C parameters is the header spelling and the one a user reaches for after reading
    // `no model for the runtime helper '__muldi3'`; four is the word arity. `validatePrototypes`
    // accepts all three, and all three must decline.
    for (const params of [['s64', 's64'], 2, 4] as FnProto['params'][]) {
      expect(() => decompile('llmul', asm, ARMV4T_AGBCC, { prototypes: { __muldi3: { params } } })).toThrow(
        /no model for the runtime helper '__muldi3'/,
      );
    }
  });

  test('…and with no prototype the same function recovers the 64-bit multiply', () => {
    expect(lift('llmul')).toBe('s64 llmul(s64 a0, s64 a1) {\n    return a0 * a1;\n}\n');
  });
});

// A C function may be named `toString`, and both helper tables are object literals — so a bare
// index answers with a `Function` off `Object.prototype`. The wrong answer is not a wrong value
// here but a wrong CHANNEL: an internal TypeError out of `isWideHelper`, and on the target whose
// table was read with `in`, a decline whose stated reason names a runtime helper that does not
// exist. Both must be an ordinary call.
describe('the helper table is read by name, not by prototype chain', () => {
  test('a callee named after an Object.prototype member is an ordinary call', () => {
    const asmOf = objectProtoCallers('toString', 'valueOf', 'hasOwnProperty', 'constructor');
    for (const sym of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
      expect(decompile(`calls_${sym}`, asmOf, ARMV4T_AGBCC).source).toContain(`${sym}(`);
    }
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
