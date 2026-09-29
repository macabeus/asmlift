// Reading a function-scope static's definition out of the target (frontend/local-object.ts), over
// compiled listings rather than invented ones.
//
//   corpus/agbcc-local-statics.s   agbcc 2.9 `-mthumb-interwork -O2 -fhex-asm` over the C below
//   corpus/agbcc-inline-static.s   the same compiler over a `static inline` callee used by A and B
//   corpus/agbcc-static-data-word.s  the same compiler over a static whose initializer names another
//   corpus/agbcc-static-escapes.s  the same compiler over statics whose strings carry `\b` and `\f`
//   corpus/mwcc-local-statics.txt  `objdump -s -r -t` of mwcc_242_81 `-O4,s -inline auto` over m2.c
//   corpus/mwcc-dump-*.txt         the published `asmDump` of three benchmark rows, as the harness
//                                  hands it to asmlift
//   corpus/mwcc-zero-statics.{txt,asm}  the side table and disassembly of mwcc_242_81 at its
//                                  canonical flags over
//     u32 zeromix(void) { static u32 a = 0; static u32 b; static u32 c = 0; return a + b + c; }
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
// agbcc-static-data-word.s:
//   s32 X(s32 i) { return i + 1; }
//   s32 T(s32 i) { static const u8 tide[2] = {1, 2}; static const u8 *const ptr = tide; return tide[i] + *ptr; }
// agbcc-static-escapes.s:
//   struct E { u8 a; char s[3]; };
//   const char *k1(s32 i) { static const char t[][4] = {"ab", "c\b", "de"}; return t[i]; }
//   const u8 *h5(void) { static const struct E t[] = {{1, "\f"}, {2, "x"}}; return &t[0].a; }
//   u8 g1(s32 i) { static const char s[] = "hello!"; return s[i]; }
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
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC, PPC_MWCC } from '../src/target';

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
    directives: { align: 1, unit: 1, negative: false, string: false },
  });
});

test('agbcc: the directives say the element width, a narrow negative says signed, `.align` the alignment', () => {
  const dir = (sym: string) => {
    const r = readGasLocalObject(agbcc, sym);
    return 'refused' in r ? r.refused : r.directives;
  };
  expect(dir('cs.7')).toEqual({ align: 2, unit: 2, negative: true, string: false }); // `.short -0x1` under `.align 1`
  // `.word -0x80000000` is the u32 0x80000000: a word's sign says nothing
  expect(dir('w.19')).toEqual({ align: 4, unit: 4, negative: false, string: false });
  expect(dir('str.31')).toEqual({ align: 4, unit: 1, negative: false, string: true }); // a string is word-aligned
  expect(dir('st.35')).toEqual({ align: 4, negative: false, string: false }); // `.byte`, `.space`, `.word`: no one width
  expect(dir('big.39')).toEqual({ align: 2, unit: 2, negative: false, string: false }); // the `.space` tail is padding
  expect(readGasLocalObject('.data\n\t.balign 4\nx.1:\n\t.word 1\n', 'x.1')).toMatchObject({
    refused: 'whose alignment directive this reader does not read',
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

test('agbcc: every escape agbcc writes in a string decodes, so an unsized object keeps its whole run', () => {
  // neither object has a `.size` to catch a run that ended early
  const asm = corpus('agbcc-static-escapes.s');
  expect(bytes(readGasLocalObject(asm, 't.3'))).toEqual([0x61, 0x62, 0, 0, 0x63, 8, 0, 0, 0x64, 0x65, 0, 0]);
  expect(bytes(readGasLocalObject(asm, 't.7'))).toEqual([1, 12, 0, 0, 2, 0x78, 0, 0]);
});

test('agbcc: a directive inside the run that is not data refuses rather than ending the object', () => {
  expect(readGasLocalObject('.data\nx.1:\n\t.byte 1\n\t.fill 2, 1, 0\n\t.byte 2\n', 'x.1')).toEqual({
    refused: "whose data run holds '.fill', a directive this reader does not read as bytes",
  });
  expect(readGasLocalObject('.data\nx.1:\n\t.ascii "a\\v"\n', 'x.1')).toMatchObject({
    refused: expect.stringContaining("'.ascii'"),
  });
  // the next object's alignment ends it
  expect(bytes(readGasLocalObject('.data\nx.1:\n\t.byte 1\n\t.align 2, 0\ny.2:\n\t.word 3\n', 'x.1'))).toEqual([1]);
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

test("agbcc: a data word naming a static is another static's initializer, not a referrer", () => {
  // `ptr.7`'s `.word tide.6` sits in .rodata after X's code and before T's: it is T's, and no pool
  const asm = corpus('agbcc-static-data-word.s');
  expect([...gasPoolReferrers(asm, 'tide.6')]).toEqual(['T']);
  expect(decompile('T', asm, ARMV4T_AGBCC).source).toContain('    static const u8 tide[2] = { 1, 2 };\n');
});

test('mwcc: the symbol table gives the section and size, the section contents the bytes, .comment the alignment', () => {
  const ad = dump('mwcc-local-statics.txt');
  expect(readObjectLocalObject(ad, 'kt$18', 'rtab')).toEqual({
    name: 'kt',
    symbol: 'kt$18',
    order: 18,
    section: 'rodata',
    size: 12,
    bytes: Uint8Array.from([0, 0, 0, 7, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 9]),
    bigEndian: true,
    placement: { align: 4, section: '.rodata', offset: 0 },
  });
  // an aggregate initialized to zero stays in .data under mwcc
  expect(bytes(readObjectLocalObject(ad, 'zz$23', 'zdata'))).toEqual([0, 0, 0, 0]);
});

test('mwcc: a bss static laid out ahead of a later-declared one had `= 0`', () => {
  // .sbss holds a$4 +0, c$6 +4, b$5 +8: the zero scalars first in declaration order, then the one
  // with no initializer. c, the last of the rising run, lands there declared either way
  const asm = corpus('mwcc-zero-statics.asm');
  const ad = dump('mwcc-zero-statics.txt');
  expect(decompile('zeromix', asm, PPC_MWCC, { asmData: ad }).source).toContain(
    '    static u32 a = 0;\n    static u32 b;\n    static u32 c;\n',
  );
  // eight bytes read a word at a time are two elements, and no array is moved to bss for its zeros
  ad.symbols.set('a$4', { ...ad.symbols.get('a$4')!, size: 8 });
  expect(() => decompile('zeromix', asm, PPC_MWCC, { asmData: ad })).toThrow(
    "names a function-scope static ('a$4') laid out ahead of a static declared after it, as only a scalar " +
      'initialized to zero is, but of 2 elements',
  );
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
  // the .debug section names the static too; debug information is not a referrer. It is an OSTime,
  // an s64, and mwcc's .comment records the 8 bytes it is aligned to
  expect(
    readObjectLocalObject(dump('mwcc-dump-JW_JUTGamePad_read.txt'), 'last_pad_read$256', 'JW_JUTGamePad_read'),
  ).toEqual({
    name: 'last_pad_read',
    symbol: 'last_pad_read$256',
    order: 256,
    section: 'bss',
    size: 8,
    bigEndian: true,
    placement: { align: 8, section: '.bss', offset: 0 },
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
  ad.symbols.set('odd$1', { section: '.ctors', value: 0, size: 4, index: ad.symbolCount + 1 });
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
  // agbcc keeps `= 0` in .data, so one element holding zero there is the scalar it reads as
  expect(decompile('fd', agbcc, ARMV4T_AGBCC).source).toContain('    static u32 q = 0;\n');
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
    "names a function-scope static ('tide.3') whose source name 'tide' is also a global this one names",
  );
});

test('the definition decides the element: a byte table read a halfword at a time is still bytes', () => {
  const asm = thumbFn(rodata('t.3', [1, 2, 3, 4]), '\tldr\tr1, .L3\n\tldrh\tr0, [r1, #0x2]', ['t.3']);
  expect(decompile('f', asm, ARMV4T_AGBCC).source).toContain('    static const u8 t[4] = { 1, 2, 3, 4 };\n');
});

test('an alignment wider than the elements is stated, one narrower declines', () => {
  // a struct of bytes: `.align 2` over `.byte`s, handed to a callee
  const struct = thumbFn(
    ['\t.section .rodata', '\t.align\t2, 0', 't.3:', '\t.byte\t0x1', '\t.byte\t0x2', '\t.short\t0x3'].join('\n'),
    '\tpush\t{lr}\n\tldr\tr0, .L3\n\tbl\tuse\n\tpop\t{r0}',
    ['t.3'],
  );
  expect(decompile('f', struct, ARMV4T_AGBCC).source).toContain(
    '    static const u8 t[4] __attribute__((aligned(4))) = { 1, 2, 3, 0 };\n',
  );
  const packed = thumbFn(['\t.section .rodata', 't.3:', '\t.word\t0x1'].join('\n'), '\tldr\tr1, .L3\n\tldr\tr0, [r1]', [
    't.3',
  ]);
  expect(() => decompile('f', packed, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('t.3') whose definition is aligned to 1 bytes, less than the 4 its declaration here would get",
  );
});

test('a byte array the listing wrote as a string, at the string alignment, is initialized by a string literal', () => {
  // agbcc word-aligns `static const char str[] = "hello"` for its STRING_CST initializer; the
  // literal is what gives the definition that alignment, where a byte list would need an attribute
  expect(decompile('fh', agbcc, ARMV4T_AGBCC).source).toContain('    static const u8 str[6] = "hello";\n');
  // an array of strings is no string literal and keeps its element's alignment: a byte list
  const escapes = corpus('agbcc-static-escapes.s');
  expect(decompile('k1', escapes, ARMV4T_AGBCC).source).toContain('    static const u8 t[12] = {\n');
  // quotes, backslashes, a trigraph's second `?` and unprintables are octal; trailing zeros are the size's
  const odd = thumbFn(
    ['\t.section .rodata', '\t.align\t2, 0', 't.3:', '\t.ascii\t"a\\"b\\\\??\\001\\000\\000"'].join('\n'),
    '\tldr\tr1, .L3\n\tldrb\tr0, [r1, r0]',
    ['t.3'],
  );
  expect(decompile('f', odd, ARMV4T_AGBCC).source).toContain('    static const u8 t[9] = "a\\042b\\134?\\077\\001";\n');
});

test('a target whose compiler declares no static layout declines the static', () => {
  const { staticLayout: _, ...behaviors } = ARMV4T_AGBCC.compilerBehaviors;
  expect(() => decompile('fa', agbcc, { ...ARMV4T_AGBCC, compilerBehaviors: behaviors })).toThrow(
    "names a function-scope static ('tide.3') whose layout rules this target's compiler does not declare",
  );
});

test('without one width in the definition, accesses that disagree or do not divide the object decline', () => {
  const mixed = (lines: string[]) => ['\t.section .rodata', '\t.align\t1, 0', 't.3:', ...lines].join('\n');
  const twoWidths = thumbFn(
    mixed(['\t.byte\t0x1', '\t.byte\t0x2', '\t.short\t0x403']),
    '\tldr\tr1, .L3\n\tldrb\tr0, [r1]\n\tldrh\tr1, [r1, #0x2]\n\tadd\tr0, r0, r1',
    ['t.3'],
  );
  expect(() => decompile('f', twoWidths, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('t.3') whose accesses disagree on its element width (1 and 2 bytes)",
  );
  const odd = thumbFn(mixed(['\t.byte\t0x1', '\t.short\t0x2']), '\tldr\tr1, .L3\n\tldrh\tr0, [r1]', ['t.3']);
  expect(() => decompile('f', odd, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('t.3') whose 2-byte elements do not divide its 3 bytes",
  );
});

test('an element of a struct array is read at its field, not at the stride', () => {
  // agbcc over `static const struct { s32 a; s16 b; s16 c; } t[2]; return t[i].a;` — the load is
  // an 8-byte-stride aload of the 4-byte field at 0, and the directives name no one width
  const asm = [
    '\t.section .rodata',
    '\t.align\t2, 0',
    't.3:',
    ...['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'].map((v, i) => `\t.${i % 3 === 0 ? 'word' : 'short'}\t${v}`),
    thumbFn('', '\tldr\tr1, .L3\n\tlsl\tr0, r0, #0x3\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]', ['t.3']),
  ].join('\n');
  expect(decompile('f', asm, ARMV4T_AGBCC).source).toContain(
    '    static const u32 t[4] = { 1, 0x30002, 4, 0x60005 };\n',
  );
});

test('the loads settle the signedness, and the definition only where no load of the element does', () => {
  const bytes = ['\t.section .rodata', 't.3:', '\t.byte\t-0x1', '\t.byte\t0x2'].join('\n');
  // read zero-extended: the function computes with u8, and the byte is 0xff declared either way
  const read = thumbFn(bytes, '\tldr\tr1, .L3\n\tldrb\tr0, [r1]', ['t.3']);
  expect(decompile('f', read, ARMV4T_AGBCC).source).toContain('    static const u8 t[2] = { 0xff, 2 };\n');
  // handed on, never loaded: the negative directive is the only word on it
  const handed = thumbFn(bytes, '\tpush\t{lr}\n\tldr\tr0, .L3\n\tbl\tuse\n\tpop\t{r0}', ['t.3']);
  expect(decompile('f', handed, ARMV4T_AGBCC).source).toContain('    static const s8 t[2] = { -1, 2 };\n');
  // agbcc over `static const struct { s16 x; u8 id; u8 pad; } t[2] = {{-1, 5, 0}, {-2, 6, 0}};
  // return t[i].id;` — the negative is field x's `.short`, and says nothing of the byte `id`
  const struct = thumbFn(
    [
      '\t.section .rodata',
      '\t.align\t2, 0',
      't.3:',
      ...['\t.short\t-0x1', '\t.byte\t0x5', '\t.byte\t0x0', '\t.short\t-0x2', '\t.byte\t0x6', '\t.byte\t0x0'],
    ].join('\n'),
    '\tldr\tr1, .L3\n\tlsl\tr0, r0, #0x2\n\tadd\tr0, r0, r1\n\tldrb\tr0, [r0, #0x2]',
    ['t.3'],
  );
  expect(decompile('f', struct, ARMV4T_AGBCC).source).toContain(
    '    static const u8 t[8] __attribute__((aligned(4))) = { 0xff, 0xff, 5, 0, 0xfe, 0xff, 6, 0 };\n',
  );
});

test('a static named like a function this one calls declines', () => {
  const asm = thumbFn(rodata('g.3', [1, 2]), '\tpush\t{lr}\n\tldr\tr0, .L3\n\tbl\tg\n\tpop\t{r0}', ['g.3']);
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(
    "names a function-scope static ('g.3') whose source name 'g' is also a function this one names",
  );
});

test('the IR names a static by its linker name, so a map global of its source name stays another object', () => {
  // agbcc over `extern u32 gBase; void f(void) { static const u8 tide[4] = {1,2,3,4}; use(tide);
  // *(u32 *)((u8 *)&gBase + 4) = 7; gBase = 3; }`, with a map that puts a global `tide` at gBase+4:
  // raise/offsetnames.ts names that store `tide`, the map's, which is not the static
  const asm = thumbFn(
    rodata('tide.3', [1, 2, 3, 4]),
    [
      '\tpush\t{lr}\n\tldr\tr0, .L3\n\tbl\tuse\n\tldr\tr0, .L3+0x4\n\tmov\tr1, #0x7\n\tstr\tr1, [r0]',
      '\tsub\tr0, r0, #0x4\n\tmov\tr1, #0x3\n\tstr\tr1, [r0]\n\tpop\t{r0}',
    ].join('\n'),
    ['tide.3', 'gBase+0x4'],
  );
  const plain = decompile('f', asm, ARMV4T_AGBCC);
  expect(plain.ir.raw).toContain('gaddr {sym="tide.3"}');
  expect(plain.source).toContain('    static const u8 tide[4] = { 1, 2, 3, 4 };\n    use((u8 *)tide);\n');
  const symbols: SymbolMap = new Map([
    [0x03000000, [{ name: 'gBase', kind: 'data', size: 4, shape: 'scalar' }]],
    [0x03000004, [{ name: 'tide', kind: 'data', size: 4, shape: 'scalar' }]],
  ]);
  expect(() => decompile('f', asm, ARMV4T_AGBCC, { symbols })).toThrow(
    "names a function-scope static ('tide.3') whose source name 'tide' is also a global this one names",
  );
});

test("a pool word naming the function's predefined name declines rather than naming a global", () => {
  // agbcc puts `__FUNCTION__` in `.LC0`; a listing that names `__FUNCTION__.2` still has no spelling
  const asm = thumbFn(rodata('__FUNCTION__.2', [0x66, 0]), '\tldr\tr0, .L3', ['__FUNCTION__.2']);
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow("names the function's predefined name ('__FUNCTION__.2')");
});

test("mwcc: a .comment that is not mwcc's, or does not hold one record per symbol, refuses", () => {
  const ad = dump('mwcc-local-statics.txt');
  const comment = ad.sections.get('.comment')!;
  ad.sections.set('.comment', comment.subarray(0, comment.length - 8));
  expect(readObjectLocalObject(ad, 'kt$18', 'rtab')).toMatchObject({
    refused: "whose alignment the object's `.comment` section does not record",
  });
  ad.sections.delete('.comment');
  expect(readObjectLocalObject(ad, 'kt$18', 'rtab')).toMatchObject({ refused: expect.stringContaining('.comment') });
});
