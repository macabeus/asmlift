// MIPS dense switch recovery (`sltiu at,k,N ; beqz at,DEF ; …sll…; addu; lw; jr`).
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { FrontendUnsupportedError } from '../src/frontend/errors';
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

// THE TABLE'S HOLES NAME THE DEFAULT BLOCK ON MIPS TOO. IDO 7.1 `-O2` for the C that
// `thumb-switch.test.ts`'s `HOLES_WITH_IFS` is compiled from (`synthetic:sw_jtholeif:ido7.1`):
// cases 0, 2, 5, 6, 7 and no `default`, cases 5 and 7 an `if` that leaves the switch. Every arm
// returns on its own (`jr ra`), so only the default-anchored retry gives the table an end, and the
// end it derives is the out-of-range `jr ra` at 0x8c — which slots 1, 3 and 4 also hold. The rule
// that lets the retry end there is not Thumb's: it reads the table, not the ISA.
const holedTable: AsmData = {
  sections: new Map([
    ['.rodata', new Uint8Array([0x20, 0x8c, 0x2c, 0x8c, 0x8c, 0x38, 0x5c, 0x68].flatMap((w) => [0, 0, 0, w]))],
  ]),
  relocs: [
    { section: '.text', offset: 0xc, type: 'R_MIPS_HI16', sym: 'jt', addend: 0 },
    { section: '.text', offset: 0x14, type: 'R_MIPS_LO16', sym: 'jt', addend: 0 },
    ...[0, 4, 8, 12, 16, 20, 24, 28].map((offset) => ({
      section: '.rodata',
      offset,
      type: 'R_MIPS_32',
      sym: '.text',
      addend: 0,
    })),
  ],
  symbols: new Map([
    ['jt', { section: '.rodata', value: 0, size: 32, index: 1 }],
    ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
  ]),
  symbolCount: 2,
  bigEndian: true,
};

test('a table whose holes name the default block ends the switch there, on IDO as on agbcc', () => {
  const asm = obj(
    ' 0:\tsltiu\tat,a0,8',
    ' 4:\tbeqz\tat,8c <f+0x8c>',
    ' 8:\tsll\tt6,a0,0x2',
    ' c:\tlui\tat,0x0',
    '10:\taddu\tat,at,t6',
    '14:\tlw\tt6,0(at)',
    '18:\tjr\tt6',
    '1c:\tnop',
    '20:\tli\tt7,1',
    '24:\tjr\tra',
    '28:\tsw\tt7,0(a1)',
    '2c:\tli\tt8,2',
    '30:\tjr\tra',
    '34:\tsw\tt8,4(a1)',
    '38:\tlw\tt9,12(a1)',
    '3c:\tli\tt2,7',
    '40:\taddiu\tt0,t9,2',
    '44:\tslti\tat,t0,10',
    '48:\tbnez\tat,8c <f+0x8c>',
    '4c:\tsw\tt0,12(a1)',
    '50:\tsw\tt2,16(a1)',
    '54:\tjr\tra',
    '58:\tsw\tzero,20(a1)',
    '5c:\tli\tt3,4',
    '60:\tjr\tra',
    '64:\tsw\tt3,24(a1)',
    '68:\tlw\tt4,12(a1)',
    '6c:\tli\tt7,3',
    '70:\tli\tt8,1',
    '74:\taddiu\tt5,t4,-2',
    '78:\tslti\tat,t5,9',
    '7c:\tbnez\tat,8c <f+0x8c>',
    '80:\tsw\tt5,12(a1)',
    '84:\tsw\tt7,16(a1)',
    '88:\tsw\tt8,20(a1)',
    '8c:\tjr\tra',
    '90:\tnop',
  );
  const out = decompile('f', asm, MIPS_IDO, { asmData: holedTable, prototypes: { f: { returnsVoid: true } } }).source;
  expect(out).not.toContain('ASMLIFT_ERROR');
  expect(out).toContain('switch (a0)');
  expect(out).toMatch(/case 1:\s*case 3:\s*case 4:\s*break;/);
  expect(out).not.toContain('default:');
  expect(out).toMatch(/case 5:[^]*\[4\] = 7;[^]*case 6:/);
  expect(out).toMatch(/case 7:[^]*\[4\] = 3;/);
});

// A CASE BODY THAT BREAKS ON ONE PATH AND FALLS INTO THE NEXT CASE ON ANOTHER, on IDO. IDO 7.1
// `-O2` for `synthetic:sw_jtifbreak` (`case 1: if (i != gA && i != gB) break; case 2: f(i); break;`,
// cases 0..4, `r(0)` after the switch). IDO does not cross-jump `if (c) f(i); break;` into this
// shape the way agbcc and gcc 2.7.2 do, so here only the fall-through source gives the object, and
// the `break;` must leave the switch on the path that skips the call.
const ifBreakTable: AsmData = {
  sections: new Map([['.rodata', new Uint8Array([0x28, 0x38, 0x58, 0x68, 0x78].flatMap((w) => [0, 0, 0, w]))]]),
  relocs: [
    { section: '.text', offset: 0x14, type: 'R_MIPS_HI16', sym: 'jt', addend: 0 },
    { section: '.text', offset: 0x1c, type: 'R_MIPS_LO16', sym: 'jt', addend: 0 },
    ...(
      [
        [0x28, 'R_MIPS_26', 'g'],
        [0x38, 'R_MIPS_HI16', 'gA'],
        [0x3c, 'R_MIPS_LO16', 'gA'],
        [0x40, 'R_MIPS_HI16', 'gB'],
        [0x4c, 'R_MIPS_LO16', 'gB'],
        [0x58, 'R_MIPS_26', 'f'],
        [0x68, 'R_MIPS_26', 'h'],
        [0x78, 'R_MIPS_26', 'm'],
        [0x80, 'R_MIPS_26', 'r'],
      ] as const
    ).map(([offset, type, sym]) => ({ section: '.text', offset, type, sym, addend: 0 })),
    ...[0, 4, 8, 12, 16].map((offset) => ({ section: '.rodata', offset, type: 'R_MIPS_32', sym: '.text', addend: 0 })),
  ],
  symbols: new Map([
    ['jt', { section: '.rodata', value: 0, size: 20, index: 1 }],
    ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
  ]),
  symbolCount: 2,
  bigEndian: true,
};

test('a case body that breaks on one path and falls into the next case on another, on IDO', () => {
  const asm = obj(
    ' 0:\taddiu\tsp,sp,-24',
    ' 4:\tsltiu\tat,a1,5',
    ' 8:\tbeqz\tat,80 <f+0x80>',
    ' c:\tsw\tra,20(sp)',
    '10:\tsll\tt6,a1,0x2',
    '14:\tlui\tat,0x0',
    '18:\taddu\tat,at,t6',
    '1c:\tlw\tt6,0(at)',
    '20:\tjr\tt6',
    '24:\tnop',
    '28:\tjal\t0 <f>',
    '2c:\tnop',
    '30:\tb\t80 <f+0x80>',
    '34:\tnop',
    '38:\tlui\tt7,0x0',
    '3c:\tlw\tt7,0(t7)',
    '40:\tlui\tt8,0x0',
    '44:\tbeq\ta0,t7,58 <f+0x58>',
    '48:\tnop',
    '4c:\tlw\tt8,0(t8)',
    '50:\tbne\ta0,t8,80 <f+0x80>',
    '54:\tnop',
    '58:\tjal\t0 <f>',
    '5c:\tnop',
    '60:\tb\t80 <f+0x80>',
    '64:\tnop',
    '68:\tjal\t0 <f>',
    '6c:\tnop',
    '70:\tb\t80 <f+0x80>',
    '74:\tnop',
    '78:\tjal\t0 <f>',
    '7c:\tnop',
    '80:\tjal\t0 <f>',
    '84:\tmove\ta0,zero',
    '88:\tlw\tra,20(sp)',
    '8c:\taddiu\tsp,sp,24',
    '90:\tjr\tra',
    '94:\tnop',
  ).replace('<f>:', '<sw>:');
  const v = { params: 1, returnsVoid: true };
  const out = decompile('sw', asm, MIPS_IDO, {
    asmData: ifBreakTable,
    prototypes: { sw: { returnsVoid: true }, f: v, g: v, h: v, m: v, r: v },
  }).source;
  expect(out).toMatch(/case 1:\s*\n\s*if \(a0 != gA && a0 != gB\) break;\s*\n\s*case 2:\s*\n\s*f\(a0\);\s*\n\s*break;/);
  expect(out.match(/\bf\(/g)).toHaveLength(1);
  expect(out).toMatch(/\}\s*\n\s*r\(0\);/);
});

// WHAT AN ELIDED DISPATCH LEAVES IN ITS REGISTERS. Past the bounds branch's delay slot (which runs on
// both paths and is lifted), the dispatch block is pruned, so each case target is entered with what
// its words wrote (jump-table.ts `enterCaseTarget`): an `sll` there leaves the scaled scrutinee, a
// value C spells; `lui`, `addu` and `lw` leave the table's, the entry's and the case's addresses,
// which a case may not read. No compiler measured reads one — IDO and KMC recompute the index in the
// case — so these are hand-written.
const scaledTable: AsmData = {
  ...asmData,
  sections: new Map([['.rodata', new Uint8Array([0, 0, 0, 0x24, 0, 0, 0, 0x2c])]]),
};
const shiftedAfterSlot = (c0slot: string) =>
  obj(
    ' 0:\tsltiu\tat,a0,0x2',
    ' 4:\tbeqz\tat,34 <f+0x34>',
    ' 8:\tnop',
    ' c:\tlui\tat,0x0',
    '10:\tsll\tv0,a0,0x2',
    '14:\taddu\tat,at,v0',
    '18:\tlw\tt6,0(at)',
    '1c:\tjr\tt6',
    '20:\tnop',
    '24:\tjr\tra',
    `28:\t${c0slot}`,
    '2c:\tjr\tra',
    '30:\tli\tv0,9',
    '34:\tjr\tra',
    '38:\tli\tv0,-1',
  );

test('an elided dispatch leaves its scaled index in a case, on IDO as on gcc', () => {
  for (const t of [MIPS_IDO, MIPS_GCC]) {
    expect(decompile('f', shiftedAfterSlot('addiu\tv0,v0,1'), t, { asmData: scaledTable }).source).toMatch(
      /case 0:\s*\n\s*return \(a0 << 2\) \+ 1;/,
    );
  }
});

test('a case reading the table, entry or code address the elided dispatch left DECLINES', () => {
  const stale = /a case of the elided jump table reads (at|t6), which the unlifted dispatch idiom wrote/;
  for (const t of [MIPS_IDO, MIPS_GCC]) {
    expect(() => decompile('f', shiftedAfterSlot('move\tv0,at'), t, { asmData: scaledTable })).toThrow(stale);
    expect(() => decompile('f', shiftedAfterSlot('move\tv0,t6'), t, { asmData: scaledTable })).toThrow(stale);
  }
});

// The scaled index at a target another case falls into (jump-table.ts `StaleScaledIndex.settle`):
// every path in brings it, so the case reads it; one that rewrote it on the way declines.
const fallTable: AsmData = {
  ...asmData,
  sections: new Map([['.rodata', new Uint8Array([0, 0, 0, 0x24, 0, 0, 0, 0x28])]]),
};
const fallsIntoScaled = (c0: string) =>
  obj(
    ' 0:\tsltiu\tat,a0,0x2',
    ' 4:\tbeqz\tat,30 <f+0x30>',
    ' 8:\tnop',
    ' c:\tlui\tat,0x0',
    '10:\tsll\tv0,a0,0x2',
    '14:\taddu\tat,at,v0',
    '18:\tlw\tt6,0(at)',
    '1c:\tjr\tt6',
    '20:\tnop',
    `24:\t${c0}`,
    '28:\tjr\tra',
    '2c:\taddiu\tv0,v0,1',
    '30:\tjr\tra',
    '34:\tli\tv0,-1',
  );

test('a case another falls into reads the scaled index both paths bring, on IDO as on gcc', () => {
  for (const t of [MIPS_IDO, MIPS_GCC]) {
    const out = decompile('f', fallsIntoScaled('sw\ta0,0(a1)'), t, { asmData: fallTable }).source;
    expect(out).toMatch(/case 0:\s*\n\s*\*a1 = a0;\s*\n\s*case 1:\s*\n\s*return \(a0 << 2\) \+ 1;/);
    expect(() => decompile('f', fallsIntoScaled('li\tv0,8'), t, { asmData: fallTable })).toThrow(
      /a case of the elided jump table reads v0, which the unlifted dispatch idiom wrote/,
    );
  }
});

// THE TABLE'S `%lo` FOLDED INTO THE LOAD. IDO 7.1, KMC and gcc 2.7.2 form a dispatch's base in its
// own block as `lui at,%hi(T) ; addu at,at,rI ; lw rV,%lo(T)(at)`, both relocations against the
// section symbol with addend 0 (REL): the table's offset lives only in the two immediates. So the
// second table of a unit is `lw rV,32(at)` (`synthetic:sw_jtloop2:ido7.1`), one 64 KiB in is
// `lui at,0x1 ; lw rV,0(at)`, and one 40 KiB in is `lui at,0x1 ; lw rV,-24576(at)`.
/** `.rodata` holding a decoy table at 0 (cases swapped) and the real one at `at`. */
const foldedTable = (at: number, lo: string | null): AsmData => {
  const bytes = new Uint8Array(at + 8);
  bytes.set([0, 0, 0, 0x28, 0, 0, 0, 0x20], 0);
  bytes.set([0, 0, 0, 0x20, 0, 0, 0, 0x28], at);
  return {
    sections: new Map([['.rodata', bytes]]),
    relocs: [
      { section: '.text', offset: 0xc, type: 'R_MIPS_HI16', sym: '.rodata', addend: 0 },
      ...(lo === null ? [] : [{ section: '.text', offset: 0x14, type: 'R_MIPS_LO16', sym: lo, addend: 0 }]),
      ...[0, 4, at, at + 4].map((offset) => ({
        section: '.rodata',
        offset,
        type: 'R_MIPS_32',
        sym: '.text',
        addend: 0,
      })),
    ],
    symbols: new Map([
      ['other', { section: '.rodata', value: 0, size: 8, index: 1 }],
      ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  };
};
const folded = (hi: string, disp: string) =>
  obj(
    ' 0:\tsltiu\tat,a0,0x2',
    ' 4:\tbeqz\tat,30 <f+0x30>',
    ' 8:\tsll\tt6,a0,0x2',
    ` c:\tlui\tat,${hi}`,
    '10:\taddu\tat,at,t6',
    `14:\tlw\tt6,${disp}(at)`,
    '18:\tjr\tt6',
    '1c:\tnop',
    '20:\tjr\tra',
    '24:\tli\tv0,5',
    '28:\tjr\tra',
    '2c:\tli\tv0,9',
    '30:\tjr\tra',
    '34:\tli\tv0,-1',
  );

test('a table whose %lo the load carries is read at both halves, past 32 and 64 KiB too', () => {
  for (const [hi, disp, at] of [
    ['0x0', '32', 32],
    ['0x1', '0', 0x10000],
    ['0x1', '-24576', 0xa000],
  ] as const) {
    for (const t of [MIPS_IDO, MIPS_GCC]) {
      const out = decompile('f', folded(hi, disp), t, { asmData: foldedTable(at, '.rodata') }).source;
      expect(out).toContain('switch (a0)');
      expect(out).toMatch(/case 0:\s*return 5;/);
      expect(out).toMatch(/case 1:\s*return 9;/);
    }
  }
});

test('a load displacement that is no paired %lo of the base declines', () => {
  const declines = /indirect jump 'jr t6'/;
  // No LO16: `table[a0 + 8]` off an unpaired `%hi`.
  expect(() => decompile('f', folded('0x0', '32'), MIPS_IDO, { asmData: foldedTable(32, null) })).toThrow(declines);
  // A LO16 on another symbol than the `lui`'s HI16, at any displacement.
  for (const disp of ['32', '0']) {
    expect(() => decompile('f', folded('0x0', disp), MIPS_IDO, { asmData: foldedTable(32, 'other') })).toThrow(
      declines,
    );
  }
});

// IDO `-KPIC` forms the base off the GOT: `lw at,%got(T)(gp)` (GOT16, its immediate the high
// half) and the load's own LO16, then adds gp to the gp-relative entry. The first table of a unit is
// at displacement 0; a later one is `lw rV,28(at)`, which stays refused (no benchmark row is PIC).
const picTable = (at: number, lo: string | null): AsmData => {
  const bytes = new Uint8Array(at + 8);
  bytes.set([0, 0, 0, 0x2c, 0, 0, 0, 0x24], 0);
  bytes.set([0, 0, 0, 0x24, 0, 0, 0, 0x2c], at);
  return {
    sections: new Map([['.rodata', bytes]]),
    relocs: [
      { section: '.text', offset: 0xc, type: 'R_MIPS_GOT16', sym: '.rodata', addend: 0 },
      ...(lo === null ? [] : [{ section: '.text', offset: 0x14, type: 'R_MIPS_LO16', sym: lo, addend: 0 }]),
      ...[0, 4, at, at + 4].map((offset) => ({
        section: '.rodata',
        offset,
        type: 'R_MIPS_GPREL32',
        sym: '.text',
        addend: 0,
      })),
    ],
    symbols: new Map([
      ['other', { section: '.rodata', value: 0, size: 8, index: 1 }],
      ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  };
};
const pic = (got: string, disp: string) =>
  obj(
    ' 0:\tsltiu\tat,a0,0x2',
    ' 4:\tbeqz\tat,34 <f+0x34>',
    ' 8:\tsll\tt6,a0,0x2',
    ` c:\tlw\tat,${got}(gp)`,
    '10:\taddu\tat,at,t6',
    `14:\tlw\tt6,${disp}(at)`,
    '18:\taddu\tt6,t6,gp',
    '1c:\tjr\tt6',
    '20:\tnop',
    '24:\tjr\tra',
    '28:\tli\tv0,5',
    '2c:\tjr\tra',
    '30:\tli\tv0,9',
    '34:\tjr\tra',
    '38:\tli\tv0,-1',
  );

test('an IDO -KPIC table is read at its GOT16 half and the LO16 the load carries', () => {
  for (const [got, at] of [
    ['0', 0],
    ['1', 0x10000],
  ] as const) {
    const out = decompile('f', pic(got, '0'), MIPS_IDO, { asmData: picTable(at, '.rodata') }).source;
    expect(out).toMatch(/case 0:\s*return 5;/);
    expect(out).toMatch(/case 1:\s*return 9;/);
  }
  const declines = /indirect jump 'jr t6'/;
  // A later table's folded `%lo` on a GOT16 base, and a LO16 on another symbol.
  expect(() => decompile('f', pic('0', '32'), MIPS_IDO, { asmData: picTable(32, '.rodata') })).toThrow(declines);
  expect(() => decompile('f', pic('0', '0'), MIPS_IDO, { asmData: picTable(0, 'other') })).toThrow(declines);
});

/** The same object with its `.rodata` renamed `.data`: the table in a writable section. */
const writable = (ad: AsmData): AsmData => {
  const sec = (x: string) => (x === '.rodata' ? '.data' : x);
  return {
    ...ad,
    sections: new Map([...ad.sections].map(([k, v]) => [sec(k), v])),
    relocs: ad.relocs.map((r) => ({ ...r, section: sec(r.section), sym: sec(r.sym) })),
    symbols: new Map([...ad.symbols].map(([k, v]) => [k, { ...v, section: sec(v.section) }])),
  };
};

test('a table in a writable section declines: a store may retarget an entry the table read missed', () => {
  // gcc puts a non-const computed-goto label table (`static void *t[] = {&&a, &&b}`) in `.data`,
  // and its function may write it (`t[1] = &&c`); a switch lifted from its initial words is wrong.
  const declines = /indirect jump 'jr t6'/;
  for (const t of [MIPS_IDO, MIPS_GCC]) {
    expect(decompile('f', dispatch('sll\tt6,a0,0x2', 't6'), t, { asmData }).source).toContain('switch (a0)');
    expect(() => decompile('f', dispatch('sll\tt6,a0,0x2', 't6'), t, { asmData: writable(asmData) })).toThrow(declines);
    expect(() => decompile('f', folded('0x0', '32'), t, { asmData: writable(foldedTable(32, '.rodata')) })).toThrow(
      declines,
    );
  }
});

test('a table entry naming code outside the function declines loud', () => {
  // The table's second word points past the function's last block (0x40), as one read off another
  // function's table would.
  const outside: AsmData = {
    ...asmData,
    sections: new Map([['.rodata', new Uint8Array([0, 0, 0, 0x20, 0, 0, 0, 0x40])]]),
  };
  for (const t of [MIPS_IDO, MIPS_GCC]) {
    expect(() => decompile('f', dispatch('sll\tt6,a0,0x2', 't6'), t, { asmData: outside })).toThrow(
      FrontendUnsupportedError,
    );
    expect(() => decompile('f', dispatch('sll\tt6,a0,0x2', 't6'), t, { asmData: outside })).toThrow(
      /jump-table target is not a block boundary/,
    );
  }
});
