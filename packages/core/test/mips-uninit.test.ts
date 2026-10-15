// UNINITIALISED LOCALS ON MIPS (frontend/mips.ts): the O32 live-in model. A def-less read of a
// register O32 passes no argument in, that is scratch or the prologue saved, is an uninitialised
// local (`registerLiveIns`, MIPS_IDO/MIPS_GCC `nonArgRegs`/`scratchRegs`); so is a def-less read of
// a word of the one frame the function pushed, where nothing but the function could have written
// it (`ownedFrame`). Everything else keeps the parameter or the refusal it had. The compiled
// fixtures are the synthetic tier's rows, built at each toolchain's canonical flags.
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

  // Hand-written O32 asm hands values over in scratch registers (af's famicom_emu stores the t0 it
  // is handed, `sw t0,6348(s8)`), while a local the compiler homed in one is assigned on some path,
  // so its entry value meets that assignment at a join. An entry value no join takes refuses.
  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])("a scratch register's entry value no join takes refuses (%s)", (_c, target) => {
    for (const r of ['at', 'v0', 'v1', 't0', 't9']) {
      expect(lift(['0:\tjr\tra', `4:\taddu\tv0,${r},a0`], target)).toThrow(
        new RegExp(`${r} is read before anything writes it, and no path's definition joins it`),
      );
    }
  });
});

describe('the frame half: words of the frame the function pushed', () => {
  // `uninit_join` at ido7.1 -O2: r lives in 4(sp) of an 8-byte leaf frame, pushed in the first
  // branch's delay slot.
  test('a word stored on one path only is the local the other path leaves unset', () => {
    expect(
      src(
        [
          '0:\tblez\ta0,10 <f+0x10>',
          '4:\taddiu\tsp,sp,-8',
          '8:\tsll\tt6,a0,0x1',
          'c:\tsw\tt6,4(sp)',
          '10:\tlw\tv0,4(sp)',
          '14:\taddiu\tsp,sp,8',
          '18:\tjr\tra',
          '1c:\taddiu\tv0,v0,1',
        ],
        MIPS_IDO,
      ),
    ).toBe('s32 f(s32 a0) {\n    s32 v0;\n    if (a0 > 0) v0 = a0 << 1;\n    return v0 + 1;\n}\n');
  });

  // `uninit_spill` at ido7.1 reads 36(sp) and 0(sp), which no instruction stores: a local the
  // source never assigns on that path. In a leaf nothing else can write the frame.
  test('a word of a leaf frame no store reaches is uninitialised', () => {
    expect(src(['0:\taddiu\tsp,sp,-24', '4:\tlw\tv0,8(sp)', '8:\tjr\tra', 'c:\taddiu\tsp,sp,24'], MIPS_IDO)).toBe(
      's32 f(void) {\n    s32 uninit_sp8;\n    return uninit_sp8;\n}\n',
    );
  });

  // `uninit_saved` at ido7.1 -O2: x lives in 28(sp), above the 16-byte outgoing area of calls to a
  // one-argument k, and the path that skips the first call reads it unstored.
  test('past the outgoing area of a function that calls, the same holds', () => {
    expect(
      src(
        [
          '0:\taddiu\tsp,sp,-32',
          '4:\tsw\tra,20(sp)',
          '8:\tsw\ta2,40(sp)',
          'c:\tbeqz\ta0,20 <f+0x20>',
          '10:\tsw\ta3,44(sp)',
          '14:\tjal\t0 <f>',
          '18:\tmove\ta0,a1',
          '1c:\tsw\tv0,28(sp)',
          '20:\tjal\t0 <f>',
          '24:\tlw\ta0,40(sp)',
          '28:\tlw\tt6,44(sp)',
          '2c:\tjal\t0 <f>',
          '30:\taddu\ta0,v0,t6',
          '34:\tlw\tt7,48(sp)',
          '38:\tjal\t0 <f>',
          '3c:\taddu\ta0,v0,t7',
          '40:\tlw\tt8,52(sp)',
          '44:\tjal\t0 <f>',
          '48:\taddu\ta0,v0,t8',
          '4c:\tlw\tra,20(sp)',
          '50:\tlw\tt9,28(sp)',
          '54:\taddiu\tsp,sp,32',
          '58:\tjr\tra',
          '5c:\taddu\tv0,v0,t9',
        ],
        MIPS_IDO,
        callsTo('k', [0x14, 0x20, 0x2c, 0x38, 0x44]),
        { k: { params: 1 } },
      ),
    ).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n' +
        '    s32 v0;\n' +
        '    if (a0 != 0) v0 = k(a1);\n' +
        '    return k(k(k(k(a2) + a3) + a4) + a5) + v0;\n' +
        '}\n',
    );
  });

  const NEVER = /that was never stored/;
  const CALL = ['0:\taddiu\tsp,sp,-32', '4:\tsw\tra,20(sp)', '8:\tjal\t0 <f>', 'c:\tnop'];
  const READ = (off: number) => [
    `10:\tlw\tt6,${off}(sp)`,
    '14:\taddu\tv0,v0,t6',
    '18:\tlw\tra,20(sp)',
    '1c:\tjr\tra',
    '20:\taddiu\tsp,sp,32',
  ];
  const G = callsTo('g', [8]);

  // A callee stores its a0..a3 into the caller's [0,16) and assigns a stack parameter in place, so
  // below the outgoing area's end a word a call reaches may hold what the callee left there.
  test('a word in the outgoing area of a function that calls keeps its refusal', () => {
    expect(lift([...CALL, ...READ(4)], MIPS_IDO, G, { g: { params: 0 } })).toThrow(NEVER);
    expect(src([...CALL, ...READ(28)], MIPS_IDO, G, { g: { params: 0 } })).toBe(
      's32 f(void) {\n    s32 uninit_sp28;\n    return g() + uninit_sp28;\n}\n',
    );
  });

  test('a callee no declaration sizes leaves the outgoing area unknown, so nothing is claimed', () => {
    expect(lift([...CALL, ...READ(28)], MIPS_IDO, G)).toThrow(NEVER);
  });

  test("the caller's home of a0..a3, above the frame, is in no range", () => {
    expect(lift(['0:\taddiu\tsp,sp,-8', '4:\tlw\tv0,12(sp)', '8:\tjr\tra', 'c:\taddiu\tsp,sp,8'], MIPS_IDO)).toThrow(
      NEVER,
    );
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-8',
          '4:\tbeqz\ta0,14 <f+0x14>',
          '8:\tnop',
          'c:\tsw\ta0,12(sp)',
          '10:\tnop',
          '14:\tlw\tv0,12(sp)',
          '18:\taddiu\tv0,v0,1',
          '1c:\tjr\tra',
          '20:\taddiu\tsp,sp,8',
        ],
        MIPS_IDO,
      ),
    ).toThrow(/sp@12 is read on a path that never stores it, and lies outside this function's frame partition/);
  });

  // `int g(int); int cv(int a,int c){ int r; if (c) r = g(a); return r + 1; }` at ido7.1 -O2, with g
  // mis-declared void: what the arm stores in 28(sp) is the callee's v0, and it reaches the reload
  // only as the argument of the join's phi. Declared as returning, it lifts.
  const CV = [
    '0:\taddiu\tsp,sp,-32',
    '4:\tbeqz\ta1,18 <f+0x18>',
    '8:\tsw\tra,20(sp)',
    'c:\tjal\t0 <f>',
    '10:\tnop',
    '14:\tsw\tv0,28(sp)',
    '18:\tlw\tra,20(sp)',
    '1c:\tlw\tv0,28(sp)',
    '20:\taddiu\tsp,sp,32',
    '24:\tjr\tra',
    '28:\taddiu\tv0,v0,1',
  ];
  test("a call's destroyed v0 stored to an owned word refuses where the join reads it back", () => {
    expect(lift(CV, MIPS_IDO, callsTo('g', [0xc]), { g: { params: 1, returnsVoid: true } })).toThrow(
      /v0 is read on a path where a call has destroyed it/,
    );
    expect(src(CV, MIPS_IDO, callsTo('g', [0xc]), { g: { params: 1 } })).toBe(
      's32 f(s32 a0, s32 a1) {\n    s32 v0;\n    if (a1 != 0) v0 = g(a0);\n    return v0 + 1;\n}\n',
    );
  });

  // The key is the raw offset, so a word reached at the entry depth names other storage under the
  // same spelling: one such access and the frame claims nothing.
  test('an sp access at another depth than the frame withdraws the claim', () => {
    expect(
      lift(
        [
          '0:\tlw\tv0,4(sp)',
          '4:\taddiu\tsp,sp,-8',
          '8:\tlw\tv1,4(sp)',
          'c:\taddu\tv0,v0,v1',
          '10:\tjr\tra',
          '14:\taddiu\tsp,sp,8',
        ],
        MIPS_IDO,
      ),
    ).toThrow(NEVER);
  });
});
