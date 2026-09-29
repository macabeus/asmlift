// Reading a function-scope static's definition out of the target (frontend/local-object.ts), over
// compiled listings rather than invented ones.
//
//   corpus/agbcc-local-statics.s   agbcc 2.9 `-mthumb-interwork -O2 -fhex-asm` over the C below
//   corpus/agbcc-inline-static.s   the same compiler over a `static inline` callee used by A and B
//   corpus/mwcc-local-statics.txt  `objdump -s -r -t` of mwcc_242_81 `-O4,s -inline auto` over m2.c
//   corpus/mwcc-dump-*.txt         the published `asmDump` of three benchmark rows, as the harness
//                                  hands it to asmlift
//
// agbcc-local-statics.s:
//   int fa(int i) { static const u8 tide[] = {1,2,3}; return tide[i]; }
//   int fb(int i) { static const short cs[3] = {-1, 2, 3}; return cs[i]; }
//   int fc(int i) { static u8 z[3]; z[i] = 1; return z[0]; }
//   int fd(void) { static int q = 0; return q++; }
//   int fe(int i) { static const u32 w[2] = {0x80000000, 5}; return w[i]; }
//   int ff(int i) { static const char *s[2] = {"ab", "cd"}; return s[i][0]; }
//   int fg(int i) { static int *p = &g; return p[i]; }
//   int fh(int i) { static const char str[] = "hello"; return str[i]; }
//   int fi(int i) { static struct S st = {1, 2}; return st.b + i; }   // struct S { u8 a; u32 b; }
//   int fj(int i) { static const u16 big[40] = {1,2}; return big[i]; }
//   int fk(int i) { static const float fl[2] = {1.0f, 2.5f}; return *(int*)&fl[i]; }
// agbcc-inline-static.s:
//   static inline int counter(void) { static int n; return ++n; }
//   static inline int tab(int i) { static const unsigned char t[4] = {9,8,7,6}; return t[i]; }
//   int A(int i) { return counter() + tab(i); }
//   int B(void) { return counter(); }
// mwcc-local-statics.txt (m2.c):
//   static int counter(void) { static int n; return ++n; }
//   int A(void) { return counter() + 1; }
//   int B(void) { return counter(); }
//   s32 rtab(int i) { static const s32 kt[3] = {7, -1, 9}; return kt[i]; }
//   int zdata(int i) { static int zz[1] = {0}; return zz[i]; }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { parseAsmData } from '../src/frontend/asmdata';
import {
  type LocalObjectRead,
  gasPoolReferrers,
  readGasLocalObject,
  readObjectLocalObject,
} from '../src/frontend/local-object';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const corpus = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');
const agbcc = corpus('agbcc-local-statics.s');
const dump = (f: string) => {
  const t = corpus(f);
  return parseAsmData(t, t, t, true);
};
const bytes = (r: LocalObjectRead) => ('refused' in r ? r.refused : [...(r.bytes ?? [])]);

test('agbcc: an unsized initialized static is the data run under its label', () => {
  // `static const u8 tide[] = {…}` has `.type` and no `.size`; the run ends at the `.text` switch.
  expect(readGasLocalObject(agbcc, 'tide.3')).toEqual({
    name: 'tide',
    symbol: 'tide.3',
    order: 3,
    section: 'rodata',
    size: 3,
    bytes: Uint8Array.from([1, 2, 3]),
    bigEndian: false,
  });
});

test('agbcc: a sized static reads its halfwords little-endian, and `.size` agrees', () => {
  const r = readGasLocalObject(agbcc, 'cs.7');
  expect(r).toMatchObject({ name: 'cs', section: 'rodata', size: 6 });
  expect(bytes(r)).toEqual([0xff, 0xff, 2, 0, 3, 0]);
});

test('agbcc: a static with no initializer is `.lcomm`, bss, at its exact size', () => {
  expect(readGasLocalObject(agbcc, 'z.11')).toEqual({
    name: 'z',
    symbol: 'z.11',
    order: 11,
    section: 'bss',
    size: 3,
    bigEndian: false,
  });
});

test('agbcc: `= 0` stays in .data — agbcc 2.9 has no zero-to-bss rule', () => {
  const r = readGasLocalObject(agbcc, 'q.15');
  expect(r).toMatchObject({ section: 'data', size: 4 });
  expect(bytes(r)).toEqual([0, 0, 0, 0]);
});

test('agbcc: words, strings, `.space` padding and a long `.space` tail all read as bytes', () => {
  expect(bytes(readGasLocalObject(agbcc, 'w.19'))).toEqual([0, 0, 0, 0x80, 5, 0, 0, 0]);
  expect(bytes(readGasLocalObject(agbcc, 'str.31'))).toEqual([...'hello'].map((c) => c.charCodeAt(0)).concat(0));
  expect(bytes(readGasLocalObject(agbcc, 'st.35'))).toEqual([1, 0, 0, 0, 2, 0, 0, 0]);
  const big = readGasLocalObject(agbcc, 'big.39');
  expect(big).toMatchObject({ size: 80 });
  expect(bytes(big)).toEqual([1, 0, 2, 0, ...new Array(76).fill(0)]);
  // a leading-zero count is octal to the assembler
  expect(readGasLocalObject('.data\nx.1:\n\t.space\t010\n', 'x.1')).toMatchObject({ size: 8 });
  // a float word carries its value in a trailing `@` comment, which is not an operand
  expect(bytes(readGasLocalObject(agbcc, 'fl.43'))).toEqual([0, 0, 0x80, 0x3f, 0, 0, 0x20, 0x40]);
});

test('agbcc: an initializer holding an address refuses — the word is relocated', () => {
  expect(readGasLocalObject(agbcc, 's.23')).toEqual({
    refused: "whose initializer holds the address '.LC5' — a relocation inside the object",
  });
  expect(readGasLocalObject(agbcc, 'p.27')).toMatchObject({ refused: expect.stringContaining("the address 'g'") });
  // the lift opens the sentence with the static it could not define
  expect(() => decompile('fg', agbcc, ARMV4T_AGBCC)).toThrow(
    "cannot lift 'fg': literal-pool load of a pool word that names a function-scope static ('p.27') whose " +
      "initializer holds the address 'g'",
  );
});

test('agbcc: no definition, a doubled label and a non-static name refuse', () => {
  expect(readGasLocalObject(agbcc, 'nope.9')).toEqual({
    refused: 'whose definition this asm does not carry',
  });
  expect(readGasLocalObject(`${agbcc}\n.data\ntide.3:\n\t.byte 1\n`, 'tide.3')).toMatchObject({
    refused: expect.stringContaining('defined twice'),
  });
  expect(readGasLocalObject(agbcc, 'fa')).toMatchObject({ refused: expect.stringContaining('no source spelling') });
});

test('agbcc: a `.size` that disagrees with the bytes under the label refuses', () => {
  const lying = agbcc.replace('.size\t cs.7,6', '.size\t cs.7,8');
  expect(readGasLocalObject(lying, 'cs.7')).toMatchObject({
    refused: expect.stringContaining("'.size' (8) disagrees"),
  });
});

test('agbcc: a static of an inlined callee sits ahead of its first caller, and every caller names it', () => {
  // `n.3` belongs to `counter`, which both A and B inlined: the data position says nothing, the
  // pools do. `t.7` belongs to `tab`, which only A inlined, so A alone names it.
  const asm = corpus('agbcc-inline-static.s');
  expect([...gasPoolReferrers(asm, 'n.3')].sort()).toEqual(['A', 'B']);
  expect([...gasPoolReferrers(asm, 't.7')]).toEqual(['A']);
  expect(readGasLocalObject(asm, 'n.3')).toMatchObject({ section: 'bss', size: 4 });
});

test('mwcc: the symbol table gives the section and size, the section contents the bytes', () => {
  const ad = dump('mwcc-local-statics.txt');
  expect(readObjectLocalObject(ad, 'kt$18', 'rtab')).toEqual({
    name: 'kt',
    symbol: 'kt$18',
    order: 18,
    section: 'rodata',
    size: 12,
    bytes: Uint8Array.from([0, 0, 0, 7, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 9]),
    bigEndian: true,
  });
  // an aggregate initialized to zero stays in .data under mwcc
  expect(bytes(readObjectLocalObject(ad, 'zz$23', 'zdata'))).toEqual([0, 0, 0, 0]);
});

test("mwcc: a static every inliner names is not one function's", () => {
  // -inline auto: `counter`, A and B all address `n$4`.
  expect(readObjectLocalObject(dump('mwcc-local-statics.txt'), 'n$4', 'A')).toMatchObject({
    refused: expect.stringContaining("that .text also names at 0x2 — it is not this function's alone"),
  });
});

test('mwcc: benchmark rows — .data table, .bss scalar, and a pointer table that refuses', () => {
  const lbrk = readObjectLocalObject(dump('mwcc-dump-lbRk_SeirekiDays.txt'), 't_seiyo_days_tbl$32', 'lbRk_SeirekiDays');
  expect(lbrk).toMatchObject({ name: 't_seiyo_days_tbl', section: 'data', size: 0x1a });
  expect(bytes(lbrk).slice(0, 4)).toEqual([0x00, 0x1f, 0x1c, 0x1f]);
  // the .debug section names the static too; debug information is not a referrer
  expect(
    readObjectLocalObject(dump('mwcc-dump-JW_JUTGamePad_read.txt'), 'last_pad_read$256', 'JW_JUTGamePad_read'),
  ).toEqual({
    name: 'last_pad_read',
    symbol: 'last_pad_read$256',
    order: 256,
    section: 'bss',
    size: 8,
    bigEndian: true,
  });
  expect(
    readObjectLocalObject(dump('mwcc-dump-mCoBG_MakeJumpFlag.txt'), 'make_jump_flag_proc$320', 'mCoBG_MakeJumpFlag'),
  ).toMatchObject({ refused: expect.stringContaining('a relocation inside the object') });
});

test('mwcc: an absent symbol and a section that is not data refuse', () => {
  const ad = dump('mwcc-local-statics.txt');
  expect(readObjectLocalObject(ad, 'nope$9', 'rtab')).toMatchObject({
    refused: expect.stringContaining('does not carry'),
  });
  ad.symbols.set('odd$1', { section: '.ctors', value: 0, size: 4 });
  expect(readObjectLocalObject(ad, 'odd$1', 'rtab')).toMatchObject({
    refused: expect.stringContaining("section '.ctors'"),
  });
});

// ── The lift: a static becomes a definition in the body, or a decline naming why ────────────────

/** One agbcc-shaped function reading pool words `words` through `body`, after `data`. */
const thumbFn = (data: string, body: string, words: string[]) =>
  [
    data,
    '.text',
    '\t.align\t2, 0',
    '\t.globl\tf',
    '\t.type\t f,function',
    '\t.thumb_func',
    'f:',
    body,
    '\tbx\tlr',
    '.L4:',
    '\t.align\t2, 0',
    '.L3:',
    ...words.map((w) => `\t.word\t${w}`),
  ].join('\n');
const rodata = (sym: string, bytes: number[]) =>
  ['\t.section .rodata', `${sym}:`, ...bytes.map((b) => `\t.byte\t0x${b.toString(16)}`)].join('\n');

test('the static is defined in the body under its source name, typed by the access', () => {
  // corpus functions, sliced out of one file: an unsized rodata table, a bss array, `= 0` data
  expect(decompile('fa', agbcc, ARMV4T_AGBCC).source).toBe(
    's32 fa(s32 a0) {\n    static const u8 tide[3] = { 1, 2, 3 };\n    return tide[a0];\n}\n',
  );
  expect(decompile('fc', agbcc, ARMV4T_AGBCC).source).toContain('    static u8 z[3];\n');
  // one element holding zero is an ARRAY: mwcc moves a zero scalar to .bss and keeps an aggregate
  expect(decompile('fd', agbcc, ARMV4T_AGBCC).source).toContain('    static u32 q[1] = { 0 };\n');
  // a sign-extending load types the elements signed, and a long table wraps eight to a line
  expect(decompile('fb', agbcc, ARMV4T_AGBCC).source).toContain('    static const s16 cs[3] = { -1, 2, 3 };\n');
  expect(decompile('fj', agbcc, ARMV4T_AGBCC).source).toContain(
    '    static const u16 big[40] = {\n        1, 2, 0, 0, 0, 0, 0, 0,\n',
  );
});

test('statics are declared in the order their counters record, not by name', () => {
  // the compiler lays a function's statics out in declaration order, and the counter IS that order
  const asm = thumbFn(
    `${rodata('zeta.3', [1, 2])}\n${rodata('alpha.4', [3, 4])}`,
    '\tldr\tr1, .L3+0x4\n\tldrb\tr0, [r1]\n\tldr\tr1, .L3\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, r1',
    ['zeta.3', 'alpha.4'],
  );
  const src = decompile('f', asm, ARMV4T_AGBCC).source;
  expect(src.indexOf('zeta[2]')).toBeGreaterThan(-1);
  expect(src.indexOf('zeta[2]')).toBeLessThan(src.indexOf('alpha[2]'));
});

test('two statics sharing a source name decline — one block cannot declare both', () => {
  const asm = thumbFn(
    `${rodata('a.3', [1, 2])}\n${rodata('a.7', [3, 4])}`,
    '\tldr\tr1, .L3\n\tldrb\tr0, [r1]\n\tldr\tr1, .L3+0x4\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, r1',
    ['a.3', 'a.7'],
  );
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('a.7') whose source name 'a' another static here ('a.3') also has",
  );
});

test('a static sharing its name with a global the function names declines — the static would hide it', () => {
  const asm = thumbFn(
    rodata('tide.3', [1, 2]),
    '\tldr\tr1, .L3\n\tldrb\tr0, [r1]\n\tldr\tr1, .L3+0x4\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, r1',
    ['tide.3', 'tide'],
  );
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('tide.3') whose source name 'tide' is also a global this function names",
  );
});

test('accesses that disagree on the element, or do not divide the object, decline', () => {
  const twoWidths = thumbFn(
    rodata('t.3', [1, 2, 3, 4]),
    '\tldr\tr1, .L3\n\tldrb\tr0, [r1]\n\tldrh\tr1, [r1, #0x2]\n\tadd\tr0, r0, r1',
    ['t.3'],
  );
  expect(() => decompile('f', twoWidths, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('t.3') whose accesses disagree on its element width (1 and 2 bytes)",
  );
  const odd = thumbFn(rodata('t.3', [1, 2, 3]), '\tldr\tr1, .L3\n\tldrh\tr0, [r1]', ['t.3']);
  expect(() => decompile('f', odd, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('t.3') whose 2-byte accesses do not divide its 3 bytes into elements",
  );
});

test('a static named like a function this one calls declines', () => {
  const asm = thumbFn(rodata('g.3', [1, 2]), '\tpush\t{lr}\n\tldr\tr0, .L3\n\tbl\tg\n\tpop\t{r0}', ['g.3']);
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('g.3') whose source name 'g' is also a function this one names",
  );
});
