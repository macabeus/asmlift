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

describe('a struct passed by value on O32', () => {
  // Before any rule placed one, the arity guess lifted each of these to C that compiles and passes
  // the wrong thing: `takeW(*(s32 *)&gW)`, `takeT(*p0, p0[1], p0[2])`, `takeW(*a0)`, `takeW()` and
  // `takeP(*p0 << 16 | p0[1])`.
  test.each([
    ['bvwg', KMC_BVWG, MIPS_GCC, 'struct W'],
    ['bvwg', IDO_BVWG, MIPS_IDO, 'struct W'],
    ['bvwg', GCC_BVWG, MIPS_GCC, 'struct W'],
    ['bvtg', GCC_BVTG, MIPS_GCC, 'struct T'],
    ['bvwp', KMC_BVWP, MIPS_GCC, 'struct W'],
    ['byvalW', KMC_BYVALW, MIPS_GCC, 'struct W'],
    ['byvalG', KMC_BYVALG, MIPS_GCC, 'struct P'],
  ] as const)('%s declines where no rule places it, and is not guessed', (name, f, target, spelling) => {
    expect(() => lift(name, f, target)).toThrow(
      new RegExp(`takes '${spelling}' by value as its parameter 1, and this target states no rule`),
    );
  });
});
