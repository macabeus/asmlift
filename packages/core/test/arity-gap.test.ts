// A GAP IN A GUESSED CALL ARITY, DECIDED (frontend/call-plan.ts `decideGap`). An argument register
// left at its incoming value below one the call's own block set up is the function's own argument
// passed on — where the set one is surely an argument, and the ABI cannot leave the gap empty below
// it. Each fixture is the toolchain's own output (canonical flags, 2026-10-18); the Thumb shapes are
// in thumb-frontend.test.ts beside the refusal they replaced.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { type Prototypes, ownLeadingWordParams } from '../src/proto';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, TOOLCHAIN_TARGETS, argRegisterHoles } from '../src/target';

describe('where an ABI can leave an argument register empty below a filled one', () => {
  test('an 8-byte argument skips an odd word on O32 and PowerPC, and a leading float shadows O32 words', () => {
    expect(argRegisterHoles(ARMV4T_AGBCC)).toEqual({ skippable: new Set(), leadingFloatShadow: false });
    for (const t of [MIPS_IDO, MIPS_GCC]) {
      expect(argRegisterHoles(t)).toEqual({ skippable: new Set(['a1', 'a3']), leadingFloatShadow: true });
    }
    expect(argRegisterHoles(PPC_MWCC)).toEqual({
      skippable: new Set(['r4', 'r6', 'r8', 'r10']),
      leadingFloatShadow: false,
    });
  });

  test('every toolchain states it through the facts that place its arguments', () => {
    const holes = Object.fromEntries(
      Object.entries(TOOLCHAIN_TARGETS).map(([id, r]) => {
        const h = argRegisterHoles(r.description);
        return [id, [[...h.skippable].join(','), h.leadingFloatShadow]];
      }),
    );
    expect(holes).toMatchObject({
      agbcc: ['', false],
      'ido7.1': ['a1,a3', true],
      'gcc2.7.2kmc': ['a1,a3', true],
      'gcc2.7.2': ['a1,a3', true],
      mwcc_242_81: ['r4,r6,r8,r10', false],
      mwcc_233_163n: ['r4,r6,r8,r10', false],
      mwcc_247_107: ['r4,r6,r8,r10', false],
    });
  });
});

describe('the first argument registers that surely hold an own word parameter', () => {
  const n = (p: Parameters<typeof ownLeadingWordParams>[1], target = MIPS_IDO) => ownLeadingWordParams('f', p, target);
  test('counts leading integer words, and stops at anything else', () => {
    expect(n({ params: ['const char *', 's32'], returns: 's32' })).toBe(2);
    expect(n({ params: ['s32', 'float', 's32'], returns: 's32' })).toBe(1);
    expect(n({ params: ['float', 's32'], returns: 's32' })).toBe(0);
    expect(n({ params: ['s32', 'long long'], returns: 'void' })).toBe(1);
  });
  test('is none where a hidden word may come first, or nothing is laid out', () => {
    expect(n(undefined)).toBe(0);
    expect(n({ params: 2 })).toBe(0);
    // an unsized parameter anywhere lays nothing out
    expect(n({ params: ['s32', 'Foo'], returns: 's32' })).toBe(0);
    // a return the declaration does not show is a scalar may be a struct handed back through a0
    expect(n({ params: ['s32'] })).toBe(0);
    expect(n({ params: ['s32'], returns: 'struct Big' })).toBe(0);
  });
});

/** Wrap objdump-shaped MIPS body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const mips = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');
const jalTo = (offset: number, sym: string): AsmData => ({
  sections: new Map(),
  relocs: [{ section: '.text', offset, type: 'R_MIPS_26', sym, addend: 0 }],
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});
const own = (params: string[]): Prototypes => ({ f: { params, returns: 's32' } });

describe('on O32 (gcc2.7.2kmc), a gap is decided where the own declaration rules out the holes', () => {
  // `int logv(); int f(const char *s){ return logv(s, 1) + 1; }`
  const passgap = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tjal\t0 <f>',
    'c:\tli\ta1,1',
    '10:\tlw\tra,16(sp)',
    '14:\taddiu\tv0,v0,1',
    '18:\tjr\tra',
    '1c:\taddiu\tsp,sp,24',
  ];
  const lift = (lines: string[], sym: string, prototypes: Prototypes = {}) =>
    decompile('f', mips(lines), MIPS_GCC, { asmData: jalTo(lines === passgap ? 8 : 0xc, sym), prototypes }).source;

  test('a0 below a set a1 is passed on where the own declaration puts an integer word there', () => {
    expect(lift(passgap, 'logv', own(['const char *']))).toContain('return logv(a0, 1) + 1;');
  });
  // `int gp(float, int); int f(float x){ return gp(x, 5) + 1; }` is the same object: the float
  // crosses in $f12 and leaves a0 holding nothing
  test('…and refuses where a leading float may have left a0 empty', () => {
    expect(() => lift(passgap, 'logv')).toThrow(/a1 holds a value and a0 holds none/);
    expect(() => lift(passgap, 'logv', own(['float']))).toThrow(/a1 holds a value and a0 holds none/);
  });

  // `int g3(); int f(int a, int b){ return g3(1, b, 3) + 1; }`
  const passmid = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tli\ta0,1',
    'c:\tjal\t0 <f>',
    '10:\tli\ta2,3',
    '14:\tlw\tra,16(sp)',
    '18:\taddiu\tv0,v0,1',
    '1c:\tjr\tra',
    '20:\taddiu\tsp,sp,24',
  ];
  test('a1 below a set a2 is passed on where a3 holds nothing an 8-byte argument could own', () => {
    expect(lift(passmid, 'g3', own(['s32', 's32']))).toContain('return g3(1, a1, 3) + 1;');
  });
  // `g3(1, ((long long)3 << 32) | d)` of a fourth parameter `d` sets a0 and a2 alone as well, so a3
  // left at an incoming value may be the low word of a pair that skipped a1
  test('…and refuses where a3 may be an own parameter, or nothing says', () => {
    expect(() => lift(passmid, 'g3')).toThrow(/a2 holds a value and a1 holds none/);
    expect(() => lift(passmid, 'g3', own(['s32', 's32', 's32', 's32']))).toThrow(/a2 holds a value and a1 holds none/);
  });

  // `int g(); int f(int a, int b){ return g(1, 3LL) + 1; }`, the object `g(1, b, 0, 3)` compiles to
  test('a1 below a set a2:a3 pair is the hole an 8-byte argument skips, and refuses', () => {
    const fb = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tli\ta2,0',
      'c:\tli\ta3,3',
      '10:\tjal\t0 <f>',
      '14:\tli\ta0,1',
      '18:\tlw\tra,16(sp)',
      '1c:\taddiu\tv0,v0,1',
      '20:\tjr\tra',
      '24:\taddiu\tsp,sp,24',
    ];
    expect(() =>
      decompile('f', mips(fb), MIPS_GCC, { asmData: jalTo(0x10, 'g'), prototypes: own(['s32', 's32']) }),
    ).toThrow(/a2 holds a value and a1 holds none/);
  });
});

describe('on PowerPC (mwcc_242_81), a gap is decided where no 8-byte argument can own it', () => {
  const ppc = (body: string) => `0 <f>:\n${body}`;
  const call = (at: number, sym: string) =>
    `${at.toString(16)}:\tbl      ${at.toString(16)} <f+0x${at.toString(16)}>\n\t\t\t${at.toString(16)}: R_PPC_REL24\t${sym}\n`;
  const frame = (setup: string, at: number, sym: string) =>
    ppc(
      '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n' +
        setup +
        call(at, sym) +
        `${(at + 4).toString(16)}:\tlwz     r0,20(r1)\n${(at + 8).toString(16)}:\taddi    r3,r3,1\n` +
        `${(at + 12).toString(16)}:\tmtlr    r0\n${(at + 16).toString(16)}:\taddi    r1,r1,16\n${(at + 20).toString(16)}:\tblr\n`,
    );

  // `int logv(); int f(const char *s){ return logv(s, 1) + 1; }`: r3 is even, and PowerPC's floats
  // take no general word, so nothing can leave it empty
  test('r3 below a set r4 is passed on, with or without an own declaration', () => {
    const passgap = frame('8:\tli      r4,1\nc:\tstw     r0,20(r1)\n', 0x10, 'logv');
    expect(decompile('f', passgap, PPC_MWCC).source).toContain('return logv(a0, 1) + 1;');
    expect(decompile('f', passgap, PPC_MWCC, { prototypes: own(['const char *']) }).source).toContain(
      'return logv(a0, 1) + 1;',
    );
    // …but not where the own declaration gives r3 no parameter
    expect(() => decompile('f', passgap, PPC_MWCC, { prototypes: own([]) })).toThrow(
      /r4 holds a value and r3 holds none/,
    );
  });

  // `int g3(); int f(int a, int b){ return g3(1, b, 3) + 1; }`
  test('r4 below a set r5 is passed on where r6 holds nothing an 8-byte argument could own', () => {
    const passmid = frame('8:\tli      r3,1\nc:\tli      r5,3\n10:\tstw     r0,20(r1)\n', 0x14, 'g3');
    expect(decompile('f', passmid, PPC_MWCC, { prototypes: own(['s32', 's32']) }).source).toContain(
      'return g3(1, a1, 3) + 1;',
    );
    expect(() => decompile('f', passmid, PPC_MWCC)).toThrow(/r5 holds a value and r4 holds none/);
  });

  // `int g(); int f(int a, int b){ return g(1, 3LL) + 1; }`, the object `g(1, b, 0, 3)` compiles to
  test('r4 below a set r5:r6 pair is the hole an 8-byte argument skips, and refuses', () => {
    const fb = frame('8:\tli      r3,1\nc:\tli      r6,3\n10:\tstw     r0,20(r1)\n14:\tli      r5,0\n', 0x18, 'g');
    expect(() => decompile('f', fb, PPC_MWCC, { prototypes: own(['s32', 's32']) })).toThrow(
      /r5 holds a value and r4 holds none/,
    );
  });
});
