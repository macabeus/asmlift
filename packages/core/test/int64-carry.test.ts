// A 64-bit add or subtract, which Thumb-1 spells as a flag-setting `add`/`sub` on the low words
// and an `adc`/`sbc` on the high words that consumes its carry. The frontend reads the adjacent
// pair as ONE operation over two register pairs; everything after it — the parameter fusion, the
// pair return, the widen and the loud `concat` gap — is the machinery the 64-bit helper calls
// already use (`int64-helpers.test.ts`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-int64-carry.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC).source;

/** A hand-written leaf `f` with `body` between its label and `bx lr`. */
const leaf = (body: string[], ret = ['\tbx\tlr']) =>
  ['\t.code\t16', '\t.globl\tf', '\t.thumb_func', 'f:', ...body, ...ret, ''].join('\n');
const liftLeaf = (body: string[], ret?: string[]) => decompile('f', leaf(body, ret), ARMV4T_AGBCC).source;

describe('a carry pair is one 64-bit operation', () => {
  test('add + adc over two parameter pairs', () => {
    expect(lift('lladd')).toBe('s64 lladd(s64 a0, s64 a1) {\n    return a0 + a1;\n}\n');
  });

  test('sub + sbc over two parameter pairs', () => {
    expect(lift('llsub')).toBe('s64 llsub(s64 a0, s64 a1) {\n    return a0 - a1;\n}\n');
  });

  // THE WIDEN ARRIVES AS A PAIR SHAPE, and the structurer spells it from the high half's
  // producer — `asr #0x1f` signed, `mov #0` unsigned — exactly as it does for a helper's operand.
  test('a word widened into one operand', () => {
    expect(lift('lladdw')).toBe('s64 lladdw(s64 a0, s32 a1) {\n    return (s64)a1 + a0;\n}\n');
    expect(lift('lladdu')).toBe('s64 lladdu(s64 a0, s32 a1) {\n    return (s64)(u32)a1 + a0;\n}\n');
  });

  test('the high half alone is a shift of the 64-bit sum', () => {
    expect(lift('llhisum')).toBe('s32 llhisum(s64 a0, s64 a1) {\n    return (s32)(a0 + a1 >> 32);\n}\n');
  });

  test('a chain of two, the third pair read off the stack', () => {
    expect(lift('lladd3')).toBe('s64 lladd3(s64 a0, s64 a1, s64 a2) {\n    return a2 + (a0 + a1);\n}\n');
  });

  // `adc` IS A 64-BIT ADD, NOT A SOURCE `+`: agbcc reaches `adddi3` from `a*3` as `(a<<1)+a`, and
  // the shifted pair is no widen, so its `concat` stays the loud gap.
  test('a pair that is not a widen or a parameter stays a gap', () => {
    expect(() => lift('lltimes3')).toThrow(/no lowering for op 'concat'/);
  });
});

// THE PAIR RETURN IS READ OFF WHAT r1 HOLDS (`wideReturn`), and a carry pair's projections are
// what it reads: `lladdw` above hands its sum back through `add r1,r3,#0`.
describe('the return width', () => {
  test('an epilogue that pops into the high register returns a word', () => {
    const src = liftLeaf(['\tpush\t{lr}', '\tadd\tr0, r0, r2', '\tadc\tr1, r1, r3', '\tpop\t{r1}'], ['\tbx\tr1']);
    expect(src).toMatch(/^s32 f\(/);
  });

  test('…and one that pops elsewhere returns the pair', () => {
    const src = liftLeaf(['\tpush\t{lr}', '\tadd\tr0, r0, r2', '\tadc\tr1, r1, r3', '\tpop\t{r2}'], ['\tbx\tr2']);
    expect(src).toBe('s64 f(s64 a0, s64 a1) {\n    return a0 + a1;\n}\n');
  });

  test('a high register overwritten after the pair does not return the pair', () => {
    const src = liftLeaf(['\tadd\tr0, r0, r2', '\tadc\tr1, r1, r3', '\tmov\tr1, #0x0']);
    expect(src).not.toMatch(/^s64 f\(/);
  });

  test('a pair returned from a join declines rather than returning a word', () => {
    expect(() => lift('lljoin')).toThrow(/two halves of a 64-bit value that another block built/);
  });

  // agbcc holds the sum in r4:r5 across `g()` and copies it back; the call rules are pinned beside
  // `llkeep` in int64-helpers.test.ts.
  test('a pair held across a call and copied back is returned', () => {
    const src = decompile('llkeepadd', asm, ARMV4T_AGBCC, { prototypes: { g: { params: 0 } } }).source;
    expect(src).toBe('s64 llkeepadd(s64 a0, s64 a1) {\n    g();\n    return a0 + a1;\n}\n');
  });
});

// Each refusal leaves the carry instruction to decode as the opaque it always was.
describe('what refuses', () => {
  const unmodelled = /unmodelled instruction '(adc|sbc)'/;

  test('the carry consumer is not the next instruction', () => {
    expect(() => liftLeaf(['\tadd\tr0, r0, r2', '\tldr\tr4, [r5]', '\tadc\tr1, r1, r3'])).toThrow(unmodelled);
  });

  test('an add does not feed an sbc, nor a sub an adc', () => {
    expect(() => liftLeaf(['\tadd\tr0, r0, r2', '\tsbc\tr1, r1, r3'])).toThrow(unmodelled);
    expect(() => liftLeaf(['\tsub\tr0, r0, r2', '\tadc\tr1, r1, r3'])).toThrow(unmodelled);
  });

  // `add r0, r8` is the high-register encoding, which writes no flags at all.
  test('a high register anywhere in the pair', () => {
    expect(() => liftLeaf(['\tadd\tr0, r8', '\tadc\tr1, r1, r3'])).toThrow(unmodelled);
  });

  test('the low destination is a high-half operand', () => {
    expect(() => liftLeaf(['\tadd\tr0, r0, r2', '\tadc\tr1, r1, r0'])).toThrow(unmodelled);
    expect(() => liftLeaf(['\tadd\tr1, r0, r2', '\tadc\tr1, r1, r3'])).toThrow(unmodelled);
  });

  test('a three-operand carry Thumb-1 cannot encode', () => {
    expect(() => liftLeaf(['\tadd\tr0, r0, r2', '\tadc\tr1, r2, r3'])).toThrow(unmodelled);
  });
});
