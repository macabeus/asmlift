// Hardware floating point, lifted: the single-precision arithmetic, through the ABI's float homes
// (`TargetDescription.fpu`, frontend/fpu.ts). What still refuses, and by which message, is
// `fp-refusal.test.ts`'s; this file pins what now lifts and the refusals the homes themselves add.
//
// THE SHAPE THIS REPLACES is the ablation `docs/floating-point.md` §2 measures: the arithmetic
// decoded with no homes lifts `float fadd(float a, float b){ return a + b; }` as
// `void fadd(s32 a0, s32 a1) { return; }` — phantom integer parameters and a dead add. Every
// positive case below would be that, or a decline, without the homes. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { writesFloatReturn } from '../src/frontend/fpu';
import { mipsEvenFpKey } from '../src/frontend/splat';
import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '../src/target';

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
    expect(lift('poly', KMC, MIPS_GCC)).toContain('v0 = a0 * a0;\n    return (v0 - a1) / (a0 + a1);');
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

// Compiled with the synthetic tier's mwcc_242_81 flags (`-proc gekko -O4,p -fp hard -lang=c`) from
// the same five functions as the KMC listing above, plus
//   float mixed(int *p, float b){ *p = 1; return b + b; }
// and each lift recompiles through that compiler to its function instruction for instruction —
// except `pw`, whose integer loop spells differently, which is not a float question.
const MWCC = `00000000 <sel>:
   0:\tcmpwi   r3,0
   4:\tbnelr
   8:\tfmr     f1,f2
   c:\tblr

00000010 <pw>:
  10:\tfmr     f0,f1
  14:\tb       1c <pw+0xc>
  18:\tfmuls   f0,f0,f1
  1c:\taddic.  r3,r3,-1
  20:\tbne     18 <pw+0x8>
  24:\tfmr     f1,f0
  28:\tblr

0000002c <neg2>:
  2c:\tfsubs   f0,f1,f2
  30:\tfneg    f1,f0
  34:\tblr

00000038 <second>:
  38:\tfmr     f1,f2
  3c:\tblr

00000040 <poly>:
  40:\tfmuls   f3,f1,f1
  44:\tfadds   f0,f1,f2
  48:\tfsubs   f1,f3,f2
  4c:\tfdivs   f1,f1,f0
  50:\tblr

00000054 <mixed>:
  54:\tli      r0,1
  58:\tfadds   f1,f1,f1
  5c:\tstw     r0,0(r3)
  60:\tblr
`;

describe('PowerPC EABI: single-precision arithmetic through f1..f8', () => {
  const ppc = (sym: string, body: string) => lift(sym, objdump(sym, body), PPC_MWCC);

  test('the fadd row lifts to the program that compiled it', () => {
    expect(ppc('fadd', '   0:\tfadds   f1,f1,f2\n   4:\tblr\n')).toBe(
      'float fadd(float a0, float a1) {\n    return a0 + a1;\n}\n',
    );
  });

  // `fmuls fD,fA,fC` names its second source third; a third float argument is f3.
  // A product that feeds a sum is NAMED: under mwcc `-fp_contract on` the inline `a2 + a0 * a1`
  // recompiles to one `fmadds`, which rounds once, while the temp gives this pair under either
  // setting (structure/analysis.ts). Both spellings compile to this row's object at its own flags.
  test('the fma1 row: a third float argument, and a product feeding a sum', () => {
    expect(ppc('fma1', '   0:\tfmuls   f0,f1,f2\n   4:\tfadds   f1,f3,f0\n   8:\tblr\n')).toBe(
      'float fma1(float a0, float a1, float a2) {\n    float v0;\n    v0 = a0 * a1;\n    return a2 + v0;\n}\n',
    );
  });

  // …on every path it reaches, and still once when it is also returned alone. Compiled with
  // `-fp_contract on` from
  //   float c3(float a, float b, float c, int k){ float t = a*b; if (k) return t; return t + c; }
  test('a product read by a sum and returned alone is one named value', () => {
    const src = ppc(
      'c3',
      '  24:\tcmpwi   r3,0\n  28:\tfmuls   f1,f1,f2\n  2c:\tbnelr\n  30:\tfadds   f1,f1,f3\n  34:\tblr\n',
    );
    expect(src).toContain('v0 = a1 * a2;');
    expect(src).toContain('return v0 + a3;');
    expect(src).toContain('return v0;');
  });

  // …and read through a negation. Compiled with `-fp_contract on` from
  //   float n1(float a, float b, float c){ float t = a * b; float u = -t; return u + c; }
  // the inline `-(a0 * a1) + a2` recompiles to one `fnmsubs`, the temp to this listing.
  test('a product read by a sum through a negation is named too', () => {
    expect(ppc('n1', '   0:\tfmuls   f0,f1,f2\n   4:\tfneg    f0,f0\n   8:\tfadds   f1,f0,f3\n   c:\tblr\n')).toBe(
      'float n1(float a0, float a1, float a2) {\n    float v0;\n    v0 = a0 * a1;\n    return -v0 + a2;\n}\n',
    );
  });

  test('negation, a nested expression, and an unread first float argument', () => {
    expect(lift('neg2', MWCC, PPC_MWCC)).toContain('return -(a0 - a1);');
    expect(lift('poly', MWCC, PPC_MWCC)).toContain('return (v0 - a1) / (a0 + a1);');
    expect(lift('second', MWCC, PPC_MWCC)).toBe('float second(float a0, float a1) {\n    return a1;\n}\n');
  });

  // f1 is both the first float argument and the float return, so the conditional return that leaves
  // it untouched returns `a`.
  test('a return path that leaves f1 alone returns the float argument that arrived there', () => {
    const src = lift('sel', MWCC, PPC_MWCC);
    expect(src).toContain('float sel(s32 a0, float a1, float a2)');
    expect(src).toContain('return a1;');
    expect(src).toContain('return a2;');
  });

  // THE 'separate' ORDER IS A SPELLING: `float mixed(int *p, float b)` and `float mixed(float b,
  // int *p)` are one object, so the integer argument is put first by choice, not by reading.
  test('integer arguments come first, then the floats', () => {
    expect(lift('mixed', MWCC, PPC_MWCC)).toContain('float mixed(s32 *a0, float a1)');
  });

  test('a float carried round a loop is declared a float', () => {
    const src = lift('pw', MWCC, PPC_MWCC);
    expect(src).toContain('float pw(s32 a0, float a1)');
    expect(src).toMatch(/float v\d;/);
  });

  test('a record form sets cr1, which is not modelled, and keeps the register-file refusal', () => {
    expect(() => ppc('f', '   0:\tfadds.  f1,f1,f2\n   4:\tblr\n')).toThrow(
      /unmodelled floating-point instruction 'fadds\.'/,
    );
  });

  // Which FPRs a callee reads, returns in and destroys is unmodelled, so a float and a call in one
  // function refuses — here `a * g2()` would otherwise read g2's return in f1 as the argument `a`.
  test('a function that computes on floats and makes a call refuses', () => {
    const body =
      '   0:\tfmr     f31,f1\n   4:\tbl      4 <f+0x4>\n\t\t\t4: R_PPC_REL24\tg2\n   8:\tfmuls   f1,f31,f1\n   c:\tblr\n';
    expect(() => ppc('f', body)).toThrow(/the floating-point registers a call reads, returns in and destroys/);
  });

  test('a float register read before any write that is not an argument home refuses', () => {
    expect(() => ppc('f', '   0:\tfadds   f1,f9,f1\n   4:\tblr\n')).toThrow(
      /f9 is read before this function writes it, and no floating-point argument arrives there/,
    );
  });

  // The float return is read off the blocks the entry reaches: a write to f1 past the `blr` is on
  // no path, and deciding by it would return f1 — argument 0's home — and drop `r3`.
  test('an unreachable write to f1 does not make the function return a float', () => {
    expect(ppc('f', '   0:\taddi    r3,r3,1\n   4:\tblr\n   8:\tfmr     f1,f2\n')).toBe(
      's32 f(s32 a0) {\n    return a0 + 1;\n}\n',
    );
  });
});

// ONE SLOT READING FOR BOTH FILES (frontend/fpu.ts `argSlots`, `settleArgSlots`). Compiled from
//   float hole4(float a, float b, int c, int d){ return d ? a : b; }
//   float hole2(float a, int b, int c){ return c ? a : -a; }
//   int gap(int a, int b, int c){ return a + c; }
// with GCC_KMC_TOOLCHAIN's flags and the synthetic tier's mwcc_242_81 flags. Each reads an argument
// register above one it never reads, and the unread slot is a parameter from the file the ABI puts
// it in: under o32 `'leading'` a slot above the highest float is an integer, under the EABI
// `'separate'` each file fills its own holes. Without the hole, every later argument binds one slot
// low and the program still compiles.
const KMC_SLOTS = `00000000 <hole4>:
   0:\tbeqz\ta3,c <hole4+0xc>
   4:\tmov.s\t$f0,$f14
   8:\tmov.s\t$f0,$f12
   c:\tjr\tra
  10:\tnop

00000014 <hole2>:
  14:\tbnez\ta2,20 <hole2+0xc>
  18:\tmov.s\t$f0,$f12
  1c:\tneg.s\t$f0,$f0
  20:\tjr\tra
  24:\tnop

0000003c <gap>:
  3c:\tjr\tra
  40:\taddu\tv0,a0,a2
`;
const MWCC_SLOTS = `00000000 <hole4>:
   0:\tcmpwi   r4,0
   4:\tbnelr
   8:\tfmr     f1,f2
   c:\tblr

00000010 <hole2>:
  10:\tcmpwi   r4,0
  14:\tbnelr
  18:\tfneg    f1,f1
  1c:\tblr

00000028 <gap>:
  28:\tadd     r3,r3,r5
  2c:\tblr
`;

describe('an unread argument keeps its slot, in the file the ABI puts it in', () => {
  test.each([
    [
      'o32: an integer hole above two floats',
      'hole4',
      KMC_SLOTS,
      MIPS_GCC,
      'float hole4(float a0, float a1, s32 a2, s32 a3)',
      'if (a3 != 0)',
    ],
    [
      'o32: an integer hole above one float',
      'hole2',
      KMC_SLOTS,
      MIPS_GCC,
      'float hole2(float a0, s32 a1, s32 a2)',
      'if (a2 == 0)',
    ],
    ['o32: an integer function', 'gap', KMC_SLOTS, MIPS_GCC, 's32 gap(s32 a0, s32 a1, s32 a2)', 'return a0 + a2;'],
    [
      'EABI: an integer hole beside two floats',
      'hole4',
      MWCC_SLOTS,
      PPC_MWCC,
      'float hole4(s32 a0, s32 a1, float a2, float a3)',
      'if (a1 == 0)',
    ],
    [
      'EABI: an integer hole beside one float',
      'hole2',
      MWCC_SLOTS,
      PPC_MWCC,
      'float hole2(s32 a0, s32 a1, float a2)',
      'return -a2;',
    ],
    ['EABI: an integer function', 'gap', MWCC_SLOTS, PPC_MWCC, 's32 gap(s32 a0, s32 a1, s32 a2)', 'return a0 + a2;'],
  ])('%s', (_label, sym, asm, target, signature, body) => {
    const src = lift(sym, asm, target);
    expect(src).toContain(signature);
    expect(src).toContain(body);
  });
});

// THE RETURN RULE IS SOUND ONLY WHILE A FLOAT CANNOT LEAVE THE FILE (frontend/fpu.ts
// `writesFloatReturn`). Compiled with GCC_KMC_TOOLCHAIN's flags from
//   int st3(float a, float b, float *p, float *q){ *p = a * b; *q = a + b; return 2; }
// it writes `$f0` and returns `v0`. The `swc1` refusal is what stands between it and a float return
// that drops the `2`: a layer that decodes the store turns the second test red, and must decide
// the return from the value reaching each `ret` before it can land.
describe('the refusal the float return rule stands on', () => {
  const ST3 = objdump(
    'st3',
    '   0:\tmul.s\t$f0,$f12,$f14\n   4:\tadd.s\t$f12,$f12,$f14\n   8:\tli\tv0,2\n' +
      '   c:\tswc1\t$f0,0(a2)\n  10:\tjr\tra\n  14:\tswc1\t$f12,0(a3)\n',
  );

  test('the mnemonic scan reads an int-returning function as a float return', () => {
    const instrs = [
      { mnemonic: 'mul.s', ops: ['$f0', '$f12', '$f14'] },
      { mnemonic: 'add.s', ops: ['$f12', '$f12', '$f14'] },
    ];
    expect(writesFloatReturn(instrs, new Set(['mul.s', 'add.s']), mipsEvenFpKey, MIPS_GCC.fpu)).toBe(true);
  });

  test('and the float store refuses, so it does not lift', () => {
    expect(() => lift('st3', ST3, MIPS_GCC)).toThrow(/unmodelled floating-point instruction 'swc1'/);
  });
});
