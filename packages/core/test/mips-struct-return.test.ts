// A call to a function declared to return a struct or union BY VALUE on O32 (ido7.1, gcc2.7.2kmc,
// gcc2.7.2). Every aggregate comes back through memory: the caller hands the callee a hidden pointer
// in a0 and every declared argument one register up. Every fixture is the compiler's own output at
// the benchmark's flags, read with `objdump -dr`, for the source quoted above it or above the
// `describe` that reads it, unless marked hand-written. The declarations they share:
//
//   struct S1w { u32 x; }; struct S2 { u16 h; }; struct S8 { u32 a, b; }; struct S12 { u32 a, b, c; };
//   struct SF { float f; }; struct S4 { u16 a; u8 b; u8 pad; };
//   struct S1w mk1(s32); struct S2 mk2(s32); struct S8 mk8(s32); struct S12 mk12(s32);
//   struct S8 mk5(s32, s32, s32, s32); struct S8 mkil(s32, long long); struct SF mkf(float);
//   struct S4 mk(u16, u16, u8); extern struct S4 gS4; extern struct S8 gS8;
//   struct L { s64 v; }; struct S8 tk3(s32, struct L); struct S8 tk(struct L); extern struct L gL;
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import type { AggregateLayout, Prototypes } from '../src/proto';
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

const lift = (name: string, f: Fixture, target: TargetDescription) =>
  decompile(name, obj(name, f.lines), target, { asmData: relocs(f.rs), prototypes: PROTOS }).source;

const layout = (...members: [string, string][]): AggregateLayout => ({
  kind: 'struct',
  members: members.map(([name, type]) => ({ name, type })),
});
const returning = (tag: string, l: AggregateLayout, params: string[]) => ({
  params,
  returns: `struct ${tag}`,
  returnLayout: l,
});
const S8 = layout(['a', 'u32'], ['b', 'u32']);
const PROTOS: Prototypes = {
  mk1: returning('S1w', layout(['x', 'u32']), ['s32']),
  mk2: returning('S2', layout(['h', 'u16']), ['s32']),
  mk8: returning('S8', S8, ['s32']),
  mk12: returning('S12', layout(['a', 'u32'], ['b', 'u32'], ['c', 'u32']), ['s32']),
  mk5: returning('S8', S8, ['s32', 's32', 's32', 's32']),
  mkil: returning('S8', S8, ['s32', 'long long']),
  ldiv: returning('QR', layout(['quot', 's32'], ['rem', 's32']), ['s32', 's32']),
  mkf: returning('SF', layout(['f', 'float']), ['float']),
  mk: returning('S4', layout(['a', 'u16'], ['b', 'u8'], ['pad', 'u8']), ['u16', 'u16', 'u8']),
  tk3: { ...returning('S8', S8, ['s32', 'struct L']), byValueLayouts: { 1: layout(['v', 's64']) } },
  tk: { ...returning('S8', S8, ['struct L']), byValueLayouts: { 0: layout(['v', 's64']) } },
};

const KMC_SRET1W: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tmove\ta1,a0',
    '8:\tsw\tra,24(sp)',
    'c:\tjal\t0 <sret1w>',
    '10:\taddiu\ta0,sp,16',
    '14:\tlw\tv0,16(sp)',
    '18:\tlui\tat,0x0',
    '1c:\tsw\tv0,0(at)',
    '20:\tlw\tra,24(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,32',
  ],
  rs: [
    [0xc, 'R_MIPS_26', 'mk1'],
    [0x18, 'R_MIPS_HI16', 'gW'],
    [0x1c, 'R_MIPS_LO16', 'gW'],
  ],
};
const IDO_SRET8: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tsw\tra,20(sp)',
    '8:\tmove\ta1,a0',
    'c:\tjal\t0 <sret8>',
    '10:\taddiu\ta0,sp,24',
    '14:\tlw\tt6,24(sp)',
    '18:\tlw\tra,20(sp)',
    '1c:\tlui\tat,0x0',
    '20:\tlw\tt7,28(sp)',
    '24:\tsw\tt6,0(at)',
    '28:\tlui\tat,0x0',
    '2c:\taddiu\tsp,sp,32',
    '30:\tjr\tra',
    '34:\tsw\tt7,0(at)',
  ],
  rs: [
    [0xc, 'R_MIPS_26', 'mk8'],
    [0x1c, 'R_MIPS_HI16', 'gW'],
    [0x24, 'R_MIPS_LO16', 'gW'],
    [0x28, 'R_MIPS_HI16', 'gW2'],
    [0x34, 'R_MIPS_LO16', 'gW2'],
  ],
};
const GCC_SRET12: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-40',
    '4:\tsw\tra,32(sp)',
    '8:\tmove\ta1,a0',
    'c:\tjal\t0 <sret12>',
    '10:\taddiu\ta0,sp,16',
    '14:\tlw\tv0,16(sp)',
    '18:\tlui\tat,0x0',
    '1c:\tsw\tv0,0(at)',
    '20:\tlw\tv0,24(sp)',
    '24:\tlui\tat,0x0',
    '28:\tsw\tv0,0(at)',
    '2c:\tlw\tra,32(sp)',
    '30:\tjr\tra',
    '34:\taddiu\tsp,sp,40',
  ],
  rs: [
    [0xc, 'R_MIPS_26', 'mk12'],
    [0x18, 'R_MIPS_HI16', 'gW'],
    [0x1c, 'R_MIPS_LO16', 'gW'],
    [0x24, 'R_MIPS_HI16', 'gW2'],
    [0x28, 'R_MIPS_LO16', 'gW2'],
  ],
};
const IDO_SRET2: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tsw\tra,20(sp)',
    '8:\tmove\ta1,a0',
    'c:\tjal\t0 <sret2>',
    '10:\taddiu\ta0,sp,28',
    '14:\tlw\tra,20(sp)',
    '18:\tlhu\tt6,28(sp)',
    '1c:\tlui\tat,0x0',
    '20:\taddiu\tsp,sp,32',
    '24:\tjr\tra',
    '28:\tsh\tt6,0(at)',
  ],
  rs: [
    [0xc, 'R_MIPS_26', 'mk2'],
    [0x1c, 'R_MIPS_HI16', 'gOut'],
    [0x28, 'R_MIPS_LO16', 'gOut'],
  ],
};
const KMC_SRET5: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-40',
    '4:\tmove\tv0,a0',
    '8:\tmove\tv1,a1',
    'c:\tmove\tt0,a2',
    '10:\taddiu\ta0,sp,24',
    '14:\tmove\ta1,v0',
    '18:\tmove\ta2,v1',
    '1c:\tsw\ta3,16(sp)',
    '20:\tsw\tra,32(sp)',
    '24:\tjal\t0 <sret5>',
    '28:\tmove\ta3,t0',
    '2c:\tlw\tv0,28(sp)',
    '30:\tlui\tat,0x0',
    '34:\tsw\tv0,0(at)',
    '38:\tlw\tra,32(sp)',
    '3c:\tjr\tra',
    '40:\taddiu\tsp,sp,40',
  ],
  rs: [
    [0x24, 'R_MIPS_26', 'mk5'],
    [0x30, 'R_MIPS_HI16', 'gW'],
    [0x34, 'R_MIPS_LO16', 'gW'],
  ],
};
const KMC_SRETIL: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tmove\ta1,a0',
    '8:\tsw\tra,24(sp)',
    'c:\tjal\t0 <sretil>',
    '10:\taddiu\ta0,sp,16',
    '14:\tlw\tv0,16(sp)',
    '18:\tlui\tat,0x0',
    '1c:\tsw\tv0,0(at)',
    '20:\tlw\tra,24(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,32',
  ],
  rs: [
    [0xc, 'R_MIPS_26', 'mkil'],
    [0x18, 'R_MIPS_HI16', 'gW'],
    [0x1c, 'R_MIPS_LO16', 'gW'],
  ],
};
const IDO_SRETGLOB8: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tmove\ta1,a0',
    '8:\tsw\tra,20(sp)',
    'c:\tlui\ta0,0x0',
    '10:\tjal\t0 <sretglob8>',
    '14:\taddiu\ta0,a0,0',
    '18:\tlw\tra,20(sp)',
    '1c:\taddiu\tsp,sp,24',
    '20:\tjr\tra',
    '24:\tnop',
  ],
  rs: [
    [0xc, 'R_MIPS_HI16', 'gS8'],
    [0x10, 'R_MIPS_26', 'mk8'],
    [0x14, 'R_MIPS_LO16', 'gS8'],
  ],
};
const KMC_SRETGLOB: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tandi\ta1,a0,0xffff',
    'c:\tlui\ta0,0x0',
    '10:\taddiu\ta0,a0,0',
    '14:\tmove\ta2,zero',
    '18:\tjal\t0 <sretglob>',
    '1c:\tli\ta3,16',
    '20:\tlw\tra,16(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,24',
  ],
  rs: [
    [0xc, 'R_MIPS_HI16', 'gS4'],
    [0x10, 'R_MIPS_LO16', 'gS4'],
    [0x18, 'R_MIPS_26', 'mk'],
  ],
};
const GCC_SRETGLOB8: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tmove\ta1,a0',
    'c:\tlui\ta0,0x0',
    '10:\tjal\t0 <sretglob8>',
    '14:\taddiu\ta0,a0,0',
    '18:\tlw\tra,16(sp)',
    '1c:\tjr\tra',
    '20:\taddiu\tsp,sp,24',
  ],
  rs: [
    [0xc, 'R_MIPS_HI16', 'gS8'],
    [0x10, 'R_MIPS_26', 'mk8'],
    [0x14, 'R_MIPS_LO16', 'gS8'],
  ],
};
const IDO_SRETPTR: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,20(sp)',
    '8:\tjal\t0 <sretptr>',
    'c:\tnop',
    '10:\tlw\tra,20(sp)',
    '14:\taddiu\tsp,sp,24',
    '18:\tjr\tra',
    '1c:\tnop',
  ],
  rs: [[0x8, 'R_MIPS_26', 'mk8']],
};
const IDO_SRETFWD: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,20(sp)',
    '8:\tjal\t0 <sretfwd>',
    'c:\taddiu\ta1,a1,1',
    '10:\tlw\tra,20(sp)',
    '14:\taddiu\tsp,sp,24',
    '18:\tjr\tra',
    '1c:\tnop',
  ],
  rs: [[0x8, 'R_MIPS_26', 'mk8']],
};
const KMC_SRETFWD: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\ts0,16(sp)',
    '8:\tmove\ts0,a0',
    'c:\tsw\tra,20(sp)',
    '10:\tjal\t0 <sretfwd>',
    '14:\taddiu\ta1,a1,1',
    '18:\tmove\tv0,s0',
    '1c:\tlw\tra,20(sp)',
    '20:\tlw\ts0,16(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,24',
  ],
  rs: [[0x10, 'R_MIPS_26', 'mk8']],
};
const GCC_SRETFWD: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,20(sp)',
    '8:\tsw\ts0,16(sp)',
    'c:\tmove\ts0,a0',
    '10:\tjal\t0 <sretfwd>',
    '14:\taddiu\ta1,a1,1',
    '18:\tmove\tv0,s0',
    '1c:\tlw\tra,20(sp)',
    '20:\tlw\ts0,16(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,24',
  ],
  rs: [[0x10, 'R_MIPS_26', 'mk8']],
};
const KMC_SRETPTR: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tsw\ts0,24(sp)',
    '8:\tmove\ts0,a0',
    'c:\tsw\tra,28(sp)',
    '10:\tjal\t0 <sretptr>',
    '14:\taddiu\ta0,sp,16',
    '18:\tlw\tv0,16(sp)',
    '1c:\tlw\tv1,20(sp)',
    '20:\tsw\tv0,0(s0)',
    '24:\tsw\tv1,4(s0)',
    '28:\tlw\tra,28(sp)',
    '2c:\tlw\ts0,24(sp)',
    '30:\tjr\tra',
    '34:\taddiu\tsp,sp,32',
  ],
  rs: [[0x10, 'R_MIPS_26', 'mk8']],
};
const IDO_SRETF: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tsw\tra,20(sp)',
    '8:\tmfc1\ta1,$f12',
    'c:\tjal\t0 <sretf>',
    '10:\taddiu\ta0,sp,28',
    '14:\tlw\tra,20(sp)',
    '18:\tlwc1\t$f4,28(sp)',
    '1c:\tlui\tat,0x0',
    '20:\taddiu\tsp,sp,32',
    '24:\tjr\tra',
    '28:\tswc1\t$f4,0(at)',
  ],
  rs: [
    [0xc, 'R_MIPS_26', 'mkf'],
    [0x1c, 'R_MIPS_HI16', 'gF'],
    [0x28, 'R_MIPS_LO16', 'gF'],
  ],
};

// gcc2.7.2kmc `void c9(void){ gW = tk3(1, gL).a; }`: a0 hidden, a1 = 1, gL in a2:a3 (an even word)
const KMC_C9: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tlui\ta2,0x0',
    '8:\tlw\ta2,0(a2)',
    'c:\tlui\ta3,0x0',
    '10:\tlw\ta3,4(a3)',
    '14:\taddiu\ta0,sp,16',
    '18:\tsw\tra,24(sp)',
    '1c:\tjal\t0 <c9>',
    '20:\tli\ta1,1',
    '24:\tlw\tv0,16(sp)',
    '28:\tlui\tat,0x0',
    '2c:\tsw\tv0,0(at)',
    '30:\tlw\tra,24(sp)',
    '34:\tjr\tra',
    '38:\taddiu\tsp,sp,32',
  ],
  rs: [
    [0x4, 'R_MIPS_HI16', 'gL'],
    [0x8, 'R_MIPS_LO16', 'gL'],
    [0xc, 'R_MIPS_HI16', 'gL'],
    [0x10, 'R_MIPS_LO16', 'gL'],
    [0x1c, 'R_MIPS_26', 'tk3'],
    [0x28, 'R_MIPS_HI16', 'gW'],
    [0x2c, 'R_MIPS_LO16', 'gW'],
  ],
};

// gcc2.7.2kmc `void c8(void){ gW = tk(gL).b; }`: a0 hidden, a1 skipped, gL in a2:a3
const KMC_C8: Fixture = {
  lines: [
    '0:\tlui\ta2,0x0',
    '4:\tlw\ta2,0(a2)',
    '8:\tlui\ta3,0x0',
    'c:\tlw\ta3,4(a3)',
    '10:\taddiu\tsp,sp,-32',
    '14:\tsw\tra,24(sp)',
    '18:\tjal\t0 <c8>',
    '1c:\taddiu\ta0,sp,16',
    '20:\tlw\tv0,20(sp)',
    '24:\tlui\tat,0x0',
    '28:\tsw\tv0,0(at)',
    '2c:\tlw\tra,24(sp)',
    '30:\tjr\tra',
    '34:\taddiu\tsp,sp,32',
  ],
  rs: [
    [0x0, 'R_MIPS_HI16', 'gL'],
    [0x4, 'R_MIPS_LO16', 'gL'],
    [0x8, 'R_MIPS_HI16', 'gL'],
    [0xc, 'R_MIPS_LO16', 'gL'],
    [0x18, 'R_MIPS_26', 'tk'],
    [0x24, 'R_MIPS_HI16', 'gW'],
    [0x28, 'R_MIPS_LO16', 'gW'],
  ],
};

// gcc2.7.2kmc `void pc(s32 x){ struct S8 a; if (x) a = mk8(x); else a = mk8(x + 1); gW = a.a; }`:
// `addiu a0,sp,16` in both arms, ahead of one shared `jal`
const KMC_PC: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tmove\ta1,a0',
    '8:\tbeqz\ta1,18 <pc+0x18>',
    'c:\tsw\tra,24(sp)',
    '10:\tj\t20 <pc+0x20>',
    '14:\taddiu\ta0,sp,16',
    '18:\taddiu\ta0,sp,16',
    '1c:\tli\ta1,1',
    '20:\tjal\t0 <pc>',
    '24:\tnop',
    '28:\tlw\tv0,16(sp)',
    '2c:\tlui\tat,0x0',
    '30:\tsw\tv0,0(at)',
    '34:\tlw\tra,24(sp)',
    '38:\tjr\tra',
    '3c:\taddiu\tsp,sp,32',
  ],
  rs: [
    [0x10, 'R_MIPS_26', '.text'],
    [0x20, 'R_MIPS_26', 'mk8'],
    [0x2c, 'R_MIPS_HI16', 'gW'],
    [0x30, 'R_MIPS_LO16', 'gW'],
  ],
};

// gcc2.7.2kmc `void litoa(u8 *p, s32 lo){ struct QR qr; while (lo > 0) { qr = ldiv(lo, 10);
// *--p = qr.rem + '0'; lo = qr.quot; } }`: the rotated loop sets a0 ahead of it and in the delay
// slot of its back branch
const KMC_LITOA: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-32',
    '4:\tsw\ts0,24(sp)',
    '8:\tmove\ts0,a0',
    'c:\tblez\ta1,3c <litoa+0x3c>',
    '10:\tsw\tra,28(sp)',
    '14:\taddiu\ta0,sp,16',
    '18:\tjal\t0 <litoa>',
    '1c:\tli\ta2,10',
    '20:\tlw\tv0,20(sp)',
    '24:\taddiu\ts0,s0,-1',
    '28:\taddiu\tv0,v0,48',
    '2c:\tsb\tv0,0(s0)',
    '30:\tlw\ta1,16(sp)',
    '34:\tbgtz\ta1,18 <litoa+0x18>',
    '38:\taddiu\ta0,sp,16',
    '3c:\tlw\tra,28(sp)',
    '40:\tlw\ts0,24(sp)',
    '44:\tjr\tra',
    '48:\taddiu\tsp,sp,32',
  ],
  rs: [[0x18, 'R_MIPS_26', 'ldiv']],
};

// gcc2.7.2kmc `struct S1w rmk1(s32 x){ struct S1w r; r.x = x + 1; return r; }`: the callee's half
const KMC_RMK1: Fixture = {
  lines: ['0:\tmove\tv0,a0', '4:\taddiu\ta1,a1,1', '8:\tjr\tra', 'c:\tsw\ta1,0(v0)'],
  rs: [],
};

// `void sret1w(s32 x){ struct S1w s = mk1(x); gW = s.x; }` and its 8- and 12-byte twins reading
// `s.a` and `s.b` (or `s.c`); `void sret2(s32 x){ struct S2 s = mk2(x); gOut = s.h; }`;
// `void sret5(s32 a, s32 b, s32 c, s32 d){ struct S8 s = mk5(a, b, c, d); gW = s.b; }`
describe('a struct returned into a local of this frame', () => {
  test('the local is the struct, and the declared arguments start at a1', () => {
    expect(lift('sret1w', KMC_SRET1W, MIPS_GCC)).toMatch(/struct S1w sp16;\n\s+sp16 = mk1\(a0\);/);
    expect(lift('sret2', IDO_SRET2, MIPS_IDO)).toMatch(/struct S2 sp28;\n\s+sp28 = mk2\(a0\);\n\s+gOut = sp28\.h;/);
  });

  test('an 8- and a 12-byte struct are each one local, read back at their own words', () => {
    const ido = lift('sret8', IDO_SRET8, MIPS_IDO);
    expect(ido).toMatch(/struct S8 sp24;[^]*sp24 = mk8\(a0\);/);
    expect(ido).toMatch(/p0 = \(s32 \*\)&sp24;[^]*v0 = p0\[1\];\n\s+gW = \*p0;\n\s+gW2 = v0;/);
    // gcc2.7.2: s.c is the third word
    expect(lift('sret12', GCC_SRET12, MIPS_GCC)).toMatch(/struct S12 sp16;[^]*sp16 = mk12\(a0\);[^]*v0 = p0\[2\];/);
  });

  test("a fourth declared argument travels in the outgoing area, past the struct's own temp", () => {
    // kmc: the temp at sp+24, d staged at sp+16
    expect(lift('sret5', KMC_SRET5, MIPS_GCC)).toMatch(/sp24 = mk5\(a0, a1, a2, a3\);/);
  });

  // kmc and gcc go through a frame temp and copy it word by word
  test('a struct stored through a pointer from a frame temp is that temp, then the copy', () => {
    expect(lift('sretptr', KMC_SRETPTR, MIPS_GCC)).toMatch(/sp16 = mk8\(a1\);[^]*\*a0 = v0;\n\s+a0\[1\] = v1;/);
  });

  // hand-written: the callee hands the pointer back in v0, which no compiled caller reads
  test('v0 past the call is not a value', () => {
    const rd = { ...KMC_SRET1W, lines: KMC_SRET1W.lines.map((l) => l.replace('lw\tv0,16(sp)', 'lw\tv0,4(v0)')) };
    expect(() => lift('rd', rd, MIPS_GCC)).toThrow(/v0 is read on a path where a call has destroyed it/);
  });
});

// `void sretglob(u16 x){ gS4 = mk(x, 0, 0x10); }` and `void sretglob8(s32 x){ gS8 = mk8(x); }` hand
// the global's address over directly; IDO's `void sretptr(struct S8 *p, s32 x){ *p = mk8(x); }`
// hands p over; `struct S8 sretfwd(s32 x){ return mk8(x + 1); }` forwards its own a0
describe('a hidden pointer that is not a local of this frame declines', () => {
  const outside =
    /returns struct S\d through the pointer in a0, and that pointer is not the address of a local of this frame/;
  test.each<[string, string, Fixture, TargetDescription]>([
    ['ido7.1 into a global', 'sretglob8', IDO_SRETGLOB8, MIPS_IDO],
    ['gcc2.7.2kmc into a global', 'sretglob', KMC_SRETGLOB, MIPS_GCC],
    ['gcc2.7.2 into a global', 'sretglob8', GCC_SRETGLOB8, MIPS_GCC],
    ['ido7.1 through a pointer', 'sretptr', IDO_SRETPTR, MIPS_IDO],
    ['ido7.1 forwarded', 'sretfwd', IDO_SRETFWD, MIPS_IDO],
    ['gcc2.7.2kmc forwarded', 'sretfwd', KMC_SRETFWD, MIPS_GCC],
    ['gcc2.7.2 forwarded', 'sretfwd', GCC_SRETFWD, MIPS_GCC],
  ])('%s', (_label, name, f, target) => {
    expect(() => lift(name, f, target)).toThrow(outside);
  });

  // hand-written: `pc` with its frame grown and the else arm's temp moved to sp+24, so the merge
  // names two locals, which the audit refuses before the struct return is asked
  test("a merge of two locals' addresses declines", () => {
    const two: Fixture = {
      ...KMC_PC,
      lines: KMC_PC.lines.map((l) =>
        l
          .replace('sp,sp,-32', 'sp,sp,-40')
          .replace('sp,sp,32', 'sp,sp,40')
          .replace('ra,24(sp)', 'ra,32(sp)')
          .replace('18:\taddiu\ta0,sp,16', '18:\taddiu\ta0,sp,24'),
      ),
    };
    expect(() => lift('pc', two, MIPS_GCC)).toThrow(
      /a phi merges the frame objects at \[sp,#16\] and \[sp,#24\] — one value, two objects/,
    );
  });
});

// gcc hoists `addiu a0,sp,16` into both arms ahead of one shared `jal` (`pc`), and rotates a loop
// so that it runs once ahead of the loop and once in the delay slot of the back branch (`litoa`):
// every path names the one local, which the call is handed (`nameMergedSretObjects`)
describe('a hidden pointer that names one local on every path is that local', () => {
  test('two arms ahead of one call', () => {
    expect(lift('pc', KMC_PC, MIPS_GCC)).toMatch(/struct S8 sp16;\n\s+if \(a0 == 0\) a0 = 1;\n\s+sp16 = mk8\(a0\);/);
  });

  test('a rotated loop', () => {
    expect(lift('litoa', KMC_LITOA, MIPS_GCC)).toMatch(
      /struct QR sp16;[^]*do \{\n\s+sp16 = ldiv\(a1, 10\);[^]*a1 = sp16\.quot;\n\s+\} while \(a1 > 0\);/,
    );
  });
});

// `void sretil(s32 k, long long v){ struct S8 s = mkil(k, v); gW = s.a; }` passes v in a2:a3 and
// `void sretf(float x){ struct SF s = mkf(x); gF = s.f; }` passes x in a1 (`mfc1 a1,$f12`)
describe('what the lowering does not build still declines', () => {
  test('a 64-bit argument after the hidden pointer', () => {
    expect(() => lift('sretil', KMC_SRETIL, MIPS_GCC)).toThrow(
      /one half of a 64-bit value would be handed to 'mkil' — its parameter 2 is declared wider/,
    );
  });

  test('a float argument', () => {
    expect(() => lift('sretf', IDO_SRETF, MIPS_IDO)).toThrow(/cannot lift 'sretf': `mkf` returns struct SF/);
  });
});

// THE EVEN-WORD RULE COUNTS THE HIDDEN POINTER. An 8-aligned struct starts at an even argument word,
// and a0 is word 0: tk3's struct at a2:a3 needs no skip, tk's would start at a1, which O32 skips.
describe('a struct passed by value beside the hidden pointer', () => {
  test('at an even word counting a0, it is passed', () => {
    expect(lift('c9', KMC_C9, MIPS_GCC)).toMatch(/sp16 = tk3\(1, gL\);/);
  });

  test('at an odd word counting a0, it refuses as the skipped word', () => {
    expect(() => lift('c8', KMC_C8, MIPS_GCC)).toThrow(
      /`tk` takes 'struct L' by value as its parameter 1, and it is aligned to 8 and would start at an odd argument word/,
    );
  });
});

// ido7.1 `struct S12 rmk12(s32 x){ struct S12 s; s.a = x; s.b = 0; s.c = x + 3; return s; }` builds
// the struct at sp+4 and copies it out word by word through t7
const IDO_RMK12: Fixture = {
  lines: [
    '0:\taddiu\tsp,sp,-16',
    '4:\taddiu\tt6,a1,3',
    '8:\tsw\ta1,4(sp)',
    'c:\tsw\tzero,8(sp)',
    '10:\tsw\tt6,12(sp)',
    '14:\taddiu\tt7,sp,4',
    '18:\tlw\tt9,0(t7)',
    '1c:\tmove\tv0,a0',
    '20:\tsw\tt9,0(a0)',
    '24:\tlw\tt8,4(t7)',
    '28:\tsw\tt8,4(a0)',
    '2c:\tlw\tt9,8(t7)',
    '30:\taddiu\tsp,sp,16',
    '34:\tjr\tra',
    '38:\tsw\tt9,8(a0)',
  ],
  rs: [],
};

// THE FUNCTION'S OWN STRUCT RETURN, stated or from its context's own entry (frontend/own-struct-return.ts)
describe('a function that itself returns a struct', () => {
  const S1W = returning('S1w', layout(['x', 'u32']), ['s32']);
  const S12 = returning('S12', layout(['a', 'u32'], ['b', 'u32'], ['c', 'u32']), ['s32']);
  const own = (name: string, f: Fixture, target: TargetDescription, p: object) =>
    decompile(name, obj(name, f.lines), target, { asmData: relocs(f.rs), ...p }).source;

  test('is the struct its declaration names, the hidden a0 its storage', () => {
    for (const p of [{ prototypes: { ...PROTOS, rmk1: S1W } }, { prototypes: PROTOS, ownContextProto: S1W }]) {
      expect(own('rmk1', KMC_RMK1, MIPS_GCC, p)).toMatch(
        /struct S1w rmk1\(s32 a0\) \{\n\s+struct S1w ret;\n\s+ret\.x = a0 \+ 1;\n\s+return ret;\n\}/,
      );
    }
  });

  test("IDO's frame copy is the return", () => {
    const source = own('rmk12', IDO_RMK12, MIPS_IDO, { ownContextProto: S12 });
    expect(source).toMatch(
      /struct S12 rmk12\(s32 a0\) \{\n\s+struct S12 ret;\n\s+ret\.a = a0;\n\s+ret\.b = 0;\n\s+ret\.c = a0 \+ 3;\n\s+return ret;/,
    );
    expect(source).not.toMatch(/sp0/);
  });

  // hand-written: the copy's last word is moved to a store that follows it, so the frame object is
  // written after it is copied, and what was copied is not what the object last held
  test('a frame object stored to after its copy is not folded', () => {
    const late = {
      ...IDO_RMK12,
      lines: [...IDO_RMK12.lines.slice(0, 13), '34:\tsw\tzero,8(t7)', '38:\tjr\tra', '3c:\tsw\tt9,8(a0)'],
    };
    expect(own('rmk12', late, MIPS_IDO, { ownContextProto: S12 })).toMatch(
      /struct S12 ret;[^]*ret\.a = [^]*sp0[^]*return ret;/,
    );
  });

  // hand-written: the else path stores to the frame object and returns without the copy, so that
  // store is no write to the caller's storage, and folding it into the return would make it one
  test('a frame object stored to on a path that skips its copy is not folded', () => {
    const skip: Fixture = {
      lines: [
        '0:\taddiu\tsp,sp,-8',
        '4:\tbeqz\ta1,24 <f+0x24>',
        '8:\tnop',
        'c:\tsw\ta1,0(sp)',
        '10:\taddiu\tt7,sp,0',
        '14:\tlw\tt9,0(t7)',
        '18:\tsw\tt9,0(a0)',
        '1c:\tb\t2c <f+0x2c>',
        '20:\tnop',
        '24:\tsw\ta2,0(sp)',
        '28:\tnop',
        '2c:\tmove\tv0,a0',
        '30:\tjr\tra',
        '34:\taddiu\tsp,sp,8',
      ],
      rs: [],
    };
    const source = own('f', skip, MIPS_IDO, { ownContextProto: { ...S1W, params: ['s32', 's32'] } });
    expect(source).toMatch(/if \(a0 != 0\) \{\n\s+sp0 = a0;\n\s+ret\.x = sp0;\n\s+\}\n\s+return ret;/);
    expect(source).not.toMatch(/= a1;/);
  });

  test('is the pointer function it compiles to where nothing states it', () => {
    expect(lift('rmk1', KMC_RMK1, MIPS_GCC)).toMatch(/s32 \* rmk1\(s32 \*a0, s32 a1\)/);
  });
});
