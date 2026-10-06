// `/int-cell` (l3/intcell.ts): a global the function stores a pointer into, spelled as the integer a
// project may have declared it — beside the default's pointer spelling, published only at a
// byte-exact score, and offered only where the two spellings can build different objects.
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import type { AsmData } from '../src/frontend/asmdata';
import { enumerateCandidates, withheldReason } from '../src/rank';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

const relocs = (rs: { off: number; type: string; sym: string }[]): AsmData => ({
  sections: new Map(),
  relocs: rs.map((r) => ({ section: '.text', offset: r.off, type: r.type, sym: r.sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

// IDO 7.1 -O2 of `extern u32 *g; extern u32 gLimit; void sink2(void);
//   u32 kr2(u32 n) { *g = n; g++; sink2(); return (u32)g == gLimit; }`
const KR2 =
  '00000000 <kr2>:\n   0:\tlui\tv1,0x0\n   4:\taddiu\tv1,v1,0\n   8:\tlw\tt6,0(v1)\n   c:\taddiu\tsp,sp,-24\n' +
  '  10:\tsw\tra,20(sp)\n  14:\tsw\ta0,0(t6)\n  18:\tlw\tt7,0(v1)\n  1c:\taddiu\tt8,t7,4\n  20:\tjal\t0 <kr2>\n' +
  '  24:\tsw\tt8,0(v1)\n  28:\tlui\tv1,0x0\n  2c:\taddiu\tv1,v1,0\n  30:\tlui\tt9,0x0\n  34:\tlw\tt9,0(t9)\n' +
  '  38:\tlw\tt0,0(v1)\n  3c:\tlw\tra,20(sp)\n  40:\taddiu\tsp,sp,24\n  44:\txor\tv0,t9,t0\n  48:\tjr\tra\n' +
  '  4c:\tsltiu\tv0,v0,1\n';
const KR2_RELOCS = relocs([
  { off: 0, type: 'R_MIPS_HI16', sym: 'g' },
  { off: 4, type: 'R_MIPS_LO16', sym: 'g' },
  { off: 32, type: 'R_MIPS_26', sym: 'sink2' },
  { off: 40, type: 'R_MIPS_HI16', sym: 'g' },
  { off: 44, type: 'R_MIPS_LO16', sym: 'g' },
  { off: 48, type: 'R_MIPS_HI16', sym: 'gLimit' },
  { off: 52, type: 'R_MIPS_LO16', sym: 'gLimit' },
]);

// agbcc -O2 of `extern u32 *g; u32 kpA(u32 n) { *g = n; g++; return 0; }`
const STORE_ADVANCE =
  'kpA:\n\tldr\tr2, .L3\n\tldr\tr1, [r2]\n\tstr\tr0, [r1]\n\tldr\tr0, [r2]\n\tadd\tr0, r0, #0x4\n\tstr\tr0, [r2]\n' +
  '\tmov\tr0, #0x0\n\tbx\tlr\n.L3:\n\t.word\tg\n';

describe('integerCells', () => {
  const cands = enumerateCandidates('kr2', KR2, MIPS_IDO, { asmData: KR2_RELOCS });
  const cell = cands.filter((c) => hasVariation(c.variations, 'int-cell'));

  test('spells the cell as an integer beside the default pointer spelling', () => {
    const plain = cands.find((c) => c.variations.length === 1)!;
    expect(plain.source).toContain('g = (void *)((u8 *)g + 4);');
    expect(plain.source).toContain('(gLimit ^ (u32)g) < 1');
    expect(cell.length).toBeGreaterThan(0);
    for (const c of cell) {
      expect(c.source).toContain('g = g + 4;');
      expect(c.source).toContain('(gLimit ^ g) < 1');
      expect(c.source).not.toContain('(void *)');
      expect(c.source).not.toContain('(u32)g');
    }
  });

  test('publishes it only at a byte-exact score, naming the declaration it rests on', () => {
    for (const c of cell) {
      expect(c.matchOnly).toBe(true);
      expect(withheldReason(c, { score: 0 })).toBeNull();
      expect(withheldReason(c, { score: 3 })).toContain('declaring the global an integer');
    }
  });

  test('declares the cell an integer in its own self-declared world', () => {
    for (const c of cell) {
      expect(renderDeclarations(c.symbolRefs!)).toContain('extern u32 g;\n');
    }
  });

  test('does not fire where no global is stored a pointer', () => {
    // IDO 7.1 -O2 of `extern u32 *g; u32 kpR(void) { return *g; }`
    const read = '00000000 <kpR>:\n   0:\tlui\tt6,0x0\n   4:\tlw\tt6,0(t6)\n   8:\tjr\tra\n   c:\tlw\tv0,0(t6)\n';
    const rs = relocs([
      { off: 0, type: 'R_MIPS_HI16', sym: 'g' },
      { off: 4, type: 'R_MIPS_LO16', sym: 'g' },
    ]);
    const all = enumerateCandidates('kpR', read, MIPS_IDO, { asmData: rs });
    expect(all.some((c) => hasVariation(c.variations, 'int-cell'))).toBe(false);
  });

  test('is not offered where the symbol map declares the cell a pointer', () => {
    const symbols = new Map([[0x80001000, [{ name: 'g', kind: 'data' as const, shape: 'pointer' as const }]]]);
    const all = enumerateCandidates('kr2', KR2, MIPS_IDO, { asmData: KR2_RELOCS, symbols });
    expect(all.some((c) => c.source.includes('g = (void *)((u8 *)g + 4);'))).toBe(true);
    expect(all.some((c) => hasVariation(c.variations, 'int-cell'))).toBe(false);
  });

  test('is not offered on agbcc, which builds both spellings into one object', () => {
    const all = enumerateCandidates('kpA', STORE_ADVANCE, ARMV4T_AGBCC);
    expect(all.some((c) => c.source.includes('g = (void *)((u8 *)g + 4);'))).toBe(true);
    expect(all.some((c) => hasVariation(c.variations, 'int-cell'))).toBe(false);
  });
});
