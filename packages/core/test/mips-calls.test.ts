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

  test('a callee declared to return a struct', () => {
    expect(
      lift(DELAY_ARG, [[8, 'R_MIPS_26', 'g']], {
        g: {
          params: ['s32'],
          returns: 'struct S',
          returnLayout: { kind: 'struct', members: [{ name: 'a', type: 's32' }] },
        },
      }),
    ).toThrow(/'g' is declared to return struct S by value — a struct returned through a hidden pointer/);
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
