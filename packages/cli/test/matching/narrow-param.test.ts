// The `/narrow-param` lift variation (core raise/paramwidth.ts, EVERY READER AN EXTENSION) against
// the REAL agbcc, in both directions. `s16 a` read as `a * 4` and `(u16)a`, and `s32 a` read as
// `(s16)a * 4` and `(u16)a`, compute the same values; agbcc widens the `s16` one at each use, so the
// prologue carries no declaration, and the two objects differ only in how a sibling `u8` parameter is
// copied. Each source must be recovered byte-exact by the candidate whose declaration it used.
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { hasVariation } from '@asmlift/core/variation-tokens';
import { assembleTarget, compileCandAgbcc, compileTargetAsm } from '@asmlift/toolchains';
import { describe, expect, it } from 'vitest';

import { decompileRanked } from '../../src/rank';

const DECLS = 'extern u8 *gM; void f3(u8 *, u16, u8); void f2(u8 *, u8);\n';

const ranked = async (decl: string, scaled: string) => {
  const c = `${DECLS}void np(${decl} a, u8 b) { u8 *p = gM; f3(p + ${scaled} * 4, (u16)a, b); f2(p + b * 8, b); }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return await decompileRanked('np', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: {
      f3: { params: ['u8 *', 'u16', 'u8'], returnsVoid: true },
      f2: { params: ['u8 *', 'u8'], returnsVoid: true },
    },
    compile: async (source) => compileCandAgbcc(DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

describe('/narrow-param, real agbcc, both directions', () => {
  it('recovers a parameter declared at the width every use extends it to through the variation', async () => {
    const r = await ranked('s16', 'a');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-param')).toBe(true);
    expect(r.winner.source).toContain('void np(s16 a0, u8 a1)');
  });

  it('keeps the s32 parameter cast at each use, which the variation would lose', async () => {
    const r = await ranked('s32', '(s16)a');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-param')).toBe(false);
    expect(r.winner.source).toContain('void np(s32 a0, u8 a1)');
  });
});

// `s16 a` read bare and `s32 a` cast at each read build ONE object here, so the asm decides nothing,
// and a narrow declaration costs every prototyped caller a truncation before its `bl`
const TIE_DECLS = 'extern u32 gOut[4]; extern s32 gS[4]; void use(u32);\n';

const rankedTie = async (decl: string, self?: string) => {
  const read = decl === 's16' ? 'a' : '(s16)a';
  const c =
    `${TIE_DECLS}void np(${decl} a) { gS[1] = ${read}; gOut[2] = (u32)${read} / 3u; ` +
    `gOut[3] = (u32)${read} % 7u; if ((u32)${read} > 5u) use(1); }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return await decompileRanked('np', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: {
      use: { params: ['u32'], returnsVoid: true },
      ...(self ? { np: { params: [self], returnsVoid: true } } : {}),
    },
    compile: async (source) => compileCandAgbcc(TIE_DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

describe('/narrow-param where both declarations build one object, real agbcc', () => {
  it('keeps the parameter wide when no prototype declares it', async () => {
    const r = await rankedTie('s32');
    expect(r.winner.score.match).toBe(true);
    expect(r.candidates.some((c) => hasVariation(c.variations, 'narrow-param') && c.score.match)).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-param')).toBe(false);
  });

  it("declares it at the prototype's width", async () => {
    const r = await rankedTie('s16', 's16');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-param')).toBe(true);
    expect(r.winner.source).toContain('void np(s16 a0)');
  });
});
