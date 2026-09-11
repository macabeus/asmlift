// A NARROWING EXTENSION FUSED WITH ITS SCALE (core raise/extscale.ts), end-to-end through
// decompile() and the REAL agbcc toolchain, byte-exact (objdiff 0).
//
// agbcc merges the right half of a cast's shift pair into a following left shift, so `a * 4` over a
// `u8 a` is `lsl #24` in the prologue and `lsr #22` at the use. The unfolded pair recompiles as
// written — `a0 << 24 >> 22` over a wide parameter — and that is the point of the first two cases:
// the declaration is what moves the `lsl`, so recovering it is the byte fix, and a body cast that
// did NOT move it must keep the wide parameter. The signed case is the control where the machine
// carries no such evidence: agbcc lowers `s16 a; a * 2` with both halves at the use, exactly like
// `(s16)a * 2`, so the wide recovery reproduces it. The last case is a body cast behind nothing but
// a pool load, which paramwidth's scan cannot tell from a prologue: the fold records the pair as
// behind the pool load, paramwidth's `fused-behind-pool` keeps the parameter wide, and with nothing
// claiming the scale it prints as lifted (`raw`) — as do the wide and signed cases.
//
// Toolchain-gated like the other agbcc tests (compileTargetAsm/scoreC use real agbcc).
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileCandAgbcc, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

const DECLS = 'extern u32 gA; extern u32 gB; extern u32 gC; extern u32 gT;\n';

const CASES: { name: string; c: string; signature: RegExp; raw: boolean }[] = [
  // a DECLARED narrow parameter scaled: the prologue `lsl` is its extension, and the second
  // parameter's extension behind it is recovered too
  {
    name: 'xsnarrow',
    c: 'void xsnarrow(u8 a, u8 b) { gA |= 4; gB = (u32)&gT + a * 4; gC = b; }',
    signature: /^void xsnarrow\(u8 a0, u8 a1\)/m,
    raw: false,
  },
  // the same scale over a CAST in the body: both halves at the use, the parameter stays wide
  {
    name: 'xswide',
    c: 'void xswide(u32 a, u8 b) { gA |= 4; gB = (u32)&gT + (u8)a * 4; gC = b; }',
    signature: /^void xswide\([su]32 a0, u8 a1\)/m,
    raw: true,
  },
  // the signed form: `lsl #16; asr #15`, and no placement evidence either way
  {
    name: 'xssigned',
    c: 'void xssigned(s16 a, u8 b) { gA |= 4; gB = (u32)&gT + a * 2; gC = b; }',
    signature: /^void xssigned\([su]32 a0, u8 a1\)/m,
    raw: true,
  },
  // a body cast with only a pool load ahead of its pair — `ldr r2,=gB; lsl r0,#24; lsr r0,#22`
  {
    name: 'xspool',
    c: 'void xspool(u32 a) { gB = (u32)&gT + (u8)a * 4; }',
    signature: /^void xspool\([su]32 a0\)/m,
    raw: true,
  },
];

describe('scaled-extension fold — real agbcc, byte-exact, through decompile()', () => {
  for (const { name, c, signature, raw } of CASES) {
    test(name, () => {
      const asm = compileTargetAsm(DECLS + c);
      const res = decompile(name, asm, ARMV4T_AGBCC, { prototypes: { [name]: { returnsVoid: true } } });
      expect(res.source).toMatch(signature);
      expect(/<< (24|16)\)? >>/.test(res.source)).toBe(raw);
      const s = scoreC(DECLS + res.source, name, assembleTarget(asm));
      if (!s.match) {
        throw new Error(`${name}: objdiff ${s.score}\n${res.source}`);
      }
      expect(s.match).toBe(true);
    });
  }
});

// The fold's sibling refusal and paramwidth's `fused-behind-pool`, each spelled back to its own
// bytes. A same-sign sibling in the block means the source wrote the shift itself (`t = a << 24`),
// so the fold leaves the pair as lifted; an opposite-sign sibling is a second cast and folds. A pair
// behind a pool load folds too — the SCALE is sound and the table takes it — while
// `fused-behind-pool` keeps the WIDTH wide: over a body cast, and over a declared `s16` whose `lsl`
// agbcc scheduled there.
const SIB_DECLS = 'extern u32 gB; extern u32 gW[];\n';

describe('the fold beside a sibling, and behind a pool load — real agbcc, byte-exact', () => {
  for (const { name, c, spelled, raw } of [
    {
      name: 'xsshared',
      c: 'u32 xsshared(u32 a, u32 *p) { u32 t = a << 24; p[t >> 22] = 1; return t >> 24; }',
      spelled: 'return (u8)a0;',
      raw: true,
    },
    {
      name: 'xsshared2',
      c: 'void xsshared2(u32 a, u32 *p, u16 *q) { u32 t = a << 24; p[t >> 22] = 1; q[t >> 23] = 2; }',
      spelled: 'void xsshared2(s32 a0',
      raw: true,
    },
    {
      name: 'xsopposite',
      c: 'void xsopposite(u32 a, u32 *p) { p[(u8)a] = (s8)a; }',
      spelled: '[(u8)a0] = (s8)a0',
      raw: false,
    },
    { name: 'xspooltbl', c: 'void xspooltbl(u32 a) { gB = gW[(u8)a]; }', spelled: 'gW[(u8)a0]', raw: false },
    { name: 'xspoolsgn', c: 'u32 xspoolsgn(s16 i) { return gW[i]; }', spelled: 'gW[(s16)a0]', raw: false },
  ]) {
    test(name, () => {
      const asm = compileTargetAsm(SIB_DECLS + c);
      const res = decompile(name, asm, ARMV4T_AGBCC, { prototypes: { [name]: { returnsVoid: c.startsWith('void') } } });
      expect(res.source).toContain(spelled);
      expect(/<< (24|16)\)? >>/.test(res.source)).toBe(raw);
      const s = scoreC(SIB_DECLS + res.source, name, assembleTarget(asm));
      if (!s.match) {
        throw new Error(`${name}: objdiff ${s.score}\n${res.source}`);
      }
      expect(s.match).toBe(true);
    });
  }
});

// The same fused pair as an ARRAY SUBSCRIPT (core raise/globalshape.ts reads it as a scaling). A
// `u16` table read by a `u8 i` is `lsl #24` / `lsr #23`, and the pool load lands before the right
// half for `gTbl[i]` and after it for `((u16 *)gTbl)[i]` — two objects, told apart by the order
// licence, each spelled back to its own bytes.
const TBL = 'extern u16 gTbl[];\n';

describe('the fused scale orders an array subscript — real agbcc, byte-exact', () => {
  for (const { name, c, spelled } of [
    { name: 'xsarr', c: 'u32 xsarr(u8 i) { return gTbl[i]; }', spelled: 'gTbl[a0]' },
    { name: 'xscast', c: 'u32 xscast(u8 i) { return ((u16 *)gTbl)[i]; }', spelled: '((u16 *)&gTbl)[a0]' },
  ]) {
    test(name, () => {
      const asm = compileTargetAsm(TBL + c);
      const res = decompile(name, asm, ARMV4T_AGBCC, {});
      expect(res.source).toContain(spelled);
      const s = scoreC(TBL + res.source, name, assembleTarget(asm));
      if (!s.match) {
        throw new Error(`${name}: objdiff ${s.score}\n${res.source}`);
      }
      expect(s.match).toBe(true);
    });
  }

  test('a struct table behind a narrow index gets its home from the licence (`/orderbase`)', () => {
    // kleod's `GetEntityLookupData`, renamed: both bases in pointer locals, the table's element
    // read 5 and 6 bytes in. The single-shot default leaves the element's cast base inline, which
    // costs the `ldr` its slot ahead of the `lsr`; the home is a ranked candidate, offered only
    // where the licence reads the fused pair's order.
    const decls = 'extern u8 gFlags[]; extern const u8 gTable[];\n';
    const asm = compileTargetAsm(
      `${decls}void entrylookup(u8 idx) { u8 *flags = gFlags; const u8 *t = gTable; ` +
        'const u8 *e = &t[(u32)idx * 8]; flags[0x11] = e[5]; flags[0x12] = e[6]; }',
    );
    const r = decompileRanked('entrylookup', asm, ARMV4T_AGBCC, assembleTarget(asm), {
      prototypes: { entrylookup: { returnsVoid: true } },
      compile: (source) => compileCandAgbcc(decls + source),
    });
    expect(r.best.score.match).toBe(true);
    expect(r.best.label).toContain('/orderbase');
  });
});
