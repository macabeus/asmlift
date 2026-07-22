// The objdump→gaddr reloc bridge (frontend/mips.ts applyMipsGlobalRelocs): in an object file a
// global load shows `lui rX,0x0` with the symbol only in the R_MIPS_HI16/LO16 relocations. Given
// the asmData side-table, the frontend rewrites those into `%hi(SYM)`/`%lo(SYM+N)` operands so the
// gaddr recognition (shared with the Splat dialect) recovers the named global — instead of reading
// address 0 as `*(T *)0`. This is what lets asmlift match global access in the benchmark's objdump
// tier, symmetric with the symbols the harness feeds m2c.
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { MIPS_GCC } from '../src/target';

// A minimal AsmData carrying only .text relocations (the bridge reads nothing else).
const relocs = (rs: { off: number; type: string; sym: string }[]): AsmData => ({
  sections: new Map(),
  relocs: rs.map((r) => ({ section: '.text', offset: r.off, type: r.type, sym: r.sym, addend: 0 })),
  symbols: new Map(),
  bigEndian: true,
});

test('a scalar global load recovers the named symbol via HI16/LO16 relocs (not *(T *)0)', () => {
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gByte' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gByte' },
  ]);
  expect(decompile('getg', asm, MIPS_GCC, { asmData: rs }).source).toContain('return gByte;');
  // without the relocs the symbol is invisible → the honest raw-address read
  expect(decompile('getg', asm, MIPS_GCC).source).toContain('*(s8 *)0');
});

test('a global field access folds the LO16 instruction offset into the gaddr access offset', () => {
  // `lw v0,8(v0)` under an LO16 reloc → the global at byte offset 8 → element 2 of an s32 aggregate
  const asm = '00000000 <getf>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlw\tv0,8(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gStruct' },
    { off: 8, type: 'R_MIPS_LO16', sym: 'gStruct' },
  ]);
  expect(decompile('getf', asm, MIPS_GCC, { asmData: rs }).source).toContain('((s32 *)&gStruct)[2]');
});

test('an addiu-materialised global base + plain-offset access recovers through the symbol', () => {
  // `lui;addiu %lo` materialises &gArr, then a plain `lw 4(v0)` reads element 1
  const asm = '00000000 <getm>:\n   0:\tlui\tv0,0x0\n   4:\taddiu\tv0,v0,0\n   8:\tjr\tra\n   c:\tlw\tv0,4(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: 'gArr' },
    { off: 4, type: 'R_MIPS_LO16', sym: 'gArr' },
  ]);
  expect(decompile('getm', asm, MIPS_GCC, { asmData: rs }).source).toContain('&gArr');
});

test('a section-symbol reloc (jump-table base / anonymous data) is NOT rewritten as a global', () => {
  // A `.rodata`/`.data` section reloc is a jump-table base or section-relative data — the bridge
  // leaves it raw so Regime-B recovery owns it; it must not become a bogus `%hi(.rodata)` global.
  const asm = '00000000 <getg>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\tlb\tv0,0(v0)\n';
  const rs = relocs([
    { off: 0, type: 'R_MIPS_HI16', sym: '.rodata' },
    { off: 8, type: 'R_MIPS_LO16', sym: '.rodata' },
  ]);
  // unchanged from the no-reloc behaviour: the raw address read, never a named global
  expect(decompile('getg', asm, MIPS_GCC, { asmData: rs }).source).toContain('*(s8 *)0');
});
