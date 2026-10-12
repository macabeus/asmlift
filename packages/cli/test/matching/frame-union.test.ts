// A FRAME OBJECT ACCESSED AT TWO WIDTHS, end to end through the real agbcc: reference C → target →
// lift → the candidate declares the bytes as a union of per-width views → compiled → scored.
//
// WHY A UNION AND NOT A CAST. agbcc at -O2 orders a load after a store to the same bytes only when
// their alias sets conflict (c-common.c `c_get_alias_set`). Through casts on byte storage a `u16`
// read and a `u32` store are two sets, and compiled, `((u16 *)b)[0] = 1; *(u32 *)b = x; return
// ((u16 *)b)[0];` returns the stale `mov r0, #0x1`. A union member access is set 0, which conflicts
// with every set, so the same three accesses through a union reload. So a candidate that spells
// these frame bytes through casts can drop a reload the asm made — C that compiles and is wrong —
// and the frame audit declares them as a union instead (frontend/frame-objects.ts `unionViews`).
//
// Each reference below is the union spelling's own source, so the target carries the reload, and
// the candidate must reproduce it: a score of 0 is the proof the read after the store stayed.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
const U = 'union U { s32 w; u16 h[2]; }; void k(void *);\n';
const K = { prototypes: { k: { params: ['void *'], returnsVoid: true } } };

describe('a frame object accessed at two widths — real agbcc: the union keeps every reload', () => {
  test.each([
    {
      sym: 'rd',
      // a halfword read after a word store to the same bytes: through casts, read stale
      c: `${U}int rd(int x){ union U u; k(&u); u.h[0] = 1; u.w = x; return u.h[0]; }`,
      spelled: 'sp0.half[0] = 1;\n    sp0.word = a0;\n    return sp0.half[0];',
    },
    {
      sym: 'rw',
      // …and a word read after a halfword store into it
      c: `${U}int rw(int x){ union U u; k(&u); u.w = x; u.h[1] = 7; return u.w; }`,
      spelled: 'sp0.word = a0;\n    sp0.half[1] = 7;\n    return sp0.word;',
    },
  ])('a read after a store of the other width: $sym', ({ sym, c, spelled }) => {
    const asm = compileTargetAsm(c, FLAGS);
    const r = decompile(sym, asm, ARMV4T_AGBCC, K);
    expect(r.source).toContain('union { s32 word; u16 half[2]; } sp0;');
    expect(r.source).toContain(spelled);
    expect(scoreC(`void k(void *);\n${r.source}`, sym, assembleTarget(asm), FLAGS).score, r.source).toBe(0);
  });

  // A BY-VALUE STRUCT PARAMETER: agbcc spills its registers word by word and reads its members at
  // the widths they are declared, through `mov rD, sp`. Nothing escapes, so the spills and the reads
  // are one object (frontend/frame-objects.ts, no escape at all), and its two widths one union.
  test('a by-value struct parameter read at its members` widths', () => {
    const c = 'struct P { u16 a, b, c, d; s8 e; }; int b2(struct P p){ return p.a + p.c - p.e; }';
    const asm = compileTargetAsm(c, FLAGS);
    const r = decompile('b2', asm, ARMV4T_AGBCC);
    expect(r.source).toContain('union { s32 word[3]; u16 half[6]; u8 byte[12]; } sp0;');
    expect(scoreC(r.source, 'b2', assembleTarget(asm), FLAGS).score, r.source).toBe(0);
  });
});
