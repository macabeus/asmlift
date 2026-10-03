// The MIPS frame's SAVES (frontend/mips.ts): a word store of `ra`, or of a register the O32 callee
// must preserve, while it still holds what the caller left there. The word holds the caller's
// value, which no C value names, so the store mints no parameter, the reload into the same
// register writes nothing a read may use, and every other use of the word refuses.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (...lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

const src = (...lines: string[]) => decompile('f', obj(...lines), MIPS_IDO).source;
const lift =
  (...lines: string[]) =>
  () =>
    src(...lines);

test('a saved s0 is no parameter: `f(a) { s = a + 1; return s + s; }` takes one argument', () => {
  expect(
    src(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\taddiu\ts0,a0,1',
      'c:\taddu\tv0,s0,s0',
      '10:\tlw\ts0,4(sp)',
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,8',
    ),
  ).toMatch(/^s32 f\(s32 a0\) \{/);
});

test('a saved ra is no parameter either', () => {
  expect(
    decompile(
      'f',
      obj(
        '0:\taddiu\tsp,sp,-24',
        '4:\tsw\tra,20(sp)',
        '8:\taddiu\tv0,a0,1',
        'c:\tlw\tra,20(sp)',
        '10:\tjr\tra',
        '14:\taddiu\tsp,sp,24',
      ),
      MIPS_GCC,
    ).source,
  ).toMatch(/^s32 f\(s32 a0\) \{/);
});

test('a read of the register its restore wrote refuses: it holds the caller s0', () => {
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\taddiu\ts0,a0,1',
      'c:\tsw\ts0,0(a1)',
      '10:\tlw\ts0,4(sp)',
      '14:\taddu\tv0,s0,s0',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/s0 is read after the 'lw' at 0x10 restores the caller's s0 into it/);
});

test('a restored value that reaches a merge someone reads refuses at the end of the lift', () => {
  // The read at the join resolves to the block parameter, not to the restore, so only the check of
  // the finished function sees the caller's s0 flowing into it.
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\tbeqz\ta0,18 <f+0x18>',
      'c:\tmove\ts0,a1',
      '10:\tlw\ts0,4(sp)',
      '14:\tnop',
      '18:\tmove\tv0,s0',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/the caller's s0, which the 'lw' at 0x10 restores, reaches a value this function computes with/);
});

test('a save slot reloaded into another register refuses', () => {
  expect(
    lift('0:\taddiu\tsp,sp,-8', '4:\tsw\ts0,4(sp)', '8:\tlw\tv0,4(sp)', 'c:\tjr\tra', '10:\taddiu\tsp,sp,8'),
  ).toThrow(/reload of '4\(sp\)' into v0, a slot s0 was saved into/);
});

test('a value stored into a save slot refuses: the word is one kind for the whole function', () => {
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\tsw\ta0,4(sp)',
      'c:\tlw\tv0,4(sp)',
      '10:\tjr\tra',
      '14:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/'4\(sp\)' at 0x8 is a word this function both saves a register in and stores a value to/);
});

test('a save into a slot an earlier block stored a value to refuses the same way', () => {
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tbeqz\ta0,10 <f+0x10>',
      '8:\tsw\ta1,4(sp)',
      'c:\tsw\ts0,4(sp)',
      '10:\tlw\ts0,4(sp)',
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/'4\(sp\)' at 0xc is a word this function both saves a register in and stores a value to/);
});

test('a callee-saved register stored after it was written is a value, reloaded like any spill', () => {
  expect(
    src(
      '0:\taddiu\tsp,sp,-8',
      '4:\taddiu\ts0,a0,1',
      '8:\tsw\ts0,4(sp)',
      'c:\tlw\tv0,4(sp)',
      '10:\tjr\tra',
      '14:\taddiu\tsp,sp,8',
    ),
  ).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
});

test('a caller-saved t-register stored with nothing in it is no save, so reloading it elsewhere is no refusal', () => {
  // `t0` is not one the callee preserves, so the store says nothing about the caller: the word is
  // an ordinary value slot, and a save's cross-register refusal would be the wrong reading of it.
  expect(
    lift('0:\taddiu\tsp,sp,-8', '4:\tsw\tt0,4(sp)', '8:\tlw\tv0,4(sp)', 'c:\tjr\tra', '10:\taddiu\tsp,sp,8'),
  ).not.toThrow();
});
