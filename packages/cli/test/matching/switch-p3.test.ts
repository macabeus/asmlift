// P3 / Regime C — the AsmData side-table widens MIPS/PPC
// input so a DENSE-SWITCH jump table (case→target map in a `.rodata`/`.data` section + relocations,
// which `objdump -d` never shows) recovers to a matching `switch_br`. Three layers:
//   1. the pure `parseAsmData`/`readJumpTable` parser (offline — captured objdump text);
//   2. end-to-end recovery: IDO (native), KMC-GCC + mwcc (Docker-gated) — dense switch scores 0;
//   3. fail-closed: WITHOUT the side-table, the same dispatch loud-fails.
import { parseAsmData, readJumpTable, textRelocAt } from '@asmlift/core/frontend/asmdata';
import { FrontendUnsupportedError } from '@asmlift/core/frontend/errors';
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_GCC, MIPS_IDO, PPC_MWCC } from '@asmlift/core/target';
import {
  compileMipsGccTarget,
  compileMipsTarget,
  compilePpcTarget,
  extractMipsAsmData,
  extractPpcAsmData,
  scoreCMips,
  scoreCMipsGcc,
  scoreCPpc,
} from '@asmlift/toolchains';
import { GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { dockerGate, ppcDockerGate } from './docker-gate';

const dense = (n: number) => {
  const cases = Array.from({ length: n }, (_, i) => `case ${i}:return ${i * 2 + 3};`).join('');
  return `int sw_jt(int x){ switch(x){${cases}default:return -1;} }`;
};

// ── Layer 1: the pure parser (offline, deterministic against captured objdump text) ────────────
describe('P3 parser — parseAsmData + readJumpTable resolve a table from bytes+relocs', () => {
  // Captured `objdump -s -r -t` of a mwcc PPC dense switch: table is the local `@15` object in `.data`,
  // bytes ZERO, the map lives entirely in `R_PPC_ADDR32 sw_jt+0xNN` relocs (big-endian).
  const PPC_DUMP = `
Contents of section .data:
 0000 00000000 00000000 00000000 00000000  ................
 0010 00000000 00000000 00000000 00000000  ................

RELOCATION RECORDS FOR [.text]:
OFFSET   TYPE              VALUE
0000000a R_PPC_ADDR16_HA   @15
00000012 R_PPC_ADDR16_LO   @15

RELOCATION RECORDS FOR [.data]:
OFFSET   TYPE              VALUE
00000000 R_PPC_ADDR32      sw_jt+0x00000020
00000004 R_PPC_ADDR32      sw_jt+0x00000028
00000008 R_PPC_ADDR32      sw_jt+0x00000030
0000000c R_PPC_ADDR32      sw_jt+0x00000038

SYMBOL TABLE:
00000000 l    d  .text\t00000000 .text
00000000 l    d  .data\t00000000 .data
00000000 l     O .data\t00000020 @15
00000000 g     F .text\t00000068 sw_jt
`;
  const ad = parseAsmData(PPC_DUMP, PPC_DUMP, PPC_DUMP, true);

  test('sections, symbols, and .text/.data relocs parse', () => {
    expect(ad.sections.get('.data')!.length).toBe(32);
    expect(ad.symbols.get('@15')).toEqual({ section: '.data', value: 0 });
    expect(ad.symbols.get('sw_jt')).toEqual({ section: '.text', value: 0 });
    expect(textRelocAt(ad, 0xa)!.sym).toBe('@15');
  });

  test('readJumpTable resolves RELA addends against the function symbol (.data bytes are zero)', () => {
    expect(readJumpTable(ad, '@15', 0, 4)).toEqual([0x20, 0x28, 0x30, 0x38]);
  });

  // MIPS variant: entries stored as `.text` offsets in `.rodata` bytes (REL), reloc against `.text`.
  const MIPS_DUMP = `
Contents of section .rodata:
 0000 00000034 0000003c 00000044 0000004c  ...4...<...D...L

RELOCATION RECORDS FOR [.rodata]:
OFFSET   TYPE              VALUE
00000000 R_MIPS_GPREL32    .text
00000004 R_MIPS_GPREL32    .text
00000008 R_MIPS_GPREL32    .text
0000000c R_MIPS_GPREL32    .text

SYMBOL TABLE:
00000000 l    d  .text\t00000080 .text
00000000 l    d  .rodata\t00000020 .rodata
`;
  test('readJumpTable resolves REL entries from .rodata bytes', () => {
    const m = parseAsmData(MIPS_DUMP, MIPS_DUMP, MIPS_DUMP, true);
    expect(readJumpTable(m, '.rodata', 0, 4)).toEqual([0x34, 0x3c, 0x44, 0x4c]);
  });

  test('fail-closed: a table entry with no reloc, or a non-.text target, declines', () => {
    expect(readJumpTable(ad, '@15', 0, 5)).toBeNull(); // 5th slot has no reloc
    expect(readJumpTable(ad, '.nonexistent', 0, 4)).toBeNull(); // unknown section
  });
});

// ── Layer 2 + 3: end-to-end recovery, and fail-closed without the side-table ────────────────────
describe('P3 IDO/MIPS — a dense jump-table switch recovers to a matching switch', () => {
  test('8-case dense switch scores 0 with the AsmData side-table', () => {
    const c = dense(8);
    const { obj, asm } = compileMipsTarget(c, 'sw_jt');
    const asmData = extractMipsAsmData(obj, IDO_TOOLCHAIN.objdump);
    const src = decompile('sw_jt', asm, MIPS_IDO, { asmData }).source;
    expect(src).toContain('switch (');
    expect(scoreCMips(src, 'sw_jt', obj).score).toBe(0);
  });

  test('fail-closed: WITHOUT the side-table the same dispatch loud-fails (jr not a return)', () => {
    const { asm } = compileMipsTarget(dense(8), 'sw_jt');
    expect(() => decompile('sw_jt', asm, MIPS_IDO)).toThrow(FrontendUnsupportedError);
  });

  // SOUNDNESS: a MIPS branch-LIKELY (`bnezl`/`beql`/…) has no register dest, so a jal/jalr/jr-only
  // loud-fail allowlist would let `emitOpaqueDest` silently DROP its branch — a switch fn with an
  // outer branch-likely guard would silently miscompile. The PPC-style catch-all loud-fails
  // instead. Constructed asm (IDO emits `bnezl` for the guard).
  test('branch-likely is loud-failed, not silently dropped (even with the side-table)', () => {
    const asm = [
      '00000000 <f>:',
      '   0:\tbnezl\ta0,10 <f+0x10>',
      '   4:\tnop',
      '   8:\tli\tv0,1',
      '   c:\tjr\tra',
      '  10:\tli\tv0,2',
      '  14:\tjr\tra',
    ].join('\n');
    expect(() => decompile('f', asm, MIPS_IDO)).toThrow(/branch-likely|unmodelled control transfer/);
  });
});

const HAVE_DOCKER = dockerGate('switch-p3');
describe.runIf(HAVE_DOCKER)('P3 KMC-GCC/MIPS — dense jump-table switch recovers (absolute R_MIPS_32 table)', () => {
  test('8-case dense switch scores 0', () => {
    const c = dense(8);
    const { obj, asm } = compileMipsGccTarget(c, 'sw_jt');
    const asmData = extractMipsAsmData(obj, GCC_KMC_TOOLCHAIN.objdump);
    const src = decompile('sw_jt', asm, MIPS_GCC, { asmData }).source;
    expect(src).toContain('switch (');
    expect(scoreCMipsGcc(src, 'sw_jt', obj).score).toBe(0);
  });
});

const HAVE_PPC = ppcDockerGate('switch-p3');
describe.runIf(HAVE_PPC)('P3 mwcc/PPC — dense jump-table switch recovers (R_PPC_ADDR32 table in .data)', () => {
  test('8-case dense switch scores 0', () => {
    const c = dense(8);
    const { obj, asm } = compilePpcTarget(c, 'sw_jt');
    const asmData = extractPpcAsmData(obj);
    const src = decompile('sw_jt', asm, PPC_MWCC, { asmData }).source;
    expect(src).toContain('switch (');
    expect(scoreCPpc(src, 'sw_jt', obj).score).toBe(0);
  });

  test('fail-closed: WITHOUT the side-table the bctr dispatch loud-fails', () => {
    const { asm } = compilePpcTarget(dense(8), 'sw_jt');
    expect(() => decompile('sw_jt', asm, PPC_MWCC)).toThrow();
  });
});
