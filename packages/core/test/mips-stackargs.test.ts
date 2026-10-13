// O32 INCOMING STACK ARGUMENTS (frontend/mips.ts `emitLoad`, `frameDepths`): argument word k >= 4
// sits at entry sp + 4k, above the caller's 16-byte home of a0..a3, so a word `lw` this function
// never writes, at or past entry + 16, reads `@sarg<k>` — a parameter, as on Thumb. Every other
// never-stored read keeps its refusal, and so does every shape whose depth is not one number.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

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

const src = (lines: string[], rs: [number, string, string][] = [], target = MIPS_IDO) =>
  decompile('f', obj(lines), target, { asmData: relocs(rs), prototypes: { k1: { params: 1 } } }).source;
const lift =
  (...args: Parameters<typeof src>) =>
  () =>
    src(...args);

describe('an incoming stack word is a parameter', () => {
  test('frameless: `return e + i` for nine int arguments reads 16(sp) and 32(sp)', () => {
    // in9e at ido7.1 / gcc2.7.2kmc / gcc2.7.2 alike
    expect(src(['0:\tlw\tv0,16(sp)', '4:\tlw\tt6,32(sp)', '8:\tjr\tra', 'c:\taddu\tv0,v0,t6'])).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8) {\n    return a4 + a8;\n}\n',
    );
  });

  test('framed: the pushed size comes off the offset, in every block the push dominates', () => {
    // in9 at gcc2.7.2kmc: `lw s0,40(sp)` is `e` and `lw a0,56(sp)`, past the branch, is `i`
    const out = src(
      [
        '0:\taddiu\tsp,sp,-24',
        '4:\tsw\ts0,16(sp)',
        '8:\tlw\ts0,40(sp)',
        'c:\tmove\tv0,a1',
        '10:\tbeqz\ta0,28 <f+0x28>',
        '14:\tsw\tra,20(sp)',
        '18:\tlw\ta0,56(sp)',
        '1c:\tjal\t0 <f>',
        '20:\tnop',
        '24:\taddu\tv0,v0,s0',
        '28:\tlw\tra,20(sp)',
        '2c:\tlw\ts0,16(sp)',
        '30:\tjr\tra',
        '34:\taddiu\tsp,sp,24',
      ],
      [[0x1c, 'R_MIPS_26', 'k1']],
      MIPS_GCC,
    );
    expect(out).toMatch(/^s32 f\(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8\)/);
    expect(out).toContain('k1(a8) + a4');
  });

  test('after the pop the block runs at the entry depth again', () => {
    expect(
      src(['0:\taddiu\tsp,sp,-8', '4:\tsw\ta0,8(sp)', '8:\taddiu\tsp,sp,8', 'c:\tjr\tra', '10:\tlw\tv0,16(sp)']),
    ).toBe('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    return a4;\n}\n');
  });
});

describe('every other never-stored read keeps its refusal', () => {
  const NEVER = /that was never stored/;

  test("a word of the caller's home of a0..a3 is no argument", () => {
    expect(lift(['0:\tlw\tv0,4(sp)', '4:\tjr\tra', '8:\tnop'])).toThrow(NEVER);
  });

  test('a word below the pushed size is an uninitialised local', () => {
    expect(lift(['0:\taddiu\tsp,sp,-24', '4:\tlw\tv0,8(sp)', '8:\tjr\tra', 'c:\taddiu\tsp,sp,24'])).toThrow(NEVER);
  });

  test('a stack parameter this function assigns to on one path is not the incoming value', () => {
    expect(
      lift(['0:\tbeqz\ta0,c <f+0xc>', '4:\tnop', '8:\tsw\ta1,16(sp)', 'c:\tlw\tv0,16(sp)', '10:\tjr\tra', '14:\tnop']),
    ).toThrow(/is read on a path that never stores it/);
  });

  test('a second push leaves the depth unproven', () => {
    expect(
      lift([
        '0:\taddiu\tsp,sp,-8',
        '4:\taddiu\tsp,sp,-8',
        '8:\tlw\tv0,32(sp)',
        'c:\taddiu\tsp,sp,16',
        '10:\tjr\tra',
        '14:\tnop',
      ]),
    ).toThrow(NEVER);
  });

  test('so does a push outside the entry block', () => {
    expect(
      lift([
        '0:\tbeqz\ta0,10 <f+0x10>',
        '4:\tnop',
        '8:\taddiu\tsp,sp,-8',
        'c:\taddiu\tsp,sp,8',
        '10:\tlw\tv0,16(sp)',
        '14:\tjr\tra',
        '18:\tnop',
      ]),
    ).toThrow(NEVER);
  });

  test('so does any other write to sp', () => {
    expect(lift(['0:\tmove\tsp,a1', '4:\tlw\tv0,16(sp)', '8:\tjr\tra', 'c:\tnop'])).toThrow(NEVER);
  });

  test('a sub-word incoming argument is not modelled: `short e` reads lh 18(sp)', () => {
    expect(lift(['0:\tlh\tv0,18(sp)', '4:\tjr\tra', '8:\taddu\tv0,v0,a0'])).toThrow(/stack pointer used as data/);
  });

  test('nor is a float argument beside a stack word', () => {
    expect(lift(['0:\tlw\tt6,16(sp)', '4:\tsw\tt6,0(a0)', '8:\tjr\tra', 'c:\tadd.s\t$f0,$f12,$f12'])).toThrow(
      /floating-point argument beside the incoming stack argument/,
    );
  });
});
