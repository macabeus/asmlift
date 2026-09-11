// A NARROWING EXTENSION FUSED WITH ITS SCALE (core raise/extscale.ts), end-to-end through
// decompile() and the REAL agbcc toolchain, byte-exact (objdiff 0).
//
// agbcc merges the right half of a cast's shift pair into a following left shift, so `a * 4` over a
// `u8 a` is `lsl #24` in the prologue and `lsr #22` at the use. The unfolded pair recompiles as
// written — `a0 << 24 >> 22` over a wide parameter — and that is the point of the first two cases:
// the declaration is what moves the `lsl`, so recovering it is the byte fix, and a body cast that
// did NOT move it must keep the wide parameter. The signed case is the control where the machine
// carries no such evidence: agbcc lowers `s16 a; a * 2` with both halves at the use, exactly like
// `(s16)a * 2`, so the wide recovery reproduces it.
//
// Toolchain-gated like the other agbcc tests (compileTargetAsm/scoreC use real agbcc).
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const DECLS = 'extern u32 gA; extern u32 gB; extern u32 gC; extern u32 gT;\n';

const CASES: { name: string; c: string; signature: RegExp }[] = [
  // a DECLARED narrow parameter scaled: the prologue `lsl` is its extension, and the second
  // parameter's extension behind it is recovered too
  {
    name: 'xsnarrow',
    c: 'void xsnarrow(u8 a, u8 b) { gA |= 4; gB = (u32)&gT + a * 4; gC = b; }',
    signature: /^void xsnarrow\(u8 a0, u8 a1\)/m,
  },
  // the same scale over a CAST in the body: both halves at the use, the parameter stays wide
  {
    name: 'xswide',
    c: 'void xswide(u32 a, u8 b) { gA |= 4; gB = (u32)&gT + (u8)a * 4; gC = b; }',
    signature: /^void xswide\([su]32 a0, u8 a1\)/m,
  },
  // the signed form: `lsl #16; asr #15`, and no placement evidence either way
  {
    name: 'xssigned',
    c: 'void xssigned(s16 a, u8 b) { gA |= 4; gB = (u32)&gT + a * 2; gC = b; }',
    signature: /^void xssigned\([su]32 a0, u8 a1\)/m,
  },
];

describe('scaled-extension fold — real agbcc, byte-exact, through decompile()', () => {
  for (const { name, c, signature } of CASES) {
    test(name, () => {
      const asm = compileTargetAsm(DECLS + c);
      const res = decompile(name, asm, ARMV4T_AGBCC, { prototypes: { [name]: { returnsVoid: true } } });
      expect(res.source).toMatch(signature);
      expect(res.source).not.toMatch(/<< (24|16)\)? >>/);
      const s = scoreC(DECLS + res.source, name, assembleTarget(asm));
      if (!s.match) {
        throw new Error(`${name}: objdiff ${s.score}\n${res.source}`);
      }
      expect(s.match).toBe(true);
    });
  }
});
