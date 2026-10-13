// O32 FRAME OBJECTS (frontend/mips.ts `measureO32Frame`, `emitLaddr`, `frameAccess`): a function
// that takes a frame address gets a local area (`compilerBehaviors.o32LocalArea`), every `off(sp)`
// access inside it is memory through an `laddr`, and the shared frame-object audit
// (frontend/frame-objects.ts) proves the objects or refuses. The shapes are the compilers' own
// (`corpus/probe-o32-frame.c` and the escape probes), and the refusals are the ways a frame word
// that is not a local — an outgoing argument, a save, an incoming argument — would otherwise be
// declared one.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { MIPS_GCC, MIPS_IDO, type TargetDescription } from '../src/target';

const obj = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

const relocs = (rs: [offset: number, type: string, sym: string][]): AsmData => ({
  sections: new Map(),
  relocs: rs.map(([offset, type, sym]) => ({ section: '.text', offset, type, sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

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
  // stack argument, and keeping them as a local would drop them from the call.
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
        {},
      ),
    ).toThrow(/may be that call's stack argument/);
  });

  test('an undeclared call that fills a0..a3 beside a local area: where its stack words end is unknown', () => {
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
    expect(lift(fills, [[0x14, 'R_MIPS_26', 'tb']], MIPS_GCC, {})).toThrow(
      /fills a0\.\.a3 in a frame whose local area/,
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

  test('a frame sum carried across a join names no one object', () => {
    expect(
      lift([
        '0:\taddiu\tsp,sp,-16',
        '4:\tsw\tzero,0(sp)',
        '8:\tsw\tzero,4(sp)',
        'c:\tbeqz\ta1,18 <f+0x18>',
        '10:\taddu\tv0,sp,a0',
        '14:\taddu\tv0,sp,a2',
        '18:\tlw\tv0,0(v0)',
        '1c:\tjr\tra',
        '20:\taddiu\tsp,sp,16',
      ]),
    ).toThrow(/across a join/);
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
