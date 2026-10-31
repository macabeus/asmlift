// A scalar global the declaration context declares at another width or signedness than its one
// access (proto-context.ts `ContextGlobals.storage`, read by structure.ts's declaration-shape
// override of `scalarGlobals`). The usage inference reads a global accessed only at offset 0 at one
// width as a scalar of that width; the bare name is that scalar only where the declaration agrees.
// Over `extern s32 gN;` a byte read spelled `gN` reads four bytes, a byte store spelled `gN = x`
// writes four, and over `extern s8 gN;` the bare name sign-extends what `ldrb` zero-extends. Each
// mismatch is spelled through the address instead, and each control (the same access under a
// declaration that agrees) keeps the bare name. A symbol map states the same facts (`size`,
// `signed`, `shape: 'pointer'`), read the same way.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { globalsFromContext } from '../src/proto-context';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC } from '../src/target';

const TYPES =
  'typedef unsigned char u8; typedef signed char s8; typedef unsigned short u16; typedef signed short s16;\n' +
  'typedef unsigned int u32; typedef signed int s32;\n';
const ctx = (decl: string) => globalsFromContext(`${TYPES}${decl}`, 'c');

/** agbcc: `op` of the pool-addressed `gN` at offset 0 (a load into r0, or a store of r0) */
const thumb = (op: string, sym = 'gN') =>
  op.startsWith('str')
    ? `f:\n\tldr\tr1, .L1\n\t${op}\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\t${sym}\n`
    : `f:\n\tldr\tr0, .L1\n\t${op}\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t${sym}\n`;
const agbcc = (op: string, decl: string, sym?: string) =>
  decompile('f', thumb(op, sym), ARMV4T_AGBCC, { contextGlobals: ctx(decl) }).source;

/** O32: `op` of `gN` at offset 0, the address built by a `lui`/`%lo` pair */
const mips = (op: string, decl: string) => {
  const reg = op.startsWith('s') ? 'a0' : 'v0';
  const asm = `00000000 <f>:\n   0:\tlui\tv0,0x0\n   4:\tjr\tra\n   8:\t${op}\t${reg},0(v0)\n`;
  const asmData: AsmData = {
    sections: new Map(),
    relocs: [
      { section: '.text', offset: 0, type: 'R_MIPS_HI16', sym: 'gN', addend: 0 },
      { section: '.text', offset: 8, type: 'R_MIPS_LO16', sym: 'gN', addend: 0 },
    ],
    symbols: new Map(),
    symbolCount: 0,
    bigEndian: true,
  };
  return decompile('f', asm, MIPS_IDO, { asmData, contextGlobals: ctx(decl) }).source;
};

/** mwcc: `op` of the small-data `gN` at offset 0, then `ext` of what it read */
const ppcExt = (op: string, ext: string, decl: string) =>
  decompile(
    'f',
    `0 <f>:\n   0:\t${op}     r3,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\tgN\n   4:\t${ext}   r3,r3\n   8:\tblr\n`,
    PPC_MWCC,
    { contextGlobals: ctx(decl) },
  ).source;

/** mwcc: `op` of the small-data `gN` at offset 0 */
const ppc = (op: string, decl: string) =>
  decompile('f', `0 <f>:\n   0:\t${op}     r3,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\tgN\n   4:\tblr\n`, PPC_MWCC, {
    contextGlobals: ctx(decl),
  }).source;

describe('a declared scalar whose storage disagrees with its one access', () => {
  test('agbcc: a narrower read, a wider read, a store and a sign are spelled through the address', () => {
    expect(agbcc('ldrb', 'extern s32 gN;')).toContain('return *(u8 *)&gN;');
    expect(agbcc('ldrh', 'extern u32 gN;')).toContain('return *(u16 *)&gN;');
    expect(agbcc('ldr', 'extern u8 gN;')).toContain('*(s32 *)&gN;');
    expect(agbcc('ldrb', 'extern s8 gN;')).toContain('return *(u8 *)&gN;');
    expect(agbcc('strb', 'extern s32 gN;')).toContain('*(u8 *)&gN = a0;');
    expect(agbcc('str', 'extern u8 gN;')).toContain('*(s32 *)&gN = a0;');
    expect(agbcc('ldrb', 'extern u8 *gP;', 'gP')).toContain('return *(u8 *)&gP;');
  });

  test('agbcc: the same accesses under a declaration that agrees keep the bare name', () => {
    expect(agbcc('ldrb', 'extern u8 gN;')).toContain('return gN;');
    expect(agbcc('ldrh', 'extern u16 gN;')).toContain('return gN;');
    expect(agbcc('ldr', 'extern s32 gN;')).toContain('return gN;');
    expect(agbcc('strb', 'extern s8 gN;')).toContain('gN = a0;');
    expect(agbcc('ldr', 'extern u8 *gP;', 'gP')).toContain('return gP;');
    // through a typedef chain the declaration is the same width
    expect(agbcc('ldrh', 'typedef u16 Half; typedef Half Word2; extern Word2 gN;')).toContain('return gN;');
    expect(agbcc('ldrb', 'typedef s32 MyInt; extern MyInt gN;')).toContain('return *(u8 *)&gN;');
  });

  test('a store compares no sign: it writes the same byte either way', () => {
    expect(agbcc('strb', 'extern u8 gN;')).toContain('gN = a0;');
    expect(agbcc('strb', 'extern s8 gN;')).toContain('gN = a0;');
  });

  test("a plain char and an enum are what the target makes them: agbcc's char is unsigned, its enum a word", () => {
    expect(agbcc('ldrb', 'extern char gN;')).toContain('return gN;');
    expect(agbcc('ldr', 'enum E { EA, EB }; extern enum E gN;')).toContain('return gN;');
    expect(agbcc('str', 'enum E { EA, EB }; extern enum E gN;')).toContain('gN = a0;');
    expect(agbcc('ldr', 'typedef enum { TA, TB } T; extern T gN;')).toContain('return gN;');
    expect(agbcc('ldrb', 'enum E { EA, EB }; extern enum E gN;')).toContain('return *(u8 *)&gN;');
    // a packed enum is no size the target states
    expect(agbcc('ldr', 'enum __attribute__((packed)) P { PA }; extern enum P gN;')).toContain('*(s32 *)&gN;');
    expect(agbcc('ldrb', 'extern signed char gN;')).toContain('return *(u8 *)&gN;');
    expect(agbcc('ldrb', 'extern unsigned char gN;')).toContain('return gN;');
  });

  test('where the target states no enum size or char sign, the read is spelled through the address', () => {
    expect(ppc('lwz', 'enum E { EA, EB }; extern enum E gN;')).toContain('*(s32 *)&gN;');
    const unmeasured = { ...ARMV4T_AGBCC, compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors } };
    delete unmeasured.compilerBehaviors.plainCharSigned;
    expect(decompile('f', thumb('ldrb'), unmeasured, { contextGlobals: ctx('extern char gN;') }).source).toContain(
      'return *(u8 *)&gN;',
    );
  });

  test('a float agrees with no integer access, which reinterprets the bytes the bare name would convert', () => {
    expect(agbcc('ldrh', 'extern float gN;')).toContain('return *(u16 *)&gN;');
    expect(agbcc('ldr', 'extern float gN;')).toContain('*(s32 *)&gN;');
    expect(agbcc('strb', 'extern float gN;')).toContain('*(u8 *)&gN = a0;');
    expect(agbcc('ldr', 'extern double gN;')).toContain('*(s32 *)&gN;');
  });

  test("a type the context cannot read agrees with no access; C89's implicit int is an int", () => {
    expect(agbcc('ldrb', 'extern Unknown gN;')).toContain('return *(u8 *)&gN;');
    expect(agbcc('ldrb', 'typedef int A32 __attribute__((aligned(4))); extern A32 gN;')).toContain(
      'return *(u8 *)&gN;',
    );
    expect(agbcc('strb', 'typedef int A32 __attribute__((aligned(4))); extern A32 gN;')).toContain('*(u8 *)&gN = a0;');
    expect(agbcc('ldrb', 'extern gN;')).toContain('return *(u8 *)&gN;');
    expect(agbcc('ldr', 'extern gN;')).toContain('return gN;');
    // a global the context does not declare keeps the usage-inferred spelling
    expect(agbcc('ldrb', 'extern s32 gOther;')).toContain('return gN;');
  });

  test('a narrow read every use of which takes only its own bytes agrees with either sign', () => {
    // mwcc has no sign-extending byte load: `extern s8 gN; return gN;` is lbz + extsb
    expect(ppcExt('lbz', 'extsb', 'extern s8 gN;')).toContain('return (s8)gN;');
    expect(ppcExt('lbz', 'extsb', 'extern u8 gN;')).toContain('return (s8)gN;');
    // a use that reads the extension still compares the sign
    expect(ppc('lbz', 'extern s8 gN;')).toContain('return *(u8 *)&gN;');
  });

  test('a narrow read handed across an edge compares the sign: the join may return the extended value', () => {
    // `u32 x = *(u8 *)&gN; gM = x; if (c) x = 7; return x;` — the store takes one byte, the join
    // returns all four, and over `extern s8 gN;` the bare name would return them sign-extended
    const stored =
      'g:\n\tldr\tr1, .L4\n\tldrb\tr2, [r1]\n\tldr\tr1, .L4+0x4\n\tstrb\tr2, [r1]\n\tcmp\tr0, #0\n' +
      '\tbeq\t.L3\n\tmov\tr2, #0x7\n.L3:\n\tadd\tr0, r2, #0\n\tbx\tlr\n.L4:\n\t.word\tgN\n\t.word\tgM\n';
    const lift = (asm: string, decl: string) =>
      decompile('g', asm, ARMV4T_AGBCC, { contextGlobals: ctx(decl) }).source;
    expect(lift(stored, 'extern s8 gN; extern u8 gM;')).toContain('*(u8 *)&gN');
    expect(lift(stored, 'extern u8 gN; extern u8 gM;')).not.toContain('&gN');
    // `u8 v = *(u8 *)&gN; s32 r = v; if (c) r = (s8)v; return r;` — the sext is one use, the
    // unextended value reaching the join the other
    const extended =
      'g:\n\tldr\tr1, .L4\n\tldrb\tr1, [r1]\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tlsl\tr0, r1, #0x18\n' +
      '\tasr\tr1, r0, #0x18\n.L3:\n\tadd\tr0, r1, #0\n\tbx\tlr\n.L4:\n\t.word\tgN\n';
    expect(lift(extended, 'extern s8 gN;')).toContain('*(u8 *)&gN');
    expect(lift(extended, 'extern u8 gN;')).not.toContain('&gN');
  });

  test('ido: an offset-0 narrow read, a store and a signed read of a u8 take the address', () => {
    expect(mips('lbu', 'extern s32 gN;')).toContain('return *(u8 *)&gN;');
    expect(mips('lb', 'extern u8 gN;')).toContain('return *(s8 *)&gN;');
    expect(mips('sb', 'extern s32 gN;')).toContain('*(u8 *)&gN = a0;');
    expect(mips('lbu', 'extern u8 gN;')).toContain('return gN;');
    expect(mips('lb', 'extern s8 gN;')).toContain('return gN;');
    expect(mips('sb', 'extern u8 gN;')).toContain('gN = a0;');
  });

  test('mwcc: the same on PowerPC', () => {
    expect(ppc('lbz', 'extern s32 gN;')).toContain('return *(u8 *)&gN;');
    expect(ppc('lhz', 'extern s16 gN;')).toContain('return *(u16 *)&gN;');
    expect(ppc('stb', 'extern s32 gN;')).toContain('*(u8 *)&gN = a0;');
    expect(ppc('lbz', 'extern u8 gN;')).toContain('return gN;');
    expect(ppc('lhz', 'extern u16 gN;')).toContain('return gN;');
    expect(ppc('stw', 'extern s32 gN;')).toContain('gN = a0;');
  });
});

/** agbcc: `op` of the map-described global at 0x03001234, at offset 0 */
const mapped = (op: string, info: Partial<SymbolInfo>) => {
  const asm = thumb(op).replace('\t.word\tgN', '\t.word\t0x03001234');
  const symbols: SymbolMap = new Map([[0x03001234, [{ name: 'gC', kind: 'data', ...info }]]]);
  return decompile('f', asm, ARMV4T_AGBCC, { symbols }).source;
};

describe('a map-described scalar whose size or sign disagrees with its one access', () => {
  test('a narrower read, a wider read, a store, a sign and a pointer take the address', () => {
    expect(mapped('ldrb', { shape: 'scalar', size: 4, signed: true })).toContain('return *(u8 *)&gC;');
    expect(mapped('ldrh', { shape: 'scalar', size: 4, signed: false })).toContain('return *(u16 *)&gC;');
    expect(mapped('ldr', { shape: 'scalar', size: 1, signed: false })).toContain('*(s32 *)&gC;');
    expect(mapped('ldrb', { shape: 'scalar', size: 1, signed: true })).toContain('return *(u8 *)&gC;');
    expect(mapped('strb', { shape: 'scalar', size: 4, signed: true })).toContain('*(u8 *)&gC = a0;');
    expect(mapped('ldrb', { shape: 'pointer', size: 4 })).toContain('return *(u8 *)&gC;');
  });

  test('an access the map agrees with, or a map that sizes nothing, keeps the bare name', () => {
    expect(mapped('ldrb', { shape: 'scalar', size: 1, signed: false })).toContain('return gC;');
    expect(mapped('ldr', { shape: 'scalar', size: 4, signed: true })).toContain('return gC;');
    expect(mapped('strb', { shape: 'scalar', size: 1, signed: true })).toContain('gC = a0;');
    expect(mapped('ldr', { shape: 'pointer', size: 4 })).toContain('return gC;');
    expect(mapped('ldrb', {})).toContain('return gC;');
  });
});
