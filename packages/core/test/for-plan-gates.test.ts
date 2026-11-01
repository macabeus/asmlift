// UNIT tests for `forPlanAt`'s rule tables (structure.ts, THE LOOP AS A `for`): `FOR_PLAN_GATES`,
// and `FOR_PLAN_IV_GATES`. Each SOUND gate the suite does not already guard elsewhere is dropped
// here and the pass re-run on a fixture it refuses: the `for` then lifts and is
// wrong — the trace oracle (`irAgreement`) disagrees with the IR, a contract fails, or, where the
// oracle cannot judge (a division, a load from a parameter's address), the emitted C shows the op
// on a path the asm never ran it on. Every fixture is `for-derived-iv.test.ts`'s strength-reduced
// loop with one part changed, so the default structuring declines it with the loop-exit refusal;
// `/for-continue` (`spellCountedLoopsFor`) asks every loop's `for`. Each runs raise's derived-param
// fold first, as the pipeline does, so its header carries the IV alone (the fold's own refusals are
// unpre.test.ts's).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { assertLocalsWritten } from '../src/contracts';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { type Gate, tallying, without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { recomputeDerivedParams } from '../src/raise/unpre';
import { FOR_PLAN_GATES, FOR_PLAN_IV_GATES, type StructureHooks, structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);

/** The hooks that drop gate `id` from whichever table holds it. */
const dropping = (id: string): StructureHooks => {
  const has = <C>(t: readonly Gate<C>[]) => t.some((g) => g.id === id);
  return has(FOR_PLAN_GATES)
    ? { forPlanGates: without(FOR_PLAN_GATES, id) }
    : { forPlanIvGates: without(FOR_PLAN_IV_GATES, id) };
};

const lift = (ir: string, hooks: StructureHooks = {}) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  recomputeDerivedParams(fn);
  const sfn = structure(fn, { spellCountedLoopsFor: true }, hooks);
  return { sfn, src: cBackend.emit(sfn), agreement: irAgreement(ir, sfn, SEEDS) };
};

const LOOP_EXIT = /leaves its switch for a loop exit/;

/** `for-derived-iv.test.ts`'s `srFor`: guard `hi < lo`, a pure preheader #16, the header's `(i, i +
 *  3)`, arms that `continue` to the latch #11 or call and leave to #12, the latch's `(i + 1, (i + 1)
 *  + 3)`, and a loop after the exit. */
const srFor = ({
  guard = '%4: u32 = icmp_slt %1, %0',
  entryDerived = '%2: s32 = add %0, %3',
  backDerived = '%38: s32 = add %36, %3',
  test = '%37: u32 = icmp_slt %1, %36',
  pre = '%80: s32 = const {value=1}',
} = {}) => `fn srfor {
^bb0(%0: s32, %1: s32):
  %3: s32 = const {value=3}
  ${entryDerived}
  ${guard}
  cond_br %4, ^bb12(), ^bb16()
^bb16():
  ${pre}
  br ^bb1(%0, %2)
^bb1(%5: s32, %6: s32):
  %7: s32 = call %6 {target="f"}
  %8: s32 = const {value=2}
  %9: u32 = icmp_sge %7, %8
  cond_br %9, ^bb11(), ^bb2()
^bb2():
  %10: s32 = call %6 {target="id"}
  switch_br %10, ^bb3(), ^bb5(), ^bb7(), ^bb7(), ^bb11(), ^bb11(), ^bb9(), ^bb11() {cases=[0;1;2;3;4;5;6]}
^bb3():
  %13: s32 = call %5 {target="u"}
  %14: s32 = const {value=1}
  %15: u32 = icmp_eq %13, %14
  cond_br %15, ^bb11(), ^bb7()
^bb5():
  %20: s32 = call %5 {target="v"}
  %21: s32 = const {value=3}
  %22: u32 = icmp_slt %20, %21
  cond_br %22, ^bb11(), ^bb6()
^bb6():
  %23: s32 = const {value=5}
  %24: s32 = call %23 {target="k"}
  br ^bb12()
^bb7():
  %25: s32 = call %5 {target="x"}
  %26: s32 = const {value=4}
  %27: u32 = icmp_sge %25, %26
  cond_br %27, ^bb11(), ^bb8()
^bb8():
  %28: s32 = call %80 {target="set"}
  %30: s32 = call %5 {target="k"}
  br ^bb12()
^bb9():
  %31: s32 = call %5 {target="x"}
  %32: s32 = const {value=0}
  %33: u32 = icmp_slt %31, %32
  cond_br %33, ^bb11(), ^bb10()
^bb10():
  %34: s32 = call %5 {target="k"}
  br ^bb12()
^bb11():
  %35: s32 = const {value=1}
  %36: s32 = add %5, %35
  ${backDerived}
  ${test}
  cond_br %37, ^bb12(), ^bb1(%36, %38)
^bb12():
  %70: s32 = const {value=0}
  br ^bb13(%70)
^bb13(%71: s32):
  %72: s32 = call %71 {target="post"}
  %73: s32 = const {value=1}
  %74: s32 = add %71, %73
  %75: u32 = icmp_slt %74, %1
  cond_br %75, ^bb13(%74), ^bb14()
^bb14():
  ret
}`;

/** The full tables decline `ir` with the loop-exit refusal, and dropping `id` lifts it. */
const refusedOnlyBy = (id: string, ir: string) => {
  expect(() => lift(ir)).toThrow(LOOP_EXIT);
  return lift(ir, dropping(id));
};

test('without preheader-params the value the guard hands the preheader is read unset', () => {
  // the guard hands the preheader `hi + 1`, which the `for`'s statements ahead of it never write
  const ir = srFor({ pre: '' })
    .replace(
      'cond_br %4, ^bb12(), ^bb16()',
      '%95: s32 = const {value=1}\n  %96: s32 = add %1, %95\n  cond_br %4, ^bb12(), ^bb16(%96)',
    )
    .replace('^bb16():', '^bb16(%80: s32):');
  const r = refusedOnlyBy('preheader-params', ir);
  // the trace oracle reads an unset local as matching anything, so the contract is the witness
  expect(() => assertLocalsWritten(r.sfn)).toThrow(/read but never assigned/);
});

test('without preheader-traps a division runs ahead of the loop the guard skipped', () => {
  // `hi / lo` in the preheader: the `for` runs it ahead of its first test, so also where `hi < lo`
  // skipped the loop (lo == 0 there divides by zero). The oracle skips a trapping seed, so the C is
  // the witness.
  const r = refusedOnlyBy('preheader-traps', srFor({ pre: '%80: s32 = sdiv %1, %0' }));
  expect(r.src).toMatch(/= a1 \/ a0;\n\s*for \(/);
});

/** `ir` (an `srFor`) with an exit that takes one param: the guard hands it `entry` (a value of bb0;
 *  none where the loop has no guard), every arm `i`, and the latch `latchArg`; the code after the
 *  loop calls `exitv` on it. */
const withExitParam = (ir: string, entry: string | null, latchArg: string) =>
  (entry === null ? ir : ir.replace('cond_br %4, ^bb12(), ^bb16()', `cond_br %4, ^bb12(${entry}), ^bb16()`))
    .replace(/br \^bb12\(\)/g, 'br ^bb12(%5)')
    .replace('cond_br %37, ^bb12(), ^bb1(%36, %38)', `cond_br %37, ^bb12(${latchArg}), ^bb1(%36, %38)`)
    .replace(
      '^bb12():\n  %70: s32 = const {value=0}',
      '^bb12(%60: s32):\n  %61: s32 = call %60 {target="exitv"}\n  %70: s32 = const {value=0}',
    );

test('without exit-copy the value the test edges hand the exit is never written', () => {
  // the guard hands the exit 7 and the latch `i + 1`: the `for` leaves by its test, and neither
  // edge's copy is one its init or update makes
  const ir = withExitParam(srFor({ guard: '%90: s32 = const {value=7}\n  %4: u32 = icmp_slt %1, %0' }), '%90', '%36');
  expect(refusedOnlyBy('exit-copy', ir).agreement.disagree).toBeGreaterThan(0);
});

test('without exit-name-rewritten the exit reads the IV past its update', () => {
  // `for (i = 0; i < 40; i++) { last = i; .. } exitv(last);` with no guard (the first test folds):
  // every edge hands the exit `i`, under the IV's name, and the latch hands it from before the
  // update, which the `for` runs ahead of its test
  const guardless = srFor({
    guard: '%39: s32 = const {value=40}\n  %80: s32 = const {value=1}',
    entryDerived: '%91: s32 = const {value=0}\n  %2: s32 = add %91, %3',
    test: '%37: u32 = icmp_slt %39, %36',
  }).replace(
    'cond_br %4, ^bb12(), ^bb16()\n^bb16():\n  %80: s32 = const {value=1}\n  br ^bb1(%0, %2)',
    'br ^bb1(%91, %2)',
  );
  expect(guardless).not.toContain('bb16');
  const r = refusedOnlyBy('exit-name-rewritten', withExitParam(guardless, null, '%5'));
  expect(r.agreement.disagree).toBeGreaterThan(0);
});

test('without latch-effect a call in the latch never runs', () => {
  const ir = srFor().replace(
    '%35: s32 = const {value=1}\n',
    '%35: s32 = const {value=1}\n  %39: s32 = call %5 {target="tick"}\n',
  );
  expect(refusedOnlyBy('latch-effect', ir).agreement.disagree).toBeGreaterThan(0);
});

test('without test-reads-update the test reads the updated IV where the asm read the old', () => {
  // the latch tests `hi < i`, the IV before its update: the `for` tests after it
  const r = refusedOnlyBy('test-reads-update', srFor({ test: '%37: u32 = icmp_slt %1, %5' }));
  expect(r.agreement.disagree).toBeGreaterThan(0);
});

test('without entry-test-differs a guard other than the test is dropped', () => {
  // the guard `hi < lo + 3` is not the test `hi < i + 1` on the entry values
  const r = refusedOnlyBy('entry-test-differs', srFor({ guard: '%4: u32 = icmp_slt %1, %2' }));
  expect(r.agreement.disagree).toBeGreaterThan(0);
});

test('the heuristic and defensive rules admit nothing wrong when dropped on these fixtures', () => {
  // `latch-params`: the latch's param is read by its update and so by the test of the updated IV,
  // which `test-reads-body` refuses first
  const lp = srFor()
    .replace('^bb11():', '^bb11(%50: s32):')
    .replace(/\^bb11\(\)/g, '^bb11(%5)')
    .replace('%36: s32 = add %5, %35', '%36: s32 = add %50, %35');
  const tally = tallying(without(FOR_PLAN_GATES, 'latch-params'));
  expect(() => lift(lp, { forPlanGates: tally.gates })).toThrow(LOOP_EXIT);
  expect(tally.refusals().map(([id]) => id)).toContain('test-reads-body');
  // `test-reads-body`: a test that reads the header's call `f(i)` has no value on entry, so the guard
  // is not that test there and `entry-test-differs` refuses it
  const tb = srFor({ test: '%37: u32 = icmp_slt %1, %7' }).replace(
    '%7: s32 = call %6 {target="f"}',
    '%7: s32 = call %5 {target="f"}',
  );
  const iv = tallying(FOR_PLAN_IV_GATES);
  expect(() =>
    lift(tb, { forPlanGates: without(FOR_PLAN_GATES, 'test-reads-body'), forPlanIvGates: iv.gates }),
  ).toThrow(LOOP_EXIT);
  expect(iv.refusals().map(([id]) => id)).toContain('entry-test-differs');
});
