// F-CFG return-sinking. A value-returning `&&`-guarded short-circuit
// (`if (a && b) return X; return Y;`) converges its arms on a return-only merge block; lowered as a
// merge VARIABLE (`v0 = X … return v0`) it recompiles differently from the source
// and MISSES. `raise/retsink.ts` tail-duplicates the return-only merge into its unconditional-branch
// predecessors — but ONLY in the short-circuit shape (a shared arm, ≥2 preds) — so early returns are
// emitted, which recompile to the compiler's shared-return diamond and MATCH. Simple single-condition
// selects keep the merge variable (which is what matches for them) — the gate must not touch those.
//
// All scored byte-exact on agbcc.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const match = (sym: string, src: string) => {
  const asm = compileTargetAsm(src);
  const r = decompile(sym, asm, ARMV4T_AGBCC);
  return { src: r.source, sc: scoreC(r.source, sym, assembleTarget(asm)) };
};

describe('F-CFG return-sinking: && short-circuit returns match byte-exact', () => {
  test('if (a && b) return X; return Y — early returns, no merge var', () => {
    const { src, sc } = match('ifand', 'int ifand(int a, int b){ if (a && b) return 42; return 7; }');
    expect(sc.match).toBe(true);
    expect(src).not.toContain('v0'); // sunk to early returns, not a merge variable
    expect((src.match(/return/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('chained a && b && c returns match', () => {
    const { sc } = match('and3', 'int and3(int a, int b, int c){ if (a && b && c) return 42; return 7; }');
    expect(sc.match).toBe(true);
  });
});

describe('F-CFG return-sinking gate: simple value-selects are NOT sunk (kept as merge var)', () => {
  // A single-condition select must stay a merge variable — sinking it would REGRESS the match. The gate
  // (shared-arm / ≥2-pred requirement) leaves these untouched; assert they still match.
  test('clamp0 (if a<0 a=0; return a) keeps its match', () => {
    const { sc } = match('clamp0', 'int clamp0(int a){ if (a < 0) return 0; return a; }');
    expect(sc.match).toBe(true);
  });

  test('select (c ? x : y) keeps its match', () => {
    const { sc } = match('sel', 'int sel(int a, int x, int y){ return a ? x : y; }');
    expect(sc.match).toBe(true);
  });
});
