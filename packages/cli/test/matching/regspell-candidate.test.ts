// The register-copy lever's GATE (mirrors branch-sense-candidate.test.ts): the offline pins call
// registerishSpellings directly, so a wiring regression in rank.ts's respell seam (a contract
// change rejecting the SFn, an emit throw) would silently drop the candidate with every offline
// test green. This pins the seam END-TO-END: the ranked path must actually produce the regcopy
// candidates, and the ranked best must still match byte-exact. agbcc-native (no Docker).
//
// WHY THE VEHICLE IS `recip` AND NOT `modpow2`: this test used to run on `a % 8`, where the
// regcopy spelling was what matched. Commit 4a85b70 ("Recover branching signed /2^k division")
// taught divpow2 to fold the branching signed-division diamond, so `modpow2` now lifts straight
// to `a0 - (a0 / 8 << 3)` and matches at score 0 by itself — R1 has no diamond left to re-spell,
// so no regcopy candidate is emitted for it at all. That is an improvement, not a regression, but
// it cost this file its subject. `recip` fires the lever through R2 (const-expression staging)
// instead, which keeps the seam covered.
//
// IT ALSO PINS THE LABEL, which nothing else does. `/regcopy-ret-fresh` wins exactly one corpus
// row (`synthetic:ringread:ido7.1`), so a census over it is thin enough that a rename is easy to
// miss — and with the labels unpinned, deleting the string from rank.ts's table is a SILENT
// RENAME to `/regcopy-2`, a 0-flip change `bench regression` green-lights. The names are the
// instrument (`candidateLabel` is a `bench diff` field), so they are asserted here as names, and
// the tail-kind correspondence with them.
//
// SCOPE, stated so it is not mistaken for more than it is: this pins that the candidates are
// ENUMERATED and that ranking still lands on a byte-exact spelling. It does NOT pin a shape where
// the regcopy spelling is the one that WINS — the measured winners are real ROM functions
// (kleod MultiplyQ8/Q4, ReciprocalQ8/Q4, pokeemerald MathUtil_Mul16, see l3/regspell.ts), whose
// register pressure has no synthetic reproduction here. The benchmark is what covers the win.
import { enumerateCandidates, rankBy } from '@asmlift/core/rank';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

test('the register-copy candidates are enumerated and ranked through the ranked path', () => {
  const c = 'int recip(int a){ return 0x10000 / a; }';
  const asm = compileTargetAsm(c);
  const obj = assembleTarget(asm);
  const cands = enumerateCandidates('recip', asm, ARMV4T_AGBCC, {});
  // The lever fired, and the tail reached the candidate set under the name of the tail it IS.
  //
  // `recip` fires through R2 alone — no diamond, so R1 never runs and there is no dead value var
  // for the tail to reuse. The only tail that exists here is the FRESH one. Label rank.ts's table
  // by list POSITION and the fresh spelling lands at index 1 and wears the reuse name — and this
  // file is the only place the label is pinned at all, so it would pin the mislabel. Asserting the
  // ABSENCE of the reuse name is the load-bearing half: without it, positional labelling passes.
  expect(cands.some((x) => x.label.endsWith('/regcopy'))).toBe(true);
  expect(cands.some((x) => x.label.endsWith('/regcopy-ret-fresh'))).toBe(true);
  expect(cands.filter((x) => x.label.endsWith('/regcopy-ret'))).toEqual([]);
  // every regcopy candidate is emittable C, not a shape that throws downstream of the seam
  const r = rankBy(cands, 'recip', (src) => scoreC(src, 'recip', obj));
  expect(r.best.score.match).toBe(true);
});
