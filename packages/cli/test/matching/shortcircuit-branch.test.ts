// Control-flow short-circuit orientation. `if (a && b) X else Y` and `if (!a || !b) Y else X` are
// the same branch graph, so the fold in raise/shortcircuit.ts can only emit whichever orientation
// the asm's branch senses spell — and only ONE of the two is the bytes agbcc produced.
//
// This is the executable half of what synthetic:ifand_near:agbcc publishes. That row nonmatches,
// and `bench regression` fails only on a LOST match, so the direction is pinned here: the un-folded
// dual byte-matches, the emitted orientation does not, and the gap is exactly the orientation.
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
  test('a reconverging `&&` is spelled as its dual and misses', () => {
    const { rk, target } = ranked(src('&&'));
    // the fold fired: the arms came out exchanged and the condition negated
    expect(rk.best.source).toContain('||');
    expect(rk.best.score.match).toBe(false);
    // and the dual — what the branch-sense lever would produce if it reached reconverging ifs — IS
    // the bytes. So the whole diff is the orientation, not anything about the arms.
    const dual = `int f(int a, int b, int *p, int *q){ if (a != 0 && b != 0) { ${ARM} } else { p[0] = -1; } return p[1]; }`;
    expect(scoreC(dual, 'f', target).match).toBe(true);
  });

  test('the same shape written `||` matches, so the fold itself is not the defect', () => {
    // The control that keeps the claim honest: the fold emits the source's own orientation here.
    const { rk } = ranked(src('||'));
    expect(rk.best.source).toContain('||');
    expect(rk.best.score.match).toBe(true);
  });

  test('divergent arms already reach both orientations', () => {
    // `preserveDivergentBranchSense` is the lever, and it fires only when the arms do not
    // reconverge — so this `&&`, unlike the one above, gets its dual enumerated and wins.
    const asm = compileTargetAsm(
      `int f(int a, int b, int *p){ if (a && b) { ${ARM.replace(/q/g, 'p')} return 2; } return 3; }`,
    );
    const rk = decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm));
    expect(rk.best.source).toContain('&&');
    expect(rk.best.score.match).toBe(true);
  });
});
