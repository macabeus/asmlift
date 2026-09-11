// F-CFG return-sinking. A value-returning `&&`-guarded short-circuit
// (`if (a && b) return X; return Y;`) converges its arms on a return-only merge block; lowered as a
// merge VARIABLE (`v0 = X … return v0`) it recompiles differently from the source
// and MISSES. `raise/retsink.ts` tail-duplicates the return-only merge into its unconditional-branch
// predecessors — in the short-circuit shape (a shared arm, ≥2 preds) and in ONE single-condition
// shape — so early returns are emitted, which recompile to the compiler's shared-return diamond and
// MATCH.
//
// WHICH single-condition selects keep the merge variable is the whole content of `SELECT_GATES`, and
// it is a COMPILER fact, so every case below is compiled and byte-scored rather than asserted over
// hand-written IR. Two populations, and the file holds both:
//
//   - COMPUTED arms (`clamp0`, `sel`, `lor`) and BODIED arms (`selbody` and friends) keep the merge
//     variable, because that is what byte-matches for them. Sinking would regress them.
//   - BARE CONSTANT arms (`if (x & 0x40) return 1; return 0;`) cannot be spelled by a merge variable
//     at all: agbcc hoists the constant above the compare and erases the diamond the target keeps.
//     Those are sunk, and their match is won through the RANKED path, on `/flip-branch` — a sunk
//     diamond has no join left, so the shipped joined-if default reads its sense inverted.
//
// All scored byte-exact on agbcc.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

const match = (sym: string, src: string) => {
  const asm = compileTargetAsm(src);
  const r = decompile(sym, asm, ARMV4T_AGBCC);
  return { src: r.source, sc: scoreC(r.source, sym, assembleTarget(asm)) };
};

describe('F-CFG return-sinking: && short-circuit returns match byte-exact', () => {
  test('if (a && b) return X; return Y — early returns, no merge var', () => {
    const { src, sc } = match('ifand', 'int ifand(int a, int b){ if (a && b) return 42; return 7; }');
    expect(sc.match).toBe(true);
    expect(src).not.toContain('v0'); // sunk to returns, not a merge variable — the point of the pass
    // Two returns, not three: `branch-shortcircuit` (raise/shortcircuit.ts) fuses the chain into one
    // `a0 != 0 && a1 != 0` head BEFORE this pass runs, so the arms are `return 42` / `return 7` rather
    // than the pre-fusion `if (!a) return 7; if (!b) return 7; return 42`. Both spellings recompile to
    // the compiler's shared-return diamond; this one is also the more faithful source.
    expect((src.match(/return/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('&&'); // the fused connective, not a re-expanded chain
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

  // `return a || b` — the VALUE form. It reaches this pass as a `cond_br` on a `logic_or` too (the
  // value fold in shortcircuit.ts declines it: its const-1 arm has two predecessors), so the
  // connective alone would sink it. It must NOT be: one edge runs from the head straight into the
  // merge, the merge variable is what byte-matches, and a first cut of the fused-shape gate cost
  // this exact row its match on the benchmark (synthetic:lor:agbcc).
  //
  // Scored through the RANKED path, because that is where this row's match lives: single-shot
  // `decompile` emits the if/else merge variable and scores 4 — it is the `/defsite` candidate
  // (`v0 = 0; if (…) v0 = 1;`) that is byte-exact, both before this gate existed and after.
  test('lor (return a || b) keeps its match — a value-merge, not a two-armed diamond', () => {
    const asm = compileTargetAsm('int lor(int a, int b){ return a || b; }');
    const r = decompileRanked('lor', asm, ARMV4T_AGBCC, assembleTarget(asm));
    expect(r.best.score.match).toBe(true);
    expect(r.best.source).toContain('v0'); // still the merge variable, not sunk to returns
  });
});

describe('F-CFG return-sinking: a BARE constant-arm diamond IS sunk', () => {
  // The capability `kleod:IsSelectButtonPressed:agbcc` bought, measured on shapes the corpus does
  // not hold. Each of these scores 3 unranked and matches only through the fan, because the winning
  // candidate is `/flip-branch` in all four — a sunk diamond has no join for the joined-if default
  // to read, and for a constant-arm diamond agbcc puts the source's taken arm in the FAR block.
  // If a later round fixes the sense AT the sink, these become unranked matches and the `unranked`
  // expectation below is what will say so.
  test.each([
    ['selc1', 'int selc1(int x){ if (x & 0x40) return 1; return 0; }'],
    ['selc2', 'int selc2(int x){ if (x & 0x40) return 0; return 1; }'],
    ['selc3', 'int selc3(int x){ if (x > 3) return 5; return 3; }'],
    ['selc4', 'int selc4(int x){ if (x == 0) return 1; return 0; }'],
  ])('%s matches through the ranked fan and is sunk to early returns', (sym, src) => {
    const asm = compileTargetAsm(src);
    const obj = assembleTarget(asm);
    const unranked = decompile(sym, asm, ARMV4T_AGBCC);
    expect(unranked.source).not.toContain('v0'); // sunk: no merge variable
    expect(scoreC(unranked.source, sym, obj).match).toBe(false); // …but the wrong sense
    const r = decompileRanked(sym, asm, ARMV4T_AGBCC, obj);
    expect(r.best.score.match).toBe(true);
    expect(r.best.label).toContain('flip-branch');
  });
});

describe('F-CFG return-sinking gate: an arm that is NOT one SET is not sunk (`arms-are-one-set`)', () => {
  // THE REGRESSION THE FIRST CUT OF `SELECT_GATES` SHIPPED. The compiler fact behind the admission
  // is gcc 2.x's one-speculatable-SET arm hoist (`gcc/jump.c:471-502`), and one `*p = 1` makes the
  // arm two SETs, so the constant stays below the compare: the merge-variable spelling emits a
  // diamond too and byte-matches as it stands. Sinking then trades a match for the same shape in the
  // other ARM ORDER — recoverable only by `/flip-branch`, which this unranked path does not have.
  // Every row below scored 0/byte-exact before the one-set-arm admission existed, 5 or 6 with it and
  // no arm clause, and 0 again now. The predicate is `raise/narrowlocal.ts`'s shared `armIsOneSet`,
  // and `packages/core/test/corpus/agbcc-select-{merge,early}.s` is the compiled pair behind it.
  test.each([
    ['selbody', 'int selbody(int x, int *p){ int v; if (x) { *p = 1; v = 5; } else { *p = 2; v = 3; } return v; }'],
    ['selonearm', 'int selonearm(int x, int *p){ int v; if (x) { *p = 1; v = 5; } else { v = 3; } return v; }'],
    ['selcmp', 'int selcmp(int x, int *p){ int v; if (x == 3) { *p = 1; v = 5; } else { *p = 2; v = 3; } return v; }'],
    [
      'selbig2',
      'int selbig2(int x, int *p){ int v; if (x) { *p = 1; v = 0x12345678; } else { *p = 2; v = 0x7ABCDEF0; } return v; }',
    ],
    // A two-way `switch` with a `default` IS a diamond, and it reaches `SELECT_GATES` — the fall-in
    // machinery above never sees it, because its arms do not run on into one another.
    [
      'sw2',
      'int sw2(int x, int *p){ int r; switch (x) { case 1: *p = 1; r = 10; break; default: *p = 2; r = 20; } return r; }',
    ],
  ])('%s keeps its merge variable and its byte-exact match', (sym, src) => {
    const { sc } = match(sym, src);
    expect(sc.match).toBe(true);
  });
});
