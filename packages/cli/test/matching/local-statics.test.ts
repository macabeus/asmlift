// FUNCTION-SCOPE STATICS, end to end through decompile() and the real agbcc and mwcc: reference C
// defining a static inside the function → target → lift → the candidate DEFINES the static again →
// compiled → the candidate's data sections compared with the target's, byte for byte.
//
// WHY THE BYTES AND NOT ONLY THE SCORE. objdiff at its defaults cannot see which local object a
// function reads, nor what it holds: against these targets a static with the wrong initializer, or
// under another name, scores a MATCH. Only its SECTION (.rodata / .data / .bss) and its local
// linkage are scored. So the score here says the code is right, and the section comparison is the
// only thing that says the emitted table is.
//
// Every data section is compared, small-data ones included, with its alignment: each reference below
// defines one function and nothing else, so its data sections hold exactly that function's statics,
// and where one of them lands depends on the ones declared before it and on its own alignment —
// neither of which any score checks either.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, PPC_MWCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  assembleTarget,
  compileCandAgbcc,
  compileCandPpc,
  compilePpcTarget,
  compileTargetAsm,
  extractPpcAsmData,
  scoreC,
  scoreCPpc,
} from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

const DATA_SECTIONS = new Set(['.rodata', '.data', '.bss', '.sdata', '.sdata2', '.sbss']);

/** Each data section of an ELF32 object: its alignment, and its contents (its size when it
 *  occupies no file space). */
function dataSections(obj: string): Record<string, { align: number; bytes: number[] | number }> {
  const b = readFileSync(obj);
  const big = b[5] === 2;
  const u16 = (o: number) => (big ? b.readUInt16BE(o) : b.readUInt16LE(o));
  const u32 = (o: number) => (big ? b.readUInt32BE(o) : b.readUInt32LE(o));
  const shoff = u32(0x20);
  const shentsize = u16(0x2e);
  const shnum = u16(0x30);
  const shstr = u32(shoff + u16(0x32) * shentsize + 16);
  const out: Record<string, { align: number; bytes: number[] | number }> = {};
  for (let i = 0; i < shnum; i++) {
    const h = shoff + i * shentsize;
    const nameAt = shstr + u32(h);
    const name = b.toString('latin1', nameAt, b.indexOf(0, nameAt));
    if (!DATA_SECTIONS.has(name)) {
      continue;
    }
    const nobits = u32(h + 4) === 8;
    const off = u32(h + 16);
    const size = u32(h + 20);
    out[name] = { align: u32(h + 32), bytes: nobits ? size : [...b.subarray(off, off + size)] };
  }
  return out;
}

/** Each case: the function, and what its statics' definitions must read as in the emitted C —
 *  `mwccSpelled` where mwcc's object shows less of the definition than agbcc's listing does.
 *  `agbccScore` is the default candidate's objdiff score where it is not 0: the same function
 *  reading an `extern` instead of a static lifts to the same body and scores the same, so the
 *  difference is a spelling gap of the access, not of the static. A `layoutOnly` case is scored by
 *  nothing but its data: its access has a spelling gap of that kind on both compilers. `context` is
 *  what a project's headers would declare beside the candidate. */
const CASES: {
  sym: string;
  c: string;
  spelled: RegExp;
  mwccSpelled?: RegExp;
  agbccScore?: number;
  layoutOnly?: true;
  context?: string;
}[] = [
  {
    sym: 'tidef',
    c: 's32 tidef(s32 i) { static const u8 tide[] = {1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1}; return tide[i]; }',
    spelled: /static const u8 tide\[11\] = \{/,
  },
  {
    sym: 'halves',
    c: 's32 halves(s32 i) { static const s16 cs[3] = {-1, 2, -300}; return cs[i]; }',
    spelled: /static const s16 cs\[3\] = \{ -1, 2, -0x12c \};/,
    agbccScore: 2,
  },
  {
    sym: 'bssf',
    c: 's32 bssf(s32 i) { static u8 z[3]; z[i] = 1; return z[0]; }',
    spelled: /static u8 z\[3\];/,
  },
  {
    sym: 'counter',
    c: 's32 counter(void) { static s32 q = 5; return q++; }',
    spelled: /static u32 q = 5;/,
    agbccScore: 5,
  },
  {
    sym: 'words',
    c: 'u32 words(s32 i) { static const u32 w[2] = {0x80000000, 5}; return w[i]; }',
    spelled: /static const u32 w\[2\] = \{ 0x80000000, 5 \};/,
  },
  {
    // declared zeta first and read alpha first: the declarations keep the target's order
    sym: 'ord',
    c: 's32 ord(s32 i) { static const u8 zeta[4] = {1, 2, 3, 4}; static const u8 alpha[4] = {5, 6, 7, 8}; return alpha[i] + zeta[i]; }',
    spelled: /static const u8 zeta\[4\] = \{ 1, 2, 3, 4 \};\n {4}static const u8 alpha\[4\]/,
  },
  {
    // a word table no access reads, after an odd-sized one: agbcc's `.word`s say the element, and
    // with it the alignment that puts `t` at +4
    sym: 'handed',
    c:
      'extern void use(const void *); void handed(void) { static const u8 a[3] = {7, 8, 9}; ' +
      'static const u32 t[2] = {1, 2}; use(a); use(t); }',
    spelled: /static const u32 t\[2\] = \{ 1, 2 \};/,
    mwccSpelled: /static const u8 t\[8\] = \{ 0, 0, 0, 1, 0, 0, 0, 2 \};/,
  },
  {
    // a struct of bytes and a halfword, aligned as agbcc aligns every struct
    sym: 'window',
    c:
      'struct W { u8 a, b, c, d, e, f; u16 g; }; extern u8 AddWindow(const struct W *); u8 window(void) { ' +
      'static const u8 odd[3] = {1, 2, 3}; static const struct W t = {0, 1, 1, 6, 2, 15, 8}; ' +
      'AddWindow((const void *)odd); return AddWindow(&t); }',
    spelled: /static const u8 t\[8\] __attribute__\(\(aligned\(4\)\)\) = \{ 0, 1, 1, 6, 2, 0xf, 8, 0 \};/,
    mwccSpelled: /static const u8 t\[8\] = \{ 0, 1, 1, 6, 2, 0xf, 0, 8 \};/,
  },
  {
    // an array of rows read one byte in: the load is the field's byte, not the 3-byte row
    sym: 'rows',
    c: 'u8 rows(s32 i) { static const u8 m[4][3] = {{1, 2, 3}, {4, 5, 6}, {7, 8, 9}, {10, 11, 12}}; return m[i][1]; }',
    spelled: /static const u8 m\[12\] = \{/,
    layoutOnly: true,
  },
  {
    // the negative is field x's, and the byte the function reads is unsigned
    sym: 'fieldneg',
    c: 'u8 fieldneg(s32 i) { static const struct { s16 x; u8 id; u8 pad; } t[2] = {{-1, 5, 0}, {-2, 6, 0}}; return t[i].id; }',
    spelled: /static const u8 t\[8\] __attribute__\(\(aligned\(4\)\)\) = \{ 0xff, 0xff, 5, 0, 0xfe, 0xff, 6, 0 \};/,
    mwccSpelled: /static const u8 t\[8\] = \{ 0xff, 0xff, 5, 0, 0xff, 0xfe, 6, 0 \};/,
    layoutOnly: true,
  },
  {
    // a read-only table's address handed to a pointer parameter the context declares: mwcc does
    // not convert its `const` away implicitly
    sym: 'constarg',
    c: 'extern s32 g(u8 *p); s32 constarg(void) { static const u8 tbl[4] = {1, 2, 3, 4}; return g((u8 *)tbl); }',
    context: 'extern s32 g(u8 *p);\n',
    spelled: /return g\(\(u8 \*\)tbl\);/,
  },
  {
    sym: 'fields',
    c: 's32 fields(s32 i) { static const struct { s32 a; s32 b; } t[3] = {{1, 2}, {3, 4}, {5, 6}}; return t[i].b; }',
    spelled: /static const u32 t\[6\] = \{ 1, 2, 3, 4, 5, 6 \};/,
    layoutOnly: true,
  },
];

describe('function-scope statics — real agbcc: the candidate defines the target’s bytes', () => {
  const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
  test.each(CASES)('$sym', ({ sym, c, spelled, agbccScore = 0, layoutOnly, context = '' }) => {
    const asm = compileTargetAsm(c, FLAGS);
    const target = assembleTarget(asm);
    const r = decompile(sym, asm, ARMV4T_AGBCC);
    expect(r.source).toMatch(spelled);
    expect(dataSections(compileCandAgbcc(context + r.source, FLAGS))).toEqual(dataSections(target));
    if (!layoutOnly) {
      expect(scoreC(context + r.source, sym, target, FLAGS).score, r.source).toBe(agbccScore);
    }
  });

  test('a static every caller of an inlined function names declines, naming the others', () => {
    // agbcc 2.9 puts `n` ahead of A, the first function it inlined `counter` into; B names it too.
    const c =
      'static inline s32 counter(void) { static s32 n; return ++n; }\n' +
      's32 A(void) { return counter() + 1; }\ns32 B(void) { return counter(); }';
    const asm = compileTargetAsm(c, FLAGS);
    expect(() => decompile('A', asm, ARMV4T_AGBCC)).toThrow(
      /names a function-scope static \('n\.\d+'\) that B also names — it is not this function's alone/,
    );
  });
});

const HAVE_MWCC = ppcDockerGate('local-statics', 'mwcc_242_81');

describe.runIf(HAVE_MWCC)('function-scope statics — real mwcc: the candidate defines the target’s bytes', () => {
  const FLAGS = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
  test.each(CASES)('$sym', ({ sym, c, spelled, mwccSpelled = spelled, layoutOnly, context = '' }) => {
    const { obj, asm } = compilePpcTarget('mwcc_242_81', c, sym, FLAGS);
    const r = decompile(sym, asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, sym) });
    expect(r.source).toMatch(mwccSpelled);
    expect(dataSections(compileCandPpc('mwcc_242_81', context + r.source, FLAGS))).toEqual(dataSections(obj));
    if (!layoutOnly) {
      const s = scoreCPpc('mwcc_242_81', context + r.source, sym, obj, FLAGS);
      expect(s.match, `objdiff ${s.score}\n${r.source}`).toBe(true);
    }
  });

  test('without the object’s data the static declines rather than lifting a name with no definition', () => {
    const { asm } = compilePpcTarget('mwcc_242_81', CASES[0].c, CASES[0].sym, FLAGS);
    expect(() => decompile(CASES[0].sym, asm, PPC_MWCC)).toThrow(
      /names a function-scope static \('tide\$\d+'\) whose definition needs the object's data/,
    );
  });

  test.each(['__FUNCTION__', '__func__'])('the predefined %s declines rather than being redefined', (id) => {
    const c = `extern void use(const char *); void fnm(void) { use(${id}); }`;
    const { obj, asm } = compilePpcTarget('mwcc_242_81', c, 'fnm', FLAGS);
    expect(() => decompile('fnm', asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, 'fnm') })).toThrow(
      new RegExp(`names the function's predefined name \\('${id}\\$\\d+'\\)`),
    );
  });
});
