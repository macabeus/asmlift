// A FUNCTION DECLARED TO RETURN A 64-BIT INTEGER (pipeline.ts `refuseNarrowReturnsOfWideDeclaration`):
// a lift that returns one word refuses, on every frontend. The declaration is the only witness —
// `long long d64(long long *p) { long long x = *p; p[1] = x; return x; }` never reads the pair's
// second register back, so its asm is the `s32` function's — and a one-word lift prints
// `s32 d64(s32 *a0)` against the project's own `long long d64(long long *p)`, which the compiler
// rejects as conflicting types. A frontend that builds the pair (Thumb's `__muldi3` return) still
// lifts. Asm compiled at canonical flags.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { TOOLCHAIN_TARGETS } from '../src/target';

const WIDE = /its declaration returns a 64-bit integer, which comes back as the halves of a 64-bit pair/;
const D64: Prototypes = { d64: { params: ['long long *'], returns: 'long long' } };

const AGBCC_D64 = [
  '\t.code\t16',
  '.text',
  '\t.align\t2, 0',
  '\t.globl\td64',
  '\t.thumb_func',
  'd64:',
  '\tadd\tr2, r0, #0',
  '\tldr\tr0, [r2]',
  '\tldr\tr1, [r2, #0x4]',
  '\tstr\tr0, [r2, #0x8]',
  '\tstr\tr1, [r2, #0xc]',
  '\tbx\tlr',
  '',
].join('\n');

const objdump = (format: string, lines: string[]) =>
  `\nref.o:     file format ${format}\n\n\nDisassembly of section .text:\n\n00000000 <d64>:\n` +
  lines.map((l) => `   ${l}\n`).join('');

// gcc2.7.2kmc and gcc 2.7.2 alike
const GCC_D64 = objdump('elf32-tradbigmips', [
  '0:\tlw\tv0,0(a0)',
  '4:\tlw\tv1,4(a0)',
  '8:\tsw\tv0,8(a0)',
  'c:\tjr\tra',
  '10:\tsw\tv1,12(a0)',
]);

const MWCC_D64 = objdump('elf32-powerpc', [
  '0:\tlwz     r4,4(r3)',
  '4:\tlwz     r0,0(r3)',
  '8:\tstw     r4,12(r3)',
  'c:\tstw     r0,8(r3)',
  '10:\tmr      r3,r0',
  '14:\tblr',
]);

const lift = (asm: string, tc: keyof typeof TOOLCHAIN_TARGETS, prototypes: Prototypes) => () =>
  decompile('d64', asm, TOOLCHAIN_TARGETS[tc].description, { prototypes }).source;

describe('a declared 64-bit return refuses a one-word lift', () => {
  test.each([
    ['agbcc', AGBCC_D64],
    ['gcc2.7.2kmc', GCC_D64],
    ['mwcc_242_81', MWCC_D64],
  ] as const)('%s', (tc, asm) => {
    expect(lift(asm, tc, D64)).toThrow(WIDE);
  });

  test('undeclared, the same bytes lift as the s32 function they also are', () => {
    expect(lift(GCC_D64, 'gcc2.7.2kmc', {})()).toMatch(/^s32 d64\(s32 \*a0\)/m);
  });

  test('a declared word return is not asked', () => {
    expect(lift(GCC_D64, 'gcc2.7.2kmc', { d64: { params: ['s32 *'], returns: 's32' } })()).toMatch(/^s32 d64/m);
  });
});

describe('a lift that returns the pair passes', () => {
  // `long long m64(int a, int b) { return (long long)a * b; }` at agbcc: the `__muldi3` result in r0:r1
  const M64 = [
    '\t.code\t16',
    '.text',
    '\t.align\t2, 0',
    '\t.globl\tm64',
    '\t.thumb_func',
    'm64:',
    '\tpush\t{r4, r5, lr}',
    '\tadd\tr4, r0, #0',
    '\tadd\tr2, r1, #0',
    '\tasr\tr5, r4, #0x1f',
    '\tasr\tr3, r2, #0x1f',
    '\tadd\tr1, r5, #0',
    '\tadd\tr0, r4, #0',
    '\tbl\t__muldi3',
    '\tpop\t{r4, r5}',
    '\tpop\t{r2}',
    '\tbx\tr2',
    '',
  ].join('\n');

  test('agbcc', () => {
    const source = decompile('m64', M64, TOOLCHAIN_TARGETS.agbcc.description, {
      prototypes: { m64: { params: ['int', 'int'], returns: 'long long' } },
    }).source;
    expect(source).toMatch(/^s64 m64\(/m);
  });
});
