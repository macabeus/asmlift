// `||`-guarded-return short-circuit recovery as a differ-ranked candidate axis (rank.ts), NOT a
// global structurer heuristic. A divergent `if` can be spelled with either branch sense; which one
// the source compiler emitted is genuinely ambiguous from asm, and there is no safe global rule
// (`ifor` wants positive, `simpleif` wants negated, `diamond` wants positive). So `decompileRanked`
// emits BOTH senses as candidates and the objdiff score referees, exactly as it does for param
// signedness. The single-shot `decompile` default is deliberately untouched; the win shows up in
// the ranked path the report/benchmark use.
//
// Also pins rank.ts↔pipeline.ts SYNC: the ranked path must apply the same passes as `decompile`
// (default idiom patterns, const-fold, soft-div, return-sinking), or candidates silently
// under-score.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

const ranked = (sym: string, src: string) => {
  const asm = compileTargetAsm(src);
  return decompileRanked(sym, asm, ARMV4T_AGBCC, assembleTarget(asm));
};

describe('branch-sense candidate: || short-circuit return matches via the flipped sense', () => {
  test('if (a || b) return X — the flip-branch candidate wins byte-exact', () => {
    const r = ranked('ifor', 'int ifor(int a, int b){ if (a || b) return 42; return 7; }');
    expect(r.best.score.match).toBe(true);
    expect(r.best.label).toContain('flip-branch'); // the non-default sense is what matched
    // the default sense is still in the set (never dropped) and does NOT match here
    expect(r.candidates.some((c) => !c.label.includes('flip-branch'))).toBe(true);
  });

  test('if (a && b) return X still matches on the DEFAULT sense (flip not needed)', () => {
    const r = ranked('ifand', 'int ifand(int a, int b){ if (a && b) return 42; return 7; }');
    expect(r.best.score.match).toBe(true);
    expect(r.best.label).not.toContain('flip-branch');
  });
});

describe('rank.ts is in sync with the pipeline (no candidate under-scoring)', () => {
  // half needs the default sdiv idiom pattern; clamp0 needs the simple-select form preserved. Both must
  // match through decompileRanked, proving the ranked path applies the same passes as decompile.
  test('half (needs default idiom patterns) matches', () => {
    expect(ranked('half', 'int half(int x){ return x / 2; }').best.score.match).toBe(true);
  });
  test('clamp0 (simple select) matches', () => {
    expect(ranked('clamp0', 'int clamp0(int a){ if (a < 0) return 0; return a; }').best.score.match).toBe(true);
  });
});
