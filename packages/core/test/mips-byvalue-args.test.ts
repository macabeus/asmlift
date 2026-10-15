// A struct passed BY VALUE on O32 (ido7.1, gcc2.7.2kmc, gcc2.7.2). Every fixture is the compiler's
// own output at the benchmark's flags for the source above it, read with `objdump -dr`:
//
//   struct W { u32 x; }; struct Q { u32 a, b; }; struct T { u32 a, b, c; }; struct P { u16 a, b; };
//   void takeW(struct W w); void takeQ(s32 k, struct Q q); void takeT(struct T t); void takeP(struct P p);
//   extern struct W gW; extern struct Q gQ; extern struct T gT; extern struct P gP;
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { MIPS_GCC, MIPS_IDO, type TargetDescription } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (name: string, lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n' +
  `00000000 <${name}>:\n` +
  lines.map((l) => `   ${l}\n`).join('');

/** `.text` relocation records, as the object's `objdump -r` side table hands them over. */
const relocs = (rs: [offset: number, type: string, sym: string][]): AsmData => ({
  sections: new Map(),
  relocs: rs.map(([offset, type, sym]) => ({ section: '.text', offset, type, sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

interface Fixture {
  readonly lines: string[];
  readonly rs: [number, string, string][];
}

const lift = (name: string, f: Fixture, target: TargetDescription, prototypes: Prototypes = PROTOS) =>
  decompile(name, obj(name, f.lines), target, { asmData: relocs(f.rs), prototypes }).source;

const u32s = (...names: string[]) => ({
  kind: 'struct' as const,
  members: names.map((name) => ({ name, type: 'u32' })),
});
const PROTOS: Prototypes = {
  takeW: { params: ['struct W'], byValueLayouts: { 0: u32s('x') }, returnsVoid: true },
  takeQ: { params: ['s32', 'struct Q'], byValueLayouts: { 1: u32s('a', 'b') }, returnsVoid: true },
  takeT: { params: ['struct T'], byValueLayouts: { 0: u32s('a', 'b', 'c') }, returnsVoid: true },
  takeP: {
    params: ['struct P'],
    byValueLayouts: {
      0: {
        kind: 'struct',
        members: [
          { name: 'a', type: 'u16' },
          { name: 'b', type: 'u16' },
        ],
      },
    },
    returnsVoid: true,
  },
};

// `void bvwg(void) { takeW(gW); }`
const KMC_BVWG: Fixture = {
  lines: [
    '0:\tlui\ta0,0x0',
    '4:\tlw\ta0,0(a0)',
    '8:\taddiu\tsp,sp,-24',
    'c:\tsw\tra,16(sp)',
    '10:\tjal\t0 <bvwg>',
    '14:\tnop',
    '18:\tlw\tra,16(sp)',
    '1c:\tjr\tra',
    '20:\taddiu\tsp,sp,24',
  ],
  rs: [
    [0, 'R_MIPS_HI16', 'gW'],
    [4, 'R_MIPS_LO16', 'gW'],
    [0x10, 'R_MIPS_26', 'takeW'],
  ],
};
const IDO_BVWG: Fixture = {
  lines: [
    '0:\tlui\tt6,0x0',
    '4:\tlw\ta0,0(t6)',
    '8:\taddiu\tsp,sp,-24',
    'c:\tsw\tra,20(sp)',
    '10:\tjal\t0 <bvwg>',
    '14:\tsw\ta0,0(sp)',
    '18:\tlw\tra,20(sp)',
    '1c:\taddiu\tsp,sp,24',
    '20:\tjr\tra',
    '24:\tnop',
  ],
  rs: [
    [0, 'R_MIPS_HI16', 'gW'],
    [4, 'R_MIPS_LO16', 'gW'],
    [0x10, 'R_MIPS_26', 'takeW'],
  ],
};
// gcc2.7.2 -O1
const GCC_BVWG: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tlui\ta0,0x0',
    'c:\tjal\t0 <bvwg>',
    '10:\tlw\ta0,0(a0)',
    '14:\tlw\tra,16(sp)',
    '18:\tjr\tra',
    '1c:\taddiu\tsp,sp,24',
  ],
  rs: [
    [8, 'R_MIPS_HI16', 'gW'],
    [0x10, 'R_MIPS_LO16', 'gW'],
    [0xc, 'R_MIPS_26', 'takeW'],
  ],
};
// `void bvtg(void) { takeT(gT); }`
const GCC_BVTG: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tlui\tv0,0x0',
    'c:\taddiu\tv0,v0,0',
    '10:\tlw\ta0,0(v0)',
    '14:\tlw\ta1,4(v0)',
    '18:\tjal\t0 <bvtg>',
    '1c:\tlw\ta2,8(v0)',
    '20:\tlw\tra,16(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,24',
  ],
  rs: [
    [8, 'R_MIPS_HI16', 'gT'],
    [0xc, 'R_MIPS_LO16', 'gT'],
    [0x18, 'R_MIPS_26', 'takeT'],
  ],
};
// `void bvwp(struct W *p) { takeW(*p); }`
const KMC_BVWP: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tjal\t0 <bvwp>',
    'c:\tlw\ta0,0(a0)',
    '10:\tlw\tra,16(sp)',
    '14:\tjr\tra',
    '18:\taddiu\tsp,sp,24',
  ],
  rs: [[8, 'R_MIPS_26', 'takeW']],
};
// `void byvalW(u32 x) { struct W w; w.x = x; takeW(w); }` — the incoming register passed untouched
const KMC_BYVALW: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tjal\t0 <byvalW>',
    'c:\tnop',
    '10:\tlw\tra,16(sp)',
    '14:\tjr\tra',
    '18:\taddiu\tsp,sp,24',
  ],
  rs: [[8, 'R_MIPS_26', 'takeW']],
};
// `void byvalG(void) { takeP(gP); }` — the two halfwords packed into a0 in registers
const KMC_BYVALG: Fixture = {
  lines: [
    '0:\tlui\tv0,0x0',
    '4:\tlhu\tv0,0(v0)',
    '8:\tlui\ta0,0x0',
    'c:\tlhu\ta0,2(a0)',
    '10:\taddiu\tsp,sp,-24',
    '14:\tsw\tra,16(sp)',
    '18:\tsll\tv1,v0,0x10',
    '1c:\tjal\t0 <byvalG>',
    '20:\tor\ta0,v1,a0',
    '24:\tlw\tra,16(sp)',
    '28:\tjr\tra',
    '2c:\taddiu\tsp,sp,24',
  ],
  rs: [
    [0, 'R_MIPS_HI16', 'gP'],
    [4, 'R_MIPS_LO16', 'gP'],
    [8, 'R_MIPS_HI16', 'gP'],
    [0xc, 'R_MIPS_LO16', 'gP'],
    [0x1c, 'R_MIPS_26', 'takeP'],
  ],
};

// `void bvqg(s32 k) { takeQ(k, gQ); }` — IDO also stores each word into its home slot
const IDO_BVQG: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tlui\tt6,0x0',
    '8:\tsw\tra,20(sp)',
    'c:\taddiu\tt6,t6,0',
    '10:\tlw\ta1,0(t6)',
    '14:\tsw\ta1,4(sp)',
    '18:\tlw\ta2,4(t6)',
    '1c:\tjal\t0 <bvqg>',
    '20:\tsw\ta2,8(sp)',
    '24:\tlw\tra,20(sp)',
    '28:\taddiu\tsp,sp,24',
    '2c:\tjr\tra',
    '30:\tnop',
  ],
  rs: [
    [4, 'R_MIPS_HI16', 'gQ'],
    [0xc, 'R_MIPS_LO16', 'gQ'],
    [0x1c, 'R_MIPS_26', 'takeQ'],
  ],
};
// `void bvtg(void) { takeT(gT); }` — and reads its first word back out of the home slot into a0
const IDO_BVTG: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tlui\tt6,0x0',
    '8:\tsw\tra,20(sp)',
    'c:\taddiu\tt6,t6,0',
    '10:\tlw\tt8,0(t6)',
    '14:\tsw\tt8,0(sp)',
    '18:\tlw\ta1,4(t6)',
    '1c:\tlw\ta0,0(sp)',
    '20:\tsw\ta1,4(sp)',
    '24:\tlw\ta2,8(t6)',
    '28:\tjal\t0 <bvtg>',
    '2c:\tsw\ta2,8(sp)',
    '30:\tlw\tra,20(sp)',
    '34:\taddiu\tsp,sp,24',
    '38:\tjr\tra',
    '3c:\tnop',
  ],
  rs: [
    [4, 'R_MIPS_HI16', 'gT'],
    [0xc, 'R_MIPS_LO16', 'gT'],
    [0x28, 'R_MIPS_26', 'takeT'],
  ],
};
// gcc2.7.2: `struct D { double d; }; void takeD(s32 k, struct D d); void bvd(s32 k) { takeD(k, gD); }`
//  passes the struct in a2:a3 and leaves a1 unset; `void takeD0(struct D d)` is passed a0:a1
const GCC_BVD: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tlui\tv0,0x0',
    'c:\taddiu\tv0,v0,0',
    '10:\tlw\ta2,0(v0)',
    '14:\tjal\t0 <bvd>',
    '18:\tlw\ta3,4(v0)',
    '1c:\tlw\tra,16(sp)',
    '20:\tjr\tra',
    '24:\taddiu\tsp,sp,24',
  ],
  rs: [
    [8, 'R_MIPS_HI16', 'gD'],
    [0xc, 'R_MIPS_LO16', 'gD'],
    [0x14, 'R_MIPS_26', 'takeD'],
  ],
};
const GCC_BVD0: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tlui\tv0,0x0',
    'c:\taddiu\tv0,v0,0',
    '10:\tlw\ta0,0(v0)',
    '14:\tjal\t0 <bvd0>',
    '18:\tlw\ta1,4(v0)',
    '1c:\tlw\tra,16(sp)',
    '20:\tjr\tra',
    '24:\taddiu\tsp,sp,24',
  ],
  rs: [
    [8, 'R_MIPS_HI16', 'gD'],
    [0xc, 'R_MIPS_LO16', 'gD'],
    [0x14, 'R_MIPS_26', 'takeD0'],
  ],
};
// gcc2.7.2kmc addresses each word through a `lui`/`lw` pair of its own
const KMC_BVQG: Fixture = {
  lines: [
    '0:\tlui\ta1,0x0',
    '4:\tlw\ta1,0(a1)',
    '8:\tlui\ta2,0x0',
    'c:\tlw\ta2,4(a2)',
    '10:\taddiu\tsp,sp,-24',
    '14:\tsw\tra,16(sp)',
    '18:\tjal\t0 <bvqg>',
    '1c:\tnop',
    '20:\tlw\tra,16(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,24',
  ],
  rs: [
    [0, 'R_MIPS_HI16', 'gQ'],
    [4, 'R_MIPS_LO16', 'gQ'],
    [8, 'R_MIPS_HI16', 'gQ'],
    [0xc, 'R_MIPS_LO16', 'gQ'],
    [0x18, 'R_MIPS_26', 'takeQ'],
  ],
};
const KMC_BVTG: Fixture = {
  lines: [
    '0:\tlui\ta0,0x0',
    '4:\tlw\ta0,0(a0)',
    '8:\tlui\ta1,0x0',
    'c:\tlw\ta1,4(a1)',
    '10:\tlui\ta2,0x0',
    '14:\tlw\ta2,8(a2)',
    '18:\taddiu\tsp,sp,-24',
    '1c:\tsw\tra,16(sp)',
    '20:\tjal\t0 <bvtg>',
    '24:\tnop',
    '28:\tlw\tra,16(sp)',
    '2c:\tjr\tra',
    '30:\taddiu\tsp,sp,24',
  ],
  rs: [
    [0, 'R_MIPS_HI16', 'gT'],
    [4, 'R_MIPS_LO16', 'gT'],
    [8, 'R_MIPS_HI16', 'gT'],
    [0xc, 'R_MIPS_LO16', 'gT'],
    [0x10, 'R_MIPS_HI16', 'gT'],
    [0x14, 'R_MIPS_LO16', 'gT'],
    [0x20, 'R_MIPS_26', 'takeT'],
  ],
};
const D = { kind: 'struct' as const, members: [{ name: 'd', type: 'double' }] };

describe('a struct passed by value on O32', () => {
  // Before any rule placed one, the arity guess lifted each of these to C that compiles and passes
  // the wrong thing: `takeW(*(s32 *)&gW)`, `takeT(*p0, p0[1], p0[2])` and `takeQ(a0, *p0, p0[1])`.
  test.each([
    ['bvwg', KMC_BVWG, MIPS_GCC, '    takeW(gW);\n'],
    ['bvwg', IDO_BVWG, MIPS_IDO, '    takeW(gW);\n'],
    ['bvwg', GCC_BVWG, MIPS_GCC, '    takeW(gW);\n'],
    ['bvtg', GCC_BVTG, MIPS_GCC, '    takeT(gT);\n'],
    ['bvqg', IDO_BVQG, MIPS_IDO, '    takeQ(a0, gQ);\n'],
    ['bvtg', IDO_BVTG, MIPS_IDO, '    takeT(gT);\n'],
    ['bvqg', KMC_BVQG, MIPS_GCC, '    takeQ(a0, gQ);\n'],
    ['bvtg', KMC_BVTG, MIPS_GCC, '    takeT(gT);\n'],
  ] as const)('%s passes the global whole', (name, f, target, call) => {
    expect(lift(name, f, target)).toContain(call);
  });

  test("IDO's stores into the home slots are the call's, not locals of this function", () => {
    expect(lift('bvqg', IDO_BVQG, MIPS_IDO)).toBe('void bvqg(s32 a0) {\n    takeQ(a0, gQ);\n}\n');
    expect(lift('bvtg', IDO_BVTG, MIPS_IDO)).toBe('void bvtg(void) {\n    takeT(gT);\n}\n');
  });

  // Before, `takeW(*a0)`, `takeW()` and `takeP(*p0 << 16 | p0[1])`: words off a pointer, an incoming
  // register passed on untouched, and two halfwords packed in registers are not one object here.
  test.each([
    ['bvwp', KMC_BVWP, 'takeW', 'struct W'],
    ['byvalW', KMC_BYVALW, 'takeW', 'struct W'],
    ['byvalG', KMC_BYVALG, 'takeP', 'struct P'],
  ] as const)('%s declines, and is not guessed', (name, f, callee, spelling) => {
    expect(() => lift(name, f, MIPS_GCC)).toThrow(
      new RegExp(
        `the call to \`${callee}\` passes ${spelling} by value, and its words are not one frame object or one global`,
      ),
    );
  });

  test('an 8-aligned struct at word 0 is passed whole, and one after an s32 skips a1 and declines', () => {
    const protos: Prototypes = {
      takeD: { params: ['s32', 'struct D'], byValueLayouts: { 1: D }, returnsVoid: true },
      takeD0: { params: ['struct D'], byValueLayouts: { 0: D }, returnsVoid: true },
    };
    expect(lift('bvd0', GCC_BVD0, MIPS_GCC, protos)).toContain('    takeD0(gD);\n');
    expect(() => lift('bvd', GCC_BVD, MIPS_GCC, protos)).toThrow(
      /`takeD` takes 'struct D' by value as its parameter 2, and it is aligned to 8 and would start at an odd argument word/,
    );
  });

  test('one lui/lw pair per word is one global only where every pair names the same symbol, at its word', () => {
    // hand-edited: the second word's pair names another global
    const two: Fixture = {
      ...KMC_BVQG,
      rs: KMC_BVQG.rs.map(([o, t, sym]) => [o, t, o >= 8 && o <= 0xc ? 'gR' : sym] as [number, string, string]),
    };
    expect(() => lift('bvqg', two, MIPS_GCC)).toThrow(
      /the call to `takeQ` passes struct Q by value, and its words are not one frame object or one global/,
    );
    // hand-edited: the second word is read off the symbol's start again
    const again: Fixture = { ...KMC_BVQG, lines: KMC_BVQG.lines.map((l) => l.replace('lw\ta2,4(a2)', 'lw\ta2,0(a2)')) };
    expect(() => lift('bvqg', again, MIPS_GCC)).toThrow(/its words are not one frame object or one global/);
  });
});
