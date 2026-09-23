// A NEGATIVE LITERAL-POOL ADDEND (core frontend/thumb.ts POOL_WORD_SYMBOL), end-to-end through
// decompile() and the REAL agbcc toolchain, byte-exact (objdiff 0) — and, on the same objects, the
// proof that getting the sign wrong does NOT score the same.
//
// `&gTab[i - 1]` contains no subtract. agbcc folds the element bias into the literal pool, and
// under `-fhex-asm` its hex printer emits the `+` OPERATOR followed by a constant that spells its
// own sign: `.word gTab+-0x4`. `-fhex-asm` is in agbcc's canonical flags here and in every agbcc
// GBA decomp, so that is the ONLY spelling of this shape the corpus can contain; the second case
// below compiles the same source without the flag and pins the `gTab-4` spelling of the same
// address, so a reader that handled one and not the other is visible here rather than in a decline.
//
// WHY THIS SUITE AND NOT A UNIT TEST. Misreading a pool word yields a wrong ADDRESS, and a wrong
// address compiles and scores: the whole instruction text is identical and only the pool word's
// bytes move. The unit pins in packages/core/test/globals.test.ts assert the VALUE the assembler
// gives each spelling; what they cannot show is that the corpus can tell a right address from a
// wrong one. `the wrong sign is not byte-exact` does that on compiled objects, which is the only
// referee that counts for `synthetic:arrback:agbcc` being a gate rather than a row that passes
// whatever it is handed.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const DECLS = 'extern u32 gTab[];\n';
const C = 'u32 *arrback(u32 i){ return &gTab[i - 1]; }';
const CANONICAL = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
const NO_HEX = CANONICAL.filter((f) => f !== '-fhex-asm');

describe('a negative pool addend — real agbcc, byte-exact, through decompile()', () => {
  for (const { label, flags, word } of [
    { label: '`-fhex-asm` spells it `gTab+-0x4`', flags: CANONICAL, word: '.word\tgTab+-0x4' },
    { label: 'without `-fhex-asm` the same address is `gTab-4`', flags: NO_HEX, word: '.word\tgTab-4' },
  ]) {
    test(label, () => {
      const asm = compileTargetAsm(DECLS + C, flags);
      expect(asm).toContain(word); // the producer claim, checked against the compiler and not quoted
      const res = decompile('arrback', asm, ARMV4T_AGBCC);
      expect(res.source).toContain('+ -4');
      const s = scoreC(DECLS + res.source, 'arrback', assembleTarget(asm), flags);
      if (!s.match) {
        throw new Error(`objdiff ${s.score}\n${res.source}`);
      }
    });
  }

  test('the wrong sign is not byte-exact — the row can referee the address', () => {
    const target = assembleTarget(compileTargetAsm(DECLS + C, CANONICAL));
    const body = (addend: string) => `${DECLS}s32 arrback(s32 a0) { return (a0 << 2) + ((u32)&gTab + ${addend}); }`;
    // the sign the asm says, which is what the lift emits
    expect(scoreC(body('-4'), 'arrback', target, CANONICAL).match).toBe(true);
    // the two ways to get it wrong: read `+-4` as a plus, or lose the addend and keep the symbol
    for (const wrong of ['4', '0']) {
      const s = scoreC(body(wrong), 'arrback', target, CANONICAL);
      expect(s.match, `addend ${wrong} scored the same as the truth`).toBe(false);
      expect(s.score).toBeGreaterThan(0);
    }
  });
});
