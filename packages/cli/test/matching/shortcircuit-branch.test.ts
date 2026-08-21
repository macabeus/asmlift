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
  test('a reconverging `&&` reaches the source orientation through /flip-join and matches', () => {
    const { rk, target } = ranked(src('&&'));
    // the fold alone emits the dual (`||` with exchanged arms); the /flip-join axis restores the
    // source's own orientation, and that one is the bytes
    expect(rk.best.source).toContain('&&');
    expect(rk.best.score.match).toBe(true);
    // the dual spelling is byte-identical evidence of the same fact, stated directly
    const dual = `int f(int a, int b, int *p, int *q){ if (a != 0 && b != 0) { ${ARM} } else { p[0] = -1; } return p[1]; }`;
    expect(scoreC(dual, 'f', target).match).toBe(true);
  });

  test('the same shape written `||` matches, so the fold itself is not the defect', () => {
    // The control that keeps the claim honest: the fold emits the source's own orientation here.
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
