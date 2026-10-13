// MIPS dense switch recovery (`sltiu at,k,N ; beqz at,DEF ; …sll…; addu; lw; jr`).
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (...lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

/** A two-entry table at `jt` whose words point at 0x20 (case 0) and 0x28 (case 1). */
const asmData: AsmData = {
  sections: new Map([['.rodata', new Uint8Array([0, 0, 0, 0x20, 0, 0, 0, 0x28])]]),
  relocs: [
    { section: '.text', offset: 0xc, type: 'R_MIPS_HI16', sym: 'jt', addend: 0 },
    { section: '.rodata', offset: 0, type: 'R_MIPS_32', sym: '.text', addend: 0 },
    { section: '.rodata', offset: 4, type: 'R_MIPS_32', sym: '.text', addend: 0 },
  ],
  symbols: new Map([
    ['jt', { section: '.rodata', value: 0, size: 8, index: 1 }],
    ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
  ]),
  symbolCount: 2,
  bigEndian: true,
};

const dispatch = (slot: string, index: string) =>
  obj(
    ' 0:\tsltiu\tat,a0,0x2',
    ' 4:\tbeqz\tat,30 <f+0x30>',
    ` 8:\t${slot}`,
    ' c:\tlui\tat,0x0',
    `10:\taddu\tat,at,${index}`,
    '14:\tlw\tt6,0(at)',
    '18:\tjr\tt6',
    '1c:\tnop',
    '20:\tjr\tra',
    '24:\tli\tv0,5',
    '28:\tjr\tra',
    '2c:\tli\tv0,9',
    '30:\tjr\tra',
    '34:\tli\tv0,-1',
  );

test('the switch scrutinee is the index the bounds check tested, not the delay slot’s scaled copy', () => {
  // IDO scales the index IN PLACE in the bounds branch's delay slot (`sll t6,t6,0x2`, here on a0).
  // The `sltiu` bounded the unscaled value, and the case labels are 0..N-1, so the switch reads it
  // before the slot runs. Read after the slot, it would be `switch (a0 << 2)`, which compiles and
  // returns -1 for k = 1.
  const inPlace = decompile('f', dispatch('sll\ta0,a0,0x2', 'a0'), MIPS_IDO, { asmData }).source;
  expect(inPlace).toContain('switch (a0)');
  expect(inPlace).not.toContain('<< 2');
  // gcc shifts into another register; both orders read the same value there.
  const elsewhere = decompile('f', dispatch('sll\tv0,a0,0x2', 'v0'), MIPS_GCC, { asmData }).source;
  expect(elsewhere).toContain('switch (a0)');
  expect(elsewhere).not.toContain('<< 2');
});
