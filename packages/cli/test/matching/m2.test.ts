// M2 — a SERIALIZABLE idiom pattern that folds a real idiom to the source spelling.
//
// `half` = agbcc's signed x/2, lowered (no hw-divide) to `lsr #31; add; asr #1`. With the
// pattern (a pure data object) the idiom folds to `x / 2` and recompiles byte-exact.
//
// HISTORICAL NOTE — this test used to assert the pattern MOVED the score, because the raw
// lowering did not match: asmlift spelled the sign-bit shift as a bare `x >> 31`, C's ARITHMETIC
// shift, where the target has `lsr`. That was the shift-direction miscompile, not a fact about
// the pattern, and it is fixed at the rendering layer — the raw lowering now spells
// `(s32)(a0 + ((u32)a0 >> 31)) >> 1` and matches on its own. So the pattern's payoff is
// READABILITY, and the claim under test is that folding it stays byte-exact rather than that it
// rescues a broken lift. The signedness lever is still pinned on a shape no spelling can hide
// (m3.test.ts, division).
import { SDIV_POW2_2 } from '@asmlift/core/pattern/engine';
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

const REFERENCE_C = 'int half(int x){ return x / 2; }';

test('M2: the sdiv-pow2 pattern moves the objdiff score to 0', () => {
  const targetAsm = compileTargetAsm(REFERENCE_C);
  const targetObj = assembleTarget(targetAsm);

  // `patterns: []` explicitly opts out of the default idiom bundle to show the naive baseline;
  // `withPat` passes the pattern (equivalent to the default here) to show the fold.
  const without = decompile('half', targetAsm, ARMV4T_AGBCC, { patterns: [] });
  const withPat = decompile('half', targetAsm, ARMV4T_AGBCC, { patterns: [SDIV_POW2_2] });

  const sWithout = scoreC(without.source, 'half', targetObj);
  const sWith = scoreC(withPat.source, 'half', targetObj);

  console.log('without pattern:', without.source.trim(), '→ score', sWithout.score);
  console.log('with pattern:   ', withPat.source.trim(), '→ score', sWith.score);

  // the pattern fired, folded the idiom, and the folded spelling is byte-exact
  expect(withPat.patternHits).toBe(1);
  expect(without.patternHits).toBe(0);
  expect(sWith.score).toBeLessThanOrEqual(sWithout.score); // folding never COSTS bytes
  expect(sWith.match).toBe(true); // …and lands byte-exact
  expect(withPat.source).toContain('/ 2');
  expect(without.source).not.toContain('/ 2'); // the baseline really is the unfolded shift tree
});
