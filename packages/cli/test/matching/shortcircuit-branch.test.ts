// Control-flow short-circuit orientation. `if (a && b) X else Y` and `if (!a || !b) Y else X` are
// the same branch graph, so the fold in raise/shortcircuit.ts can only emit whichever orientation
// the asm's branch senses spell — and only ONE of the two is the bytes agbcc produced.
//
// This is the executable half of what synthetic:ifand_near:agbcc publishes. Both orientations are
// enumerated — `/flip-branch` where the arms diverge, `/flip-join` where they reconverge — so the
// differ referees the orientation instead of the fold committing to one.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

const ARM = 'p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4;';
const src = (op: string) =>
  `int f(int a, int b, int *p, int *q){ if (a ${op} b) { ${ARM} } else { p[0] = -1; } return p[1]; }`;

const ranked = (c: string) => {
  const asm = compileTargetAsm(c);
  return { rk: decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm)), target: assembleTarget(asm) };
};

describe('the emitted orientation decides the match, and only one orientation is reachable', () => {
  test('a reconverging `&&` reaches the source orientation at the default sense and matches', () => {
    const { rk, target } = ranked(src('&&'));
    // the `&&`'s tests all branch to the ELSE arm, so the fall-through IS the then-arm and the
    // default joined sense spells the source's own orientation — which is the bytes
    expect(rk.best.source).toContain('&&');
    expect(rk.best.score.match).toBe(true);
    // the dual spelling is byte-identical evidence of the same fact, stated directly
    const dual = `int f(int a, int b, int *p, int *q){ if (a != 0 && b != 0) { ${ARM} } else { p[0] = -1; } return p[1]; }`;
    expect(scoreC(dual, 'f', target).match).toBe(true);
  });

  test('the same shape written `||` matches, so the fold itself is not the defect', () => {
    // The control that keeps the claim honest, and the axis's own reason to exist: an `||`'s first
    // test branches INTO the then-arm, so the fall-through reading is inverted here and the source
    // orientation is /flip-join's.
    const { rk } = ranked(src('||'));
    expect(rk.best.source).toContain('||');
    expect(rk.best.score.match).toBe(true);
  });

  test('a far arm recovers the source `&&` through its long-branch trampolines', () => {
    // Past Thumb's ±256-byte reach agbcc inverts the branch and emits `bne ^g / b shared`, so the
    // shared block arrives behind a forwarding block on EACH edge. The fold looks through them, and
    // this orientation lands on the source's own spelling rather than the dual.
    //
    // The bytes cannot police this on their own: the un-folded spelling tail-duplicates the else
    // arm, and agbcc cross-jumps the copies back together, so the row scored 0 either way. What is
    // asserted is the `&&`.
    const far = Array.from({ length: 32 }, (_, i) => `p[${i}] = ${i * 2 + 1}; q[${i}] = ${i * 2 + 2};`).join(' ');
    const c = `int f(int a, int b, int *p, int *q){ if (a && b) { ${far} } else { p[0] = -1; } return p[1]; }`;
    const { rk } = ranked(c);
    expect(rk.best.source).toContain('&&');
    expect(rk.best.source).not.toContain('||');
    expect(rk.best.score.match).toBe(true);
    // and the else arm is emitted ONCE — the tail duplication the fold exists to remove
    expect(rk.best.source.split('-1').length - 1).toBe(1);
  });

  test('each if class carries its own orientation axis: /flip-branch divergent, /flip-join joined', () => {
    // Asserted on the CANDIDATE LIST, not on the winner: the default sense already spells `&&`
    // for the divergent shape, so a winner assertion would pass with the axis deleted.
    const divergent = compileTargetAsm(
      `int f(int a, int b, int *p, int *q){ if (a && b) { ${ARM} return 2; } return 3; }`,
    );
    const dv = decompileRanked('f', divergent, ARMV4T_AGBCC, assembleTarget(divergent));
    expect(dv.candidates.some((c) => c.label.includes('flip-branch'))).toBe(true);
    expect(dv.best.score.match).toBe(true);
    // the reconverging sibling, which differs only in that its arms rejoin, is /flip-join's:
    // its flipped spelling is a distinct candidate where the divergent axis never fires
    const reconverging = compileTargetAsm(src('&&'));
    const rc = decompileRanked('f', reconverging, ARMV4T_AGBCC, assembleTarget(reconverging));
    expect(rc.candidates.some((c) => c.label.includes('flip-branch'))).toBe(false);
    expect(rc.candidates.some((c) => c.label.includes('flip-join'))).toBe(true);
  });
});

// A three-clause chain needs the SECOND fold, and the second fold needs De Morgan: the pass is
// iterative, so ^g's condition is by then the connective the first fold built, and negating one is
// a distribution, not an opcode swap (raise/shortcircuit.ts `negateCondOps`). Without it the chain
// folds one level, the shared arm is tail-duplicated, and the row misses.
//
// This lives in the MATCHING suite deliberately: it is in no CI gate and in no `bench` command, so
// a regression here would otherwise ride main for weeks. Each score in a test name below is what the
// shape scores with `negateCondOps`' connective case ablated.
describe('a three-clause short-circuit chain folds flat', () => {
  const best = (c: string) => {
    const asm = compileTargetAsm(c);
    return decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm)).best;
  };

  test('`a || (b && c)` guarding two arms — 5 without the second fold, THEN arm duplicated', () => {
    const b = best(
      'int f(int a,int b,int c,int *p){ if (a > 0 || (b > 0 && c > 0)) { p[0]=1; } else { p[0]=2; } return p[1]; }',
    );
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('||');
    expect(b.source).toContain('&&');
    // ONE then-arm: the tail duplication the second fold removes. It is `*a3 = 1` that gets
    // duplicated, not the else arm — ablated, the winner nests `if (a0 > 0) v0 = 1; else { … v0 = 2;
    // … v0 = 1; }`, so `= 2` reads 1 either way and would gate nothing.
    expect(b.source.split('= 1').length - 1).toBe(1);
  });

  test('`a || (b && c)` over an accumulator — 7 without the second fold', () => {
    const b = best('int f(int a,int b,int c){ int r = 0; if (a > 0 || (b > 0 && c > 0)) r = 1; return r; }');
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('a0 > 0 || a1 > 0 && a2 > 0');
  });

  test('the `llcmp` shape — a 64-bit `<`, mixed compare signedness, 11 without the second fold', () => {
    // synthetic:llcmp:agbcc's own body. The unsigned half is spelled as a per-SITE cast by the
    // existing `/uns-cmp` axis, NOT as a parameter type: the winner is `signed/defsite/uns-cmp` with
    // four `s32` params, so the fan reaches the bytes with no per-parameter signedness candidate.
    const b = best(
      'int f(unsigned a,int b,unsigned c,int d){ int r=0; if (d > b || (d == b && c > a)) r=1; return r; }',
    );
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('(u32)');
  });

  test('the CONTROL: `a && (b || c)`, whose orientation never asks for the negation, still matches', () => {
    // Ablated it matches too, so it pins that the connective case takes nothing away.
    const b = best(
      'int f(int a,int b,int c,int *p){ if (a > 0 && (b > 0 || c > 0)) { p[0]=1; } else { p[0]=2; } return p[1]; }',
    );
    expect(b.score.match).toBe(true);
  });
});

// The one LOUD→SILENT conversion this fold makes, pinned. Folding a loop-EXIT connective removes
// the back-edge loop recovery was refusing, so a function that DECLINED now decompiles — the one
// effect of the connective negation with no differ to referee it, since the two real functions it
// flips (`sub_80930B8`, `sub_80932E0`) are not benchmark rows.
//
// Ablated, this very shape throws `StructureError: cannot structure 'f': unrecovered back-edge into
// block #2`, so the test below cannot even reach an assertion there. It is not a match (best 24) and
// deliberately asserts no score: what it gates is that the fold SURVIVES into the loop condition,
// not the bytes it scores.
//
// Equivalence is executed, not argued: the decompilation and the original C, both built with the
// host `cc` and run over a 512-point grid of `p`/`q` contents and `n` (including `n < 0` and
// `n` past the array), print identical output.
describe('a loop-exit connective folds, and the loop it un-declines stays recovered', () => {
  test('`while (i < n && (p[i] || q[i]))` keeps ONE loop with the connective in its condition', () => {
    const c =
      'int f(int*p,int*q,int n,int*o){ int i=0; while (i<n && (p[i]!=0 || q[i]!=0)) i++; o[0]=i; o[2]=q[1]; return i; }';
    const asm = compileTargetAsm(c);
    const best = decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm)).best;
    expect(best.source).toMatch(/while \(v0 < a2 && \(a0\[v0\] != 0 \|\| a1\[v0\] != 0\)\)/);
    expect(best.source.split('do {').length - 1).toBe(1); // no tail-duplicated loop
    expect(best.source).not.toContain('ASMLIFT_ERROR');
  });
});
