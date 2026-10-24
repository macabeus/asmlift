// MIPS calls (frontend/mips.ts `lowerJal`): the callee comes off the `jal`'s R_MIPS_26 record (or
// the Splat operand), its delay slot runs before the call, and the O32 adapter of the shared call
// plan (`frontend/call-plan.ts`) reads arguments from a0..a3 and argument 5 onward from `16(sp)`,
// returns the word in v0, and destroys every caller-saved register. What it cannot carry out — a
// register pair, a struct through a hidden pointer, a float across a call — refuses by name.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { MIPS_GCC, MIPS_IDO, type TargetDescription } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

/** `.text` relocation records, as the object's `objdump -r` side table hands them over. */
const relocs = (rs: [offset: number, type: string, sym: string][]): AsmData => ({
  sections: new Map(),
  relocs: rs.map(([offset, type, sym]) => ({ section: '.text', offset, type, sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

const src = (
  lines: string[],
  rs: [number, string, string][],
  prototypes: Prototypes = {},
  target: TargetDescription = MIPS_GCC,
) => decompile('f', obj(lines), target, { asmData: relocs(rs), prototypes }).source;
const lift =
  (...args: Parameters<typeof src>) =>
  () =>
    src(...args);

// `int f(int a) { return g(a + 1) + 1; }` at gcc2.7.2kmc -O2: the argument is set up in the slot.
const DELAY_ARG = [
  '0:\taddiu\tsp,sp,-24',
  '4:\tsw\tra,16(sp)',
  '8:\tjal\t0 <f>',
  'c:\taddiu\ta0,a0,1',
  '10:\tlw\tra,16(sp)',
  '14:\taddiu\tv0,v0,1',
  '18:\tjr\tra',
  '1c:\taddiu\tsp,sp,24',
];

describe('a jal is a call', () => {
  // objdump prints `jal 0 <f>`: the field is the addend, and the callee is the R_MIPS_26 record's.
  test('its delay slot runs first, so an argument set up there is passed, and the result is v0', () => {
    expect(src(DELAY_ARG, [[8, 'R_MIPS_26', 'g']], { g: { params: 1 } })).toBe(
      's32 f(s32 a0) {\n    return g(a0 + 1) + 1;\n}\n',
    );
  });

  test('in Splat text the callee is the operand', () => {
    const splat = `glabel f
    /* 0 80000000 27BDFFE8 */  addiu      $sp, $sp, -0x18
    /* 4 80000004 AFBF0010 */  sw         $ra, 0x10($sp)
    /* 8 80000008 0C000000 */  jal        g
    /* C 8000000C 24840001 */   addiu     $a0, $a0, 1
    /* 10 80000010 8FBF0010 */  lw        $ra, 0x10($sp)
    /* 14 80000014 24420001 */  addiu     $v0, $v0, 1
    /* 18 80000018 03E00008 */  jr        $ra
    /* 1C 8000001C 27BD0018 */   addiu    $sp, $sp, 0x18
endlabel f
`;
    expect(decompile('f', splat, MIPS_GCC, { prototypes: { g: { params: 1 } } }).source).toContain(
      'return g(a0 + 1) + 1;',
    );
  });

  test('without a prototype the arity is the argument registers set up', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tmove\ta1,a0',
      'c:\tjal\t0 <f>',
      '10:\tli\ta0,7',
      '14:\tlw\tra,16(sp)',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,24',
    ];
    expect(src(body, [[0xc, 'R_MIPS_26', 'g']])).toContain('return g(7, a0);');
  });

  test('a declared arity reads what it declares and nothing past it', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tmove\ta1,a0',
      'c:\tjal\t0 <f>',
      '10:\tli\ta0,7',
      '14:\tlw\tra,16(sp)',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,24',
    ];
    expect(src(body, [[0xc, 'R_MIPS_26', 'g']], { g: { params: ['s32'] } })).toContain('return g(7);');
  });

  test('the fifth declared argument is the word stored to 16(sp)', () => {
    const body = [
      '0:\taddiu\tsp,sp,-32',
      '4:\tsw\tra,24(sp)',
      '8:\taddiu\tt0,a0,5',
      'c:\tjal\t0 <f>',
      '10:\tsw\tt0,16(sp)',
      '14:\tlw\tra,24(sp)',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,32',
    ];
    expect(src(body, [[0xc, 'R_MIPS_26', 'g']], { g: { params: ['s32', 's32', 's32', 's32', 's32'] } })).toContain(
      'return g(a0, a1, a2, a3, a0 + 5);',
    );
  });

  test('a declared stack argument nothing stored refuses', () => {
    const body = [
      '0:\taddiu\tsp,sp,-32',
      '4:\tsw\tra,24(sp)',
      '8:\tjal\t0 <f>',
      'c:\tnop',
      '10:\tlw\tra,24(sp)',
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,32',
    ];
    expect(lift(body, [[8, 'R_MIPS_26', 'g']], { g: { params: ['s32', 's32', 's32', 's32', 's32'] } })).toThrow(
      /outgoing stack argument 5 of 'g' at 0x8 travels in 16\(sp\), and no value stored there reaches the call/,
    );
  });

  test('a declared stack argument past the pushed frame refuses: that word is the caller home area', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tt0,16(sp)',
      '8:\tsw\tt1,20(sp)',
      'c:\tsw\ta0,24(sp)',
      '10:\tjal\t0 <f>',
      '14:\tnop',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,24',
    ];
    const seven = { g: { params: ['s32', 's32', 's32', 's32', 's32', 's32', 's32'] } };
    expect(lift(body, [[0x10, 'R_MIPS_26', 'g']], seven)).toThrow(
      /outgoing stack argument 7 of 'g' at 0x10 travels in 24\(sp\), past the 24-byte frame this function pushed/,
    );
  });
});

describe('a guessed arity that cannot be decided refuses', () => {
  test('all four registers set and an outgoing-area word reaching the call', () => {
    const body = [
      '0:\taddiu\tsp,sp,-32',
      '4:\tsw\tra,24(sp)',
      '8:\tsw\ta0,16(sp)',
      'c:\tli\ta0,1',
      '10:\tli\ta1,2',
      '14:\tli\ta2,3',
      '18:\tjal\t0 <f>',
      '1c:\tli\ta3,4',
      '20:\tlw\tra,24(sp)',
      '24:\tjr\tra',
      '28:\taddiu\tsp,sp,32',
    ];
    expect(lift(body, [[0x18, 'R_MIPS_26', 'g']])).toThrow(
      /outgoing stack arguments not modelled — the undeclared call to 'g' at 0x18 fills a0\.\.a3, and the word stored to 16\(sp\) reaches it/,
    );
  });

  test('…but a word of the incoming home area, above the frame, is no argument of the call', () => {
    // IDO's helper-call shape: a0..a3 homed to the caller's area, then the call.
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,20(sp)',
      '8:\tsw\ta0,24(sp)',
      'c:\tsw\ta1,28(sp)',
      '10:\tsw\ta2,32(sp)',
      '14:\tjal\t0 <f>',
      '18:\tsw\ta3,36(sp)',
      '1c:\tlw\tra,20(sp)',
      '20:\taddiu\tsp,sp,24',
      '24:\tjr\tra',
      '28:\tnop',
    ];
    expect(src(body, [[0x14, 'R_MIPS_26', 'g']])).toContain('return g(a0, a1, a2, a3);');
  });

  test('a register past a gap holds a value', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tli\ta2,3',
      'c:\tjal\t0 <f>',
      '10:\tli\ta0,1',
      '14:\tlw\tra,16(sp)',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,24',
    ];
    expect(lift(body, [[0xc, 'R_MIPS_26', 'g']])).toThrow(/a2 holds a value and a1 holds none/);
    // `int g(int, int, ...)` states its first two argument words, so a1 is this function's own
    // argument passed on, and only a2, past them, is guessed (frontend/call-plan.ts `variadicFloor`)
    const variadic = { g: { returns: 's32', variadicParams: ['s32', 's32'] } };
    expect(src(body, [[0xc, 'R_MIPS_26', 'g']], variadic)).toContain('g(1, a1, 3)');
  });

  // past a variadic declaration's stated words, a register holding only this function's own
  // incoming value refuses (frontend/ssa.ts `fallbackArgc`), and one a call destroyed holds none.
  // IDO 7.1's own output for `int dprint(const char *, ...);` and each source below.
  test('an incoming value past a variadic floor refuses, and one a call destroyed is no argument', () => {
    const dprint = { dprint: { returns: 's32', variadicParams: ['const char *'] }, g: { params: [], returns: 's32' } };
    const withG = { ...dprint, g: { params: ['s32'], returns: 's32' } };
    // `int pr1(const char *s, int x){ if (x) return dprint(s) + 1; return 0; }`: a1 is read only
    const pr1 = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tbeqz\ta1,1c <f+0x1c>',
      '8:\tsw\tra,20(sp)',
      'c:\tjal\t0 <f>',
      '10:\tnop',
      '14:\tb\t20 <f+0x20>',
      '18:\taddiu\tv0,v0,1',
      '1c:\tmove\tv0,zero',
      '20:\tlw\tra,20(sp)',
      '24:\taddiu\tsp,sp,24',
      '28:\tjr\tra',
      '2c:\tnop',
    ];
    expect(lift(pr1, [[0xc, 'R_MIPS_26', 'dprint']], dprint, MIPS_IDO)).toThrow(
      /the call at 0xc has a prototype stating only its first 1 argument, and a1 past them still holds this function's own incoming value/,
    );
    // `int rl3(const char *s, int x){ g(x); return dprint(s); }`: `g` destroyed a1
    const rl3 = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,20(sp)',
      '8:\tsw\ta0,24(sp)',
      'c:\tjal\t0 <f>',
      '10:\tmove\ta0,a1',
      '14:\tjal\t0 <f>',
      '18:\tlw\ta0,24(sp)',
      '1c:\tlw\tra,20(sp)',
      '20:\taddiu\tsp,sp,24',
      '24:\tjr\tra',
      '28:\tnop',
    ];
    const out3 = src(
      rl3,
      [
        [0xc, 'R_MIPS_26', 'g'],
        [0x14, 'R_MIPS_26', 'dprint'],
      ],
      withG,
      MIPS_IDO,
    );
    expect(out3).toContain('g(a1);');
    expect(out3).toContain('return dprint(a0);');
    // `int rl1(const char *s, int x){ g(); if (x) return dprint(s) + 1; return 0; }`: home-stored,
    // read back, and destroyed by `g`
    const rl1 = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,20(sp)',
      '8:\tsw\ta0,24(sp)',
      'c:\tjal\t0 <f>',
      '10:\tsw\ta1,28(sp)',
      '14:\tlw\tt6,28(sp)',
      '18:\tmove\tv0,zero',
      '1c:\tbeqz\tt6,34 <f+0x34>',
      '20:\tnop',
      '24:\tjal\t0 <f>',
      '28:\tlw\ta0,24(sp)',
      '2c:\tb\t34 <f+0x34>',
      '30:\taddiu\tv0,v0,1',
      '34:\tlw\tra,20(sp)',
      '38:\taddiu\tsp,sp,24',
      '3c:\tjr\tra',
      '40:\tnop',
    ];
    expect(
      src(
        rl1,
        [
          [0xc, 'R_MIPS_26', 'g'],
          [0x24, 'R_MIPS_26', 'dprint'],
        ],
        dprint,
        MIPS_IDO,
      ),
    ).toContain('dprint(a0) + 1');
    // `int rl2(const char *s, int x, int y){ int r = g(y); if (x) return dprint(s) + r; return 0; }`
    const rl2 = [
      '0:\taddiu\tsp,sp,-32',
      '4:\tsw\tra,20(sp)',
      '8:\tsw\ta0,32(sp)',
      'c:\tmove\ta0,a2',
      '10:\tjal\t0 <f>',
      '14:\tsw\ta1,36(sp)',
      '18:\tlw\tt6,36(sp)',
      '1c:\tlw\ta0,32(sp)',
      '20:\tbeqzl\tt6,40 <f+0x40>',
      '24:\tmove\tv0,zero',
      '28:\tjal\t0 <f>',
      '2c:\tsw\tv0,28(sp)',
      '30:\tlw\tv1,28(sp)',
      '34:\tb\t40 <f+0x40>',
      '38:\taddu\tv0,v0,v1',
      '3c:\tmove\tv0,zero',
      '40:\tlw\tra,20(sp)',
      '44:\taddiu\tsp,sp,32',
      '48:\tjr\tra',
      '4c:\tnop',
    ];
    const out2 = src(
      rl2,
      [
        [0x10, 'R_MIPS_26', 'g'],
        [0x28, 'R_MIPS_26', 'dprint'],
      ],
      withG,
      MIPS_IDO,
    );
    expect(out2).toContain('g(a2)');
    expect(out2).toMatch(/dprint\(a0\) \+ v\d/);
  });

  test('a pending %hi half is no argument', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tlui\ta1,0x0',
      'c:\tlw\ta0,0(a1)',
      '10:\tjal\t0 <f>',
      '14:\tnop',
      '18:\tlw\tra,16(sp)',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,24',
    ];
    const rs: [number, string, string][] = [
      [8, 'R_MIPS_HI16', 'gv'],
      [0xc, 'R_MIPS_LO16', 'gv'],
      [0x10, 'R_MIPS_26', 'g'],
    ];
    expect(src(body, rs)).toContain('return g(gv);');
  });
});

describe('what a call destroys', () => {
  test('a caller-saved t-register read after the call refuses', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tmove\tt0,a0',
      'c:\tjal\t0 <f>',
      '10:\tnop',
      '14:\taddu\tv0,v0,t0',
      '18:\tlw\tra,16(sp)',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,24',
    ];
    expect(lift(body, [[0xc, 'R_MIPS_26', 'g']], { g: { params: 0 } })).toThrow(
      /t0 is read on a path where a call has destroyed it/,
    );
  });

  test.each([
    ['a multiply', 'mult\ta0,a1'],
    ['a divide', 'div\tzero,a0,a1'],
  ])('hi and lo after %s are the callee’s: an mflo past the call is loud', (_what, op) => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      `8:\t${op}`,
      'c:\tjal\t0 <f>',
      '10:\tnop',
      '14:\tmflo\tv0',
      '18:\tlw\tra,16(sp)',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,24',
    ];
    expect(lift(body, [[0xc, 'R_MIPS_26', 'g']], { g: { params: 0 } })).toThrow(/mflo/);
  });
});

// `void f(u32 n) { u32 i; for (i = 0; i < n; i++) if (gTab[i] == 7) { Ping(i); return; } }` at
// gcc2.7.2kmc -O2: the loop leaves a byte in v0 on its own exit, and Ping, void, destroys v0 on the
// other. A return the function's own declaration says is void reads neither.
const VOID_RETURN_PAST_CALL = [
  '0:\taddiu\tsp,sp,-32',
  '4:\tsw\tra,24(sp)',
  '8:\tmove\tv1,a0',
  'c:\tbeqz\tv1,48 <f+0x48>',
  '10:\tmove\ta0,zero',
  '14:\tli\ta1,7',
  '18:\tlui\tv0,0x0',
  '1c:\taddu\tv0,v0,a0',
  '20:\tlbu\tv0,0(v0)',
  '24:\tbnel\tv0,a1,3c <f+0x3c>',
  '28:\taddiu\ta0,a0,1',
  '2c:\tjal\t0 <f>',
  '30:\tnop',
  '34:\tj\t48 <f+0x48>',
  '38:\tnop',
  '3c:\tsltu\tv0,a0,v1',
  '40:\tbnez\tv0,18 <f+0x18>',
  '44:\tnop',
  '48:\tlw\tra,24(sp)',
  '4c:\tjr\tra',
  '50:\taddiu\tsp,sp,32',
];
const VOID_RETURN_RELOCS: [number, string, string][] = [
  [0x18, 'R_MIPS_HI16', 'gTab'],
  [0x20, 'R_MIPS_LO16', 'gTab'],
  [0x2c, 'R_MIPS_26', 'Ping'],
];

describe('a return the own declaration says is void', () => {
  test('reads no v0, so a void callee destroying it on one path refuses nothing', () => {
    const out = src(VOID_RETURN_PAST_CALL, VOID_RETURN_RELOCS, {
      Ping: { params: 1, returnsVoid: true },
      f: { returnsVoid: true },
    });
    expect(out).toContain('void f(');
    expect(out).toMatch(/Ping\(v\d\);\n\s+return;/);
  });

  test('undeclared, the same return still reads v0 and refuses', () => {
    expect(lift(VOID_RETURN_PAST_CALL, VOID_RETURN_RELOCS, { Ping: { params: 1, returnsVoid: true } })).toThrow(
      /v0 is read on a path where a call has destroyed it/,
    );
  });
});

describe('what this lowering cannot carry out refuses', () => {
  test('a callee declared to return 64 bits', () => {
    expect(lift(DELAY_ARG, [[8, 'R_MIPS_26', 'g']], { g: { params: ['s32'], returns: 'long long' } })).toThrow(
      /'g' would hand back one half of a 64-bit value/,
    );
  });

  test('a callee declared to take a 64-bit parameter', () => {
    expect(lift(DELAY_ARG, [[8, 'R_MIPS_26', 'g']], { g: { params: ['long long'] } })).toThrow(
      /one half of a 64-bit value would be handed to 'g'/,
    );
  });

  // `float g(int); float f(int a) { return g(a + 1); }` and `void g(float); void f(float x) { g(x); }`:
  // the float stays in $f0 or $f12 across the call, and the caller names no FPU register.
  test.each([
    ['return a float', { params: ['s32'], returns: 'float' }, /'g' is declared to return float/],
    ['return a double', { params: ['s32'], returns: 'const double' }, /'g' is declared to return const double/],
    ['take a float', { params: ['float'], returnsVoid: true }, /'g' is declared to take float as its parameter 1/],
    ['take a double second', { params: ['s32', 'double'] }, /'g' is declared to take double as its parameter 2/],
  ])('a callee declared to %s', (_what, g, message) => {
    expect(lift(DELAY_ARG, [[8, 'R_MIPS_26', 'g']], { g }, MIPS_IDO)).toThrow(message);
    expect(lift(DELAY_ARG, [[8, 'R_MIPS_26', 'g']], { g }, MIPS_GCC)).toThrow(message);
  });

  // the struct comes back through the pointer in a0 (mips-struct-return.test.ts), so the v0 this
  // fixture reads past the call is the callee's
  test('a callee declared to return a struct, whose v0 is read', () => {
    expect(
      lift(DELAY_ARG, [[8, 'R_MIPS_26', 'g']], {
        g: {
          params: ['s32'],
          returns: 'struct S',
          returnLayout: { kind: 'struct', members: [{ name: 'a', type: 's32' }] },
        },
      }),
    ).toThrow(/v0 is read on a path where a call has destroyed it/);
  });

  test('a call in a function that uses the FPU', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tadd.s\t$f0,$f12,$f14',
      'c:\tjal\t0 <f>',
      '10:\tnop',
      '14:\tlw\tra,16(sp)',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,24',
    ];
    expect(lift(body, [[0xc, 'R_MIPS_26', 'g']], {}, MIPS_IDO)).toThrow(
      /'add\.s' at 0x8 uses the FPU and 'jal' at 0xc makes a call — the floating-point registers a call reads/,
    );
  });

  test('a callee named by a section symbol', () => {
    expect(lift(DELAY_ARG, [[8, 'R_MIPS_26', '.text']])).toThrow(/is relocated against the section '\.text'/);
  });

  // gcc2.7.2 and KMC relocate a call to a function of the same object against `.text`: the jump's
  // field holds the target's section offset over four, and the symbol table names what starts there
  test('a callee named by a section symbol is the function at the offset its field holds', () => {
    const text = new Uint8Array(0x28);
    text.set([0x0c, 0x00, 0x00, 0x08], 8); // jal 0x20
    const sym = (value: number, index: number) => ({ section: '.text', value, size: 8, index });
    const ad = (names: [string, number][]): AsmData => ({
      ...relocs([[8, 'R_MIPS_26', '.text']]),
      sections: new Map([['.text', text]]),
      symbols: new Map([
        ['f', sym(0, 1)],
        ...names.map(([n, v], k): [string, ReturnType<typeof sym>] => [n, sym(v, k + 2)]),
      ]),
    });
    const listing = `${obj(DELAY_ARG)}00000020 <g>:\n  20:\tjr\tra\n  24:\tnop\n`;
    const g = { g: { params: 1, returns: 's32' } };
    expect(decompile('f', listing, MIPS_GCC, { asmData: ad([['g', 0x20]]), prototypes: g }).source).toContain(
      'g(a0 + 1) + 1',
    );
    // no one name starts at the offset: the call keeps the section, and refuses
    for (const names of [
      [],
      [
        ['g', 0x20],
        ['g_alias', 0x20],
      ],
      [['g', 0x24]],
    ] as [string, number][][]) {
      expect(() => decompile('f', listing, MIPS_GCC, { asmData: ad(names), prototypes: g })).toThrow(
        /is relocated against the section '\.text'/,
      );
    }
  });

  test('a jal no relocation names', () => {
    expect(lift(DELAY_ARG, [])).toThrow(/'jal' at 0x8 has no callee symbol/);
  });

  test('a delay slot another branch lands on', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tbeqz\ta0,14 <f+0x14>',
      'c:\tnop',
      '10:\tjal\t0 <f>',
      '14:\tli\ta0,1',
      '18:\tlw\tra,16(sp)',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,24',
    ];
    expect(lift(body, [[0x10, 'R_MIPS_26', 'g']])).toThrow(
      /'jal' at 0x10 — its delay slot at 0x14 is not the next instruction of its block/,
    );
  });

  test('a jal in a branch delay slot', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tbeqz\ta0,10 <f+0x10>',
      'c:\tjal\t0 <f>',
      '10:\tlw\tra,16(sp)',
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,24',
    ];
    expect(lift(body, [[0xc, 'R_MIPS_26', 'g']])).toThrow(/'jal' at 0xc sits in the delay slot of a transfer/);
  });

  test('a call in a function that pushes no frame', () => {
    expect(lift(['0:\tjal\t0 <f>', '4:\tnop', '8:\tjr\tra', 'c:\tnop'], [[0, 'R_MIPS_26', 'g']])).toThrow(
      /the call at 0x0 is made in a frame that is not one 'addiu sp,sp,-N'/,
    );
  });

  test('a j relocated against another function is a tail call', () => {
    expect(lift(['0:\tj\t0 <f>', '4:\tnop'], [[0, 'R_MIPS_26', 'g']])).toThrow(
      /'j' at 0x0 jumps to 'g' — a tail call into another function is not modelled/,
    );
  });

  test('a jalr keeps its refusal', () => {
    const body = ['0:\taddiu\tsp,sp,-24', '4:\tsw\tra,16(sp)', '8:\tjalr\tt9', 'c:\tnop'];
    expect(lift(body, [])).toThrow(/function call 'jalr' at 0x8/);
  });
});

describe("a compiler's own runtime helper is a gap, not a call", () => {
  // `long long f(long long a, long long b) { return a / b; }`: IDO homes the four words in the
  // caller's area and calls `__ll_div`, GCC calls `__divdi3` with the pairs still in a0..a3.
  test.each([
    ['IDO', '__ll_div', MIPS_IDO],
    ['GCC', '__divdi3', MIPS_GCC],
  ])('%s: %s', (_compiler, helper, target) => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,20(sp)',
      '8:\tsw\ta0,24(sp)',
      'c:\tsw\ta1,28(sp)',
      '10:\tsw\ta2,32(sp)',
      '14:\tjal\t0 <f>',
      '18:\tsw\ta3,36(sp)',
      '1c:\tlw\tra,20(sp)',
      '20:\taddiu\tsp,sp,24',
      '24:\tjr\tra',
      '28:\tnop',
    ];
    expect(lift(body, [[0x14, 'R_MIPS_26', helper]], {}, target)).toThrow(
      new RegExp(`no model for the runtime helper '${helper}'`),
    );
  });
});

// A CONVERSION BETWEEN A 64-BIT INTEGER AND A FLOAT IS A HELPER CALL ON BOTH COMPILERS, and its
// value travels in registers a guessed call cannot see: `double tod(long long a) { return a; }`
// leaves the pair in a0:a1 (GCC) or homes it (IDO), and the double comes back in $f0. Lifted as an
// ordinary call it is `return __floatdidf();`, which recompiles to the same `jal`.
describe('a 64-bit conversion is a runtime helper, and a gap', () => {
  const GCC_TOD = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tjal\t0 <f>',
    'c:\tnop',
    '10:\tlw\tra,16(sp)',
    '14:\tjr\tra',
    '18:\taddiu\tsp,sp,24',
  ];
  const IDO_TOD = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,20(sp)',
    '8:\tsw\ta0,24(sp)',
    'c:\tjal\t0 <f>',
    '10:\tsw\ta1,28(sp)',
    '14:\tlw\tra,20(sp)',
    '18:\taddiu\tsp,sp,24',
    '1c:\tjr\tra',
    '20:\tnop',
  ];
  test.each([
    '__ll_to_d',
    '__ll_to_f',
    '__ull_to_d',
    '__ull_to_f',
    '__d_to_ll',
    '__f_to_ll',
    '__d_to_ull',
    '__f_to_ull',
  ])('IDO: %s', (helper) => {
    expect(lift(IDO_TOD, [[0xc, 'R_MIPS_26', helper]], {}, MIPS_IDO)).toThrow(
      new RegExp(`no model for the runtime helper '${helper}'`),
    );
  });
  test.each(['__floatdidf', '__floatdisf', '__fixdfdi', '__fixsfdi', '__fixunsdfdi', '__fixunssfdi', '__cmpdi2'])(
    'GCC: %s',
    (helper) => {
      expect(lift(GCC_TOD, [[8, 'R_MIPS_26', helper]], {}, MIPS_GCC)).toThrow(
        new RegExp(`no model for the runtime helper '${helper}'`),
      );
    },
  );
});

// A 64-BIT BITFIELD IS READ AND WRITTEN THROUGH IDO'S RUNTIME: `struct S { long long a : 40; … };
// long long g3(struct S *s) { return s[1].a; }` hands the word's address, the start bit and the
// length to `__ll_bit_extract`. Lifted as an ordinary call it recompiles to the same `jal`.
describe('a 64-bit bitfield access is a runtime helper, and a gap', () => {
  const IDO_EXTRACT = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,20(sp)',
    '8:\taddiu\ta0,a0,8',
    'c:\tmove\ta1,zero',
    '10:\tjal\t0 <f>',
    '14:\tli\ta2,40',
    '18:\tlw\tra,20(sp)',
    '1c:\taddiu\tsp,sp,24',
    '20:\tjr\tra',
    '24:\tnop',
  ];
  test.each(['__ll_bit_extract', '__ull_bit_extract', '__ll_bit_insert'])('IDO: %s', (helper) => {
    expect(lift(IDO_EXTRACT, [[0x10, 'R_MIPS_26', helper]], {}, MIPS_IDO)).toThrow(
      new RegExp(`no model for the runtime helper '${helper}'`),
    );
  });
});

// `void g(int); void f(int x) { g(x + 1); }` at gcc2.7.2kmc -O2. Under a declaration that says `g`
// is void, v0 after the call holds nothing g handed back, so `f` returns nothing.
describe('a callee declared void hands nothing back', () => {
  const VOID_TAIL = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tjal\t0 <f>',
    'c:\taddiu\ta0,a0,1',
    '10:\tlw\tra,16(sp)',
    '14:\tjr\tra',
    '18:\taddiu\tsp,sp,24',
  ];

  test.each([
    ['returnsVoid', { params: ['s32'], returnsVoid: true }],
    ['returns: "void"', { params: ['s32'], returns: 'void' }],
  ])('a function ending on its call returns nothing (%s)', (_how, g) => {
    expect(src(VOID_TAIL, [[8, 'R_MIPS_26', 'g']], { g })).toBe('void f(s32 a0) {\n    g(a0 + 1);\n}\n');
  });

  test('a value v0 held before the call is not returned after it', () => {
    const body = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tli\tv0,5',
      'c:\tlui\tat,0x0',
      '10:\tsw\tv0,0(at)',
      '14:\tjal\t0 <f>',
      '18:\tnop',
      '1c:\tlw\tra,16(sp)',
      '20:\tjr\tra',
      '24:\taddiu\tsp,sp,24',
    ];
    const rs: [number, string, string][] = [
      [0xc, 'R_MIPS_HI16', 'gv'],
      [0x10, 'R_MIPS_LO16', 'gv'],
      [0x14, 'R_MIPS_26', 'g'],
    ];
    expect(src(body, rs, { g: { params: [], returnsVoid: true } })).toMatch(
      /^void f\(void\) \{\n {4}gv = 5;\n {4}g\(\);\n\}/,
    );
  });

  test('a read of v0 past the call refuses', () => {
    const body = [...DELAY_ARG];
    expect(lift(body, [[8, 'R_MIPS_26', 'g']], { g: { params: ['s32'], returnsVoid: true } })).toThrow(
      /v0 is read on a path where a call has destroyed it/,
    );
  });
});
