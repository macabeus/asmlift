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
// The sections compared are the object's whole .rodata and .data contents and its .bss size: each
// reference below defines one function and nothing else, so they hold exactly its statics.
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

/** The data sections of an ELF32 object: contents for .rodata/.data, the size of .bss. */
function dataSections(obj: string): { rodata: number[]; data: number[]; bss: number } {
  const b = readFileSync(obj);
  const big = b[5] === 2;
  const u16 = (o: number) => (big ? b.readUInt16BE(o) : b.readUInt16LE(o));
  const u32 = (o: number) => (big ? b.readUInt32BE(o) : b.readUInt32LE(o));
  const shoff = u32(0x20);
  const shentsize = u16(0x2e);
  const shnum = u16(0x30);
  const shstr = u32(shoff + u16(0x32) * shentsize + 16);
  const out = { rodata: [] as number[], data: [] as number[], bss: 0 };
  for (let i = 0; i < shnum; i++) {
    const h = shoff + i * shentsize;
    const nameAt = shstr + u32(h);
    const name = b.toString('latin1', nameAt, b.indexOf(0, nameAt));
    const off = u32(h + 16);
    const size = u32(h + 20);
    if (name === '.rodata' || name === '.data') {
      out[name.slice(1) as 'rodata' | 'data'] = [...b.subarray(off, off + size)];
    } else if (name === '.bss') {
      out.bss = size;
    }
  }
  return out;
}

/** Each case: the function, and what its static's definition must read as in the emitted C.
 *  `agbccScore` is the default candidate's objdiff score where it is not 0: the same function
 *  reading an `extern` instead of a static lifts to the same body and scores the same, so the
 *  difference is a spelling gap of the access, not of the static. */
const CASES: { sym: string; c: string; spelled: RegExp; agbccScore?: number }[] = [
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
];

describe('function-scope statics — real agbcc: the candidate defines the target’s bytes', () => {
  const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
  test.each(CASES)('$sym', ({ sym, c, spelled, agbccScore = 0 }) => {
    const asm = compileTargetAsm(c, FLAGS);
    const target = assembleTarget(asm);
    const r = decompile(sym, asm, ARMV4T_AGBCC);
    expect(r.source).toMatch(spelled);
    expect(dataSections(compileCandAgbcc(r.source, FLAGS))).toEqual(dataSections(target));
    expect(scoreC(r.source, sym, target, FLAGS).score, r.source).toBe(agbccScore);
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
  test.each(CASES)('$sym', ({ sym, c, spelled }) => {
    const { obj, asm } = compilePpcTarget('mwcc_242_81', c, sym, FLAGS);
    const r = decompile(sym, asm, PPC_MWCC, { asmData: extractPpcAsmData(obj, sym) });
    expect(r.source).toMatch(spelled);
    expect(dataSections(compileCandPpc('mwcc_242_81', r.source, FLAGS))).toEqual(dataSections(obj));
    const s = scoreCPpc('mwcc_242_81', r.source, sym, obj, FLAGS);
    expect(s.match, `objdiff ${s.score}\n${r.source}`).toBe(true);
  });

  test('without the object’s data the static declines rather than lifting a name with no definition', () => {
    const { asm } = compilePpcTarget('mwcc_242_81', CASES[0].c, CASES[0].sym, FLAGS);
    expect(() => decompile(CASES[0].sym, asm, PPC_MWCC)).toThrow(
      /names a function-scope static \('tide\$\d+'\) whose definition needs the object's data/,
    );
  });
});
