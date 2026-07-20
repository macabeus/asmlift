// M2 — a SERIALIZABLE idiom pattern that MOVES A REAL objdiff score on a function
// the naive lift gets wrong.
//
// `half` = agbcc's signed x/2, lowered (no hw-divide) to `lsr #31; add; asr #1`. Without
// the pattern, asmlift emits the raw shifts — which agbcc recompiles with an `asr` where
// the target has `lsr` (the sign-bit shift), so it does NOT match. With the pattern (a
// pure data object) the idiom folds to `x / 2` and recompiles byte-exact. The score
// delta is measured by real objdiff, not asserted.
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

  // the pattern fired, folded the idiom, and moved the score strictly toward 0
  expect(withPat.patternHits).toBe(1);
  expect(without.patternHits).toBe(0);
  expect(sWith.score).toBeLessThan(sWithout.score); // the score MOVED
  expect(sWith.match).toBe(true); // …all the way to byte-exact
  expect(withPat.source).toContain('/ 2');
});
