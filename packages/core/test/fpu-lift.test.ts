// Hardware floating point, lifted: the single-precision arithmetic, through the ABI's float homes
// (`TargetDescription.fpu`, frontend/fpu.ts). What still refuses, and by which message, is
// `fp-refusal.test.ts`'s; this file pins what now lifts and the refusals the homes themselves add.
//
// THE SHAPE THIS REPLACES is the ablation `docs/floating-point.md` §2 measures: the arithmetic
// decoded with no homes lifts `float fadd(float a, float b){ return a + b; }` as
// `void fadd(s32 a0, s32 a1) { return; }` — phantom integer parameters and a dead add. Every
// positive case below would be that, or a decline, without the homes. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO, type TargetDescription } from '../src/target';

const lift = (sym: string, asm: string, target: TargetDescription = MIPS_IDO) => decompile(sym, asm, target).source;
/** One objdump function under its symbol header, the shape the benchmark's targets carry. */
const objdump = (sym: string, body: string) => `00000000 <${sym}>:\n${body}`;
/** The Splat dialect, whose o32 ABI names (`$fa0`) are one register with objdump's numbers. */
const splat = (sym: string, lines: string[]) =>
  `glabel ${sym}\n${lines
    .map(
      (l, i) =>
        `/* ${(i * 4).toString(16).padStart(6, '0')} ${(0x80000000 + i * 4).toString(16).toUpperCase()} 00000000 */  ${l}`,
    )
    .join('\n')}\nendlabel ${sym}\n`;

// `pnpm bench target synthetic:fadd:<tc>`'s own listing: `float fadd(float a, float b){ return a + b; }`
// at IDO 7.1 `-mips2 -O2 -32` and KMC GCC `-O2 -mips3 -mfp32`, which print the same two instructions.
const FADD = objdump('fadd', '   0:\tjr\tra\n   4:\tadd.s\t$f0,$f12,$f14\n');

// Compiled with GCC_KMC_TOOLCHAIN's flags (`-O2 -mips3 -mabi=32 -mgp32 -mfp32 -G 0`) from
//   float sel(float a, float b, int c){ return c ? a : b; }
//   float pw(float a, int n){ float r = a; while (--n) r = r * a; return r; }
//   float neg2(float a, float b){ return -(a - b); }
//   float second(float a, float b){ return b; }
//   float poly(float x, float y){ return (x * x - y) / (x + y); }
// and disassembled `--no-show-raw-insn`. Each lift below recompiles through the same compiler to
// this listing instruction for instruction (checked by hand when the fixture was taken).
const KMC = `00000000 <sel>:
   0:\tbeqz\ta2,c <sel+0xc>
   4:\tmov.s\t$f0,$f14
   8:\tmov.s\t$f0,$f12
   c:\tjr\tra
  10:\tnop

00000014 <pw>:
  14:\taddiu\ta1,a1,-1
  18:\tbeqz\ta1,2c <pw+0x18>
  1c:\tmov.s\t$f0,$f12
  20:\taddiu\ta1,a1,-1
  24:\tbnez\ta1,20 <pw+0xc>
  28:\tmul.s\t$f0,$f0,$f12
  2c:\tjr\tra
  30:\tnop

00000034 <neg2>:
  34:\tsub.s\t$f0,$f12,$f14
  38:\tjr\tra
  3c:\tneg.s\t$f0,$f0

00000040 <second>:
  40:\tjr\tra
  44:\tmov.s\t$f0,$f14

00000048 <poly>:
  48:\tmul.s\t$f0,$f12,$f12
  4c:\tadd.s\t$f12,$f12,$f14
  50:\tsub.s\t$f0,$f0,$f14
  54:\tjr\tra
  58:\tdiv.s\t$f0,$f0,$f12
  5c:\tnop
`;

describe('MIPS o32: single-precision arithmetic through $f12/$f14 and $f0', () => {
  test.each([
    ['ido7.1', MIPS_IDO],
    ['gcc2.7.2kmc', MIPS_GCC],
  ])('the fadd row lifts to the program that compiled it (%s)', (_tc, target) => {
    const src = lift('fadd', FADD, target);
    expect(src).toBe('float fadd(float a0, float a1) {\n    return a0 + a1;\n}\n');
  });

  test('the Splat dialect names the same registers, so it lifts to the same program', () => {
    expect(lift('fadd', splat('fadd', ['jr          $ra', 'add.s       $fv0, $fa0, $fa1']))).toBe(lift('fadd', FADD));
  });

  test('operand order, negation and a nested expression', () => {
    expect(lift('neg2', KMC, MIPS_GCC)).toContain('return -(a0 - a1);');
    expect(lift('poly', KMC, MIPS_GCC)).toContain('return (a0 * a0 - a1) / (a0 + a1);');
  });

  // THE 'leading' SLOT RULE. The two floats take o32 slots 0 and 1, so the integer arrives in `a2`,
  // and ranking it by its own register is what puts it third rather than first.
  test('an integer argument after two floats is the third parameter', () => {
    const src = lift('sel', KMC, MIPS_GCC);
    expect(src).toContain('float sel(float a0, float a1, s32 a2)');
    expect(src).toContain('return a1;');
  });

  // A float carried round a loop is a phi of the FPU's file, typed a float where the SSA builder
  // mints it — recovery's s32 default would otherwise declare it an integer.
  test('a float carried round a loop is declared a float', () => {
    const src = lift('pw', KMC, MIPS_GCC);
    expect(src).toContain('float pw(float a0, s32 a1)');
    expect(src).toMatch(/float v\d;/);
    expect(src).toMatch(/v\d = v\d \* a0;/);
  });

  // `$f14` is the SECOND float argument whatever became of the first, so the first is a parameter
  // too: a one-parameter signature would hand the caller's `a` to `b`.
  test('an unread first float argument is still a parameter', () => {
    expect(lift('second', KMC, MIPS_GCC)).toBe('float second(float a0, float a1) {\n    return a1;\n}\n');
  });
});

describe('the refusals the homes add', () => {
  const mips = (lines: string[]) => lines.map((l, i) => `${(i * 4).toString(16)}:\t${l}`).join('\n') + '\n';

  // RULE 1. Nothing but an argument arrives in the FPU's file.
  test('a float register read before any write that is not an argument home refuses', () => {
    expect(() => lift('f', mips(['jr\tra', 'add.s\t$f0,$f4,$f12']))).toThrow(
      /\$f4 is read before this function writes it, and no floating-point argument arrives there/,
    );
  });

  // …which covers a return path that never writes `$f0`: the float return is the function's, so the
  // path that skips the write reads `$f0` before any write.
  test('a path that returns without writing the float return refuses', () => {
    const asm = mips(['beqz\ta1,c <f+0xc>', 'nop', 'add.s\t$f0,$f12,$f12', 'jr\tra', 'nop']);
    expect(() => lift('f', asm)).toThrow(/\$f0 is read before this function writes it/);
  });

  // RULE 3. A float argument takes the integer slot it shadows, so `a0` beside `$f12` is not a
  // layout the ABI produces.
  test.each([
    ['a0 beside $f12', ['sw\ta1,0(a0)', 'jr\tra', 'add.s\t$f0,$f12,$f12'], /a0 and \$f12 both carry argument 0/],
    ['a1 beside $f14', ['sw\ta2,0(a1)', 'jr\tra', 'add.s\t$f0,$f14,$f12'], /a1 and \$f14 both carry argument 1/],
  ])('%s refuses', (_label, lines, want) => {
    expect(() => lift('f', mips(lines))).toThrow(want);
  });

  // The odd half of a pair is a double's other word; a single-precision instruction naming one is
  // not something these compilers emit, and it keeps the register-file refusal.
  test('an odd register keeps the register-file refusal', () => {
    expect(() => lift('f', mips(['jr\tra', 'add.s\t$f0,$f13,$f12']))).toThrow(
      /unmodelled floating-point instruction 'add.s'/,
    );
  });

  test('a target that declares no float homes keeps the register-file refusal', () => {
    const noHomes: TargetDescription = { ...MIPS_IDO, fpu: undefined };
    expect(() => lift('fadd', FADD, noHomes)).toThrow(/unmodelled floating-point instruction 'add.s'/);
  });
});
