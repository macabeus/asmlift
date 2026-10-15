// UNINITIALISED LOCALS ON MIPS (frontend/mips.ts): the O32 live-in model. A def-less read of a
// register O32 passes no argument in, that is scratch or the prologue saved, is an uninitialised
// local (`registerLiveIns`, MIPS_IDO/MIPS_GCC `nonArgRegs`/`scratchRegs`). Everything else keeps
// the parameter or the refusal it had. The compiled fixtures are the synthetic tier's rows, built
// at each toolchain's canonical flags.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { assertScratchRegsPartitioned, registerLiveIns } from '../src/frontend/ssa';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { MIPS_GCC, MIPS_IDO, type TargetDescription } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

/** `.text` R_MIPS_26 records naming `k`, as `objdump -r` hands them over. */
const callsTo = (sym: string, offsets: number[]): AsmData => ({
  sections: new Map(),
  relocs: offsets.map((offset) => ({ section: '.text', offset, type: 'R_MIPS_26', sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

const src = (lines: string[], target: TargetDescription, asmData?: AsmData, prototypes: Prototypes = {}) =>
  decompile('f', obj(lines), target, { ...(asmData ? { asmData } : {}), prototypes }).source;
const lift =
  (...args: Parameters<typeof src>) =>
  () =>
    src(...args);

describe('the O32 register partition', () => {
  test.each([
    ['ido', MIPS_IDO],
    ['gcc', MIPS_GCC],
  ])('is stated, disjoint from the argument registers, and its scratch half is inside it (%s)', (_c, target) => {
    expect(target.nonArgRegs).toBeDefined();
    expect(target.nonArgRegs!.filter((r) => target.argRegs.includes(r))).toEqual([]);
    expect([...assertScratchRegsPartitioned(target)].sort()).toEqual(
      ['at', 'v0', 'v1', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'].sort(),
    );
    // the scratch half is every caller-saved register no argument travels in, and nothing else
    expect(target.callerSaved.filter((r) => r !== 'ra' && !target.argRegs.includes(r)).sort()).toEqual(
      [...(target.scratchRegs ?? [])].sort(),
    );
    // a callee-saved register is a local's home only once the frontend measures its save
    expect(registerLiveIns(target, new Set()).uninitRegs).not.toContain('s0');
    expect(registerLiveIns(target, new Set(['s0'])).uninitRegs).toContain('s0');
  });
});

describe('the register half: scratch and saved registers', () => {
  // `int uninit_join(int a){ int r; if(a>0) r=a*2; return r+1; }`, gcc2.7.2kmc -O2 (and gcc2.7.2
  // -O1, byte-identical): r lives in v0, set only in the branch-likely slot. Before the model this
  // lifted as `uninit_join(s32 a0, s32 a1)` with `return a1 | 1`.
  const UJOIN_KMC = ['0:\tbgtzl\ta0,c <f+0xc>', '4:\tsll\tv0,a0,0x1', '8:\tnop', 'c:\tjr\tra', '10:\tori\tv0,v0,0x1'];

  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])('v0 a path never assigns is a local, not a second parameter (%s)', (_c, target) => {
    expect(src(UJOIN_KMC, target)).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    if (a0 > 0) v0 = a0 << 1;\n    return v0 | 1;\n}\n',
    );
  });

  // `int k(int); int uninit_saved(int s,int a,int b,int c,int d,int e){ int x; if (s) x = k(a);
  // return k(k(k(k(b)+c)+d)+e) + x; }` at gcc2.7.2 -O1: x lives across the calls in s2, which the
  // prologue saved, and the path that skips the call reads what the caller left there. Before the
  // model that read was a SEVENTH parameter.
  const USAVED_GCC272 = [
    '0:\taddiu\tsp,sp,-40',
    '4:\tsw\tra,36(sp)',
    '8:\tsw\ts4,32(sp)',
    'c:\tsw\ts3,28(sp)',
    '10:\tsw\ts2,24(sp)',
    '14:\tsw\ts1,20(sp)',
    '18:\tsw\ts0,16(sp)',
    '1c:\tmove\ts0,a2',
    '20:\tlw\ts3,56(sp)',
    '24:\tlw\ts4,60(sp)',
    '28:\tbeqz\ta0,3c <f+0x3c>',
    '2c:\tmove\ts1,a3',
    '30:\tjal\t0 <f>',
    '34:\tmove\ta0,a1',
    '38:\tmove\ts2,v0',
    '3c:\tjal\t0 <f>',
    '40:\tmove\ta0,s0',
    '44:\tjal\t0 <f>',
    '48:\taddu\ta0,v0,s1',
    '4c:\tjal\t0 <f>',
    '50:\taddu\ta0,v0,s3',
    '54:\tjal\t0 <f>',
    '58:\taddu\ta0,v0,s4',
    '5c:\taddu\tv0,v0,s2',
    '60:\tlw\tra,36(sp)',
    '64:\tlw\ts4,32(sp)',
    '68:\tlw\ts3,28(sp)',
    '6c:\tlw\ts2,24(sp)',
    '70:\tlw\ts1,20(sp)',
    '74:\tlw\ts0,16(sp)',
    '78:\tjr\tra',
    '7c:\taddiu\tsp,sp,40',
  ];

  test('a callee-saved register the prologue saved is a local the skipped path leaves unset', () => {
    expect(src(USAVED_GCC272, MIPS_GCC, callsTo('k', [0x30, 0x3c, 0x44, 0x4c, 0x54]), { k: { params: 1 } })).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n' +
        '    s32 v0;\n' +
        '    if (a0 != 0) v0 = k(a1);\n' +
        '    return k(k(k(k(a2) + a3) + a4) + a5) + v0;\n' +
        '}\n',
    );
  });

  const SAVED_S1 = (first: string[]) => [
    '0:\taddiu\tsp,sp,-8',
    ...first,
    '0c:\tlw\ts1,4(sp)',
    '10:\tjr\tra',
    '14:\taddiu\tsp,sp,8',
  ];

  test('a saved s1 read before anything writes it is uninitialised', () => {
    expect(src(SAVED_S1(['4:\tsw\ts1,4(sp)', '8:\taddu\tv0,s1,a0']), MIPS_GCC)).toBe(
      's32 f(s32 a0) {\n    s32 uninit_s1;\n    return uninit_s1 + a0;\n}\n',
    );
  });

  // The save is the frontend's half of the rule: without it the register may be a value handed
  // over by asm that follows no ABI, so it keeps the parameter it always had.
  test('an s-register nothing saved, or that was read before its store, stays a parameter', () => {
    expect(src(['0:\tjr\tra', '4:\taddu\tv0,s1,a0'], MIPS_GCC)).toMatch(/^s32 f\(s32 a0, s32 a1\) \{/);
    expect(src(SAVED_S1(['4:\taddu\tv0,s1,a0', '8:\tsw\ts1,4(sp)']), MIPS_GCC)).toMatch(/^s32 f\(s32 a0, s32 a1\) \{/);
  });

  test('an argument register read first stays a parameter', () => {
    expect(src(['0:\tjr\tra', '4:\taddu\tv0,a1,a0'], MIPS_GCC)).toMatch(/^s32 f\(s32 a0, s32 a1\) \{/);
  });

  // gcc hands a nested function its static chain in v0, and -mabicalls code its own address in t9:
  // used directly, with no path's definition beside it, each refuses rather than becoming a local.
  test('a hidden input read directly refuses: gcc v0, and t9 on both', () => {
    const HIDDEN = /is read before anything writes it, and no path's definition joins it/;
    expect(lift(['0:\tjr\tra', '4:\taddu\tv0,v0,a0'], MIPS_GCC)).toThrow(HIDDEN);
    expect(lift(['0:\tjr\tra', '4:\taddu\tv0,t9,a0'], MIPS_GCC)).toThrow(HIDDEN);
    expect(lift(['0:\tjr\tra', '4:\taddu\tv0,t9,a0'], MIPS_IDO)).toThrow(HIDDEN);
    expect(src(['0:\tjr\tra', '4:\taddu\tv0,v0,a0'], MIPS_IDO)).toBe(
      's32 f(s32 a0) {\n    s32 uninit_v0;\n    return uninit_v0 + a0;\n}\n',
    );
  });
});
