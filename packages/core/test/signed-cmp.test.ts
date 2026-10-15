// `/signed-cmp` (rank-variations.ts, structure.ts unsignedCompareSpelling OFF): an unsigned compare
// spelled without the `(u32)` cast and the u32 declaration the default gives it. It is a real source
// where the compiler proved the operands non-negative, and a different program where it did not, so
// it is offered, scored, and published only byte-exact.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { enumerateCandidates, rankBy, withheldReason } from '../src/rank';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

// agbcc -O2 of `void g(unsigned);
//   void f(int n){ unsigned i=0; if (n!=1) do { g(i); i++; } while (i < (unsigned)(n-1)); }`
// The loop test is `cmp r4, r5; bcc`: unsigned. Spelled over `s32 n` and `s32 i` it is signed in C,
// and differs from the machine at n == 0, where n - 1 is 0xFFFFFFFF.
const P1 =
  'f:\n\tpush\t{r4, r5, lr}\n\tmov\tr4, #0x0\n\tcmp\tr0, #0x1\n\tbeq\t.L3\t@cond_branch\n\tsub\tr5, r0, #0x1\n' +
  '.L4:\n\tadd\tr0, r4, #0\n\tbl\tg\n\tadd\tr4, r4, #0x1\n\tcmp\tr4, r5\n\tbcc\t.L4\t@cond_branch\n' +
  '.L3:\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n';

describe('/signed-cmp', () => {
  const cands = enumerateCandidates('f', P1, ARMV4T_AGBCC);
  const named = (n: string) => cands.find((c) => c.variations.join('/') === n)!;
  // the signed spelling over the signed parameter: `s32 v0 < s32 a0 - 1`, a signed compare in C
  const wrong = named('signed/signed-cmp');

  test('the default spells the loop test unsigned even over a signed parameter', () => {
    const c = named('signed');
    expect(c.source).toContain('void f(s32 a0)');
    // `v0 < a0 - 1` compares unsigned once the counter is declared u32
    expect(c.source).toMatch(/u32 v0;[\s\S]*while \(v0 < a0 - 1\)/);
    expect(c.matchOnly).toBeUndefined();
  });

  test('a signed spelling of the compare is offered, and only as a proof-carrying candidate', () => {
    expect(wrong.source).toMatch(/void f\(s32 a0\)[\s\S]*s32 v0;[\s\S]*while \(v0 < a0 - 1\)/);
    expect(wrong.matchOnly).toBe(true);
    expect(withheldReason(wrong, { score: 0 })).toBeNull();
    expect(withheldReason(wrong, { score: 3 })).toContain('operands non-negative');
    for (const c of cands.filter((x) => !hasVariation(x.variations, 'signed-cmp'))) {
      expect(c.matchOnly).toBeUndefined();
    }
  });

  test('a /signed-cmp tree whose compare still renders unsigned carries no proof obligation', () => {
    // over `u32 a0`, `a0 - 1` is unsigned and so is the compare, whatever `v0` declares
    const c = named('unsigned/signed-cmp');
    expect(c.source).toMatch(/void f\(u32 a0\)[\s\S]*s32 v0;[\s\S]*while \(v0 < a0 - 1\)/);
    expect(c.matchOnly).toBeUndefined();
  });

  test('a better-scoring signed nonmatch is withheld, and a signed match wins', () => {
    const better = rankBy(cands, 'f', (source) => ({ score: source === wrong.source ? 2 : 9 }));
    expect(better.winner.source).not.toBe(wrong.source);
    expect(better.withheld.map((w) => w.variations.join('/'))).toEqual(['signed/signed-cmp']);
    const matched = rankBy(cands, 'f', (source) => ({ score: source === wrong.source ? 0 : 9 }));
    expect(matched.winner.source).toBe(wrong.source);
    expect(matched.withheld).toEqual([]);
  });

  test('a tie goes to the unsigned spelling', () => {
    const tie = rankBy(cands, 'f', () => ({ score: 4 }));
    expect(hasVariation(tie.winner.variations, 'signed-cmp')).toBe(false);
  });
});

// A respell that substitutes into a compare emission already pinned. IDO 7.1 -mips2 -O2 of
//   int gx; short gs; int gb; void h(void); void h2(void);
//   int f(int c, int n) { unsigned v; if (c) { h(); v = gs; } else { h2(); v = gb + 9; }
//                         gx = v < (unsigned)n; return 5; }
// The join is `sltu t7,v1,t6`. The default reads it through a `u32 v0` and compares unsigned;
// `/unmerge` puts each arm's value back into the join, so over `s32 a1` the copy `gs < a1` is a
// signed compare (gs = -1, n = 5: the machine stores 0, that C stores 1). No structure setting is
// `/signed-cmp` here, so only the finished tree can say so.
const UNMERGE_IDO =
  '00000000 <f>:\n   0:\taddiu\tsp,sp,-24\n   4:\tsw\tra,20(sp)\n   8:\tbeqz\ta0,24 <f+0x24>\n' +
  '   c:\tsw\ta1,28(sp)\n  10:\tjal\t0 <f>\n  14:\tnop\n  18:\tlui\tv1,0x0\n  1c:\tb\t38 <f+0x38>\n' +
  '  20:\tlh\tv1,0(v1)\n  24:\tjal\t0 <f>\n  28:\tnop\n  2c:\tlui\tv1,0x0\n  30:\tlw\tv1,0(v1)\n' +
  '  34:\taddiu\tv1,v1,9\n  38:\tlw\tt6,28(sp)\n  3c:\tlw\tra,20(sp)\n  40:\tlui\tat,0x0\n' +
  '  44:\tsltu\tt7,v1,t6\n  48:\tsw\tt7,0(at)\n  4c:\taddiu\tsp,sp,24\n  50:\tjr\tra\n  54:\tli\tv0,5\n';
const reloc = (offset: number, type: string, sym: string) => ({ section: '.text', offset, type, sym, addend: 0 });
const UNMERGE_IDO_DATA: AsmData = {
  sections: new Map(),
  relocs: [
    reloc(16, 'R_MIPS_26', 'h'),
    reloc(24, 'R_MIPS_HI16', 'gs'),
    reloc(32, 'R_MIPS_LO16', 'gs'),
    reloc(36, 'R_MIPS_26', 'h2'),
    reloc(44, 'R_MIPS_HI16', 'gb'),
    reloc(48, 'R_MIPS_LO16', 'gb'),
    reloc(64, 'R_MIPS_HI16', 'gx'),
    reloc(72, 'R_MIPS_LO16', 'gx'),
  ],
  symbols: new Map(),
  symbolCount: 8,
  bigEndian: true,
};

describe('a respelled compare is judged on the finished tree', () => {
  const cands = enumerateCandidates('f', UNMERGE_IDO, MIPS_IDO, { asmData: UNMERGE_IDO_DATA });
  const named = (n: string) => cands.find((c) => c.variations.join('/') === n)!;

  test('the unmerged copy over a signed parameter compares signed, so it is proof-carrying', () => {
    const wrong = named('signed/unmerge');
    expect(wrong.source).toMatch(/s32 f\(s32 a0, s32 a1\)[\s\S]*gx = gs < a1;/);
    expect(wrong.matchOnly).toBe(true);
    expect(withheldReason(wrong, { score: 3 })).toContain('operands non-negative');
    expect(withheldReason(wrong, { score: 0 })).toBeNull();
  });

  test('the same copy over an unsigned parameter, and the default, need no proof', () => {
    const right = named('unsigned/unmerge');
    expect(right.source).toMatch(/s32 f\(u32 a0, u32 a1\)[\s\S]*gx = gs < a1;/);
    expect(right.matchOnly).toBeUndefined();
    const dflt = named('signed');
    expect(dflt.source).toMatch(/u32 v0;[\s\S]*gx = v0 < a1;/);
    expect(dflt.matchOnly).toBeUndefined();
  });
});
