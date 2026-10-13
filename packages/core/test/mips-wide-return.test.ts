// O32 64-BIT RETURNS (frontend/mips.ts `v1MayHoldLowWord`): a `long long` comes back in v0:v1, the
// low word in v1, and the lowering returns one word. A return whose v1 was written for the caller
// refuses unless the function's own declaration says the return fits a word; v1 written as scratch
// lifts as before. Shapes compiled at canonical flags on ido7.1, gcc2.7.2kmc and gcc2.7.2.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { MIPS_GCC } from '../src/target';

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

const src = (lines: string[], prototypes: Prototypes = {}, rs: [number, string, string][] = []) =>
  decompile('f', obj(lines), MIPS_GCC, { asmData: relocs(rs), prototypes: { k1: { params: 1 }, ...prototypes } })
    .source;
const lift =
  (...args: Parameters<typeof src>) =>
  () =>
    src(...args);

const WIDE = /may hand back a 64-bit value in v0:v1/;

// `long long f(int a, int b, int c, int d, long long e) { return e; }` at gcc2.7.2kmc
const RETURN_E = ['0:\tlw\tv0,16(sp)', '4:\tjr\tra', '8:\tlw\tv1,20(sp)'];

describe('a v1 written for the caller refuses', () => {
  test('a write nothing reads: `return e` for a 64-bit fifth argument', () => {
    expect(lift(RETURN_E)).toThrow(WIDE);
  });

  test('the carry of a 64-bit add: `return x + 5`', () => {
    expect(lift(['0:\taddiu\tv1,a1,5', '4:\tsltiu\tv0,v1,5', '8:\tjr\tra', 'c:\taddu\tv0,a0,v0'])).toThrow(WIDE);
  });

  test('the carry against a register addend: `return x + a`', () => {
    expect(
      lift([
        '0:\tsra\tv0,a0,0x1f',
        '4:\taddu\tv1,a3,a0',
        '8:\tsltu\tt6,v1,a0',
        'c:\taddu\tv0,a2,v0',
        '10:\tjr\tra',
        '14:\taddu\tv0,v0,t6',
      ]),
    ).toThrow(WIDE);
  });

  test('a copy whose source still holds it where it is read: `*p = x; return x`', () => {
    expect(lift(['0:\tmove\tv0,a2', '4:\tmove\tv1,a3', '8:\tsw\tv0,0(a0)', 'c:\tjr\tra', '10:\tsw\tv1,4(a0)'])).toThrow(
      WIDE,
    );
  });

  test('a declaration of a 64-bit return does not clear it', () => {
    expect(lift(RETURN_E, { f: { params: 6, returns: 's64' } })).toThrow(WIDE);
  });
});

describe('a v1 written as scratch lifts', () => {
  test("the function's own word-wide declaration clears a write nothing reads", () => {
    expect(src(RETURN_E, { f: { params: 6, returns: 's32' } })).toContain('return a4;');
  });

  test('a bound check compares the sum against something else', () => {
    // `char *q = p + n; if (q > end) return 0; return q;` shape: linearAlloc at gcc2.7.2kmc
    expect(
      lift([
        '0:\taddu\tv1,a0,a1',
        '4:\tsltu\tv0,a2,v1',
        '8:\tbnez\tv0,14 <f+0x14>',
        'c:\tmove\tv0,zero',
        '10:\tmove\tv0,v1',
        '14:\tjr\tra',
        '18:\tnop',
      ]),
    ).not.toThrow();
  });

  test("a loop's induction update is read round the back edge", () => {
    expect(
      lift([
        '0:\tmove\tv1,zero',
        '4:\tsw\ta1,0(a0)',
        '8:\taddiu\tv1,v1,1',
        'c:\tslti\tv0,v1,4',
        '10:\tbnez\tv0,4 <f+0x4>',
        '14:\taddiu\ta0,a0,4',
        '18:\tjr\tra',
        '1c:\tnop',
      ]),
    ).not.toThrow();
  });

  test('a copy read past a join is where the arms coalesce', () => {
    // func_8002B4B8_2C0B8 (snowboardkids2, gcc2.7.2kmc)
    expect(
      lift([
        '0:\tslti\tv0,a1,0x1001',
        '4:\tbnez\tv0,10 <f+0x10>',
        '8:\taddu\tv1,a1,zero',
        'c:\tori\tv1,a1,0xe000',
        '10:\tsll\tv0,v1,16',
        '14:\tjr\tra',
        '18:\tsra\tv0,v0,16',
      ]),
    ).not.toThrow();
  });

  test("a call destroys v1, so its delay slot's write is no return value", () => {
    expect(
      src(
        [
          '0:\taddiu\tsp,sp,-24',
          '4:\tsw\tra,16(sp)',
          '8:\tjal\t0 <f>',
          'c:\tmove\tv1,a0',
          '10:\tlw\tra,16(sp)',
          '14:\tjr\tra',
          '18:\taddiu\tsp,sp,24',
        ],
        {},
        [[8, 'R_MIPS_26', 'k1']],
      ),
    ).toContain('return k1(');
  });
});
