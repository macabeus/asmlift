// The `/narrow-decl` and `/narrow-read` variations (core l3/narrowdecl.ts) against the REAL agbcc
// toolchain, in both directions. `u8 v; v = x - 1;` and `s32 v; v = (u8)(x - 1);` compute the same
// value and compile to two different objects, and so do `u8 v; v = f(); … v` and `s32 v; v = f();
// … (u8)v`, so neither spelling may replace the other: each source must be recovered byte-exact, by
// the candidate whose declaration it used.
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

const ranked = async (decl: string, write: string) => {
  const c = `${DECLS}void nd(void) { ${decl} v; v = ${write}; gB.d = (1 & v) + rnd() % (5 - v) + 1; }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return await decompileRanked('nd', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: { nd: { returnsVoid: true }, rnd: { params: [] } },
    compile: async (source) => compileCandAgbcc(DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

describe('/narrow-decl, real agbcc, both directions', () => {
  it('recovers a narrow declaration through the variation', async () => {
    const r = await ranked('u8', 'gA.c - 1');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(true);
    expect(r.winner.source).toMatch(/\bu8 v0;/);
  });

  it('keeps the s32 local assigned a cast, which the variation would lose', async () => {
    const r = await ranked('s32', '(u8)(gA.c - 1)');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(false);
    expect(r.winner.source).toMatch(/\bs32 v0;/);
  });
});

// pokeemerald:LoadMonInfo's shape: two byte reads held across two calls. Under `u8` agbcc loads each
// as its local is written; under `s32` it moves the loads down to the first call.
const LOAD_DECLS = 'void f7(u8 *, u8 *, u8, u8, s32, u8, u8);\n';

const rankedLoads = async (decl: string) => {
  const c =
    `${LOAD_DECLS}void ld(u8 *p, s32 x) { ${decl} a; ${decl} b; a = p[100]; b = p[101]; ` +
    'f7(p + 4, p + 8, a, b, x, 1, 2); f7(p + 8, p + 12, a, b, x, 3, 4); }';
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return await decompileRanked('ld', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: {
      ld: { params: ['u8 *', 's32'], returnsVoid: true },
      f7: { params: ['u8 *', 'u8 *', 'u8', 'u8', 's32', 'u8', 'u8'], returnsVoid: true },
    },
    compile: async (source) => compileCandAgbcc(LOAD_DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

describe('/narrow-decl of a local written by a byte read, real agbcc, both directions', () => {
  it('recovers byte locals holding byte reads through the variation', async () => {
    const r = await rankedLoads('u8');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(true);
    expect(r.winner.source).toMatch(/\bu8 v0;/);
  });

  it('keeps s32 locals holding byte reads, which the variation would lose', async () => {
    const r = await rankedLoads('s32');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(false);
    expect(r.winner.source).toMatch(/\bs32 v0;/);
  });
});

// pokeemerald:RtcGetDayCount's shape: three call results passed on as bytes
const CALL_DECLS = 'u32 cv(u8); u16 dc(u8, u8, u8);\n';

const rankedReads = async (body: string) => {
  const c = `${CALL_DECLS}u16 rd(u8 *p) { ${body} }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return await decompileRanked('rd', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: {
      rd: { params: ['u8 *'], returns: 'u16' },
      cv: { params: ['u8'], returns: 'u32' },
      dc: { params: ['u8', 'u8', 'u8'], returns: 'u16' },
    },
    compile: async (source) => compileCandAgbcc(CALL_DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

describe('/narrow-read, real agbcc, both directions', () => {
  it('recovers byte locals holding call results through the variation', async () => {
    const r = await rankedReads('u8 y = cv(p[0]); u8 m = cv(p[1]); u8 d = cv(p[2]); return dc(y, m, d);');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-read')).toBe(true);
    expect(r.winner.source).toMatch(/\bu8 v0;/);
  });

  it('keeps s32 locals narrowed where they are read, which the variation would lose', async () => {
    const r = await rankedReads('s32 y = cv(p[0]); s32 m = cv(p[1]); return dc((u8)y, (u8)m, (u8)cv(p[2]));');
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-read')).toBe(false);
    expect(r.winner.source).toMatch(/\bs32 v0;/);
  });
});

// A local narrowed at its write and locals narrowed at their reads, in one function: either kind
// must be declared narrow without the other
const BOTH_DECLS = DECLS + CALL_DECLS;

const rankedBoth = async (body: string) => {
  const c = `${BOTH_DECLS}u16 both(u8 *p) { ${body} }`;
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return await decompileRanked('both', asm, ARMV4T_AGBCC, assembleTarget(asm), {
    prototypes: {
      both: { params: ['u8 *'], returns: 'u16' },
      rnd: { params: [] },
      cv: { params: ['u8'], returns: 'u32' },
      dc: { params: ['u8', 'u8', 'u8'], returns: 'u16' },
    },
    compile: async (source) => compileCandAgbcc(BOTH_DECLS + source, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
  });
};

const BOTH_WRITE = 'v = gA.c - 1; gB.d = (1 & v) + rnd() % (5 - v) + 1;';

describe('/narrow-decl and /narrow-read in one function, real agbcc', () => {
  it('narrows the written local alone', async () => {
    const r = await rankedBoth(
      `u8 v; s32 y; s32 m; ${BOTH_WRITE} y = cv(p[0]); m = cv(p[1]); return dc((u8)y, (u8)m, (u8)cv(p[2]));`,
    );
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-read')).toBe(false);
    expect(r.winner.source).toMatch(/\bu8 v0;/);
  });

  it('narrows the read locals alone', async () => {
    const r = await rankedBoth(
      `s32 v; u8 y; u8 m; ${BOTH_WRITE.replace('gA.c - 1', '(u8)(gA.c - 1)')} y = cv(p[0]); m = cv(p[1]); return dc(y, m, (u8)cv(p[2]));`,
    );
    expect(r.winner.score.match).toBe(true);
    expect(hasVariation(r.winner.variations, 'narrow-decl')).toBe(false);
    expect(r.winner.source).toMatch(/\bs32 v0;/);
  });
});
