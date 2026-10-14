// A LOOP TEST THE COMPILER PEELED INTO THE ENTRY (raise/reroll.ts `rerollPeeledTests`).
//
// agbcc rotates `for (i = 0; i < n; i++) { if (p[i] == 7) { hit(); break; } } out();` so the loop is
// entered at its increment, and tests p[0] in the entry block. The arm then has a predecessor outside
// the loop, and no loop spelling owns it (`synthetic:break_code:agbcc`). The entry's test is the
// loop's first iteration; rotated back, the test block heads the loop and the arm has one way in.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { rerollPeeledTests } from '../src/raise/reroll';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const PEELED = `fn peeled {
^bb0(%0: u8*, %1: s32):
  %2: s32 = const {value=0}
  %3: s32 = load %0 {off=0, signed=false, width=1}
  %4: s32 = const {value=7}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb3(), ^bb1(%2)
^bb1(%6: s32):
  %7: s32 = const {value=1}
  %8: s32 = add %6, %7
  %9: u32 = icmp_slt %8, %1
  cond_br %9, ^bb2(), ^bb4()
^bb2():
  %10: u8* = add %8, %0
  %11: s32 = load %10 {off=0, signed=false, width=1}
  %12: u32 = icmp_eq %11, %4
  cond_br %12, ^bb3(), ^bb1(%8)
^bb3():
  %13: s32 = call %1 {target="hit"}
  br ^bb4()
^bb4():
  %14: s32 = call {target="out"}
  ret %14
}`;

const rerolled = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const n = rerollPeeledTests(fn);
  verify(fn);
  return { n, fn };
};

test('an entry test that is the loop’s own at its first values is the first iteration', () => {
  const { n, fn } = rerolled(PEELED);
  expect(n).toBe(1);
  const sfn = structure(fn);
  const src = cBackend.emit(sfn);
  expect(src.match(/hit\(/g)).toHaveLength(1);
  expect(src.match(/\*a0|a0\[/g)).toHaveLength(1); // the test is written once, in the loop
});

/** The same rotation over a test the trace oracle models (it has no loads or multiplies): `if (i + i == a1)`. */
const PEELED_ARITH = PEELED.replace('%3: s32 = load %0 {off=0, signed=false, width=1}', '%3: s32 = add %2, %2')
  .replace('%4: s32 = const {value=7}', '%4: s32 = add %1, %2')
  .replace('%10: u8* = add %8, %0', '%10: s32 = add %8, %2')
  .replace('%11: s32 = load %10 {off=0, signed=false, width=1}', '%11: s32 = add %10, %8');

test('the rotated loop computes what the peeled one does', () => {
  const { n, fn } = rerolled(PEELED_ARITH);
  expect(n).toBe(1);
  const sfn = structure(fn);
  expect(cBackend.emit(sfn).match(/hit\(/g)).toHaveLength(1);
  expect(irAgreement(PEELED_ARITH, sfn, SEEDS)).toEqual({ judged: 300, disagree: 0 });
  expect(irAgreement(PEELED_ARITH, readabilityRewrites(sfn), SEEDS)).toEqual({ judged: 300, disagree: 0 });
});

test('an entry test that differs from the loop’s at its first values is left alone', () => {
  // the entry compares with 8, the loop with 7
  const other = PEELED.replace(
    '  %5: u32 = icmp_eq %3, %4\n',
    '  %20: s32 = const {value=8}\n  %5: u32 = icmp_eq %3, %20\n',
  );
  expect(rerolled(other).n).toBe(0);
  // …and so is one reading another element: the entry tests p[1], which is not the first iteration's
  expect(rerolled(PEELED.replace('%3: s32 = load %0 {off=0,', '%3: s32 = load %0 {off=1,')).n).toBe(0);
});

test('an entry that writes memory after its test reads it is left alone', () => {
  const writes = PEELED.replace(
    '  %4: s32 = const {value=7}\n',
    '  %4: s32 = const {value=7}\n  store %0, %4 {off=0, width=1}\n',
  );
  expect(rerolled(writes).n).toBe(0);
});

test('a test that calls is left alone — the entry’s call would run as well', () => {
  const calls = PEELED.replace(
    '%3: s32 = load %0 {off=0, signed=false, width=1}',
    '%3: s32 = call %2 {target="t"}',
  ).replace('%11: s32 = load %10 {off=0, signed=false, width=1}', '%11: s32 = call %8 {target="t"}');
  expect(rerolled(calls).n).toBe(0);
});
