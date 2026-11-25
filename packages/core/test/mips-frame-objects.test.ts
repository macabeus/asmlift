// O32 FRAME OBJECTS (frontend/mips.ts `measureO32Frame`, `emitLaddr`, `frameAccess`): a function
// that takes a frame address gets a local area (`compilerBehaviors.o32LocalArea`), every `off(sp)`
// access inside it is memory through an `laddr`, and the shared frame-object audit
// (frontend/frame-objects.ts) proves the objects or refuses. The shapes are the compilers' own
// (`corpus/probe-o32-frame.c` and the escape probes), and the refusals are the ways a frame word
// that is not a local — an outgoing argument, a save, an incoming argument — would otherwise be
// declared one.
import { describe, expect, test } from 'vitest';

import { measureO32Frame } from '../src/frontend/mips';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { MIPS_GCC, MIPS_IDO, type TargetDescription } from '../src/target';
import { obj, relocs } from './helpers';

const PROTOS: Prototypes = {
  fill: { params: ['s32 *'], returnsVoid: true },
  k: { params: ['void *'], returnsVoid: true },
  h5: { params: 5 },
};

const src = (
  lines: string[],
  rs: [number, string, string][] = [],
  target: TargetDescription = MIPS_GCC,
  prototypes: Prototypes = PROTOS,
) => decompile('f', obj(lines), target, { asmData: relocs(rs), prototypes }).source;
const lift =
  (...args: Parameters<typeof src>) =>
  () =>
    src(...args);

// `int f(void){ int a[4]; fill(a); return a[0] + a[3]; }` at gcc2.7.2kmc -O2: the array at sp+16,
// right above the home of a0..a3, under the `ra` save.
const ESCARR_GCC = [
  '0:\taddiu\tsp,sp,-40',
  '4:\tsw\tra,32(sp)',
  '8:\tjal\t0 <f>',
  'c:\taddiu\ta0,sp,16',
  '10:\tlw\tv1,16(sp)',
  '14:\tlw\tv0,28(sp)',
  '18:\tlw\tra,32(sp)',
  '1c:\taddu\tv0,v1,v0',
  '20:\tjr\tra',
  '24:\taddiu\tsp,sp,40',
];

describe('a captured local lifts as one object in the local area', () => {
  test('gcc: `fill(a)` writes the whole array, so its bytes are kept as one', () => {
    const out = src(ESCARR_GCC, [[8, 'R_MIPS_26', 'fill']]);
    expect(out).toContain('u8 sp16[16];');
    expect(out).toContain('fill(sp16)');
    expect(out).toMatch(/return \*p0 \+ p0\[3\];|p0\[3\] \+ \*p0/);
  });

  test('IDO: the same array ends at the frame top, above `ra`', () => {
    const out = src(
      [
        '0:\taddiu\tsp,sp,-40',
        '4:\tsw\tra,20(sp)',
        '8:\tjal\t0 <f>',
        'c:\taddiu\ta0,sp,24',
        '10:\tlw\tra,20(sp)',
        '14:\tlw\tt6,36(sp)',
        '18:\tlw\tt7,24(sp)',
        '1c:\taddiu\tsp,sp,40',
        '20:\tjr\tra',
        '24:\taddu\tv0,t6,t7',
      ],
      [[8, 'R_MIPS_26', 'fill']],
      MIPS_IDO,
    );
    expect(out).toContain('u8 sp24[16];');
    expect(out).toContain('fill(sp24)');
  });

  // `return *(int *)((char *)a + i)` on an `int a[8]` handed to `k`: `addu v0,sp,t6 / lw v0,24(v0)`
  // indexes the array at sp+24, not the frame base — the displacement names the object.
  test('`addu rD,sp,rX` is a runtime index into the object its access displacement names', () => {
    const out = src(
      [
        '0:\taddiu\tsp,sp,-56',
        '4:\tsw\tra,20(sp)',
        '8:\tsw\ta0,56(sp)',
        'c:\tjal\t0 <f>',
        '10:\taddiu\ta0,sp,24',
        '14:\tlw\tt6,56(sp)',
        '18:\tlw\tra,20(sp)',
        '1c:\taddu\tv0,sp,t6',
        '20:\tlw\tv0,24(v0)',
        '24:\tjr\tra',
        '28:\taddiu\tsp,sp,56',
      ],
      [[0xc, 'R_MIPS_26', 'k']],
      MIPS_IDO,
    );
    expect(out).toContain('u8 sp24[32];');
    expect(out).toContain('k(sp24)');
    expect(out).toContain('return *(s32 *)((u32)sp24 + a0);');
  });

  test('…in either operand order: gcc writes `addu a0,a0,sp`, IDO `addu v0,sp,t0`', () => {
    const leaf = (index: string) => [
      '0:\taddiu\tsp,sp,-16',
      '4:\tli\tv0,1',
      '8:\tsw\tv0,0(sp)',
      'c:\tli\tv0,2',
      '10:\tsw\tv0,4(sp)',
      '14:\tsll\ta0,a0,0x2',
      `18:\t${index}`,
      '1c:\tsw\tzero,8(sp)',
      '20:\tsw\tzero,12(sp)',
      '24:\tlw\tv0,0(a0)',
      '28:\tjr\tra',
      '2c:\taddiu\tsp,sp,16',
    ];
    const gcc = src(leaf('addu\ta0,a0,sp'));
    expect(src(leaf('addu\ta0,sp,a0'))).toBe(gcc);
    expect(gcc).toContain('u8 sp0[16];');
    expect(gcc).toMatch(/return p0\[a0\];/);
  });

  test('…and the frame base by every spelling of `move rD,sp`: Splat `addu`, IDO `or`', () => {
    // Splat writes `addu $a3, $sp, $zero` where objdump writes `move a3,sp` (snowboardkids2
    // func_80036AF8_376F8); IDO's own move is `or rD,rS,zero`.
    const leaf = (base: string) => [
      '0:\taddiu\tsp,sp,-16',
      '4:\tli\tv0,1',
      '8:\tsw\tv0,0(sp)',
      'c:\tsw\tzero,4(sp)',
      '10:\tsw\tzero,8(sp)',
      '14:\tsw\tzero,12(sp)',
      `18:\t${base}`,
      '1c:\tsll\ta0,a0,0x2',
      '20:\taddu\ta0,a1,a0',
      '24:\tlw\tv0,0(a0)',
      '28:\tjr\tra',
      '2c:\taddiu\tsp,sp,16',
    ];
    const move = src(leaf('move\ta1,sp'));
    expect(move).toContain('u8 sp0[16];');
    expect(src(leaf('addu\ta1,sp,zero'))).toBe(move);
    expect(src(leaf('or\ta1,sp,zero'))).toBe(move);
  });

  test('a capture moved by a constant is the capture at the sum, and the base only the move read names nothing', () => {
    // `addiu v1,v0,8` off `addiu v0,sp,0` is `addiu v1,sp,8`: both spellings lift the same
    // per-object frame. The base `laddr(0)` is handed to the audit as moved, so it is dropped rather
    // than judged a capture, which would keep the whole frame as one blob.
    const leaf = (...capture: string[]) => [
      '0:\taddiu\tsp,sp,-16',
      ...capture.map((c, i) => `${(4 + 4 * i).toString(16)}:\t${c}`),
      ...[
        'sw\ta0,0(v1)',
        'sw\ta1,4(sp)',
        'lw\tv0,8(sp)',
        'lw\tv1,4(sp)',
        'addu\tv0,v0,v1',
        'jr\tra',
        'addiu\tsp,sp,16',
      ].map((c, i) => `${(4 + 4 * (capture.length + i)).toString(16)}:\t${c}`),
    ];
    const direct = src(leaf('addiu\tv1,sp,8'));
    expect(direct).toContain('s32 sp8;');
    expect(src(leaf('addiu\tv0,sp,0', 'addiu\tv1,v0,8'))).toBe(direct);
  });

  test('an access before the push is placed by its depth, not its raw offset', () => {
    // `lw t6,16(sp)` before `addiu sp,sp,-24` is the fifth argument (entry + 16), not the word at
    // post-push sp+16 inside the local area; the store at 0(sp) after the push is the local.
    const out = src(
      [
        '0:\tlw\tt6,16(sp)',
        '4:\taddiu\tsp,sp,-24',
        '8:\tsw\tt6,0(sp)',
        'c:\tsw\ta0,4(sp)',
        '10:\tsw\ta0,8(sp)',
        '14:\tsw\ta0,12(sp)',
        '18:\tsll\tt7,a1,0x2',
        '1c:\taddu\tv0,sp,t7',
        '20:\tlw\tv0,0(v0)',
        '24:\tjr\tra',
        '28:\taddiu\tsp,sp,24',
      ],
      [],
      MIPS_IDO,
    );
    expect(out).toMatch(/^s32 f\(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4\)/);
    expect(out).toContain('*p0 = a4;');
  });

  test('a byte and a halfword member beside each other are one object', () => {
    // `short h[2]; h[0] = x; h[1] = x + 1; k(h); return h[1];` at gcc2.7.2kmc
    const out = src(
      [
        '0:\taddiu\tsp,sp,-32',
        '4:\tsh\ta0,16(sp)',
        '8:\taddiu\ta0,a0,1',
        'c:\tsh\ta0,18(sp)',
        '10:\tsw\tra,24(sp)',
        '14:\tjal\t0 <f>',
        '18:\taddiu\ta0,sp,16',
        '1c:\tlh\tv0,18(sp)',
        '20:\tlw\tra,24(sp)',
        '24:\tjr\tra',
        '28:\taddiu\tsp,sp,32',
      ],
      [[0x14, 'R_MIPS_26', 'k']],
    );
    expect(out).toContain('u8 sp16[8];');
    expect(out).toContain('k(sp16)');
  });
});

// `void f(s32 i){ u32 a[2]; a[0] = gA; a[1] = gB; five(1, 2, 3, a[i - 1], gC); }` at ido7.1 -O2
// (bench row stkidx_five): the `- 1` is folded into the base, so the read is `lw a3,28(a3)` off
// `addu a3,sp,t9`, beneath `a` at 32, at the very word `ra` is saved in. Nothing the C names lives
// there, so the address is `a`'s moved down (`captureBelowLocalsRebases`).
const FIVE_IDO = [
  '0:\taddiu\tsp,sp,-40',
  '4:\tsw\ta0,40(sp)',
  '8:\tlw\tt8,40(sp)',
  'c:\tlui\tt6,0x0',
  '10:\tlui\tt7,0x0',
  '14:\tlw\tt6,0(t6)',
  '18:\tlw\tt7,0(t7)',
  '1c:\tlui\tt0,0x0',
  '20:\tsll\tt9,t8,0x2',
  '24:\tlw\tt0,0(t0)',
  '28:\tsw\tra,28(sp)',
  '2c:\taddu\ta3,sp,t9',
  '30:\tsw\tt6,32(sp)',
  '34:\tsw\tt7,36(sp)',
  '38:\tlw\ta3,28(a3)',
  '3c:\tli\ta0,1',
  '40:\tli\ta1,2',
  '44:\tli\ta2,3',
  '48:\tjal\t0 <f>',
  '4c:\tsw\tt0,16(sp)',
  '50:\tlw\tra,28(sp)',
  '54:\taddiu\tsp,sp,40',
  '58:\tjr\tra',
  '5c:\tnop',
];
const FIVE_RELOCS: [number, string, string][] = [
  [0xc, 'R_MIPS_HI16', 'gA'],
  [0x14, 'R_MIPS_LO16', 'gA'],
  [0x10, 'R_MIPS_HI16', 'gB'],
  [0x18, 'R_MIPS_LO16', 'gB'],
  [0x1c, 'R_MIPS_HI16', 'gC'],
  [0x24, 'R_MIPS_LO16', 'gC'],
  [0x48, 'R_MIPS_26', 'five'],
];
const FIVE_PROTOS: Prototypes = {
  f: { params: ['s32'], returnsVoid: true },
  five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true },
  k: { params: ['void *'], returnsVoid: true },
};

describe('a capture below the local area is the object above it, moved down', () => {
  test('ido7.1 `a[i - 1]`: the base at the saved `ra` word reads `a` through the index', () => {
    const out = src(FIVE_IDO, FIVE_RELOCS, MIPS_IDO, FIVE_PROTOS);
    expect(out).toContain('u8 sp32[8];');
    expect(out).toContain('five(1, 2, 3, ((s32 *)((u32)sp32 + -4))[a0], v1);');
  });

  // A read at a constant displacement there puts a word beneath the locals in the C's hands, so the
  // capture refuses. Handed to a callee, it is `a - 1` like an indexed base: beneath IDO's
  // locals is the `ra` save, which no C name owns.
  test('…handed on as `a - 1`, and only where it reads nothing beneath at a constant', () => {
    const below = /the captured address at \[sp,#28\) is below the reserved local area, which starts at \[sp,#32\)/;
    const edit = (...pairs: [string, string][]) => FIVE_IDO.map((l) => pairs.find(([at]) => at === l)?.[1] ?? l);
    // handed to a callee
    const escaped = [
      '0:\taddiu\tsp,sp,-40',
      '4:\tsw\tra,28(sp)',
      '8:\tli\tt6,1',
      'c:\tsw\tt6,32(sp)',
      '10:\tjal\t0 <f>',
      '14:\taddiu\ta0,sp,28',
      '18:\tlw\tra,28(sp)',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,40',
    ];
    expect(src(escaped, [[0x10, 'R_MIPS_26', 'k']], MIPS_IDO, FIVE_PROTOS)).toContain('k((u32)sp32 + -4);');
    // read at a constant displacement, the `ra` word itself
    const fixed = edit(['2c:\taddu\ta3,sp,t9', '2c:\taddiu\ta3,sp,28'], ['38:\tlw\ta3,28(a3)', '38:\tlw\ta3,0(a3)']);
    expect(lift(fixed, FIVE_RELOCS, MIPS_IDO, FIVE_PROTOS)).toThrow(below);
    // a target without `captureBelowLocalsRebases` refuses any capture below its locals
    const NO_REBASE = {
      ...MIPS_IDO,
      compilerBehaviors: { ...MIPS_IDO.compilerBehaviors, captureBelowLocalsRebases: undefined },
    };
    expect(lift(FIVE_IDO, FIVE_RELOCS, NO_REBASE, FIVE_PROTOS)).toThrow(below);
  });

  // `void f(s32 i){ u32 a[2], b[2]; a[0] = gA; a[1] = gB; b[0] = gC; b[1] = gD; four(1, 2, 3, 4);
  // use1(a[i] + b[i]); }` at gcc2.7.2 -O2: `a` at 16, `b` at 24. gcc draws the area from the
  // declared stack words, so a `four` declared with a fifth parameter it is not passed starts it at
  // 24, and `a`'s own capture is beneath it. Its stores at 16 and 20 are slot stores, the first one
  // read as four's fifth argument; rebasing the capture onto `b` would read `a[i]` before `b`.
  test('…and not where a word between it and the locals is stored to directly', () => {
    const QOD = [
      '0:\taddiu\tsp,sp,-40',
      '4:\tsw\tra,36(sp)',
      '8:\tsw\ts0,32(sp)',
      'c:\tmove\ts0,a0',
      '10:\tlui\tv0,0x0',
      '14:\tlw\tv0,0(v0)',
      '18:\tsw\tv0,16(sp)',
      '1c:\tlui\tv0,0x0',
      '20:\tlw\tv0,0(v0)',
      '24:\tsw\tv0,20(sp)',
      '28:\tlui\tv0,0x0',
      '2c:\tlw\tv0,0(v0)',
      '30:\tsw\tv0,24(sp)',
      '34:\tlui\tv0,0x0',
      '38:\tlw\tv0,0(v0)',
      '3c:\tsw\tv0,28(sp)',
      '40:\tli\ta0,1',
      '44:\tli\ta1,2',
      '48:\tli\ta2,3',
      '4c:\tjal\t0 <f>',
      '50:\tli\ta3,4',
      '54:\tsll\ts0,s0,0x2',
      '58:\taddiu\tv0,sp,16',
      '5c:\taddu\ts0,s0,v0',
      '60:\tlw\tv0,0(s0)',
      '64:\tlw\ta0,8(s0)',
      '68:\tjal\t0 <f>',
      '6c:\taddu\ta0,v0,a0',
      '70:\tlw\tra,36(sp)',
      '74:\tlw\ts0,32(sp)',
      '78:\tjr\tra',
      '7c:\taddiu\tsp,sp,40',
    ];
    const rs: [number, string, string][] = [
      ...['gA', 'gB', 'gC', 'gD'].flatMap((g, i): [number, string, string][] => [
        [0x10 + 12 * i, 'R_MIPS_HI16', g],
        [0x14 + 12 * i, 'R_MIPS_LO16', g],
      ]),
      [0x4c, 'R_MIPS_26', 'four'],
      [0x68, 'R_MIPS_26', 'use1'],
    ];
    const protos = (params: number): Prototypes => ({
      f: { params: ['s32'], returnsVoid: true },
      four: { params: Array<string>(params).fill('s32'), returnsVoid: true },
      use1: { params: ['u32'], returnsVoid: true },
    });
    expect(lift(QOD, rs, MIPS_GCC, protos(5))).toThrow(
      /\[sp,#16\) is below the reserved local area, which starts at \[sp,#24\), .*the word at \[sp,#16\) between it and the locals is stored to directly/,
    );
    expect(src(QOD, rs, MIPS_GCC, protos(4))).toContain('u8 sp16[16];');
  });

  // `struct HC3 { s32 h; u32 c[3]; }; void f(s32 i){ struct HC3 s; s32 k; s.h = gA; for (k = 0;
  // k < 3; k++) s.c[k] = gB + k; four(1, 2, 3, 4); use1(s.c[i] + s.h); }` at gcc2.7.2 -O1: `s` at
  // 16. Under a `four` declared with a fifth word the area starts at 24, `s.h` reads as that word,
  // and `s.c` straddles the area's start. Its first element is stored only through the loop's
  // runtime index off the base at 20 (`addiu a2,sp,16 / … / sw v1,4(v0)`), so no slot store names
  // the word, and the rebase would declare a 12-byte array as an 8-byte object with `s.c[0]`
  // outside it.
  const QS4_GCC = [
    '0:\taddiu\tsp,sp,-40',
    '4:\tsw\tra,36(sp)',
    '8:\tsw\ts0,32(sp)',
    'c:\tmove\ts0,a0',
    '10:\tlui\tv0,0x0',
    '14:\tlw\tv0,0(v0)',
    '18:\tsw\tv0,16(sp)',
    '1c:\tmove\ta0,zero',
    '20:\taddiu\ta2,sp,16',
    '24:\tlui\ta1,0x0',
    '28:\tlw\ta1,0(a1)',
    '2c:\tsll\tv0,a0,0x2',
    '30:\taddu\tv0,v0,a2',
    '34:\taddu\tv1,a0,a1',
    '38:\tsw\tv1,4(v0)',
    '3c:\taddiu\ta0,a0,1',
    '40:\tslti\tv0,a0,3',
    '44:\tbnez\tv0,30 <f+0x30>',
    '48:\tsll\tv0,a0,0x2',
    '4c:\tli\ta0,1',
    '50:\tli\ta1,2',
    '54:\tli\ta2,3',
    '58:\tjal\t0 <f>',
    '5c:\tli\ta3,4',
    '60:\tsll\tv0,s0,0x2',
    '64:\taddu\tv0,sp,v0',
    '68:\tlw\tv0,20(v0)',
    '6c:\tlw\ta0,16(sp)',
    '70:\tjal\t0 <f>',
    '74:\taddu\ta0,v0,a0',
    '78:\tlw\tra,36(sp)',
    '7c:\tlw\ts0,32(sp)',
    '80:\tjr\tra',
    '84:\taddiu\tsp,sp,40',
  ];
  // …and at gcc2.7.2kmc -O2 the loop runs down a pointer stepped from `&s.c[2]`'s base at 24, which
  // stores `s.c[0]` at 20 on its last trip.
  const QS4_KMC = [
    '0:\taddiu\tsp,sp,-40',
    '4:\tsw\ts0,32(sp)',
    '8:\tmove\ts0,a0',
    'c:\tlui\tv0,0x0',
    '10:\tlw\tv0,0(v0)',
    '14:\tlui\tv1,0x0',
    '18:\tlw\tv1,0(v1)',
    '1c:\tli\ta1,2',
    '20:\taddiu\ta0,sp,24',
    '24:\tsw\tra,36(sp)',
    '28:\taddiu\tv0,v0,2',
    '2c:\tsw\tv1,16(sp)',
    '30:\tsw\tv0,4(a0)',
    '34:\taddiu\tv0,v0,-1',
    '38:\taddiu\ta1,a1,-1',
    '3c:\tbgez\ta1,30 <f+0x30>',
    '40:\taddiu\ta0,a0,-4',
    '44:\tli\ta0,1',
    '48:\tli\ta1,2',
    '4c:\tli\ta2,3',
    '50:\tjal\t0 <f>',
    '54:\tli\ta3,4',
    '58:\tsll\tv0,s0,0x2',
    '5c:\taddu\tv0,sp,v0',
    '60:\tlw\tv0,20(v0)',
    '64:\tlw\ta0,16(sp)',
    '68:\tjal\t0 <f>',
    '6c:\taddu\ta0,v0,a0',
    '70:\tlw\tra,36(sp)',
    '74:\tlw\ts0,32(sp)',
    '78:\tjr\tra',
    '7c:\taddiu\tsp,sp,40',
  ];
  const relocsAt = (gA: number, gB: number, four: number, use1: number): [number, string, string][] => [
    [gA, 'R_MIPS_HI16', 'gA'],
    [gA + 4, 'R_MIPS_LO16', 'gA'],
    [gB, 'R_MIPS_HI16', 'gB'],
    [gB + 4, 'R_MIPS_LO16', 'gB'],
    [four, 'R_MIPS_26', 'four'],
    [use1, 'R_MIPS_26', 'use1'],
  ];
  const HC3_PROTOS = (params: number): Prototypes => ({
    f: { params: ['s32'], returnsVoid: true },
    four: { params: Array<string>(params).fill('s32'), returnsVoid: true },
    use1: { params: ['u32'], returnsVoid: true },
  });

  test('…and not where a store at a runtime index through it may land in words a declaration left out', () => {
    const rs = relocsAt(0x10, 0x24, 0x58, 0x70);
    expect(lift(QS4_GCC, rs, MIPS_GCC, HC3_PROTOS(5))).toThrow(
      /\[sp,#20\) is below the reserved local area, which starts at \[sp,#24\), .*a store at a runtime index may land in the words from \[sp,#20\) to the locals/,
    );
    expect(src(QS4_GCC, rs, MIPS_GCC, HC3_PROTOS(4))).toContain('u8 sp16[16];');
  });

  // `struct HC3 s; u32 *p; s.h = gA; p = &s.c[1]; p[gI] = gB; p[gJ] = gC; four(1, 2, 3, 4);
  // use1(s.c[i] + s.h);` at gcc2.7.2 -O1: the stores go through `p`'s base at 24, the area's start
  // under a five-word `four`, and their index reaches `s.c[0]` at 20 as surely as one through the
  // read's base at 20 does.
  test('…nor where that store goes through a capture inside the locals', () => {
    const QT1 = [
      '0:\taddiu\tsp,sp,-40',
      '4:\tsw\tra,36(sp)',
      '8:\tsw\ts0,32(sp)',
      'c:\tmove\ts0,a0',
      '10:\tlui\tv0,0x0',
      '14:\tlw\tv0,0(v0)',
      '18:\tsw\tv0,16(sp)',
      '1c:\taddiu\ta0,sp,24',
      '20:\tlui\tv0,0x0',
      '24:\tlw\tv0,0(v0)',
      '28:\tsll\tv0,v0,0x2',
      '2c:\taddu\tv0,v0,a0',
      '30:\tlui\tv1,0x0',
      '34:\tlw\tv1,0(v1)',
      '38:\tsw\tv1,0(v0)',
      '3c:\tlui\tv0,0x0',
      '40:\tlw\tv0,0(v0)',
      '44:\tsll\tv0,v0,0x2',
      '48:\taddu\tv0,v0,a0',
      '4c:\tlui\tv1,0x0',
      '50:\tlw\tv1,0(v1)',
      '54:\tsw\tv1,0(v0)',
      '58:\tli\ta0,1',
      '5c:\tli\ta1,2',
      '60:\tli\ta2,3',
      '64:\tjal\t0 <f>',
      '68:\tli\ta3,4',
      '6c:\tsll\ts0,s0,0x2',
      '70:\taddu\tv0,sp,s0',
      '74:\tlw\tv0,20(v0)',
      '78:\tlw\ta0,16(sp)',
      '7c:\tjal\t0 <f>',
      '80:\taddu\ta0,v0,a0',
      '84:\tlw\tra,36(sp)',
      '88:\tlw\ts0,32(sp)',
      '8c:\tjr\tra',
      '90:\taddiu\tsp,sp,40',
    ];
    const rs: [number, string, string][] = [
      ...(
        [
          [0x10, 'gA'],
          [0x20, 'gI'],
          [0x30, 'gB'],
          [0x3c, 'gJ'],
          [0x4c, 'gC'],
        ] as const
      ).flatMap(([at, g]): [number, string, string][] => [
        [at, 'R_MIPS_HI16', g],
        [at + 4, 'R_MIPS_LO16', g],
      ]),
      [0x64, 'R_MIPS_26', 'four'],
      [0x7c, 'R_MIPS_26', 'use1'],
    ];
    expect(lift(QT1, rs, MIPS_GCC, HC3_PROTOS(5))).toThrow(
      /\[sp,#20\) is below the reserved local area, which starts at \[sp,#24\), .*a store at a runtime index may land in the words from \[sp,#20\) to the locals/,
    );
    expect(src(QT1, rs, MIPS_GCC, HC3_PROTOS(4))).toContain('u8 sp16[16];');
  });

  // `void f(s32 i){ u32 a[2]; u32 *p = a - 1; a[0] = gA; a[1] = gB; use1(p[i]); usep(p); }` at
  // gcc2.7.2 -O1: the base at 12 is handed to `usep` as well as read through, beneath an area no
  // declaration moved, so what `usep` receives is `a - 1` like the read's base.
  test('…while one handed on beneath an area no declaration moved is the object above', () => {
    const QH2 = [
      '0:\taddiu\tsp,sp,-32',
      '4:\tsw\tra,28(sp)',
      '8:\tsw\ts0,24(sp)',
      'c:\taddiu\ts0,sp,12',
      '10:\tlui\tv0,0x0',
      '14:\tlw\tv0,0(v0)',
      '18:\tsw\tv0,16(sp)',
      '1c:\tlui\tv0,0x0',
      '20:\tlw\tv0,0(v0)',
      '24:\tsw\tv0,20(sp)',
      '28:\tsll\ta0,a0,0x2',
      '2c:\taddu\ta0,a0,s0',
      '30:\tjal\t0 <f>',
      '34:\tlw\ta0,0(a0)',
      '38:\tjal\t0 <f>',
      '3c:\tmove\ta0,s0',
      '40:\tlw\tra,28(sp)',
      '44:\tlw\ts0,24(sp)',
      '48:\tjr\tra',
      '4c:\taddiu\tsp,sp,32',
    ];
    const rs: [number, string, string][] = [
      [0x10, 'R_MIPS_HI16', 'gA'],
      [0x14, 'R_MIPS_LO16', 'gA'],
      [0x1c, 'R_MIPS_HI16', 'gB'],
      [0x20, 'R_MIPS_LO16', 'gB'],
      [0x30, 'R_MIPS_26', 'use1'],
      [0x38, 'R_MIPS_26', 'usep'],
    ];
    const protos: Prototypes = {
      f: { params: ['s32'], returnsVoid: true },
      use1: { params: ['u32'], returnsVoid: true },
      usep: { params: ['u32 *'], returnsVoid: true },
    };
    const out = src(QH2, rs, MIPS_GCC, protos);
    expect(out).toContain('u8 sp16[8];');
    expect(out).toContain('usep((u32)sp16 + -4);');
  });

  // `struct HC3 s; s.h = gA; fill(s.c); four(1, 2, 3, 4); use1(s.h + s.c[i]);` at gcc2.7.2 -O1:
  // `fill` is handed `s.c` at 20, in the word a five-word `four` leaves out of the area, so what it
  // writes there is `s.c[0]` and not the word beneath an 8-byte object.
  test('…nor where it is handed on into words a declaration left out', () => {
    const QE1 = [
      '0:\taddiu\tsp,sp,-40',
      '4:\tsw\tra,36(sp)',
      '8:\tsw\ts0,32(sp)',
      'c:\tmove\ts0,a0',
      '10:\tlui\tv0,0x0',
      '14:\tlw\tv0,0(v0)',
      '18:\tsw\tv0,16(sp)',
      '1c:\tjal\t0 <f>',
      '20:\taddiu\ta0,sp,20',
      '24:\tli\ta0,1',
      '28:\tli\ta1,2',
      '2c:\tli\ta2,3',
      '30:\tjal\t0 <f>',
      '34:\tli\ta3,4',
      '38:\tsll\ts0,s0,0x2',
      '3c:\taddu\tv0,sp,s0',
      '40:\tlw\tv1,16(sp)',
      '44:\tlw\ta0,20(v0)',
      '48:\tjal\t0 <f>',
      '4c:\taddu\ta0,v1,a0',
      '50:\tlw\tra,36(sp)',
      '54:\tlw\ts0,32(sp)',
      '58:\tjr\tra',
      '5c:\taddiu\tsp,sp,40',
    ];
    const rs: [number, string, string][] = [
      [0x10, 'R_MIPS_HI16', 'gA'],
      [0x14, 'R_MIPS_LO16', 'gA'],
      [0x1c, 'R_MIPS_26', 'fill'],
      [0x30, 'R_MIPS_26', 'four'],
      [0x48, 'R_MIPS_26', 'use1'],
    ];
    const protos = (params: number): Prototypes => ({
      ...HC3_PROTOS(params),
      fill: { params: ['u32 *'], returnsVoid: true },
    });
    expect(lift(QE1, rs, MIPS_GCC, protos(5))).toThrow(
      /\[sp,#20\) is below the reserved local area, which starts at \[sp,#24\), .*it is handed on, where what receives it may reach the words from \[sp,#20\) to the locals/,
    );
    expect(src(QE1, rs, MIPS_GCC, protos(4))).toContain('u8 sp16[16];');
  });

  // `void f(s32 i){ u32 a[2]; a[0] = gA; a[1] = gB; a[i - 3] = gC; use1(a[1]); }` at gcc2.7.2
  // -O1: the store's base is at 4, in the a0..a3 home, beneath an area no declaration moved
  // (`use1` takes no stack word), so no local can lie there and the store is `a`'s.
  test('…while a store at a runtime index below an area no declaration moved is the object above', () => {
    const BS = [
      '0:\taddiu\tsp,sp,-32',
      '4:\tsw\tra,24(sp)',
      '8:\tlui\tv0,0x0',
      'c:\tlw\tv0,0(v0)',
      '10:\tsw\tv0,16(sp)',
      '14:\tlui\tv0,0x0',
      '18:\tlw\tv0,0(v0)',
      '1c:\tsw\tv0,20(sp)',
      '20:\tsll\ta0,a0,0x2',
      '24:\taddiu\tv0,sp,16',
      '28:\taddu\ta0,a0,v0',
      '2c:\tlui\tv0,0x0',
      '30:\tlw\tv0,0(v0)',
      '34:\tsw\tv0,-12(a0)',
      '38:\tjal\t0 <f>',
      '3c:\tlw\ta0,20(sp)',
      '40:\tlw\tra,24(sp)',
      '44:\tjr\tra',
      '48:\taddiu\tsp,sp,32',
    ];
    const rs: [number, string, string][] = [
      [0x8, 'R_MIPS_HI16', 'gA'],
      [0xc, 'R_MIPS_LO16', 'gA'],
      [0x14, 'R_MIPS_HI16', 'gB'],
      [0x18, 'R_MIPS_LO16', 'gB'],
      [0x2c, 'R_MIPS_HI16', 'gC'],
      [0x30, 'R_MIPS_LO16', 'gC'],
      [0x38, 'R_MIPS_26', 'use1'],
    ];
    expect(src(BS, rs, MIPS_GCC, HC3_PROTOS(4))).toContain('((s32 *)((u32)sp16 + -12))[a0] = gC;');
  });

  test('…nor where a pointer stepped down through the locals may store beneath them', () => {
    const rs = relocsAt(0x14, 0xc, 0x50, 0x68);
    expect(lift(QS4_KMC, rs, MIPS_GCC, HC3_PROTOS(5))).toThrow(
      /\[sp,#20\) is below the reserved local area, .*a store through a pointer stepped through the frame may land beneath the locals where the pointer is lowest, at no displacement known/,
    );
    expect(src(QS4_KMC, rs, MIPS_GCC, HC3_PROTOS(4))).toContain('u8 sp16[16];');
  });

  // `void f(void){ u32 a[3]; u32 *p = a - 1; s32 k; for (k = 0; k < 3; k++) *++p = gA + k;
  // use(a[0] + a[1], a[2]); }` at gcc2.7.2kmc -O2: the pointer starts at 12, beneath `a` at 16,
  // and steps before its first store, so every store lands in `a`. A copy of a struct passed by
  // value into the outgoing area steps a pointer too, but from a base in that area, so its first
  // store lands beneath the locals and refuses on the same clause.
  test('…while a pointer stepped up from it stores only inside the locals', () => {
    const PREW = [
      '0:\taddiu\tsp,sp,-40',
      '4:\tsw\tra,32(sp)',
      '8:\taddiu\ta0,sp,12',
      'c:\tmove\tv1,zero',
      '10:\tlui\tv0,0x0',
      '14:\tlw\tv0,0(v0)',
      '18:\taddiu\ta0,a0,4',
      '1c:\taddu\tv0,v0,v1',
      '20:\taddiu\tv1,v1,1',
      '24:\tsw\tv0,0(a0)',
      '28:\tslti\tv0,v1,3',
      '2c:\tbnez\tv0,10 <f+0x10>',
      '30:\tnop',
      '34:\tlw\tv0,16(sp)',
      '38:\tlw\ta0,20(sp)',
      '3c:\tlw\ta1,24(sp)',
      '40:\tjal\t0 <f>',
      '44:\taddu\ta0,v0,a0',
      '48:\tlw\tra,32(sp)',
      '4c:\tjr\tra',
      '50:\taddiu\tsp,sp,40',
    ];
    const rs: [number, string, string][] = [
      [0x10, 'R_MIPS_HI16', 'gA'],
      [0x14, 'R_MIPS_LO16', 'gA'],
      [0x40, 'R_MIPS_26', 'use'],
    ];
    const protos: Prototypes = { f: { returnsVoid: true }, use: { params: ['u32', 's32'], returnsVoid: true } };
    const out = src(PREW, rs, MIPS_GCC, protos);
    expect(out).toContain('u8 sp16[16];');
    expect(out).toContain('(s32 *)((u32)sp16 + -4)');
    // the first store one word lower lands beneath the locals, at 12
    const low = PREW.map((l) => (l === '24:\tsw\tv0,0(a0)' ? '24:\tsw\tv0,-4(a0)' : l));
    expect(lift(low, rs, MIPS_GCC, protos)).toThrow(
      /\[sp,#12\) is below the reserved local area, .*a store through a pointer stepped through the frame may land beneath the locals where the pointer is lowest, at \[sp,#12\)/,
    );
  });
});

describe('a frame word that is not a local refuses', () => {
  test('an address below the local area is an outgoing word or a save', () => {
    // `h5`'s fifth word is staged at 16, so the area starts at 24; an address taken at 16 is not a local's
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-48',
          '4:\tsw\tra,44(sp)',
          '8:\tli\tv0,5',
          'c:\tsw\tv0,16(sp)',
          '10:\taddiu\ta0,sp,16',
          '14:\tjal\t0 <f>',
          '18:\tnop',
          '1c:\tli\ta0,1',
          '20:\tli\ta1,2',
          '24:\tli\ta2,3',
          '28:\tjal\t0 <f>',
          '2c:\tli\ta3,4',
          '30:\tlw\tra,44(sp)',
          '34:\tjr\tra',
          '38:\taddiu\tsp,sp,48',
        ],
        [
          [0x14, 'R_MIPS_26', 'k'],
          [0x28, 'R_MIPS_26', 'h5'],
        ],
      ),
    ).toThrow(/\[sp,#16\) is below the reserved local area, which starts at \[sp,#24\)/);
  });

  test('the address of an incoming stack argument is above the area — `g(&e)` for a fifth `e`', () => {
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-24',
          '4:\tsw\tra,16(sp)',
          '8:\tjal\t0 <f>',
          'c:\taddiu\ta0,sp,40',
          '10:\tlw\tv0,40(sp)',
          '14:\tlw\tra,16(sp)',
          '18:\tjr\tra',
          '1c:\taddiu\tsp,sp,24',
        ],
        [[8, 'R_MIPS_26', 'k']],
      ),
    ).toThrow();
  });

  // The ADDRLOC shape: a by-value struct argument staged in place through a copy base the
  // compiler names with a register. Nothing reads those words back, so they may be the call's
  // stack argument, and keeping them as a local would drop them from the call. Declared with one
  // word, so the extent says the area starts at sp+16: the audit is what refuses (undeclared, the
  // frame measurement refuses first, below).
  test('a store through a capture that reaches a call unread may be its stack argument', () => {
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-48',
          '4:\tsw\tra,40(sp)',
          '8:\taddiu\tt0,sp,16',
          'c:\tsw\ta1,0(t0)',
          '10:\tsw\ta2,4(t0)',
          '14:\tjal\t0 <f>',
          '18:\tli\ta0,1',
          '1c:\tlw\tra,40(sp)',
          '20:\tjr\tra',
          '24:\taddiu\tsp,sp,48',
        ],
        [[0x14, 'R_MIPS_26', 'tb']],
        MIPS_GCC,
        { tb: { params: 1 } },
      ),
    ).toThrow(/may be that call's stack argument/);
  });

  test('an undeclared call that fills a0..a3 beside a local area: where its stack words end is unknown', () => {
    // …unless a frame word it loads bounds them (`outgoingAreaNeverLoadedFrom`), which both shapes
    // below do; without that premise the question stands
    const unbound = (t: TargetDescription): TargetDescription => ({
      ...t,
      compilerBehaviors: { ...t.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
    });
    const fills = [
      '0:\taddiu\tsp,sp,-40',
      '4:\tsw\tra,32(sp)',
      '8:\tli\ta1,1',
      'c:\tli\ta2,2',
      '10:\tli\ta3,3',
      '14:\tjal\t0 <f>',
      '18:\taddiu\ta0,sp,16',
      '1c:\tlw\tv0,16(sp)',
      '20:\tlw\tra,32(sp)',
      '24:\tjr\tra',
      '28:\taddiu\tsp,sp,40',
    ];
    // gcc's area starts where the outgoing words end, so the frame measurement refuses first
    expect(lift(fills, [[0x14, 'R_MIPS_26', 'tb']], unbound(MIPS_GCC), {})).toThrow(
      /nothing declares the callee of the `jal` at 0x14, so how many stack words it takes is unknown/,
    );
    // with it, `lw v0,16(sp)` puts the area's end at 16, and what is left is the audit's own question
    expect(lift(fills, [[0x14, 'R_MIPS_26', 'tb']], MIPS_GCC, {})).toThrow(
      /`tb` takes it at argument 0 and nothing says what that callee returns/,
    );
    // IDO's starts above the saves, so the area stands and the call's guess is what refuses
    const idoFills = [
      '0:\taddiu\tsp,sp,-40',
      '4:\tsw\tra,20(sp)',
      '8:\tli\ta1,1',
      'c:\tli\ta2,2',
      '10:\tli\ta3,3',
      '14:\tjal\t0 <f>',
      '18:\taddiu\ta0,sp,24',
      '1c:\tlw\tv0,24(sp)',
      '20:\tlw\tra,20(sp)',
      '24:\tjr\tra',
      '28:\taddiu\tsp,sp,40',
    ];
    expect(lift(idoFills, [[0x14, 'R_MIPS_26', 'tb']], unbound(MIPS_IDO), {})).toThrow(
      /fills a0\.\.a3 in a frame whose local area/,
    );
    // …and the `ra` restore at 20 puts it at 20, below the area at 24
    expect(lift(idoFills, [[0x14, 'R_MIPS_26', 'tb']], MIPS_IDO, {})).toThrow(
      /`tb` takes it at argument 0 and nothing says what that callee returns/,
    );
  });

  test('IDO: a word staged below the area reaches an undeclared call even when a3 is unset', () => {
    // `tl(1, 2, 3, (long long)x)` beside `fill(a)`: the long long skips a3 for 16(sp)
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-48',
          '4:\tsw\tra,28(sp)',
          '8:\tsw\ta0,48(sp)',
          'c:\tjal\t0 <f>',
          '10:\taddiu\ta0,sp,40',
          '14:\tlw\tt6,48(sp)',
          '18:\tli\ta0,1',
          '1c:\tli\ta1,2',
          '20:\tsra\tt8,t6,0x1f',
          '24:\tsw\tt8,16(sp)',
          '28:\tli\ta2,3',
          '2c:\tjal\t0 <f>',
          '30:\tsw\tt6,20(sp)',
          '34:\tlw\tra,28(sp)',
          '38:\tlw\tt7,44(sp)',
          '3c:\taddiu\tsp,sp,48',
          '40:\tjr\tra',
          '44:\taddu\tv0,t7,v0',
        ],
        [
          [0xc, 'R_MIPS_26', 'fill'],
          [0x2c, 'R_MIPS_26', 'tl'],
        ],
        MIPS_IDO,
        { fill: PROTOS.fill },
      ),
    ).toThrow(/the word stored to 16\(sp\), below the local area, reaches the undeclared call to 'tl'/);
  });

  test('a register the prologue saves may not be stored inside the area', () => {
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-40',
          '4:\tsw\tra,32(sp)',
          '8:\tbeqz\ta0,14 <f+0x14>',
          'c:\tnop',
          '10:\tsw\ts0,20(sp)',
          '14:\tjal\t0 <f>',
          '18:\taddiu\ta0,sp,16',
          '1c:\tlw\tv0,16(sp)',
          '20:\tlw\tra,32(sp)',
          '24:\tjr\tra',
          '28:\taddiu\tsp,sp,40',
        ],
        [[0x14, 'R_MIPS_26', 'fill']],
      ),
    ).toThrow(/saves the caller's s0 inside the local area/);
  });

  test('an access reaching across the edge of the area is part memory, part slot', () => {
    expect(
      lift(
        ESCARR_GCC.map((l) => (l.startsWith('14:') ? '14:\tlw\tv0,30(sp)' : l)),
        [[8, 'R_MIPS_26', 'fill']],
      ),
    ).toThrow(/reaches across an edge of the local area/);
  });

  test('a frame sum carried across a join is a pointer into the object, built where it is handed over', () => {
    const out = src([
      '0:\taddiu\tsp,sp,-16',
      '4:\tsw\tzero,0(sp)',
      '8:\tsw\tzero,4(sp)',
      'c:\tbeqz\ta1,18 <f+0x18>',
      '10:\taddu\tv0,sp,a0',
      '14:\taddu\tv0,sp,a2',
      '18:\tlw\tv0,0(v0)',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,16',
    ]);
    expect(out).toContain('v0 = (s32 *)((u32)sp0 + a2);');
    expect(out).toContain('v0 = (s32 *)((u32)sp0 + a0);');
    expect(out).toContain('return *v0;');
  });

  // `u16 buf[16]; u16 *p = buf + n; for (k = 0; k < n; k++) { *p-- = v; v >>= 1; } *p = 1; sink(buf);`
  // at gcc2.7.2kmc -O2: the sum starts a pointer the loop steps down
  test('a pointer stepped from a runtime index into the object', () => {
    const out = src(
      [
        '0:\taddiu\tsp,sp,-64',
        '4:\tsw\tra,56(sp)',
        '8:\tsll\tv1,a0,0x1',
        'c:\taddiu\tv0,sp,16',
        '10:\taddu\ta2,v0,v1',
        '14:\tblez\ta0,38 <f+0x38>',
        '18:\tmove\tv1,zero',
        '1c:\tsh\ta1,0(a2)',
        '20:\tandi\tv0,a1,0xffff',
        '24:\tsrl\ta1,v0,0x1',
        '28:\taddiu\tv1,v1,1',
        '2c:\tslt\tv0,v1,a0',
        '30:\tbnez\tv0,1c <f+0x1c>',
        '34:\taddiu\ta2,a2,-2',
        '38:\tli\tv0,1',
        '3c:\tsh\tv0,0(a2)',
        '40:\tjal\t0 <f>',
        '44:\taddiu\ta0,sp,16',
        '48:\tlw\tra,56(sp)',
        '4c:\tjr\tra',
        '50:\taddiu\tsp,sp,64',
      ],
      [[0x40, 'R_MIPS_26', 'k']],
    );
    expect(out).toContain('u8 sp16[40];');
    expect(out).toContain('v0 = (u16 *)((u32)sp16 + (a0 << 1));');
    expect(out).toContain('v0 = v0 + -1;');
    expect(out).toContain('k(sp16);');
  });

  test('a frame sum carried across a join and read as a value refuses', () => {
    expect(
      lift([
        '0:\taddiu\tsp,sp,-16',
        '4:\tsw\tzero,0(sp)',
        '8:\tsw\tzero,4(sp)',
        'c:\tbeqz\ta1,18 <f+0x18>',
        '10:\taddu\tv0,sp,a0',
        '14:\taddu\tv0,sp,a2',
        '18:\tsltu\tv0,v0,a3',
        '1c:\tjr\tra',
        '20:\taddiu\tsp,sp,16',
      ]),
    ).toThrow(/a pointer stepped through the frame from the object at \[sp,#0\) flows into `icmp_ult`/);
  });

  test('a sub-word access outside the area keeps the whole function off the slot model', () => {
    // `short e` read in place beside an array: the saves have no slot model left to restore through
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-32',
          '4:\tsw\tra,24(sp)',
          '8:\tjal\t0 <f>',
          'c:\taddiu\ta0,sp,16',
          '10:\tlh\tv1,50(sp)',
          '14:\tlw\tv0,16(sp)',
          '18:\tlw\tra,24(sp)',
          '1c:\taddu\tv0,v0,v1',
          '20:\tjr\tra',
          '24:\taddiu\tsp,sp,32',
        ],
        [[8, 'R_MIPS_26', 'fill']],
      ),
    ).toThrow(/stack pointer used as data/);
  });

  test('a target that states no O32 layout keeps the refusal', () => {
    const bare: TargetDescription = {
      ...MIPS_GCC,
      compilerBehaviors: { ...MIPS_GCC.compilerBehaviors, o32LocalArea: undefined },
    };
    expect(lift(ESCARR_GCC, [[8, 'R_MIPS_26', 'fill']], bare)).toThrow(/stack pointer used as data/);
  });
});

describe('the outgoing extent is computed only where every call can be sized', () => {
  // `int fp5(F5 fp, int x){ int a[2]; fill(a); return fp(1,2,3,4,x) + a[0]; }` at gcc2.7.2kmc
  // stages x at sp+16 for the `jalr` and keeps `a` at sp+24. Read off the `jal` callees alone the
  // area would start at sp+16, over the staged word; the call through a register refuses where
  // the number is computed. (Its lowering refuses `jalr` too today; this holds when it no longer does.)
  const ins = (addr: number, text: string) => {
    const [mnemonic, rest = ''] = text.split('\t');
    return { addr, mnemonic, ops: rest === '' ? [] : rest.split(',') };
  };
  const code = [
    ins(0x0, 'addiu\tsp,sp,-40'),
    ins(0x4, 'sw\tra,36(sp)'),
    ins(0x8, 'addiu\ta0,sp,24'),
    ins(0xc, 'jal\t0'),
    ins(0x10, 'sw\ts0,16(sp)'),
    ins(0x14, 'jalr\tt9'),
  ];
  const measure = (
    calls: typeof code,
    stackWordsOf: (callee: string | undefined) => number | null = () => 0,
    rule: 'above-outgoing-area' | 'above-saved-registers' = 'above-outgoing-area',
  ) =>
    measureO32Frame({
      name: 'f',
      code: calls,
      entry: calls.slice(0, 2),
      depthAt: new Map(calls.map((i, k) => [i, k === 0 ? 0 : 40])),
      frameSize: 40,
      rule,
      stackWordsOf,
      savedByCallee: (r) => r === 'ra' || /^s\d$/.test(r),
      splat: false,
    });

  test('a `jalr` refuses', () => {
    expect(() => measure(code)).toThrow(/the call 'jalr' at 0x14 has no declaration to size its stack words by/);
  });

  test('without it the area is drawn from the declared callees', () => {
    expect(measure(code.slice(0, 5))?.area.from).toBe(16);
  });

  // `int ta(int x){ int a[2]; fill(a); return tl(1,2,3,(long long)x) + a[0]; }` with `tl()`
  // unprototyped, at gcc2.7.2kmc: a3 is skipped, x is staged at sp+16..24 and `a` sits at sp+24. A
  // guess of the call fills a0..a2 and sees no stack word, so nothing but a declaration can say
  // where gcc's local area starts.
  test('an undeclared `jal` refuses where the area starts past the outgoing words', () => {
    expect(() => measure(code.slice(0, 5), () => null)).toThrow(
      /nothing declares the callee of the `jal` at 0xc, so how many stack words it takes is unknown/,
    );
  });

  test("IDO's area starts above the saves, whatever the undeclared call's extent", () => {
    // `int f(void){ int a[4]; fill(a); return a[0]; }` at ido7.1: `ra` at sp+20, the array above it
    const ido = [
      ins(0x0, 'addiu\tsp,sp,-40'),
      ins(0x4, 'sw\tra,20(sp)'),
      ins(0x8, 'addiu\ta0,sp,24'),
      ins(0xc, 'jal\t0'),
    ];
    expect(measure(ido, () => null, 'above-saved-registers')?.area).toEqual({ from: 24, to: 40 });
  });
});

// THE STRONG BOUND FROM 16 (`compilerBehaviors.outgoingAreaNeverLoadedFrom`, frame-objects.ts
// `storedNeverRead`). `char b[8]; b[0] = x; b[4] = y; g(b[0]);` with the array in ido's local area
// at sp+24: `b[4]` is a dead store that reaches the call unread, and no load after the call proves
// it a local's — but `b[0]` is LOADED, at 24, before the call, and ido loads no word of its
// outgoing area from 16(sp) up, so 24 and every word above it are locals.
describe('a dead store above a frame word the function loads is a local', () => {
  const DEADB = [
    '0:\taddiu\tsp,sp,-32',
    '4:\tsw\tra,20(sp)',
    '8:\taddiu\tt0,sp,24',
    'c:\tsb\ta0,0(t0)',
    '10:\tsb\ta1,4(t0)',
    '14:\tlbu\ta0,0(t0)',
    '18:\tjal\t0 <f>',
    '1c:\tnop',
    '20:\tlw\tra,20(sp)',
    '24:\tjr\tra',
    '28:\taddiu\tsp,sp,32',
  ];
  const protos: Prototypes = {
    g: { params: ['s32'], returnsVoid: true },
    f: { params: ['s32', 's32'], returnsVoid: true },
  };
  const g: [number, string, string][] = [[0x18, 'R_MIPS_26', 'g']];

  test('lifts, the dead store dropped', () => {
    expect(src(DEADB, g, MIPS_IDO, protos)).toBe(
      'void f(s32 a0, s32 a1) {\n    u8 sp24;\n    sp24 = a0;\n    g(sp24);\n}\n',
    );
  });

  // The bound is the frontend's, measured once off the instructions: the epilogue's `lw ra,20(sp)`
  // is a load the IR does not show the audit, and it bounds the area at 20 all the same.
  test('…and with no load of the array, the epilogue restore of ra bounds it', () => {
    expect(
      src(
        DEADB.filter((l) => !l.startsWith('14:')),
        g,
        MIPS_IDO,
        protos,
      ),
    ).toBe('void f(s32 a0, s32 a1) {\n    g(a0);\n}\n');
  });

  test('…and with no load from 16(sp) up at all, the store may be the argument again', () => {
    // a function that never returns restores nothing
    const noReturn = [...DEADB.filter((l) => !/^(14|20|24|28):/.test(l)), '20:\tb\t20 <f+0x20>', '24:\tnop'];
    expect(lift(noReturn, g, MIPS_IDO, protos)).toThrow(
      /the 1-byte store at \[sp,#24\) .* no load at or beneath it, from \[sp,#16\) up, proves it a local's/,
    );
  });

  test('…and on a target that states only the after-call form, it refuses as before', () => {
    const weak = {
      ...MIPS_IDO,
      compilerBehaviors: { ...MIPS_IDO.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
    };
    expect(lift(DEADB, g, weak, protos)).toThrow(/the 1-byte store at \[sp,#28\) .* no load after a call proves it/);
  });
});

// THE BOUND CAPS AN UNSIZED CALL'S OUTGOING AREA (`o32OutgoingArea`'s `widest`). A call nothing
// declares may take any number of stack words, but they lie below the lowest frame word from
// 16(sp) up that the function loads — the compilers load no word of their outgoing area there — so
// each reader of where the area ends reads that one number: the local area's partition, the a0..a3
// guess's refusal, and the owned range of an uninitialised read.
describe("an unsized call's outgoing area ends at the loaded-word bound", () => {
  // `void f(int a){ int buf[4]; g(buf,1,2,a); h(buf[0]+buf[1]); }` at gcc2.7.2kmc -O2: buf at 16,
  // loaded back at 16, so g takes no stack word
  const KMC_UX = [
    '0:\taddiu\tsp,sp,-40',
    '4:\tmove\ta3,a0',
    '8:\taddiu\ta0,sp,16',
    'c:\tli\ta1,1',
    '10:\tsw\tra,32(sp)',
    '14:\tjal\t0 <f>',
    '18:\tli\ta2,2',
    '1c:\tlw\tv0,16(sp)',
    '20:\tlw\ta0,20(sp)',
    '24:\tjal\t0 <f>',
    '28:\taddu\ta0,v0,a0',
    '2c:\tlw\tra,32(sp)',
    '30:\tjr\tra',
    '34:\taddiu\tsp,sp,40',
  ];
  // …and at ido7.1 -O2: buf at 24, above the `ra` save at 20, whose restore bounds the area
  const IDO_UX = [
    '0:\taddiu\tsp,sp,-40',
    '4:\tsw\tra,20(sp)',
    '8:\tmove\ta3,a0',
    'c:\taddiu\ta0,sp,24',
    '10:\tli\ta1,1',
    '14:\tjal\t0 <f>',
    '18:\tli\ta2,2',
    '1c:\tlw\tt6,28(sp)',
    '20:\tlw\tt7,24(sp)',
    '24:\tjal\t0 <f>',
    '28:\taddu\ta0,t6,t7',
    '2c:\tlw\tra,20(sp)',
    '30:\taddiu\tsp,sp,40',
    '34:\tjr\tra',
    '38:\tnop',
  ];
  // `void f(int a){ int buf[4]; g(buf,1,2,3,4,5,6,a); h(buf[0]+buf[1]); }` at ido7.1 -O2: buf at
  // 40, and g's four stack words staged at 16..28, below the `ra` restore at 36
  const IDO_UW = [
    '0:\taddiu\tsp,sp,-56',
    '4:\tsw\ta0,56(sp)',
    '8:\tlw\tt9,56(sp)',
    'c:\tsw\tra,36(sp)',
    '10:\tli\tt6,4',
    '14:\tli\tt7,5',
    '18:\tli\tt8,6',
    '1c:\tsw\tt8,24(sp)',
    '20:\tsw\tt7,20(sp)',
    '24:\tsw\tt6,16(sp)',
    '28:\taddiu\ta0,sp,40',
    '2c:\tli\ta1,1',
    '30:\tli\ta2,2',
    '34:\tli\ta3,3',
    '38:\tjal\t0 <f>',
    '3c:\tsw\tt9,28(sp)',
    '40:\tlw\tt0,44(sp)',
    '44:\tlw\tt1,40(sp)',
    '48:\tjal\t0 <f>',
    '4c:\taddu\ta0,t0,t1',
    '50:\tlw\tra,36(sp)',
    '54:\taddiu\tsp,sp,56',
    '58:\tjr\tra',
    '5c:\tnop',
  ];
  const calls = (at: number[]): [number, string, string][] => [
    [at[0], 'R_MIPS_26', 'g'],
    [at[1], 'R_MIPS_26', 'h'],
  ];
  // g and h are declared for what they return, which the audit asks of a callee handed a capture;
  // their parameters stay unsized
  const returns: Prototypes = { g: { returnsVoid: true }, h: { returnsVoid: true } };
  const weak = (t: TargetDescription): TargetDescription => ({
    ...t,
    compilerBehaviors: { ...t.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
  });

  test('the partition draws the area above it (gcc2.7.2kmc)', () => {
    expect(src(KMC_UX, calls([0x14, 0x24]), MIPS_GCC, returns)).toBe(
      'void f(s32 a0) {\n    u8 sp16[16];\n    s32 *p0;\n    p0 = (s32 *)sp16;\n    g(sp16, 1, 2, a0);\n    h(*p0 + p0[1]);\n}\n',
    );
    expect(lift(KMC_UX, calls([0x14, 0x24]), weak(MIPS_GCC), returns)).toThrow(
      /nothing declares the callee of the `jal` at 0x14, so how many stack words it takes is unknown/,
    );
  });

  test('the a0..a3 guess takes no word of a local area above it as a stack argument (ido7.1)', () => {
    expect(src(IDO_UX, calls([0x14, 0x24]), MIPS_IDO, returns)).toBe(
      'void f(s32 a0) {\n    u8 sp24[16];\n    s32 *p0;\n    p0 = (s32 *)sp24;\n    g(sp24, 1, 2, a0);\n    h(p0[1] + *p0);\n}\n',
    );
    expect(lift(IDO_UX, calls([0x14, 0x24]), weak(MIPS_IDO), returns)).toThrow(
      /fills a0..a3 in a frame whose local area holds a captured address/,
    );
  });

  test('…but a word stored below the bound still reaches the guess as a stack argument', () => {
    expect(lift(IDO_UW, calls([0x38, 0x48]), MIPS_IDO, returns)).toThrow(
      /the word stored to 16\(sp\), below the local area, reaches the undeclared call to 'g'/,
    );
  });

  // `int f(int a){ int x; g(a); return x + a; }` at ido7.1 -O2: `x` is never stored and read at 28,
  // above the `ra` save at 20, so it is a local's whatever g takes — an uninitialised one
  const IDO_UV = [
    '0:\taddiu\tsp,sp,-32',
    '4:\tsw\tra,20(sp)',
    '8:\tjal\t0 <f>',
    'c:\tsw\ta0,32(sp)',
    '10:\tlw\tra,20(sp)',
    '14:\tlw\tt6,28(sp)',
    '18:\tlw\tt7,32(sp)',
    '1c:\taddiu\tsp,sp,32',
    '20:\tjr\tra',
    '24:\taddu\tv0,t6,t7',
  ];

  test('the owned range of an uninitialised read starts at it', () => {
    expect(src(IDO_UV, [[0x8, 'R_MIPS_26', 'g']], MIPS_IDO, {})).toBe(
      's32 f(s32 a0) {\n    s32 uninit_sp28;\n    g(a0);\n    return uninit_sp28 + a0;\n}\n',
    );
    expect(lift(IDO_UV, [[0x8, 'R_MIPS_26', 'g']], weak(MIPS_IDO), {})).toThrow(
      /load from stack slot sp@28 that was never stored/,
    );
  });

  test('measureO32Frame: an undeclared `jal` draws the area where the bound reaches it', () => {
    const ins = (addr: number, text: string) => {
      const [mnemonic, rest = ''] = text.split('\t');
      return { addr, mnemonic, ops: rest === '' ? [] : rest.split(',') };
    };
    const code = [
      ins(0x0, 'addiu\tsp,sp,-40'),
      ins(0x4, 'sw\tra,36(sp)'),
      ins(0x8, 'addiu\ta0,sp,16'),
      ins(0xc, 'jal\t0'),
    ];
    const measure = (loadedWordBound?: number) =>
      measureO32Frame({
        name: 'f',
        code,
        entry: code.slice(0, 2),
        depthAt: new Map(code.map((i, k) => [i, k === 0 ? 0 : 40])),
        frameSize: 40,
        rule: 'above-outgoing-area',
        stackWordsOf: () => null,
        savedByCallee: (r) => r === 'ra',
        splat: false,
        loadedWordBound,
      });
    expect(measure(16)?.area).toEqual({ from: 16, to: 36 });
    expect(() => measure(24)).toThrow(/nothing declares the callee of the `jal` at 0xc/);
    expect(() => measure()).toThrow(/nothing declares the callee of the `jal` at 0xc/);
  });
});

// `u8 a[16], b[16]; u32 v0..v7; memcpy(a, p, 16); memcpy(b, q, 16); v0..v7 = g[0..7];` three
// `sink` calls, `return a[3] + b[5] + v0 + … + v7;` at ido7.1 -O2: the eight values spill to
// sp+32..60, BELOW the arrays at sp+64 and sp+80. Kept in the one object the spill words join the
// lower part, so the split's lowest part starts at no copy; handed back to the slot model
// (`reliftRange`, `keptInRelift`), the copies tile what is left and it splits.
const SPILLBELOW_IDO = [
  '0:\taddiu\tsp,sp,-96',
  '4:\tsw\ts0,24(sp)',
  '8:\tsw\ta1,100(sp)',
  'c:\tmove\ta1,a0',
  '10:\tmove\ts0,a2',
  '14:\tsw\tra,28(sp)',
  '18:\tsw\ta0,96(sp)',
  '1c:\taddiu\ta0,sp,80',
  '20:\tjal\t0 <f>',
  '24:\tli\ta2,16',
  '28:\taddiu\ta0,sp,64',
  '2c:\tlw\ta1,100(sp)',
  '30:\tjal\t0 <f>',
  '34:\tli\ta2,16',
  '38:\tlw\tt6,16(s0)',
  '3c:\tlw\ta0,0(s0)',
  '40:\tlw\ta1,4(s0)',
  '44:\tlw\ta2,8(s0)',
  '48:\tlw\ta3,12(s0)',
  '4c:\tsw\tt6,44(sp)',
  '50:\tlw\tt7,20(s0)',
  '54:\tsw\tt7,40(sp)',
  '58:\tlw\tt8,24(s0)',
  '5c:\tsw\tt8,36(sp)',
  '60:\tlw\tt9,28(s0)',
  '64:\tsw\ta0,60(sp)',
  '68:\tsw\ta1,56(sp)',
  '6c:\tsw\ta2,52(sp)',
  '70:\tsw\ta3,48(sp)',
  '74:\tjal\t0 <f>',
  '78:\tsw\tt9,32(sp)',
  '7c:\tlw\ts0,44(sp)',
  '80:\tlw\ta1,40(sp)',
  '84:\tlw\ta2,36(sp)',
  '88:\tlw\ta3,32(sp)',
  '8c:\tjal\t0 <f>',
  '90:\tmove\ta0,s0',
  '94:\tlw\tt0,60(sp)',
  '98:\tlw\tt1,56(sp)',
  '9c:\tlw\tt2,40(sp)',
  'a0:\tlw\tt3,52(sp)',
  'a4:\tlw\tt4,36(sp)',
  'a8:\tlw\tt5,48(sp)',
  'ac:\tlw\tt6,32(sp)',
  'b0:\taddu\ta0,t0,s0',
  'b4:\taddu\ta1,t1,t2',
  'b8:\taddu\ta2,t3,t4',
  'bc:\tjal\t0 <f>',
  'c0:\taddu\ta3,t5,t6',
  'c4:\tlbu\tt7,69(sp)',
  'c8:\tlbu\tt8,83(sp)',
  'cc:\tlw\tt0,60(sp)',
  'd0:\tlw\tt2,56(sp)',
  'd4:\tlw\tt4,52(sp)',
  'd8:\taddu\tt9,t7,t8',
  'dc:\tlw\tt6,48(sp)',
  'e0:\taddu\tt1,t9,t0',
  'e4:\taddu\tt3,t1,t2',
  'e8:\tlw\tt9,40(sp)',
  'ec:\taddu\tt5,t3,t4',
  'f0:\tlw\tt1,36(sp)',
  'f4:\taddu\tt7,t5,t6',
  'f8:\tlw\tra,28(sp)',
  'fc:\taddu\tt8,t7,s0',
  '100:\tlw\tt3,32(sp)',
  '104:\taddu\tt0,t8,t9',
  '108:\tlw\ts0,24(sp)',
  '10c:\taddu\tt2,t0,t1',
  '110:\taddiu\tsp,sp,96',
  '114:\tjr\tra',
  '118:\taddu\tv0,t2,t3',
  '11c:\tnop',
];

test('spill words below two copied arrays go back to the slot model, and the arrays split', () => {
  const out = src(
    SPILLBELOW_IDO,
    [
      [0x20, 'R_MIPS_26', 'memcpy'],
      [0x30, 'R_MIPS_26', 'memcpy'],
      [0x74, 'R_MIPS_26', 'sink'],
      [0x8c, 'R_MIPS_26', 'sink'],
      [0xbc, 'R_MIPS_26', 'sink'],
    ],
    MIPS_IDO,
    {
      sink: { params: 4, returnsVoid: true },
      memcpy: { params: ['void *', 'const void *', 'unsigned long'], returns: 'void *' },
    },
  );
  expect(out).toContain('    u8 sp80[16];\n    u8 sp64[16];\n');
  expect(out).not.toMatch(/sp32|sp64\[(?:-|[2-9]\d)/);
  expect(out).toContain('memcpy(sp80, a0, 16);\n    memcpy(sp64, a1, 16);');
  expect(out).toContain('return sp64[5] + sp80[3] + ');
});

// `u32 f(u32 i, const u8 *p, const u8 *q, u32 *g){ u8 a[16], b[16]; u32 r, v0..v7; memcpy(a, p, 16);
// memcpy(b, q, 16); v0..v7 = g[0..7]; if (i) r = g[9];` three `sink` calls, `g[i] = v0 + … + v7;
// return r + a[3] + b[5]; }` at gcc2.7.2kmc -O2: `r` spills to sp+60 above the arrays, stored only
// under `if (i)` and read on every path. The relift hands it back to the slot model, and the path
// that never stored it reads an uninitialised local there, as it does in a frame no address leaves.
const CONDSPILL_KMC = [
  '0:\taddiu\tsp,sp,-104',
  '4:\tsw\ta0,52(sp)',
  '8:\taddiu\ta0,sp,16',
  'c:\tsw\ts0,64(sp)',
  '10:\tmove\ts0,a2',
  '14:\tli\ta2,16',
  '18:\tsw\ts1,68(sp)',
  '1c:\tmove\ts1,a3',
  '20:\tsw\tra,100(sp)',
  '24:\tsw\ts8,96(sp)',
  '28:\tsw\ts7,92(sp)',
  '2c:\tsw\ts6,88(sp)',
  '30:\tsw\ts5,84(sp)',
  '34:\tsw\ts4,80(sp)',
  '38:\tsw\ts3,76(sp)',
  '3c:\tjal\t0 <f>',
  '40:\tsw\ts2,72(sp)',
  '44:\taddiu\ta0,sp,32',
  '48:\tmove\ta1,s0',
  '4c:\tjal\t0 <f>',
  '50:\tli\ta2,16',
  '54:\tlw\ts8,0(s1)',
  '58:\tlw\ts0,4(s1)',
  '5c:\tlw\ts2,8(s1)',
  '60:\tlw\ts3,12(s1)',
  '64:\tlw\ts4,16(s1)',
  '68:\tlw\ts5,20(s1)',
  '6c:\tlw\tt0,52(sp)',
  '70:\tlw\ts6,24(s1)',
  '74:\tlw\ts7,28(s1)',
  '78:\tbeqz\tt0,88 <f+0x88>',
  '7c:\tmove\ta0,s8',
  '80:\tlw\tt0,36(s1)',
  '84:\tsw\tt0,60(sp)',
  '88:\tmove\ta1,s0',
  '8c:\tmove\ta2,s2',
  '90:\tjal\t0 <f>',
  '94:\tmove\ta3,s3',
  '98:\tmove\ta0,s4',
  '9c:\tmove\ta1,s5',
  'a0:\tmove\ta2,s6',
  'a4:\tjal\t0 <f>',
  'a8:\tmove\ta3,s7',
  'ac:\taddu\ta0,s8,s4',
  'b0:\taddu\ta1,s0,s5',
  'b4:\taddu\ta2,s2,s6',
  'b8:\tjal\t0 <f>',
  'bc:\taddu\ta3,s3,s7',
  'c0:\tlw\tt0,52(sp)',
  'c4:\taddu\tv0,s8,s0',
  'c8:\taddu\tv0,v0,s2',
  'cc:\taddu\tv0,v0,s3',
  'd0:\taddu\tv0,v0,s4',
  'd4:\taddu\tv0,v0,s5',
  'd8:\taddu\tv0,v0,s6',
  'dc:\taddu\tv0,v0,s7',
  'e0:\tsll\tv1,t0,0x2',
  'e4:\taddu\tv1,v1,s1',
  'e8:\tsw\tv0,0(v1)',
  'ec:\tlbu\tv0,19(sp)',
  'f0:\tlw\tt0,60(sp)',
  'f4:\tlbu\tv1,37(sp)',
  'f8:\taddu\tv0,t0,v0',
  'fc:\taddu\tv0,v0,v1',
  '100:\tlw\tra,100(sp)',
  '104:\tlw\ts8,96(sp)',
  '108:\tlw\ts7,92(sp)',
  '10c:\tlw\ts6,88(sp)',
  '110:\tlw\ts5,84(sp)',
  '114:\tlw\ts4,80(sp)',
  '118:\tlw\ts3,76(sp)',
  '11c:\tlw\ts2,72(sp)',
  '120:\tlw\ts1,68(sp)',
  '124:\tlw\ts0,64(sp)',
  '128:\tjr\tra',
  '12c:\taddiu\tsp,sp,104',
];

test('a handed-back spill word stored on one path only is an uninitialised local on the other', () => {
  const out = src(
    CONDSPILL_KMC,
    [
      [0x3c, 'R_MIPS_26', 'memcpy'],
      [0x4c, 'R_MIPS_26', 'memcpy'],
      [0x90, 'R_MIPS_26', 'sink'],
      [0xa4, 'R_MIPS_26', 'sink'],
      [0xb8, 'R_MIPS_26', 'sink'],
    ],
    MIPS_GCC,
    {
      sink: { params: 4, returnsVoid: true },
      memcpy: { params: ['void *', 'const void *', 'unsigned long'], returns: 'void *' },
    },
  );
  expect(out).toContain('    u8 sp16[16];\n    u8 sp32[16];\n');
  expect(out).toContain('if (a0 != 0) v8 = a3[9];');
  expect(out).toContain('return v8 + sp16[3] + sp32[5];');
});
