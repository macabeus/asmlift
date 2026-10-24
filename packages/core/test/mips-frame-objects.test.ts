// O32 FRAME OBJECTS (frontend/mips.ts `measureO32Frame`, `emitLaddr`, `frameAccess`): a function
// that takes a frame address gets a local area (`compilerBehaviors.o32LocalArea`), every `off(sp)`
// access inside it is memory through an `laddr`, and the shared frame-object audit
// (frontend/frame-objects.ts) proves the objects or refuses. The shapes are the compilers' own
// (`corpus/probe-o32-frame.c` and the escape probes), and the refusals are the ways a frame word
// that is not a local — an outgoing argument, a save, an incoming argument — would otherwise be
// declared one.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { measureO32Frame } from '../src/frontend/mips';
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
