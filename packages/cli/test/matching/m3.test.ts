// M3 — type recovery as RANKED CANDIDATES re-ranked by the differ.
// `x >> 1` compiles to `lsr` if x is unsigned but `asr` if signed — the asm alone can't
// say which. asmlift emits both candidates; the objdiff score, not a guess, picks the
// one that matches. This is "types are differ-ranked levers", demonstrated end-to-end.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

test('M3: the differ picks the correct signedness candidate', () => {
  // target built from the UNSIGNED shift → `lsr r0, r0, #1`
  const targetAsm = compileTargetAsm('unsigned ushr(unsigned x){ return x >> 1; }');
  const targetObj = assembleTarget(targetAsm);

  const ranked = decompileRanked('ushr', targetAsm, ARMV4T_AGBCC, targetObj);
  for (const c of ranked.candidates) {
    console.log(`  ${c.label}: score ${c.score.score}  ${c.source.trim()}`);
  }

  // the winner is the unsigned candidate, and it matches byte-exact
  expect(ranked.best.label).toBe('unsigned');
  expect(ranked.best.score.match).toBe(true);
  // the wrong candidate is strictly worse — the differ genuinely discriminated
  const signed = ranked.candidates.find((c) => c.label === 'signed')!;
  expect(signed.score.score).toBeGreaterThan(ranked.best.score.score);
});
