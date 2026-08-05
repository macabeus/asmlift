// Signed division by 2^k in its BRANCHING form (raise/divpow2.ts). The pass deletes a block and
// retires a phi, so its whole safety story is its REFUSALS: every guard below is a way a
// superficially identical diamond means something else, and relaxing one silently changes a value
// rather than losing a fold. Driven end-to-end from MIPS asm for the shapes a compiler really
// emits, and at IR level for the escape hatches asm cannot easily express.
import { expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { dce } from '../src/pattern/engine';
import { decompile } from '../src/pipeline';
import { recognizeDivPow2 } from '../src/raise/divpow2';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

const mips = (body: string, target = MIPS_IDO) => decompile('f', `00000000 <f>:\n${body}`, target).source;

test('SPLIT: the shift duplicated into both arms (a filled delay slot) folds', () => {
  // IDO's `x / 2`: the `sra` sits in the delay slot, so it runs on BOTH paths.
  expect(
    mips(
      '   0:\tbgez\ta0,10 <f+0x10>\n   4:\tsra\tv0,a0,0x1\n   8:\taddiu\tat,a0,1\n   c:\tsra\tv0,at,0x1\n  10:\tjr\tra\n  14:\tnop\n',
    ),
  ).toBe('s32 f(s32 a0) {\n    return a0 / 2;\n}\n');
});

test('SUNK: the shift after the join folds, for k > 1 too', () => {
  // GCC's larger-k form: bias by 2^k - 1, then one shift after the merge.
  expect(
    mips(
      '   0:\tbgez\ta0,10 <f+0x10>\n   4:\tnop\n   8:\taddiu\ta0,a0,7\n   c:\tnop\n  10:\tsra\tv0,a0,0x3\n  14:\tjr\tra\n  18:\tnop\n',
      MIPS_GCC,
    ),
  ).toBe('s32 f(s32 a0) {\n    return a0 / 8;\n}\n');
});

// ── refusals: each is a value change, not a missed opportunity ───────────────────────────────
const diamond = (bias: number, shift: number, guard = 'icmp_sge', extra = '') =>
  `fn f {\n^bb0(%0: s32):\n  %1: s32 = const {value=0}\n  %2: u32 = ${guard} %0, %1\n` +
  `  cond_br %2, ^bb2(%0), ^bb1()\n^bb1():\n  %3: s32 = const {value=${bias}}\n` +
  `  %4: s32 = add %0, %3\n${extra}  br ^bb2(%4)\n` +
  `^bb2(%5: s32):\n  %6: s32 = shr_s %5 {imm=${shift}}\n  ret %6\n}\n`;
const folds = (ir: string) => {
  const fn = parse(ir);
  const changed = recognizeDivPow2(fn);
  if (changed) {
    dce(fn);
    verify(fn);
  }
  return changed ? print(fn) : null;
};

test('the canonical IR diamond folds — the control for every refusal below', () => {
  expect(folds(diamond(3, 2))).toContain('sdiv %0 {imm=4}');
});

test('the bias must be exactly 2^k - 1 for the SAME k the shift uses', () => {
  expect(folds(diamond(2, 2))).toBeNull(); // 2 ≠ 2^2 - 1: rounds differently
  expect(folds(diamond(7, 2))).toBeNull(); // bias for k=3 on a k=2 shift
  expect(folds(diamond(1, 2))).toBeNull();
});

test('the biased arm must be the NEGATIVE one — the inverted diamond is not a division', () => {
  // `x >= 0 ? x + 3 : x` biases exactly the wrong side; folding it would change the value.
  const inverted = diamond(3, 2).replace('cond_br %2, ^bb2(%0), ^bb1()', 'cond_br %2, ^bb1(), ^bb2(%0)');
  expect(folds(inverted)).toBeNull();
  expect(folds(diamond(3, 2, 'icmp_slt'))).toBeNull(); // same inversion via the compare
});

test('the guard must test the dividend against ZERO, with a signed compare', () => {
  expect(folds(diamond(3, 2).replace('const {value=0}', 'const {value=1}'))).toBeNull();
  expect(folds(diamond(3, 2, 'icmp_uge'))).toBeNull(); // unsigned: no negative side to correct
  expect(folds(diamond(3, 2, 'icmp_ne'))).toBeNull();
});

test('the bias arm must do NOTHING else — its whole block is deleted', () => {
  // an effectful op there would simply stop happening
  const withStore = diamond(3, 2, 'icmp_sge', '  store %0, %3 {off=0, width=4}\n');
  expect(folds(withStore)).toBeNull();
});

test('the merge phi must feed ONLY the shift — a block-arg use counts as a use', () => {
  // `(y >> 2) + y` where y is the biased value: the pass stops computing y, so a second consumer
  // would silently read the quotient in its place. Block args live in successors[].args, not in
  // operands — counting only operands let this through and produced `(x / 4) + (x / 4)`.
  const escapes =
    'fn f {\n^bb0(%0: s32):\n  %1: s32 = const {value=0}\n  %2: u32 = icmp_sge %0, %1\n' +
    '  cond_br %2, ^bb2(%0), ^bb1()\n^bb1():\n  %3: s32 = const {value=3}\n  %4: s32 = add %0, %3\n  br ^bb2(%4)\n' +
    '^bb2(%5: s32):\n  %6: s32 = shr_s %5 {imm=2}\n  br ^bb3(%5)\n^bb3(%7: s32):\n  %8: s32 = add %6, %7\n  ret %8\n}\n';
  expect(folds(escapes)).toBeNull();
});

test('neither end of the diamond may be the ENTRY block', () => {
  // An entry that is also a loop header shows two predecessors while really being a three-way join
  // (the implicit entry edge is invisible to a successor walk). Its params are the FUNCTION'S
  // parameters, so retiring one there hands back a signature with an argument missing — silent.
  const entryMerge =
    'fn f {\n^bb0(%0: s32):\n  %1: s32 = shr_s %0 {imm=1}\n  %2: s32 = const {value=0}\n' +
    '  %3: u32 = icmp_sge %1, %2\n  cond_br %3, ^bb0(%1), ^bb1()\n' +
    '^bb1():\n  %4: s32 = const {value=1}\n  %5: s32 = add %1, %4\n  br ^bb0(%5)\n}\n';
  expect(folds(entryMerge)).toBeNull();
});

test('a dividend that is ITSELF a shift still folds — SPLIT is tried, not assumed', () => {
  // `(a >> 2) / 4`: the direct arm being a `shr_s` does not make this the split form. Treating it
  // as split-with-a-broken-bias-arm used to abandon a perfectly good sunk diamond.
  const shiftedDividend =
    'fn f {\n^bb0(%0: s32):\n  %1: s32 = shr_s %0 {imm=2}\n  %2: s32 = const {value=0}\n' +
    '  %3: u32 = icmp_sge %1, %2\n  cond_br %3, ^bb2(%1), ^bb1()\n' +
    '^bb1():\n  %4: s32 = const {value=3}\n  %5: s32 = add %1, %4\n  br ^bb2(%5)\n' +
    '^bb2(%6: s32):\n  %7: s32 = shr_s %6 {imm=2}\n  ret %7\n}\n';
  expect(folds(shiftedDividend)).toContain('sdiv');
});
