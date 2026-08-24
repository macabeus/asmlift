// M3 — type recovery as RANKED CANDIDATES re-ranked by the differ: "types are differ-ranked
// levers", demonstrated end-to-end. The asm alone cannot say whether a value is signed; asmlift
// emits every candidate and the objdiff score, not a guess, picks the one that matches.
//
// Both shapes below recompile byte-exact under BOTH candidates, and that is the point they make.
// A shift and a divide leave the choice between `asr`/`lsr` and `__divsi3`/`__udivsi3` to the C
// operand's type, and the emitted C STATES it (`(u32)a0 >> 1`, `(u32)a0 / 3`) rather than leaving
// it to the parameter declaration — which is what lets asmlift spell a per-site signedness a
// whole-function declaration cannot reach: pokeemerald:GetAnchorCoord divides unsigned between
// two arithmetic shifts of the same values.
//
// So what these tests pin is the ranking machinery end-to-end plus the byte-equality itself: a
// candidate that stops discriminating has to stop by MATCHING, never by losing.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

const rank = (sym: string, c: string) => {
  const targetAsm = compileTargetAsm(c);
  const ranked = decompileRanked(sym, targetAsm, ARMV4T_AGBCC, assembleTarget(targetAsm));
  for (const cand of ranked.candidates) {
    console.log(`  ${sym} ${cand.label}: score ${cand.score.score}  ${cand.source.trim()}`);
  }
  return ranked;
};

test('M3: the spelling carries the division signedness, so both candidates match', () => {
  // target built from the UNSIGNED division → a `__udivsi3` call
  const ranked = rank('udiv', 'unsigned udiv(unsigned x){ return x / 3; }');
  expect(ranked.best.label).toBe('unsigned'); // the simpler spelling still wins the tie
  expect(ranked.best.score.match).toBe(true);
  // Both match because the signed candidate spells `(u32)a0 / 3`, which is the same bytes — the
  // operand pin working, not the lever failing. A bare `a0 / 3` is C's SIGNED division and would
  // call `__divsi3` where the target calls `__udivsi3`.
  expect(ranked.candidates.every((c) => c.score.match)).toBe(true);
});

test('M3 control: the spelling carries the shift direction, so both candidates match', () => {
  const ranked = rank('ushr', 'unsigned ushr(unsigned x){ return x >> 1; }');
  expect(ranked.best.label).toBe('unsigned');
  expect(ranked.best.score.match).toBe(true);
  expect(ranked.candidates.every((c) => c.score.match)).toBe(true);
});
