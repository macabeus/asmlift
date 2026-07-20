// The F7 instruction batch: thumb bic/ror/ldmia/stmia, PPC rotlw/rotlwi/cntlzw, the rotr/rotl
// IR ops + the C rotate-idiom lowering (with the PPC mirror fold), and the mwcc-gated
// CNTLZW_EQ0 pattern. Every emission below was verified byte-exact against the real toolchain
// before the decode landed (agbcc/mwcc round-trips); these offline pins keep the shapes loud.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, PPC_MWCC } from '../src/target';

const thumb = (sym: string, body: string) => decompile(sym, `${sym}:\n${body}`, ARMV4T_AGBCC).source;
const ppc = (sym: string, lines: string) => decompile(sym, `0 <${sym}>:\n${lines}`, PPC_MWCC).source;

describe('thumb bic / ror / ldmia', () => {
  test('bic (3-operand agbcc spelling) lifts to the & ~ idiom', () => {
    const src = thumb('clearbit', '\tmov\tr2, #0x1\n\tlsl\tr2, r2, r1\n\tbic\tr0, r0, r2\n\tbx\tlr\n');
    expect(src).toContain('return a0 & ~(1 << a1);');
  });

  test('bic (2-operand form) lifts identically', () => {
    const src = thumb('mask', '\tbic\tr0, r1\n\tbx\tlr\n');
    expect(src).toContain('return a0 & ~a1;');
  });

  test('ror lifts to the rotate idiom with an unsigned-seeded value', () => {
    const src = thumb('rotr', '\tror\tr0, r0, r1\n\tbx\tlr\n');
    expect(src).toContain('u32 rotr(u32 a0, s32 a1)');
    expect(src).toContain('return a0 >> a1 | a0 << 32 - a1;');
  });

  test('ldmia single-register writeback = load + base advance', () => {
    const src = thumb('take', '\tldmia\tr0!, {r1}\n\tadd\tr0, r1, #0\n\tbx\tlr\n');
    expect(src).toContain('*a0'); // the load
    expect(src).not.toContain('ASMLIFT'); // no gap — the instruction is modelled
  });

  test('ldmia multi-register loads ascending offsets then advances by 4×count', () => {
    const src = thumb('pair', '\tldmia\tr2!, {r0, r1}\n\tadd\tr0, r0, r1\n\tbx\tlr\n');
    expect(src).toContain('*a0 + a0[1]'); // r2 is the only live input → param a0; offsets 0 and 4
  });
});

describe('PPC rotates + cntlzw equality fold', () => {
  test('rotlw with a 32-n amount mirror-folds to the rotr idiom (no residual subtract)', () => {
    const src = ppc('rotr', '0:\tsubfic  r0,r4,32\n4:\trotlw   r3,r3,r0\n8:\tblr\n'.replace(/^(\w)/gm, '   $1'));
    expect(src).toContain('return a0 >> a1 | a0 << 32 - a1;');
    expect(src).not.toContain('32 - (32'); // the mirror fold, not the literal double-subtract
  });

  test('rotlwi (immediate) lowers to the constant rotate idiom', () => {
    const src = ppc('rot8', '   0:\trotlwi  r3,r3,8\n   4:\tblr\n');
    expect(src).toContain('return a0 << 8 | a0 >> 24;');
  });

  test('cntlzw+srwi folds to == 0 (the mwcc boolean spelling), no clz survivor', () => {
    const src = ppc('iszero', '   0:\tcntlzw  r3,r3\n   4:\tsrwi    r3,r3,5\n   8:\tblr\n');
    expect(src).toContain('return a0 == 0;');
  });

  test('a BARE cntlzw (no fold) stays a loud gap, never silent', () => {
    expect(() => decompile('clzonly', '0 <clzonly>:\n   0:\tcntlzw  r3,r3\n   4:\tblr\n', PPC_MWCC)).toThrow();
  });
});

describe('F7 adversarial-round pins', () => {
  test('base-in-list ldmia loads every sibling from the ORIGINAL base (snapshot, not the loaded value)', () => {
    // `ldmia r0!, {r0, r1}` — hardware transfers all from the original base; the per-iteration
    // re-read loaded r1 from the freshly-loaded r0 (reproduced as silent wrong addresses).
    const src = thumb('bil', '\tldmia\tr0!, {r0, r1}\n\tadd\tr0, r0, r1\n\tbx\tlr\n');
    expect(src).toContain('*a0 + a0[1]'); // both offsets off the SAME original base
  });

  test('ldmia writeback advance is IN the emission (the M8 writeback half)', () => {
    const src = thumb('adv', '\tldmia\tr0!, {r1}\n\tadd\tr0, r0, #0\n\tbx\tlr\n');
    expect(src).toMatch(/a0 \+ \d|\d \+ a0/); // the writeback advance is NOT dropped (M8's second half)
  });

  test('a constant rotate amount of 0 is the identity, never the UB shift-by-32 spelling', () => {
    const src = ppc('rot0', '   0:\trotlwi  r3,r3,0\n   4:\tblr\n');
    expect(src).not.toContain('<< 32');
    expect(src).not.toContain('>> 32');
    expect(src).toContain('return a0;');
  });

  test('the mirror fold is mwcc-gated data (a thumb ror with a 32-n amount keeps its own spelling)', () => {
    // source-level `32 - n` feeding a thumb ror must NOT respell as a left-rotate idiom
    const src = thumb('r32n', '\tmov\tr2, #32\n\tsub\tr2, r2, r1\n\tror\tr0, r0, r2\n\tbx\tlr\n');
    expect(src).toContain('>> 32 - a1'); // the right-rotate reads the literal (un-folded) amount
    expect(src).not.toMatch(/<< a1 \|/); // never the mirror-folded left form (that is mwcc-gated)
  });
});
