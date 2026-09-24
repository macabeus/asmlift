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

/** A hand-written `f`: `body` after its label, then `ret` (a leaf's `bx lr` unless given). */
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
    expect(() => lift('lljoin')).toThrow(/halves of a 64-bit pair another block built/);
    const noInterwork = asm.replace('\tpop\t{r4, r5}\n\tpop\t{r2}\n\tbx\tr2\n.Lfe9:', '\tpop\t{r4, r5, pc}\n.Lfe9:');
    expect(noInterwork).not.toBe(asm);
    expect(() => decompile('lljoin', noInterwork, ARMV4T_AGBCC)).toThrow(/halves of a 64-bit pair another block built/);
  });

  // r1 IS ASKED ABOUT, NEVER READ: this pair lands in r0:r3 and nothing defines r1, so a read of it
  // would mint a live-in — a second parameter the function does not have.
  const widenInR3 = ['\tasr\tr3, r0, #0x1f', '\tmov\tr2, #0x0', '\tadd\tr0, r0, r0', '\tadc\tr3, r2'];
  test('a pair whose high half is not in r1 gains no parameter', () => {
    expect(liftLeaf(widenInR3)).toMatch(/^s32 f\(s32 a0\) \{/);
  });

  test('…and neither does one that reaches the return through a join', () => {
    const body = ['\tcmp\tr0, #0x0', '\tbeq\t.L1', ...widenInR3, '.L1:'];
    expect(liftLeaf(body)).toMatch(/^s32 f\(s32 a0\) \{/);
  });

  // THE HIGH HALF BUILT FROM SHIFTS, not projected from a pair: nothing this lift built reaches
  // r0:r1, and the r2 epilogue says the return type is 5 to 8 bytes.
  test('an 8-byte epilogue with no pair in r0:r1 declines', () => {
    expect(() => lift('llmuldiv')).toThrow(/says the return type is 5 to 8 bytes/);
  });

  // STALENESS TRAVELS THROUGH COPIES: a call destroys r1 and a pop reloads r4, and a copy out of
  // either is no more the pair's high half than the register it copies.
  const g0 = { prototypes: { g: { params: 0 } } };
  test('a copy of a register the call destroyed does not bring the high half back', () => {
    const body = ['\tpush\t{r4, r5, lr}', '\tadd\tr0, r0, r2', '\tadc\tr1, r1, r3', '\tadd\tr4, r0, #0', '\tbl\tg'];
    const tail = ['\tadd\tr5, r1, #0', '\tadd\tr1, r5, #0', '\tadd\tr0, r4, #0'];
    const src = decompile('f', leaf([...body, ...tail], ['\tpop\t{r4, r5, pc}']), ARMV4T_AGBCC, g0).source;
    expect(src).not.toMatch(/^s64 f\(/);
  });

  test('…nor does a copy of a register a pop reloaded', () => {
    const body = ['\tpush\t{r4, lr}', '\tadd\tr0, r0, r2', '\tadc\tr1, r1, r3', '\tadd\tr4, r1, #0', '\tpop\t{r4}'];
    const src = liftLeaf([...body, '\tadd\tr1, r4, #0'], ['\tpop\t{pc}']);
    expect(src).not.toMatch(/^s64 f\(/);
  });

  // WHAT r1 HOLDS AFTER A CALL IS KNOWN ONLY THROUGH IDENTITIES: a register copy (either spelling,
  // any register name) or a stack slot's store and reload carry what they moved, known or not, and
  // a store to memory is no write to r1 at all.
  const pair = ['\tadd\tr0, r0, r2', '\tadc\tr1, r1, r3'];
  const framed = (body: string[]) =>
    decompile('f', leaf(['\tpush\t{r4, r5, lr}', ...body], ['\tpop\t{r4, r5, pc}']), ARMV4T_AGBCC, g0).source;
  test('the high half survives a call through copies and slots of registers the call preserved', () => {
    const viaMov = ['\tmov\tr4, r0', '\tmov\tr5, r1', '\tbl\tg', '\tmov\tr1, r5', '\tmov\tr0, r4'];
    expect(framed([...pair, ...viaMov])).toMatch(/^s64 f\(/);
    const viaHigh = ['\tadd\tr4, r0, #0', '\tmov\tsl, r1', '\tbl\tg', '\tmov\tr1, sl', '\tadd\tr0, r4, #0'];
    expect(framed([...pair, ...viaHigh])).toMatch(/^s64 f\(/);
    const viaSlot = ['\tadd\tsp, #-8', ...pair, '\tstr\tr1, [sp, #4]', '\tadd\tr4, r0, #0', '\tbl\tg'];
    expect(framed([...viaSlot, '\tldr\tr1, [sp, #4]', '\tadd\tr0, r4, #0', '\tadd\tsp, #8'])).toMatch(/^s64 f\(/);
    const stored = [...pair, '\tldr\tr4, .Lg', '\tstr\tr1, [r4]'];
    expect(decompile('f', leaf(stored, ['\tpop\t{r4, r5, pc}', '.Lg:', '\t.word\tgv']), ARMV4T_AGBCC).source).toMatch(
      /^s64 f\(/,
    );
  });

  test('…and does not survive through copies and slots of the register the call destroyed', () => {
    const tail = ['\tadd\tr0, r4, #0'];
    expect(framed([...pair, '\tadd\tr4, r0, #0', '\tbl\tg', '\tmov\tr5, r1', '\tmov\tr1, r5', ...tail])).not.toMatch(
      /^s64/,
    );
    expect(framed([...pair, '\tadd\tr4, r0, #0', '\tbl\tg', '\tmov\tip, r1', '\tmov\tr1, ip', ...tail])).not.toMatch(
      /^s64/,
    );
    const slot = [
      '\tadd\tsp, #-8',
      ...pair,
      '\tadd\tr4, r0, #0',
      '\tbl\tg',
      '\tstr\tr1, [sp, #4]',
      '\tldr\tr1, [sp, #4]',
    ];
    expect(framed([...slot, ...tail, '\tadd\tsp, #8'])).not.toMatch(/^s64/);
  });

  // agbcc holds the sum in r4:r5 across `g()` and copies it back; the call rules are pinned beside
  // `llkeep` in int64-helpers.test.ts.
  test('a pair held across a call and copied back is returned', () => {
    const src = decompile('llkeepadd', asm, ARMV4T_AGBCC, { prototypes: { g: { params: 0 } } }).source;
    expect(src).toBe('s64 llkeepadd(s64 a0, s64 a1) {\n    g();\n    return a0 + a1;\n}\n');
  });
});

// Each refusal leaves the carry instruction to decode as an unmodelled opaque.
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
