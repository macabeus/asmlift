// A unit row's object holds every function its unit defines before the row's; what the row publishes and
// what its readers take is about its own function (eval/function-scope.ts).
import { parseAsmData } from '@asmlift/core/frontend/asmdata';
import { readObjectLocalObject } from '@asmlift/core/frontend/local-object';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { functionDisassembly, functionScopedDump } from '../src/eval/function-scope';

const LISTING = [
  '',
  'target.o:     file format elf32-powerpc',
  '',
  '',
  'Disassembly of section .text:',
  '',
  '00000000 <helper>:',
  '   0:\tbl      0 <helper>',
  '\t\t\t0: R_PPC_REL24\text',
  '   4:\tblr',
  '',
  '00000008 <f>:',
  '   8:\tlis     r3,0',
  '\t\t\ta: R_PPC_ADDR16_HA\t@12',
  '   c:\tblr',
  '',
].join('\n');

const DUMP = [
  '',
  'target.o:     file format elf32-powerpc',
  '',
  'SYMBOL TABLE:',
  '00000000 l     O .data\t00000004 @12',
  '00000000 g     F .text\t00000008 helper',
  '00000008 g     F .text\t00000018 f',
  '',
  '',
  'RELOCATION RECORDS FOR [.text]:',
  'OFFSET   TYPE              VALUE',
  '00000000 R_PPC_REL24       ext',
  '0000000a R_PPC_ADDR16_HA   @12',
  '',
  '',
  'RELOCATION RECORDS FOR [.data]:',
  'OFFSET   TYPE              VALUE',
  '00000000 R_PPC_ADDR32      f+0x00000004',
  '',
  '',
  'Contents of section .text:',
  ' 0000 48000001 4e800020 3c600000 4e800020  H...N.. <`..N.. ',
  ' 0010 60000000 60000000 60000000 60000000  `...`...`...`... ',
  ' 0020 60000000 60000000                    `...`...         ',
  'Contents of section .data:',
  ' 0000 00000000                             ....             ',
  '',
].join('\n');

describe('functionDisassembly', () => {
  test("keeps the listing's header and the function's own lines", () => {
    expect(functionDisassembly(LISTING, 'f')).toBe(
      '\ntarget.o:     file format elf32-powerpc\n\n\nDisassembly of section .text:\n\n00000008 <f>:\n   8:\tlis     r3,0\n\t\t\ta: R_PPC_ADDR16_HA\t@12\n   c:\tblr\n',
    );
  });
});

describe('functionScopedDump', () => {
  test('narrows `.text` relocations and contents to the function, and keeps every other section whole', () => {
    const scoped = functionScopedDump(DUMP, 'f');
    expect(scoped).not.toContain('R_PPC_REL24       ext');
    expect(scoped).toContain('0000000a R_PPC_ADDR16_HA   @12');
    expect(scoped).toContain(' 0000 48000001');
    expect(scoped).toContain(' 0010 60000000');
    expect(scoped).not.toContain(' 0020 60000000');
    expect(scoped).toContain('00000000 R_PPC_ADDR32      f+0x00000004');
    expect(scoped).toContain('00000000 g     F .text\t00000008 helper');
  });

  test('a function that is its whole object reads the same', () => {
    expect(
      functionScopedDump(DUMP.replace('00000008 g     F .text\t00000018 f', '00000000 g     F .text\t00000028 f'), 'f'),
    ).toBe(DUMP.replace('00000008 g     F .text\t00000018 f', '00000000 g     F .text\t00000028 f'));
  });
});

// The prologue split and the slice must read the same listing, which is why both come from
// frontend/disasm.ts. A C++ template symbol carries `>` of its own, so a `<[^>]+>` pattern cannot
// see its header, and a second copy of the pattern here would let the two readers disagree.
test('a listing whose FIRST function carries a TEMPLATE symbol is still scoped to one copy of it', () => {
  const sym = 'invoke__Q23zen20NumberPicCallBack<i>FP7P2DPane';
  const listing = [
    '',
    'target.o:     file format elf32-powerpc',
    '',
    'Disassembly of section .text:',
    '',
    `00000000 <${sym}>:`,
    '   0:\tblr',
    '',
    '00000004 <after>:',
    '   4:\tbl      4 <after>',
    '\t\t\t4: R_PPC_REL24\tsomewhere_else',
    '   8:\tblr',
    '',
  ].join('\n');
  // The prologue is everything BEFORE the first header, so a first header the pattern cannot see
  // puts the template function itself into the prologue — and `sliceSymbol` then appends it a
  // second time, leaving the row's listing holding its own function twice.
  const scoped = functionDisassembly(listing, sym);
  expect(scoped.split(`<${sym}>:`)).toHaveLength(2);
  expect(scoped).not.toContain('somewhere_else');
  expect(scoped).not.toContain('<after>:');
});

// The object dump of mwcc_242_81 `-inline auto` over, among others, `static int counter(void) {
// static int n; return ++n; }`, `int A(void) { return counter() + 1; }`, `int B(void) { return
// counter(); }` and `s32 rtab(int i) { static const s32 kt[3] = {7, -1, 9}; return kt[i]; }`:
// `counter` stays in the object and A and B inlined it, so all three address `n$4`. Its `.comment`
// is what records each static's alignment.
const STATICS_DUMP = readFileSync(
  join(import.meta.dirname, '../../../packages/core/test/corpus/mwcc-local-statics.txt'),
  'utf8',
);

describe('functionScopedDump — the evidence a function-scope static needs survives the narrowing', () => {
  const read = (sym: string, stat: string) => {
    const scoped = functionScopedDump(STATICS_DUMP, sym);
    return readObjectLocalObject(parseAsmData(scoped, scoped, scoped, true), stat, sym);
  };

  test("another function's relocation naming a static this one names stays, so the lift sees it is shared", () => {
    const scoped = functionScopedDump(STATICS_DUMP, 'A');
    expect(scoped).toContain('00000002 R_PPC_ADDR16_HA   n$4');
    expect(scoped).not.toContain('0000004e R_PPC_ADDR16_HA   kt$18');
    expect(read('A', 'n$4')).toMatchObject({
      refused: "that .text also names at 0x2 — it is not this function's alone",
    });
  });

  test("a static only its own function names is read as that function's", () => {
    expect(functionScopedDump(STATICS_DUMP, 'rtab')).not.toContain('00000002 R_PPC_ADDR16_HA   n$4');
    expect(read('rtab', 'kt$18')).toMatchObject({ name: 'kt', section: 'rodata', size: 12 });
  });
});
