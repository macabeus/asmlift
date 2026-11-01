// THE LOOP AS A `for` (structure.ts `forPlanAt`) whose exit takes params. A `break` writes its own
// edge's copies ahead of it, as `while (1)`'s does; the two edges the `for`'s test leaves by — the
// guard's, through agbcc's `b .L4 @long jump` relay where the exit is out of a Thumb branch's range,
// and the latch's — are never rendered, so the `for` is read only where each hands the exit what the
// `for` already left in the param's name (`exit-copy`, `exit-name-rewritten`); past a loop with no
// guard, the code may not read the IV itself (`past-reads-iv`). Every fixture is
// for-continue.test.ts's `forJt` (`synthetic:sw_forjt:agbcc`'s shape with its loads as calls) with
// an exit that takes params, judged against its own IR by the trace oracle (`irAgreement`), as
// `structure()` returns it and as it ships after `readabilityRewrites`.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { tallying, without } from '../src/l3/gates';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { FOR_PLAN_IV_GATES, type StructureHooks, structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

const judged = (ir: string, hooks: StructureHooks = {}) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, {}, hooks);
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

const agrees = (r: ReturnType<typeof judged>): void => {
  expect(r.agreement.disagree).toBe(0);
  expect(r.shipped.disagree).toBe(0);
  expect(r.agreement.judged).toBe(SEEDS.length);
};

/** `forJt` with an exit that takes `exitParams`: `guardTo` is the guard's exit edge (or the relay's
 *  block), each arm that leaves the loop hands the exit `arm(n)`, the latch hands it `latchArgs`, and
 *  the code after the loop calls `k` on each param before the loop that follows. */
const forExit = ({
  consts = '',
  guardExit = '^bb12()',
  relay = '',
  arm = (_n: number) => '',
  latchArgs = '',
  exitParams = '',
  exitCalls = '',
}: {
  consts?: string;
  guardExit?: string;
  relay?: string;
  arm?: (n: number) => string;
  latchArgs?: string;
  exitParams?: string;
  exitCalls?: string;
} = {}) => `fn forexit {
^bb0(%0: s32, %1: s32):
  ${consts}%4: u32 = icmp_slt %1, %0
  cond_br %4, ${guardExit}, ^bb1(%0)
${relay}^bb1(%5: s32):
  %7: s32 = call %5 {target="f"}
  %8: s32 = const {value=2}
  %9: u32 = icmp_sge %7, %8
  cond_br %9, ^bb11(), ^bb2()
^bb2():
  %10: s32 = call %5 {target="id"}
  switch_br %10, ^bb3(), ^bb5(), ^bb7(), ^bb7(), ^bb11(), ^bb11(), ^bb9(), ^bb11() {cases=[0;1;2;3;4;5;6]}
^bb3():
  %13: s32 = call %5 {target="u"}
  %14: s32 = const {value=1}
  %15: u32 = icmp_eq %13, %14
  cond_br %15, ^bb11(), ^bb4()
^bb4():
  %16: s32 = const {value=4}
  %17: s32 = call %16 {target="k"}
  br ^bb12(${arm(4)})
^bb5():
  %20: s32 = call %5 {target="v"}
  %21: s32 = const {value=3}
  %22: u32 = icmp_slt %20, %21
  cond_br %22, ^bb11(), ^bb6()
^bb6():
  %23: s32 = const {value=5}
  %24: s32 = call %23 {target="k"}
  br ^bb12(${arm(6)})
^bb7():
  %25: s32 = call %5 {target="x"}
  %26: s32 = const {value=4}
  %27: u32 = icmp_sge %25, %26
  cond_br %27, ^bb11(), ^bb8()
^bb8():
  %29: s32 = const {value=1}
  %28: s32 = call %29 {target="set"}
  %30: s32 = call %5 {target="k"}
  br ^bb12(${arm(8)})
^bb9():
  %31: s32 = call %5 {target="x"}
  %32: s32 = const {value=0}
  %33: u32 = icmp_slt %31, %32
  cond_br %33, ^bb11(), ^bb10()
^bb10():
  %34: s32 = call %5 {target="k"}
  br ^bb12(${arm(10)})
^bb11():
  %35: s32 = const {value=1}
  %36: s32 = add %5, %35
  %37: u32 = icmp_slt %1, %36
  cond_br %37, ^bb12(${latchArgs}), ^bb1(%36)
^bb12(${exitParams}):
  ${exitCalls}%70: s32 = const {value=0}
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

/** `s32 a = 0, b = 1; for (..) { .. case 0: .. k(4); a = 1; b = 0; break; .. } k(a); k(b);`, the
 *  flags `sub_0800D188`'s loop exit takes: constants from ahead of the loop on every edge but one
 *  arm's. */
const flags = (guardExit: (args: string) => string, relay = '') =>
  forExit({
    consts: '%40: s32 = const {value=0}\n  %41: s32 = const {value=1}\n  ',
    guardExit: guardExit('%40, %41'),
    relay,
    arm: (n) => (n === 4 ? '%41, %40' : '%40, %41'),
    latchArgs: '%40, %41',
    exitParams: '%60: s32, %61: s32',
    exitCalls: '%62: s32 = call %60 {target="k"}\n  %63: s32 = call %61 {target="k"}\n  ',
  });

test('flags set ahead of the loop and rewritten in an arm lift as a `for` past which they are read', () => {
  const r = judged(flags((a) => `^bb12(${a})`));
  expect(r.src).toMatch(/for \(v\d+ = a0; a1 >= v\d+; v\d+ = v\d+ \+ 1\) \{/);
  expect(r.src).not.toContain('while (1)');
  agrees(r);
});

test('the flags lift the same where the guard reaches the exit through a relay that carries them', () => {
  // agbcc's `ble .LCB; b .L4 @long jump`: the relay's `br` is the guard's edge, args and all
  const r = judged(flags(() => '^bb15()', `^bb15():\n  br ^bb12(%40, %41)\n`));
  expect(r.src).toMatch(/for \(v\d+ = a0; a1 >= v\d+; v\d+ = v\d+ \+ 1\) \{/);
  expect(r.src).not.toContain('while (1)');
  agrees(r);
});

test('a guard edge handing the exit a value no other edge does refuses the `for`', () => {
  // the guard hands `a` 7 where the latch hands 0: the zero-trip path would need a copy the `for`
  // has nowhere to run
  const ir = flags((a) => `^bb12(${a})`)
    .replace('%41: s32 = const {value=1}\n', '%41: s32 = const {value=1}\n  %42: s32 = const {value=7}\n')
    .replace('cond_br %4, ^bb12(%40, %41)', 'cond_br %4, ^bb12(%42, %41)');
  const r = judged(ir);
  expect(r.src).not.toContain('for (');
  expect(r.src).toContain('while (1)');
  agrees(r);
});

test('an exit read as the IV from before its update refuses the `for`', () => {
  // `last = -1; for (i = lo; ..) { last = i; .. } k(last);`: the latch hands the exit `i` from before
  // the update the `for` runs ahead of its test, and the guard hands it `-1`
  const ir = forExit({
    consts: '%40: s32 = const {value=-1}\n  ',
    guardExit: '^bb12(%40)',
    arm: () => '%5',
    latchArgs: '%5',
    exitParams: '%60: s32',
    exitCalls: '%62: s32 = call %60 {target="k"}\n  ',
  });
  const r = judged(ir);
  expect(r.src).not.toContain('for (');
  expect(r.src).toContain('while (1)');
  agrees(r);
});

/** `for (i = 0; i < 2; i++) { last = i; .. } k(last);` with no guard, its first test folded: the
 *  header dominates the code after the loop, which reads `i` itself — from before the update on the
 *  latch's way out, where the `for` has run it. The header's test always continues, so the latch's
 *  way out is the one every seed takes. The exit takes no params. */
const guardlessReadsIv = () => {
  const ir = forExit({ exitCalls: '%62: s32 = call %5 {target="k"}\n  ' })
    .replace('%4: u32 = icmp_slt %1, %0\n  cond_br %4, ^bb12(), ^bb1(%0)', '%2: s32 = const {value=0}\n  br ^bb1(%2)')
    .replace('%8: s32 = const {value=2}', '%8: s32 = const {value=-2147483648}')
    .replace('%37: u32 = icmp_slt %1, %36', '%38: s32 = const {value=2}\n  %37: u32 = icmp_sge %36, %38');
  expect(ir).toContain('br ^bb1(%2)');
  return ir;
};

test('a read of the IV past a loop with no guard refuses the `for`', () => {
  const tally = tallying(FOR_PLAN_IV_GATES);
  const r = judged(guardlessReadsIv(), { forPlanIvGates: tally.gates });
  expect(r.src).not.toContain('for (');
  expect(r.src).toContain('while (1)');
  expect(tally.refusals().map(([id]) => id)).toContain('past-reads-iv');
  agrees(r);
});

test('without past-reads-iv the code past a guardless loop reads the IV past its update', () => {
  const r = judged(guardlessReadsIv(), { forPlanIvGates: without(FOR_PLAN_IV_GATES, 'past-reads-iv') });
  expect(r.src).toMatch(/for \((v\d+) = 0; \1 < 2; \1 = \1 \+ 1\) \{/);
  expect(r.agreement.disagree).toBeGreaterThan(0);
});
