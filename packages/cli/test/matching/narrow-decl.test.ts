// The `/narrow-decl` and `/narrow-read` variations (core l3/narrowdecl.ts) against the REAL agbcc
// toolchain, in both directions. `u8 v; v = x - 1;` and `s32 v; v = (u8)(x - 1);` compute the same value and compile to
// two different objects, and so do `u8 v; v = f(); … v` and `s32 v; v = f(); … (u8)v`, so neither
// spelling may replace the other: each source must be recovered byte-exact, by the candidate whose
// declaration it used.
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

// pokeemerald:RtcGetDayCount's shape: three call results passed on as bytes
const CALL_DECLS = 'u32 cv(u8); u16 dc(u8, u8, u8);\n';

const rankedReads = (body: string) => {
  const c = `${CALL_DECLS}u16 rd(u8 *p) { ${body} }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return decompileRanked('rd', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: {
      rd: { params: ['u8 *'], returns: 'u16' },
      cv: { params: ['u8'], returns: 'u32' },
      dc: { params: ['u8', 'u8', 'u8'], returns: 'u16' },
    },
    compile: (source) => compileCandAgbcc(CALL_DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

describe('/narrow-read, real agbcc, both directions', () => {
  it('recovers byte locals holding call results through the variation', () => {
    const r = rankedReads('u8 y = cv(p[0]); u8 m = cv(p[1]); u8 d = cv(p[2]); return dc(y, m, d);');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-read')).toBe(true);
    expect(r.winner.source).toMatch(/\bu8 v0;/);
  });

  it('keeps s32 locals narrowed where they are read, which the variation would lose', () => {
    const r = rankedReads('s32 y = cv(p[0]); s32 m = cv(p[1]); return dc((u8)y, (u8)m, (u8)cv(p[2]));');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-read')).toBe(false);
    expect(r.winner.source).toMatch(/\bs32 v0;/);
  });
});

// A local narrowed at its write and locals narrowed at their reads, in one function: either kind
// must be declared narrow without the other
const BOTH_DECLS = DECLS + CALL_DECLS;

const rankedBoth = (body: string) => {
  const c = `${BOTH_DECLS}u16 both(u8 *p) { ${body} }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return decompileRanked('both', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: {
      both: { params: ['u8 *'], returns: 'u16' },
      rnd: { params: [] },
      cv: { params: ['u8'], returns: 'u32' },
      dc: { params: ['u8', 'u8', 'u8'], returns: 'u16' },
    },
    compile: (source) => compileCandAgbcc(BOTH_DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

const BOTH_WRITE = 'v = gA.c - 1; gB.d = (1 & v) + rnd() % (5 - v) + 1;';

describe('/narrow-decl and /narrow-read in one function, real agbcc', () => {
  it('narrows the written local alone', () => {
    const r = rankedBoth(
      `u8 v; s32 y; s32 m; ${BOTH_WRITE} y = cv(p[0]); m = cv(p[1]); return dc((u8)y, (u8)m, (u8)cv(p[2]));`,
    );
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-read')).toBe(false);
    expect(r.winner.source).toMatch(/\bu8 v0;/);
  });

  it('narrows the read locals alone', () => {
    const r = rankedBoth(
      `s32 v; u8 y; u8 m; ${BOTH_WRITE.replace('gA.c - 1', '(u8)(gA.c - 1)')} y = cv(p[0]); m = cv(p[1]); return dc(y, m, (u8)cv(p[2]));`,
    );
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(false);
    expect(r.winner.source).toMatch(/\bs32 v0;/);
  });
});
