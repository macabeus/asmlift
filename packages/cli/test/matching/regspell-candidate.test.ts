// The register-copy lever's GATE (mirrors branch-sense-candidate.test.ts): the offline pins call
// registerishSpellings directly, so a wiring regression in rank.ts's respell seam (a contract
// change rejecting the SFn, an emit throw) would silently drop the candidate with every offline
// test green. This pins the END-TO-END win: the ranked path must produce the byte-exact regcopy
// candidate and it must WIN. agbcc-native (no Docker). The modpow2 shape is the synthetic
// benchmark row this lever flipped; the label pin catches a silently-dropped candidate.
import { enumerateCandidates, rankBy } from '@asmlift/core/rank';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

test('modpow2: the register-copy candidate exists and wins byte-exact through the ranked path', () => {
  const c = 'int modpow2(int a){ return a % 8; }';
  const asm = compileTargetAsm(c);
  const obj = assembleTarget(asm);
  const cands = enumerateCandidates('modpow2', asm, ARMV4T_AGBCC, {});
  expect(cands.some((x) => x.label.includes('regcopy'))).toBe(true); // the lever fired
  const r = rankBy(cands, 'modpow2', (src) => scoreC(src, 'modpow2', obj));
  expect(r.best.score.match).toBe(true);
  expect(r.best.label).toContain('regcopy'); // and it is the regcopy spelling that wins
});
