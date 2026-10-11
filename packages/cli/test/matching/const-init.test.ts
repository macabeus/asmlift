// A LOCAL AGGREGATE'S CONSTANT INITIALIZER, end to end through decompile() and the real agbcc:
// reference C declaring `T a[N] = {…}` inside the function → target (agbcc copies the image from an
// anonymous `.LC` constant with `memcpy`) → lift → the candidate declares the local with that
// initializer again → compiled → scored, and the candidate's `.rodata` compared with the target's
// byte for byte, because a score cannot see what the image holds: the code only names its address.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { assembleTarget, compileCandAgbcc, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/** An ELF32 little-endian object's `.rodata` contents and alignment. */
function rodata(obj: string): { align: number; bytes: number[] } | undefined {
  const b = readFileSync(obj);
  const shoff = b.readUInt32LE(0x20);
  const size = b.readUInt16LE(0x2e);
  const shstr = b.readUInt32LE(shoff + b.readUInt16LE(0x32) * size + 16);
  for (let i = 0; i < b.readUInt16LE(0x30); i++) {
    const h = shoff + i * size;
    const at = shstr + b.readUInt32LE(h);
    if (b.toString('latin1', at, b.indexOf(0, at)) === '.rodata') {
      const off = b.readUInt32LE(h + 16);
      return { align: b.readUInt32LE(h + 32), bytes: [...b.subarray(off, off + b.readUInt32LE(h + 20))] };
    }
  }
  return undefined;
}

const USE = 'extern void g(void *);\n';
const PROTOS = { g: { params: ['void *'], returnsVoid: true } };

const CASES: { sym: string; c: string; spelled: RegExp }[] = [
  {
    // kleod:sub_0804C898's shape: nothing reads the array, and agbcc copies it anyway
    sym: 'dead16',
    c: 'void dead16(void) { u8 a[16] = {0, 1, 2, 4, 6, 4, 2, 1, 0, -1, -2, -4, -6, -4, -2, -1}; }',
    spelled:
      /u8 sp0\[16\] = \{\n {8}0, 1, 2, 4, 6, 4, 2, 1,\n {8}0, 0xff, 0xfe, 0xfc, 0xfa, 0xfc, 0xfe, 0xff,\n {4}\};/,
  },
  {
    // a signed element writes its negatives, and the address handed on says nothing of the type
    sym: 'bytes8',
    c: `${USE}void bytes8(void) { s8 a[8] = {0, 1, -1, -2, 3, 4, 5, -6}; g(a); }`,
    spelled: /s8 sp0\[8\] = \{ 0, 1, -1, -2, 3, 4, 5, -6 \};/,
  },
  {
    // a halfword image in a reservation the frame rounds to 8
    sym: 'halves3',
    c: `${USE}void halves3(void) { u16 a[3] = {1, 0xffff, 3}; g(a); }`,
    spelled: /u16 sp0\[3\] = \{ 1, 0xffff, 3 \};/,
  },
  {
    sym: 'shalves3',
    c: `${USE}void shalves3(void) { s16 a[3] = {1, -1, 3}; g(a); }`,
    spelled: /s16 sp0\[3\] = \{ 1, -1, 3 \};/,
  },
  {
    // a string literal's image is spelled as one, which is what word-aligns it
    sym: 'text9',
    c: `${USE}void text9(void) { char a[] = "hi there"; g(a); }`,
    spelled: /u8 sp0\[9\] = "hi there";/,
  },
  {
    // the elements the initializer left out are a `.space` in the image, and stay left out: spelled
    // as seventeen zeros, the constructor is mostly zero and agbcc clears and stores instead
    sym: 'tail20',
    c: `${USE}void tail20(void) { u32 a[20] = {1, 2, 3}; g(a); }`,
    spelled: /u32 sp0\[20\] = \{ 1, 2, 3 \};/,
  },
  {
    // …while zeros the source spelled are `.word 0x0` in the image, and are spelled again
    sym: 'zeros20',
    c: `${USE}void zeros20(void) { u32 a[20] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0}; g(a); }`,
    spelled: /u32 sp0\[20\] = \{\n {8}1, 2, 3, 4, 5, 6, 7, 8,\n {8}9, 0, 0, 0,\n {4}\};/,
  },
  {
    // the frame audit types the reservation by bytes; the halfword read says the element is wider
    sym: 'halfread',
    c: `${USE}u16 halfread(void) { u16 a[4] = {1, 2, 3, 0xffff}; g(a); return a[3]; }`,
    spelled: /u16 sp0\[4\] = \{ 1, 2, 3, 0xffff \};/,
  },
  {
    // …and a signed read the signedness, which an array of non-negative values does not write
    sym: 'shalfread',
    c: `${USE}s16 shalfread(void) { s16 a[4] = {1, 2, 3, 4}; g(a); return a[2]; }`,
    spelled: /s16 sp0\[4\] = \{ 1, 2, 3, 4 \};/,
  },
  {
    // a byte read off a halfword array goes through a cast, and says nothing of the element
    sym: 'byteoff',
    c: `${USE}u8 byteoff(void) { u16 a[4] = {0x102, 0x304, 5, 6}; g(a); return ((u8 *)a)[1]; }`,
    spelled: /u16 sp0\[4\] = \{ 0x102, 0x304, 5, 6 \};/,
  },
  {
    // read back by element: the local keeps the element the read was spelled against
    sym: 'pick',
    c: 'u8 pick(s32 i) { u8 a[6] = {9, 8, 7, 6, 5, 4}; return a[i]; }',
    spelled: /u8 sp0\[6\] = \{ 9, 8, 7, 6, 5, 4 \};/,
  },
];

describe('local aggregate initializers — real agbcc: the candidate copies the target’s image', () => {
  const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
  test.each(CASES)('$sym', ({ sym, c, spelled }) => {
    const asm = compileTargetAsm(c, FLAGS);
    const target = assembleTarget(asm);
    const r = decompile(sym, asm, ARMV4T_AGBCC, { prototypes: PROTOS });
    expect(r.source).toMatch(spelled);
    expect(r.source).not.toContain('memcpy');
    const context = c.startsWith(USE) ? USE : '';
    const cand = compileCandAgbcc(context + r.source, FLAGS);
    expect(rodata(cand)).toEqual(rodata(target));
    expect(scoreC(context + r.source, sym, target, FLAGS).score, r.source).toBe(0);
  });

  test('two element reads after the copy: the hoisted base ahead of it does not stop the fold', () => {
    // the readability hoist puts `p0 = (u8 *)sp0;` at the head, above the copy it then folds past
    const c = `${USE}extern void k(int);\nvoid twice(void) { u8 a[8] = {1, 2, 3, 4, 5, 6, 7, 8}; g(a); k(a[3]); k(a[6]); }`;
    const asm = compileTargetAsm(c, FLAGS);
    const r = decompile('twice', asm, ARMV4T_AGBCC, {
      prototypes: { ...PROTOS, k: { params: ['s32'], returnsVoid: true } },
    });
    expect(r.source).toMatch(/u8 sp0\[8\] = \{ 1, 2, 3, 4, 5, 6, 7, 8 \};/);
    expect(r.source).not.toContain('memcpy');
    expect(rodata(compileCandAgbcc(`${USE}extern void k(int);\n${r.source}`, FLAGS))).toEqual(
      rodata(assembleTarget(asm)),
    );
  });

  test('two functions with one initializer share one image, and each spells it again', () => {
    // agbcc places an identical constant once per unit (varasm.c `output_constant_def`)
    const init = '{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}';
    const c = `${USE}void one(s32 x) { u8 a[16] = ${init}; if (x) g(0); else g(a); }\nvoid two(void) { u8 a[16] = ${init}; g(a); }`;
    const asm = compileTargetAsm(c, FLAGS);
    expect(asm.match(/\.word\t\.LC0/g)).toHaveLength(2);
    const target = assembleTarget(asm);
    const lifted = ['one', 'two'].map((sym) => decompile(sym, asm, ARMV4T_AGBCC, { prototypes: PROTOS }).source);
    const unit = USE + lifted.join('');
    expect(rodata(compileCandAgbcc(unit, FLAGS))).toEqual(rodata(target));
    for (const sym of ['one', 'two']) {
      expect(scoreC(unit, sym, target, FLAGS).score, unit).toBe(0);
    }
  });

  test('an initializer shorter than its string array is a copy and a fill, and declines', () => {
    // `char a[8] = "hello"` copies the 6-byte literal and memsets the tail: no one copy fills `a`
    const asm = compileTargetAsm(`${USE}void tail(void) { char a[8] = "hello"; g(a); }`, FLAGS);
    expect(() => decompile('tail', asm, ARMV4T_AGBCC, { prototypes: PROTOS })).toThrow(
      /cannot (lift|structure) 'tail'/,
    );
  });
});
