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
import { renderDeclarations } from '@asmlift/core/declare';
import { decompile } from '@asmlift/core/pipeline';
import { enumerateCandidates } from '@asmlift/core/rank';
import type { SymbolMap } from '@asmlift/core/symbols';
import { ARMV4T_AGBCC, PPC_MWCC, TOOLCHAIN_TARGETS, targetFor } from '@asmlift/core/target';
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

/** Initializers holding ADDRESSES: a table of function pointers, of data pointers, of `&arr[k]`
 *  either side of the array, and a pointer scalar in .data. Neither the bytes nor the score sees an
 *  address — both name it only through a relocation — so each compiler's own record of the
 *  relocations inside the data is compared too. `context` declares what the project's headers would. */
const ADDRESS_CASES: { sym: string; c: string; context: string; spelled: RegExp; mwccDeclines?: RegExp }[] = [
  {
    sym: 'fptab',
    context: 'u8 h1(u8);\nu8 h2(u8);\nu8 h3(u8);\n',
    c: 's32 fptab(s32 i, u8 x) { static u8 (*const tbl[3])(u8) = { h1, h2, h3 }; return tbl[i](x); }',
    spelled: /static const u32 tbl\[3\] = \{ \(u32\)&h1, \(u32\)&h2, \(u32\)&h3 \};/,
    // mwcc calls through it with `bctrl`, which its frontend does not model
    mwccDeclines: /unmodelled control transfer 'bctrl'/,
  },
  {
    sym: 'dptab',
    context: 'extern s32 ga, gb;\n',
    c: 's32 dptab(s32 i) { static s32 *const tbl[2] = { &ga, &gb }; return *tbl[i]; }',
    spelled: /static const u32 tbl\[2\] = \{ \(u32\)&ga, \(u32\)&gb \};/,
  },
  {
    sym: 'addend',
    context: 'extern s32 garr[8];\n',
    c: 's32 addend(s32 i) { static s32 *const tbl[3] = { &garr[2], &garr[-1], garr }; return *tbl[i]; }',
    spelled:
      /static const u32 tbl\[3\] = \{ \(u32\)\(\(u8 \*\)&garr \+ 8\), \(u32\)\(\(u8 \*\)&garr - 4\), \(u32\)&garr \};/,
  },
  {
    sym: 'ptrdata',
    context: 'extern s32 g;\n',
    c: 's32 ptrdata(s32 i) { static s32 *p = &g; return p[i]; }',
    spelled: /static u32 p = \(u32\)&g;/,
  },
];

/** The words of each data run agbcc's listing writes as addresses, under the label that heads it. */
const addressWords = (asm: string): string[] => {
  const out: string[] = [];
  let label = '';
  let inData = false;
  for (const line of asm.split('\n')) {
    if (/^\s*\.(section\s+\.(rodata|data)|data)\b/.test(line)) {
      inData = true;
    } else if (/^\s*\.(text|section)\b/.test(line)) {
      inData = false;
    }
    const l = line.match(/^([A-Za-z_][\w.$]*):/);
    if (l) {
      label = l[1];
    }
    const w = line.match(/^\s*\.word\s+([A-Za-z_].*)$/);
    if (inData && w) {
      out.push(`${label}: ${w[1]}`);
    }
  }
  return out;
};

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

  test.each(ADDRESS_CASES)('an initializer holding addresses: $sym', ({ sym, c, context, spelled }) => {
    const asm = compileTargetAsm(context + c, FLAGS);
    const target = assembleTarget(asm);
    const r = decompile(sym, asm, ARMV4T_AGBCC);
    expect(r.source).toMatch(spelled);
    const cand = compileCandAgbcc(context + r.source, FLAGS);
    expect(dataSections(cand)).toEqual(dataSections(target));
    expect(staticPlaces(cand)).toEqual(staticPlaces(target));
    const words = addressWords(asm);
    expect(words.length).toBeGreaterThan(0);
    expect(addressWords(compileTargetAsm(context + r.source, FLAGS))).toEqual(words);
    expect(scoreC(context + r.source, sym, target, FLAGS).score, r.source).toBe(0);
  });

  // THE SELF-DECLARED WORLD (no headers, no map, no prototype): the block asmlift renders is all the
  // candidate is compiled against. The body also CALLS a function whose address the table holds, so
  // the static's `(u32)&h1` comes ahead of the call that would have declared `h1` implicitly — the
  // block must declare it, and as the implicit declaration (`int h1();`), not as a prototype nothing
  // states; undeclared, it is "`h1' undeclared".
  test('a table member the body also calls with no prototype is declared ahead of the static', () => {
    const c =
      'u8 h1(u8); u8 h2(u8);\n' +
      's32 both(s32 i, u8 x) { static u8 (*const t[2])(u8) = { h1, h2 }; return t[i](x) + h1(x); }';
    const asm = compileTargetAsm(c, FLAGS);
    const target = assembleTarget(asm);
    const cands = enumerateCandidates('both', asm, ARMV4T_AGBCC, { prototypes: {} });
    expect(cands.length).toBeGreaterThan(0);
    const scores = cands.map((cand) => {
      const decls = renderDeclarations(cand.symbolRefs ?? []);
      expect(decls).toMatch(/^int h1\(\);$/m);
      expect(addressWords(compileTargetAsm(decls + cand.source, FLAGS))).toEqual(addressWords(asm));
      return scoreC(decls + cand.source, 'both', target, FLAGS).score;
    });
    expect(scores).toContain(0);
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

  test.each(ADDRESS_CASES)('an initializer holding addresses: $sym', ({ sym, c, context, spelled, mwccDeclines }) => {
    const { obj, asm } = compilePpcTarget('mwcc_242_81', context + c, sym, FLAGS);
    const asmData = extractPpcAsmData(obj, sym);
    if (mwccDeclines) {
      expect(() => decompile(sym, asm, PPC_MWCC, { asmData })).toThrow(mwccDeclines);
      return;
    }
    const r = decompile(sym, asm, PPC_MWCC, { asmData });
    expect(r.source).toMatch(spelled);
    const cand = compileCandPpc('mwcc_242_81', context + r.source, FLAGS);
    expect(dataSections(cand)).toEqual(dataSections(obj));
    expect(staticPlaces(cand)).toEqual(staticPlaces(obj));
    const inData = (o: string) =>
      extractPpcAsmData(o, sym)
        .relocs.filter((x) => DATA_SECTIONS.has(x.section))
        .sort((a, b) => a.section.localeCompare(b.section) || a.offset - b.offset);
    expect(asmData.relocs.some((x) => DATA_SECTIONS.has(x.section))).toBe(true);
    expect(inData(cand)).toEqual(inData(obj));
    const s = scoreCPpc('mwcc_242_81', context + r.source, sym, obj, FLAGS);
    expect(s.match, `objdiff ${s.score}\n${r.source}`).toBe(true);
  });

  test('a table member the body also calls with no prototype is declared ahead of the static', () => {
    // mwcc has no implicit declaration to fall back on inside an initializer either: "undefined
    // identifier 'h1'" unless the block declares it (`int h1();`).
    const c =
      'extern s32 ga; extern s32 h1(s32);\n' +
      's32 q1(s32 i) { static s32 *const t[2] = { &ga, (s32 *)h1 }; return *t[i] + h1(i); }';
    const { obj, asm } = compilePpcTarget('mwcc_242_81', c, 'q1', FLAGS);
    const asmData = extractPpcAsmData(obj, 'q1');
    const cands = enumerateCandidates('q1', asm, PPC_MWCC, { asmData, prototypes: {} });
    expect(cands.length).toBeGreaterThan(0);
    const scores = cands.map((cand) => {
      const decls = renderDeclarations(cand.symbolRefs ?? []);
      expect(decls).toMatch(/^int h1\(\);$/m);
      return scoreCPpc('mwcc_242_81', decls + cand.source, 'q1', obj, FLAGS).score;
    });
    expect(scores).toContain(0);
  });

  test('an address element passed to a declared pointer parameter is cast, which mwcc’s C requires', () => {
    // The element is held as `u32`; mwcc refuses the implicit `u32` → `s32 *` at the call ("illegal
    // implicit conversion from 'const unsigned int' to 'int *'") where agbcc converts it.
    const context = 'extern s32 ga, gb; void g(s32 *);\n';
    const c = 'void mdp(s32 i) { static s32 *const t[2] = { &ga, &gb }; g(t[i]); }';
    const prototypes = { g: { params: ['s32 *'], returnsVoid: true }, mdp: { params: ['s32'], returnsVoid: true } };
    const { obj, asm } = compilePpcTarget('mwcc_242_81', context + c, 'mdp', FLAGS);
    const r = decompile('mdp', asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, 'mdp'), prototypes });
    expect(r.source).toContain('g((s32 *)t[a0]);');
    expect(scoreCPpc('mwcc_242_81', context + r.source, 'mdp', obj, FLAGS).match, r.source).toBe(true);
  });

  test('an address element stored into a pointer global is cast, which mwcc’s C requires', () => {
    // The store is the argument's conversion again: `gp = t[a0];` is "illegal implicit conversion
    // from 'const unsigned int' to 'int *'" where agbcc converts it. The project's map is what says
    // `gp` is a pointer.
    const context = 'extern s32 ga, gb; extern s32 *gp;\n';
    const c = 'void mst(s32 i) { static s32 *const t[2] = { &ga, &gb }; gp = t[i]; }';
    const symbols: SymbolMap = new Map([
      [0x80400000, [{ name: 'gp', kind: 'data', declared: true, shape: 'pointer', size: 4 }]],
    ]);
    const prototypes = { mst: { params: ['s32'], returnsVoid: true } };
    const { obj, asm } = compilePpcTarget('mwcc_242_81', context + c, 'mst', FLAGS);
    const r = decompile('mst', asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, 'mst'), prototypes, symbols });
    expect(r.source).toContain('gp = (void *)t[a0];');
    expect(scoreCPpc('mwcc_242_81', context + r.source, 'mst', obj, FLAGS).match, r.source).toBe(true);
  });

  test('a cell only the body reads as a pointer takes no cast: the project may declare it an integer', () => {
    // The map names `gw` but gives no shape; the body dereferences it, so it reads as a pointer
    // cell. `(void *)` into the project's `u32 gw` is "illegal implicit conversion from 'void *' to
    // 'unsigned int'" on mwcc, where the bare value compiles.
    const context = 'extern u32 gw;\n';
    const c = 'void mcd(u32 x) { *(s32 *)gw = 1; gw = x * 3; }';
    const symbols: SymbolMap = new Map([[0x80400000, [{ name: 'gw', kind: 'data', declared: true, size: 4 }]]]);
    const prototypes = { mcd: { params: ['u32'], returnsVoid: true } };
    const { obj, asm } = compilePpcTarget('mwcc_242_81', context + c, 'mcd', FLAGS);
    const r = decompile('mcd', asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, 'mcd'), prototypes, symbols });
    expect(r.source).not.toContain('(void *)');
    expect(scoreCPpc('mwcc_242_81', context + r.source, 'mcd', obj, FLAGS).match, r.source).toBe(true);
  });

  test('a pointer copied from a global no declaration types is stored bare, which C++ requires', () => {
    // `gp = gq`: both pointers in the header, neither typed for asmlift. C++ refuses `(void *)gq`
    // into an `int *` ("illegal implicit conversion from 'void *' to 'int *'").
    const CXX = [...FLAGS, '-lang=c++'];
    const context = 'extern s32 *gp, *gq;\n';
    const c = 'extern "C" void cx(s32 n) { *gp = n; gp = gq; }';
    const prototypes = { cx: { params: ['s32'], returnsVoid: true } };
    const { obj, asm } = compilePpcTarget('mwcc_242_81', context + c, 'cx', CXX);
    const r = decompile('cx', asm, targetFor('mwcc_242_81', CXX).target, {
      asmData: extractPpcAsmData(obj, 'cx'),
      prototypes,
    });
    expect(r.source).toContain('gp = gq;');
    const unit = `${context}extern "C" {\n${r.source}\n}`;
    expect(scoreCPpc('mwcc_242_81', unit, 'cx', obj, CXX).match, r.source).toBe(true);
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
    {
      sym: 'zwide',
      c:
        'extern void use(s32 *); void zwide(void) { static s32 c; ' +
        'static s32 a __attribute__((aligned(8))) = 0; use(&c); use(&a); }',
    },
  ])('-sdata 0: $sym, a static where only a zero scalar sits, declared here as bytes, declines', ({ sym, c }) => {
    const { obj, asm } = compilePpcTarget('mwcc_242_81', c, sym, SDATA0);
    expect(() => decompile(sym, asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, sym) })).toThrow(
      /names a function-scope static \('a\$\d+'\) laid out where only a scalar initialized to zero is, but of 4 elements/,
    );
  });
});
