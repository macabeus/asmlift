// M0 — the per-pattern golden test: input IR text → expected IR text. This is how
// "objdiff shows __divsi3 → add one pattern → re-score" becomes an individually
// testable, AI-addable datum.
import { expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { SDIV_POW2_2, applyPattern, dce, patternApplies } from '../src/pattern/engine';

// agbcc's signed /2 idiom, lifted to L1: shr_s(add(X, shr_u(X,31)), 1).
const BEFORE = `fn half {
^bb0(%0: s32):
  %1: u32 = shr_u %0 {imm=31}
  %2: s32 = add %0, %1
  %3: s32 = shr_s %2 {imm=1}
  ret %3
}
`;

// After folding to sdiv (asserting signed) + DCE of the now-dead feeders.
const AFTER = `fn half {
^bb0(%0: s32):
  %1: s32 = sdiv %0 {imm=2}
  ret %1
}
`;

test('golden: sdiv-pow2/2 folds the idiom and DCE cleans the feeders', () => {
  const fn = parse(BEFORE);
  const n = applyPattern(fn, SDIV_POW2_2);
  dce(fn);
  expect(n).toBe(1);
  expect(print(fn)).toBe(AFTER);
  verify(fn);
});

test('no spurious match on a non-idiom function', () => {
  const fn = parse(`fn keep {\n^bb0(%0: s32):\n  %1: s32 = shr_s %0 {imm=1}\n  ret %1\n}\n`);
  expect(applyPattern(fn, SDIV_POW2_2)).toBe(0);
});

test('patternApplies gates on the COMPILER (the /2 idiom fires for agbcc + gcc, not ido)', () => {
  // compiler is a LIVE axis: the same shift-sequence for `/2` is emitted by agbcc AND gcc (across
  // two ISAs), so the pattern is tagged by a compiler LIST — and excluded for a compiler (ido)
  // that isn't in it, even on a matching ISA. This is what distinguishes MIPS+IDO from MIPS+GCC.
  const caps = { hwDivide: false, hwFloat: false };
  const agbcc = { id: 'armv4t', compiler: 'agbcc', capabilities: caps };
  const gcc = { id: 'mips', compiler: 'gcc', capabilities: { hwDivide: true, hwFloat: true } };
  const ido = { id: 'mips', compiler: 'ido', capabilities: { hwDivide: true, hwFloat: true } };
  expect(patternApplies(SDIV_POW2_2, agbcc)).toBe(true);
  expect(patternApplies(SDIV_POW2_2, gcc)).toBe(true);
  expect(patternApplies(SDIV_POW2_2, ido)).toBe(false);
});
