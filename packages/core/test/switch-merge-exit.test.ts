// AN EXIT TO AN ENCLOSING SWITCH'S MERGE FROM A SWITCH NESTED IN ONE OF ITS ARMS.
//
// A `goto` out of an arm of a switch nested in a case body, for the code after the outer switch,
// reaches the outer switch's merge from inside the inner one, where C binds a `break;` to the inner
// switch. structure.ts `switchMergeExit` writes `f = 1; break;` there, `f = 0;` ahead of the inner
// switch and a SWITCH-scoped `if (f != 0) break;` right after it, so the rest of the outer arm is
// skipped. The fixture is judged against its own IR by the trace oracle (`irAgreement`), as
// `structure()` returns it and as it ships after `readabilityRewrites`. The flag is asked only once every run without it declined
// (structure.ts `CaseExitRanking`), and the fixture declines without it.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement, irTraceOf } from './helpers';

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

const judged = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, {});
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

const alike = (r: { judged: number; disagree: number }, least = 1 / 2): void => {
  expect(r.disagree).toBe(0);
  expect(r.judged).toBeGreaterThan(SEEDS.length * least);
};

/** How many seeds run a call to `callee` in the IR's own trace. */
const ran = (ir: string, callee: string): number =>
  SEEDS.filter((seed) => {
    try {
      return irTraceOf(parse(ir), seed).some((e) => e.fn === callee);
    } catch {
      return false;
    }
  }).length;

/** agbcc -O2's synthetic:sw_gotocase_inner as the frontend hands it to structure, with each load a
 *  call the oracle can run: `for (i = lo; i <= hi; i++) { if (f(i) <= 26) { switch (id(i)) { case 1:
 *  switch (u(i)) { case 0: k(10); break; case 1: goto shared; … } continue; case 3: case 4: shared:
 *  if (x(i) > 20) continue; mark(1); k(i); break; … } break; } } for (j = 0; j < 3; j++) k(j);`. The inner switch's `goto shared;` runs the shared body (#8, #9), and #9 leaves for the
 *  outer switch's merge #15, the loop's exit, whose code holds a loop. */
const GOTOCASE_INNER = `fn gi {
^bb0(%0: s32, %1: s32):
  %4: u32 = icmp_slt %1, %0
  cond_br %4, ^bb15(), ^bb1(%0)
^bb1(%5: s32):
  %7: s32 = call %5 {target="f"}
  %8: s32 = const {value=26}
  %9: u32 = icmp_slt %8, %7
  cond_br %9, ^bb14(), ^bb2()
^bb2():
  %10: s32 = call %5 {target="id"}
  %11: s32 = const {value=1}
  %12: s32 = sub %10, %11
  switch_br %12, ^bb3(), ^bb10(), ^bb8(), ^bb8(), ^bb14(), ^bb14(), ^bb12(), ^bb14() {cases=[0;1;2;3;4;5;6]}
^bb3():
  %13: s32 = call %5 {target="u"}
  switch_br %13, ^bb4(), ^bb8(), ^bb5(), ^bb6(), ^bb7(), ^bb14() {cases=[0;1;2;3;4]}
^bb4():
  %14: s32 = const {value=10}
  %15: s32 = call %14 {target="k"}
  br ^bb14()
^bb5():
  %16: s32 = const {value=12}
  %17: s32 = call %16 {target="k"}
  br ^bb14()
^bb6():
  %18: s32 = const {value=13}
  %19: s32 = call %18 {target="k"}
  br ^bb14()
^bb7():
  %20: s32 = const {value=14}
  %21: s32 = call %20 {target="k"}
  br ^bb14()
^bb8():
  %22: s32 = call %5 {target="x"}
  %23: s32 = const {value=20}
  %24: u32 = icmp_slt %23, %22
  cond_br %24, ^bb14(), ^bb9()
^bb9():
  %25: s32 = const {value=1}
  %60: s32 = call %25 {target="mark"}
  %26: s32 = call %5 {target="k"}
  br ^bb15()
^bb10():
  %27: s32 = const {value=1}
  %28: s32 = add %5, %27
  %29: s32 = call %28 {target="v"}
  %30: s32 = const {value=0}
  %31: u32 = icmp_eq %29, %30
  cond_br %31, ^bb11(), ^bb14()
^bb11():
  %32: s32 = const {value=5}
  %33: s32 = call %32 {target="k"}
  br ^bb15()
^bb12():
  %34: s32 = call %5 {target="x"}
  %35: s32 = const {value=0}
  %36: u32 = icmp_slt %34, %35
  cond_br %36, ^bb14(), ^bb13()
^bb13():
  %37: s32 = call %5 {target="a"}
  %38: s32 = call %37 {target="k"}
  br ^bb15()
^bb14():
  %39: s32 = const {value=1}
  %40: s32 = add %5, %39
  %41: u32 = icmp_sge %1, %40
  cond_br %41, ^bb1(%40), ^bb15()
^bb15():
  %42: s32 = const {value=0}
  %43: s32 = call %42 {target="out"}
  %44: u32 = icmp_sge %42, %43
  cond_br %44, ^bb18(), ^bb17(%42)
^bb17(%46: s32):
  %50: s32 = call %46 {target="k"}
  %51: s32 = const {value=1}
  %52: s32 = add %46, %51
  %53: s32 = const {value=3}
  %54: u32 = icmp_slt %52, %53
  cond_br %54, ^bb17(%52), ^bb18()
^bb18():
  ret
}`;

test("an arm of a nested switch reaches the outer switch's merge through a switch-scoped flag", () => {
  const { src, agreement, shipped } = judged(GOTOCASE_INNER);
  const set = /mark\(1\);\n\s*k\(v\d+\);\n\s*(v\d+) = 1;\n\s*break;/.exec(src);
  expect(set).not.toBeNull();
  const flag = set![1];
  expect(src.match(/ = 1;\n\s*break;/g)).toHaveLength(1);
  expect(src).toMatch(new RegExp(`${flag} = 0;\\n\\s*switch \\(`));
  // the test after the inner switch leaves the outer one, which the loop's `break;` then follows
  expect(src).toMatch(new RegExp(`}\\n\\s*if \\(${flag} != 0\\) break;\\n\\s*break;`));
  expect(src).toMatch(new RegExp(`s32 ${flag};`));
  expect(src).not.toContain('goto');
  alike(agreement);
  alike(shipped);
  expect(ran(GOTOCASE_INNER, 'out')).toBeGreaterThan(SEEDS.length / 4);
});
