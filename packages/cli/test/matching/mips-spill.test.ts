// B2 regression — `sp`-relative argument-spill mislift (ido7.1).
//
// IDO spills a narrow (`signed char`/`unsigned char`) parameter to its o32 ABI home slot with
// `sw a0,0(sp)`. Lifting that as a store THROUGH `sp` read as an ordinary register makes `sp` a
// spurious pointer parameter (type-recovered to `s32 *`) and displaces the real argument —
// garbage like `s32 sextb(s32 * a0, s32 a1){ *a0 = a1; ... }`. Instead (frontend/mips.ts,
// isStackPtr/stackSlot) a word `sp`-relative store/load is modelled as an SSA stack SLOT keyed by
// offset: a never-reloaded home-slot spill has no uses and simply drops, and `sp` never
// materializes as a value. These assertions lock the mislift out.
//
// NOTE: sextb/zextb do NOT byte-match the target — the reference's `sw a0,0(sp)` spill is emitted
// by IDO only for a narrow (s8/u8) parameter, which asmlift does not yet recover (it emits `s32`),
// so the recompile has no spill. Hence these tests pin the emitted source only, no objdiff score;
// closing the gap is narrow-parameter recovery, not B2.
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const CASES = [
  {
    sym: 'sextb',
    c: 'int sextb(signed char x){ return x; }',
    expect: 's32 sextb(s32 a0) {\n    return a0 << 24 >> 24;\n}\n',
  },
  {
    sym: 'zextb',
    c: 'int zextb(unsigned char x){ return x; }',
    expect: 's32 zextb(s32 a0) {\n    return a0 & 255;\n}\n',
  },
];

describe('B2: sp-relative home-slot spill is not a store through a pointer', () => {
  for (const { sym, c, expect: golden } of CASES) {
    test(`${sym} — no spurious pointer param, spill drops`, () => {
      const { asm } = compileMipsTarget(c, sym);
      const r = decompile(sym, asm, MIPS_IDO);
      // The exact emitted C: one scalar arg, no `sp` pointer, no phantom store.
      expect(r.source).toBe(golden);
      expect(r.source).not.toContain('*'); // no dereference / pointer store
      expect(r.source).not.toContain('a1'); // arg not displaced to a1
    });
  }

  // T2b — FRAMED-FUNCTION phantom `sp` param. If a leaf that allocates a frame (`addiu sp,sp,-N`)
  // reads `sp` for the frame adjustment, `sp` is fabricated as a phantom leading parameter that
  // shifts every real argument (`f(a,b)` → `f(sp, a, b)`). The frontend skips `addiu sp,sp,±N`
  // (frame setup/teardown is transparent, mirroring PPC's `addi r1`) and loud-fails on any OTHER
  // read of `sp`, so a framed leaf recovers its EXACT signature. (`volatile` forces the frame; its
  // slots are word-modelled and the spill/reload threads through — the point here is the signature.)
  const FRAMED = [
    { sym: 'vol', c: 'int vol(int a){ volatile int x = a; return x + 1; }', sig: 's32 vol(s32 a0)' },
    {
      sym: 'vol2',
      c: 'int vol2(int a,int b){ volatile int x=a; volatile int y=b; return x+y; }',
      sig: 's32 vol2(s32 a0, s32 a1)',
    },
  ];
  for (const { sym, c, sig } of FRAMED) {
    test(`${sym} — framed leaf recovers exact signature, no phantom sp param`, () => {
      const { asm } = compileMipsTarget(c, sym);
      expect(/addiu\s+sp,sp,-/.test(asm)).toBe(true); // the fixture really allocates a frame
      const r = decompile(sym, asm, MIPS_IDO);
      expect(r.source.startsWith(sig)).toBe(true); // exact params — no leading `sp` pointer
      expect(r.source).not.toContain('sp'); // sp never materialized as a value/param
    });
  }

  // B2 SOUNDNESS GUARD: a WORD store to a slot that a SUB-WORD reload aliases (`sw a0,4(sp)` then
  // `lbu v0,4(sp)`) must NOT be slot-modelled — that would drop the store and read uninitialised
  // memory, a silent miscompile. Any sub-word sp access disables the slot model for the whole
  // function, so this LOUD-FAILS. The sub-word access may instead hit the `read(sp)`-as-data guard
  // first — either loud-fail satisfies the invariant, hence the message alternation below.
  test('word-store / sub-word-reload of same sp slot loud-fails (no silent miscompile)', () => {
    const c = 'int unionbyte(int a){ union { int i; char c[4]; } u; u.i = a; return u.c[0]; }';
    const { asm } = compileMipsTarget(c, 'unionbyte');
    expect(() => decompile('unionbyte', asm, MIPS_IDO)).toThrow(
      /overlapping fields|unions not modelled|stack pointer used as data/,
    );
  });
});
