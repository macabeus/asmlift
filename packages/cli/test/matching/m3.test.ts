// M3 — type recovery as RANKED CANDIDATES re-ranked by the differ: "types are differ-ranked
// levers", demonstrated end-to-end. The asm alone cannot say whether a value is signed; asmlift
// emits both candidates and the objdiff score, not a guess, picks the one that matches.
//
// The discriminating shape is DIVISION. `x / 3` calls `__udivsi3` when x is unsigned and
// `__divsi3` when it is signed — a different relocation, so no spelling of the body can hide the
// choice and the type is the only channel that carries it.
//
// `x >> 1` used to be that shape too, and is kept below as a control on what changed: since the
// shift-direction fix, the emitted C states `shr_u` explicitly (`(u32)a0 >> 1`) instead of leaving
// it to the parameter's declared type, so BOTH candidates now recompile byte-exact. The lever is
// intact — that spelling simply stopped depending on it.
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

test('M3: the differ picks the correct signedness candidate', () => {
  // target built from the UNSIGNED division → a `__udivsi3` call
  const ranked = rank('udiv', 'unsigned udiv(unsigned x){ return x / 3; }');

  // the winner is the unsigned candidate, and it matches byte-exact
  expect(ranked.best.label).toBe('unsigned');
  expect(ranked.best.score.match).toBe(true);
  // the wrong candidate is strictly worse — the differ genuinely discriminated
  const signed = ranked.candidates.find((c) => c.label === 'signed')!;
  expect(signed.score.score).toBeGreaterThan(ranked.best.score.score);
});

test('M3 control: `x >> 1` no longer needs the lever — the spelling carries the shift direction', () => {
  const ranked = rank('ushr', 'unsigned ushr(unsigned x){ return x >> 1; }');
  expect(ranked.best.label).toBe('unsigned'); // the simpler spelling still wins the tie
  expect(ranked.best.score.match).toBe(true);
  // Both match: the signed candidate spells `(u32)a0 >> 1`, which is the same bytes. Before the
  // shift-direction fix it spelled a bare `a0 >> 1` — C's ARITHMETIC shift, `asr` where the
  // target has `lsr` — and lost. Byte-equality here is the fix working, not the lever failing.
  expect(ranked.candidates.every((c) => c.score.match)).toBe(true);
});
