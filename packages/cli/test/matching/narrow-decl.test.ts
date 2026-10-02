// The `/narrow-decl` variation (core l3/narrowdecl.ts) against the REAL agbcc toolchain, in both
// directions. `u8 v; v = x - 1;` and `s32 v; v = (u8)(x - 1);` compute the same value and compile to
// two different objects, so neither spelling may replace the other: each source must be recovered
// byte-exact, by the candidate whose declaration it used.
//
// Toolchain-gated like the other agbcc tests (compileTargetAsm/decompileRanked use real agbcc).
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { hasVariation } from '@asmlift/core/variation-tokens';
import { assembleTarget, compileCandAgbcc, compileTargetAsm } from '@asmlift/toolchains';
import { describe, expect, it } from 'vitest';

import { decompileRanked } from '../../src/rank';

const DECLS =
  'struct SA { u8 pad[12]; u8 c; }; struct SB { u8 pad[14]; u8 d; };\n' +
  'extern struct SA gA; extern struct SB gB; s32 rnd(void);\n';

const ranked = (decl: string, write: string) => {
  const c = `${DECLS}void nd(void) { ${decl} v; v = ${write}; gB.d = (1 & v) + rnd() % (5 - v) + 1; }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return decompileRanked('nd', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: { nd: { returnsVoid: true }, rnd: { params: [] } },
    compile: (source) => compileCandAgbcc(DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

describe('/narrow-decl, real agbcc, both directions', () => {
  it('recovers a narrow declaration through the variation', () => {
    const r = ranked('u8', 'gA.c - 1');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(true);
    expect(r.winner.source).toMatch(/\bu8 v0;/);
  });

  it('keeps the s32 local assigned a cast, which the variation would lose', () => {
    const r = ranked('s32', '(u8)(gA.c - 1)');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(false);
    expect(r.winner.source).toMatch(/\bs32 v0;/);
  });
});
