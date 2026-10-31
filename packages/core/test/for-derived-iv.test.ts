// A STRENGTH-REDUCED COUNTED LOOP AS A `for` (structure.ts `forPlanAt`): gcc 2.7.2's layout of
// `for (i = lo; i <= hi; i++) { .. gE[i] .. switch (..) { .. } break; }`. The guard enters the loop
// through a pure preheader, the IV is the parameter itself (no init copy), the latch names `i + 1`
// because the back edge hands it round twice, and the header carries `i << 3` beside `i` (here `i + 3`,
// an op the trace oracle models). The `for`
// reads each only for a loop the rerun asks (`ForRanking`), so every fixture is a jump table whose
// `while (1)` reading declines. Each is judged against its own IR by the trace oracle
// (`irAgreement`), as `structure()` returns it and as it ships after `readabilityRewrites`. The `for`
// refuses a derived param whose two edges apply different ops or different constants, a preheader that
// reads memory, and a test that reads the derived param; each of those declines.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

const judged = (ir: string, opts: Parameters<typeof structure>[1] = {}) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, opts);
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

/** `synthetic:sw_gotocase2:gcc2.7.2`'s loop with its loads as calls: the guard `hi < lo` skips the
 *  loop or enters the preheader #16, which holds a constant the body reads and jumps to the header
 *  with `(lo, lo + 3)`. The header reads the derived `%6`, the arms each `continue` (an edge to the
 *  latch #11) or call and leave the loop (#12), and the latch hands back `(i + 1, (i + 1) + 3)`. A
 *  loop follows, so no arm can copy the code after the loop as an early `return`. */
const srFor = ({
  entryDerived = '%2: s32 = add %0, %3',
  backDerived = '%38: s32 = add %36, %3',
  test = '%37: u32 = icmp_slt %1, %36',
  pre = '%80: s32 = const {value=1}',
} = {}) => `fn srfor {
^bb0(%0: s32, %1: s32):
  %3: s32 = const {value=3}
  %4: u32 = icmp_slt %1, %0
  ${entryDerived}
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

test('a strength-reduced counted loop entered through a preheader lifts as a `for`', () => {
  const r = judged(srFor());
  // the update copies only the IV, and the body opens with the derived param
  expect(r.src).toMatch(/for \((\w+) = a0; a1 >= \1; \1 = \1 \+ 1\) \{\n\s*(\w+) = \1 \+ \w+;\n\s*if \(\(s32\)f\(\2\)/);
  expect(r.src).not.toContain('while (1)');
  agrees(r);
});

test('an IV that is the parameter itself lifts as a `for` with no init', () => {
  // the loop's init names the parameter (`coalesceLoopInit`), so its init edge carries no copy
  const r = judged(srFor(), { coalesceLoopInit: true });
  expect(r.src).toMatch(/for \(; a1 >= a0; a0 = a0 \+ 1\) \{/);
  agrees(r);
});

test('a preheader op the body reads runs ahead of the `for`', () => {
  // a constant held across the calls, named in the preheader: it renders on the zero-trip path too
  const ir = srFor({ pre: '%80: s32 = const {value=1}' }).replace(
    '%30: s32 = call %5 {target="k"}',
    '%30: s32 = call %5 {target="k"}\n  %29: s32 = call %80 {target="set"}',
  );
  const r = judged(ir);
  expect(r.src).toMatch(/for \(/);
  expect(r.src).not.toContain('while (1)');
  agrees(r);
});

test('a derived param whose two edges apply different ops refuses the `for`', () => {
  // `lo - 3` in, `(i + 1) + 3` back: the param is no one function of the IV, and the function
  // declines as it does with no `for` reading at all
  const ir = srFor({ entryDerived: '%2: s32 = sub %0, %3' });
  expect(() => judged(ir)).toThrow(/leaves its switch for a loop exit/);
});

test('a derived param whose two edges add different constants refuses the `for`', () => {
  // `lo + 3` in, `(i + 1) + 2` back
  const ir = srFor({ backDerived: '%39: s32 = const {value=2}\n  %38: s32 = add %36, %39' });
  expect(() => judged(ir)).toThrow(/leaves its switch for a loop exit/);
});

test('two constants of one value on the two edges are one derived param', () => {
  // `lo + 3` in, `(i + 1) + 3` back with the latch's own `3`
  const r = judged(srFor({ backDerived: '%39: s32 = const {value=3}\n  %38: s32 = add %36, %39' }));
  expect(r.src).toMatch(/for \(/);
  expect(r.src).not.toContain('while (1)');
  agrees(r);
});

test('a preheader that reads memory refuses the `for`', () => {
  // the `for` would run the read ahead of its first test, on the path the guard skipped it
  const ir = srFor({ pre: '%81: s32 = gaddr {sym="gK"}\n  %80: s32 = load %81 {off=0, signed=false, width=4}' });
  expect(() => judged(ir)).toThrow(/leaves its switch for a loop exit/);
});

test('a latch test that reads the derived param refuses the `for`', () => {
  // `hi < (i + 1) + 3`: the test would read the derived name, which the update no longer writes
  const ir = srFor({ test: '%37: u32 = icmp_slt %1, %38' });
  expect(() => judged(ir)).toThrow(/leaves its switch for a loop exit/);
});
