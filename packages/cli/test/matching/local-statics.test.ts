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
// Every data section is compared, small-data ones included, with its alignment, and so is the section
// and offset of every static: each reference below defines one function and nothing else, so its
// data sections hold exactly that function's statics, and where one of them lands depends on the
// ones declared before it, on its own alignment and on whether it had an initializer — none of
// which any score checks either.
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

/** An ELF32 object's section headers: each one's name, type, file offset, size, alignment and link. */
function sectionHeaders(b: Buffer) {
  const big = b[5] === 2;
  const u16 = (o: number) => (big ? b.readUInt16BE(o) : b.readUInt16LE(o));
  const u32 = (o: number) => (big ? b.readUInt32BE(o) : b.readUInt32LE(o));
  const shoff = u32(0x20);
  const shentsize = u16(0x2e);
  const shstr = u32(shoff + u16(0x32) * shentsize + 16);
  return {
    u16,
    u32,
    headers: Array.from({ length: u16(0x30) }, (_, i) => {
      const h = shoff + i * shentsize;
      const nameAt = shstr + u32(h);
      return {
        name: b.toString('latin1', nameAt, b.indexOf(0, nameAt)),
        type: u32(h + 4),
        off: u32(h + 16),
        size: u32(h + 20),
        link: u32(h + 24),
        align: u32(h + 32),
      };
    }),
  };
}

/** Each data section of an ELF32 object: its alignment, and its contents (its size when it
 *  occupies no file space). */
function dataSections(obj: string): Record<string, { align: number; bytes: number[] | number }> {
  const b = readFileSync(obj);
  const out: Record<string, { align: number; bytes: number[] | number }> = {};
  for (const h of sectionHeaders(b).headers) {
    if (DATA_SECTIONS.has(h.name)) {
      out[h.name] = { align: h.align, bytes: h.type === 8 ? h.size : [...b.subarray(h.off, h.off + h.size)] };
    }
  }
  return out;
}

/** Where each function-scope static of an ELF32 object sits, by its source name: its section and
 *  offset. Two statics of the same size swapped leave every section's bytes alike, bss above all. */
function staticPlaces(obj: string): Record<string, string> {
  const b = readFileSync(obj);
  const { u16, u32, headers } = sectionHeaders(b);
  const symtab = headers.find((h) => h.type === 2)!;
  const strtab = headers[symtab.link];
  const out: Record<string, string> = {};
  for (let at = symtab.off; at < symtab.off + symtab.size; at += 16) {
    const nameAt = strtab.off + u32(at);
    const m = b.toString('latin1', nameAt, b.indexOf(0, nameAt)).match(/^([A-Za-z_]\w*)[.$]\d+$/);
    const shndx = u16(at + 14);
    if (m && shndx > 0 && shndx < headers.length) {
      out[m[1]] = `${headers[shndx].name}+${u32(at + 4)}`;
    }
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
    // agbcc keeps `= 0` in .data, so the one zero element there is a scalar; mwcc moves it to bss
    sym: 'zeroed',
    c: 's32 zeroed(void) { static s32 q = 0; q++; return q; }',
    spelled: /static u32 q = 0;\n {4}s32 v0;\n {4}v0 = q;/,
    mwccSpelled: /static u32 q;\n {4}s32 v0;\n {4}v0 = q;/,
  },
  {
    // agbcc word-aligns a string-literal initializer, and the literal is what says so; mwcc's
    // object shows no directives, and a byte list lands where the string did
    sym: 'hello',
    c:
      'extern void use(const void *); void hello(void) { static const u8 a[3] = {1, 2, 3}; ' +
      'static const char s[] = "hello!"; use(a); use(s); }',
    spelled: /static const u8 a\[3\] = \{ 1, 2, 3 \};\n {4}static const u8 s\[7\] = "hello!";/,
    mwccSpelled: /static const u8 s\[7\] = \{ 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0 \};/,
  },
  {
    // mwcc moves both to .sbss and lays them out in declaration order there, ahead of any static
    // with no initializer, whose order it reverses — so the offsets say which had the `= 0`. The
    // later of the two lands in the same place declared either way, and is left without
    sym: 'zeropair',
    c: 'u32 zeropair(void) { static u16 x = 0; static u8 y = 0; return x + y; }',
    spelled: /static u16 x = 0;\n {4}static u8 y = 0;/,
    mwccSpelled: /static u16 x = 0;\n {4}static u8 y;/,
  },
  {
    sym: 'zeromix',
    c: 'u32 zeromix(void) { static u32 a = 0; static u32 b; static u32 c = 0; return a + b + c; }',
    spelled: /static u32 a = 0;\n {4}static u32 b;\n {4}static u32 c = 0;/,
    mwccSpelled: /static u32 a = 0;\n {4}static u32 b;\n {4}static u32 c;/,
    layoutOnly: true,
  },
  {
    // mwcc puts both in .bss, where the statics with no initializer are laid out by first use:
    // `a` ahead of the later-declared `b` had no `= 0`
    sym: 'bssuse',
    c: 's32 bssuse(s32 i) { static u8 a[64]; static u8 b[64]; a[i] = 1; b[i] = 2; return a[0] + b[1]; }',
    spelled: /static u8 a\[64\];\n {4}static u8 b\[64\];/,
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
    // a DMA buffer: mwcc's object records the 32 bytes it is aligned to only in its `.comment`, and
    // agbcc's `.lcomm` carries no alignment at all
    sym: 'dma',
    c: 'extern s32 use(u8 *p, s32 n); s32 dma(s32 n) { static u8 buff[64] __attribute__((aligned(32))); return use(buff, n); }',
    spelled: /static u8 buff\[64\];/,
    mwccSpelled: /static u8 buff\[64\] __attribute__\(\(aligned\(32\)\)\);/,
  },
  {
    // an `s64` after an `s32`: mwcc puts it at +8, which a definition of bytes must state
    sym: 'wide',
    c: 's32 wide(void) { static s32 a = 1; static s64 last = 3; return use2(&a, &last); }',
    spelled: /static u32 last\[2\] = \{ 3, 0 \};/,
    mwccSpelled: /static u8 last\[8\] __attribute__\(\(aligned\(8\)\)\) = \{ 0, 0, 0, 0, 0, 0, 0, 3 \};/,
  },
  {
    sym: 'palette',
    c: 's32 palette(s32 i) { static s16 pal[] __attribute__((aligned(32))) = {1, 2, 3, 4, 5, 6, 7, 8}; return pal[i]; }',
    spelled: /static s16 pal\[8\] __attribute__\(\(aligned\(16\)\)\) = \{ 1, 2, 3, 4, 5, 6, 7, 8 \};/,
    mwccSpelled: /static s16 pal\[8\] __attribute__\(\(aligned\(32\)\)\) = \{ 1, 2, 3, 4, 5, 6, 7, 8 \};/,
    agbccScore: 2,
  },
  {
    // scalars mwcc aligns to their width, an array of one byte it aligns to a word, and an array of
    // `s64`s to eight; with no access to say otherwise, a scalar's alignment says it is one
    sym: 'scalars',
    c:
      'extern void u(void *); void scalars(void) { static u8 a1; static u8 a2; static u16 b1; static u8 a3[1]; ' +
      'static s64 l[2]; u(&a1); u(&a2); u(&b1); u(a3); u(l); }',
    spelled: /static u8 a1;\n {4}static u8 a2;\n {4}static u8 b1\[2\];/,
    mwccSpelled:
      /static u16 b1;\n {4}static u8 a3 __attribute__\(\(aligned\(4\)\)\);\n {4}static u8 l\[16\] __attribute__\(\(aligned\(8\)\)\);/,
  },
  {
    // strings agbcc writes with `\b` and `\f`, in objects with no `.size`: the whole run is the object
    sym: 'escapes',
    c:
      'struct E { u8 a; char s[3]; }; extern void use(const void *); void escapes(void) { ' +
      'static const char t[][4] = {"ab", "c\\b", "de"}; static const struct E e[] = {{1, "\\f"}, {2, "x"}}; ' +
      'use(t); use(e); }',
    spelled: /static const u8 t\[12\] = \{/,
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
    const cand = compileCandAgbcc(context + r.source, FLAGS);
    expect(dataSections(cand)).toEqual(dataSections(target));
    expect(staticPlaces(cand)).toEqual(staticPlaces(target));
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
    const cand = compileCandPpc('mwcc_242_81', context + r.source, FLAGS);
    expect(dataSections(cand)).toEqual(dataSections(obj));
    expect(staticPlaces(cand)).toEqual(staticPlaces(obj));
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

  // At `-sdata 0`, a real project's flags, every bss static is in .bss: the zero scalars first in
  // declaration order, the others after in the order the code first uses them. Each of these lifted
  // without the `= 0` lands `a` after the other static, and still scores a MATCH.
  const SDATA0 = [...FLAGS, '-sdata', '0', '-sdata2', '0'];
  test.each([
    {
      sym: 'zfirst',
      c: 's32 zfirst(s32 i) { static s32 a = 0; static s32 b; if (i) return b; return a; }',
      spelled: /static u32 a = 0;\n {4}static u32 b;/,
    },
    {
      sym: 'zboth',
      c: 's32 zboth(s32 i) { static s32 a = 0; static s32 b = 0; if (i) return b; return a; }',
      spelled: /static u32 a = 0;\n {4}static u32 b;/,
    },
    {
      sym: 'zarr',
      c: 's32 zarr(s32 i) { static s32 a = 0; static u8 arr[64]; if (i) return arr[i]; return a; }',
      spelled: /static u32 a = 0;\n {4}static u8 arr\[64\];/,
    },
    {
      sym: 'zlater',
      c: 's32 zlater(s32 i) { static s32 c; static s32 a = 0; if (i) return c; return a; }',
      spelled: /static u32 c;\n {4}static u32 a = 0;/,
    },
  ])('-sdata 0: $sym', ({ sym, c, spelled }) => {
    const { obj, asm } = compilePpcTarget('mwcc_242_81', c, sym, SDATA0);
    const r = decompile(sym, asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, sym) });
    expect(r.source).toMatch(spelled);
    const cand = compileCandPpc('mwcc_242_81', r.source, SDATA0);
    expect(dataSections(cand)).toEqual(dataSections(obj));
    expect(staticPlaces(cand)).toEqual(staticPlaces(obj));
    const s = scoreCPpc('mwcc_242_81', r.source, sym, obj, SDATA0);
    expect(s.match, `objdiff ${s.score}\n${r.source}`).toBe(true);
  });

  // `a` at +0 is a zero `s32` or four bytes used first; declared as bytes it would land after `c`
  test.each([
    {
      sym: 'zaddr',
      c: 'extern void use(s32 *); void zaddr(void) { static s32 c; static s32 a = 0; use(&c); use(&a); }',
    },
    {
      sym: 'zbytes',
      c: 's32 zbytes(s32 i) { static s32 c; static s32 a = 0; if (i) return c; return *(u8 *)&a; }',
    },
  ])('-sdata 0: $sym, a static where only a zero scalar sits, declared here as bytes, declines', ({ sym, c }) => {
    const { obj, asm } = compilePpcTarget('mwcc_242_81', c, sym, SDATA0);
    expect(() => decompile(sym, asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, sym) })).toThrow(
      /names a function-scope static \('a\$\d+'\) laid out where only a scalar initialized to zero is, but of 4 elements/,
    );
  });
});
