// THE LOOP AS A `for` (structure.ts `forPlanAt`): a counted loop whose latch runs the update and the
// test, entered through a guard that is the same test, spelled `for (init; cond; inc)` so that an edge
// into the latch from inside the body is `continue;` and one into the exit is `break;`. The shape a
// jump table in such a loop needs when some arms reach the latch and others leave the loop:
// `for (i = lo; i <= hi; i++) { switch (..) { case 1: if (c) continue; k(4); break; .. default:
// continue; } break; }`, agbcc's layout of which `while (1)` cannot spell (a loop `break` inside a
// case body binds to the switch). Every fixture is judged against its own IR by the trace oracle
// (`irAgreement`), as `structure()` returns it and as it ships after `readabilityRewrites`. The
// `for` takes a guard that is its test, a guard whose exit edge passes a relay block, no guard where
// its first test folds to true, and an update the header computes. It refuses a guard that is not
// the loop's test, a constant first test that leaves, two updates, a latch with an effect, an exit
// that takes a value and an update from a call, and those fixtures lift through the rerun's
// `while (1)` instead, judged the same way; a relay something else enters refuses it too, and that
// fixture declines.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

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

/** The `for` refused: the rerun reads the loop as the `while (1)` it is, where an arm's edge into the
 *  header is `continue;` and an arm that reaches the latch takes a copy of its update and test. That
 *  reading is judged like the `for`. */
const refusesFor = (ir: string): void => {
  const { src, agreement, shipped } = judged(ir);
  expect(src).not.toContain('for (');
  expect(src).toContain('while (1)');
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
};

/** `synthetic:sw_forjt:agbcc`'s shape with its loads as calls: the guard `lo > hi` skips the loop,
 *  the header tests `f(i)`, the jump table's arms each `continue` (an edge to the latch #11) or call
 *  `k` and leave the loop (an edge to #12), the default and two holes are the latch, and the latch is
 *  `i + 1`, then `hi < i + 1` leaves. A loop follows, so no arm can copy the code after the loop as
 *  an early `return`. `guard`, `latch` and the exit are the parts the refusals vary. */
const forJt = ({
  guard = '%4: u32 = icmp_slt %1, %0\n  cond_br %4, ^bb12(), ^bb1(%0)',
  latch = '%35: s32 = const {value=1}\n  %36: s32 = add %5, %35\n  %37: u32 = icmp_slt %1, %36\n  cond_br %37, ^bb12(), ^bb1(%36)',
  exitParams = '',
  exitTail = '%70: s32 = const {value=0}\n  br ^bb13(%70)',
} = {}) => `fn forjt {
^bb0(%0: s32, %1: s32):
  ${guard}
^bb1(%5: s32):
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
  br ^bb12(${exitParams ? '%16' : ''})
^bb5():
  %20: s32 = call %5 {target="v"}
  %21: s32 = const {value=3}
  %22: u32 = icmp_slt %20, %21
  cond_br %22, ^bb11(), ^bb6()
^bb6():
  %23: s32 = const {value=5}
  %24: s32 = call %23 {target="k"}
  br ^bb12(${exitParams ? '%23' : ''})
^bb7():
  %25: s32 = call %5 {target="x"}
  %26: s32 = const {value=4}
  %27: u32 = icmp_sge %25, %26
  cond_br %27, ^bb11(), ^bb8()
^bb8():
  %29: s32 = const {value=1}
  %28: s32 = call %29 {target="set"}
  %30: s32 = call %5 {target="k"}
  br ^bb12(${exitParams ? '%29' : ''})
^bb9():
  %31: s32 = call %5 {target="x"}
  %32: s32 = const {value=0}
  %33: u32 = icmp_slt %31, %32
  cond_br %33, ^bb11(), ^bb10()
^bb10():
  %34: s32 = call %5 {target="k"}
  br ^bb12(${exitParams ? '%5' : ''})
^bb11():
  ${latch}
^bb12(${exitParams}):
  ${exitTail}
^bb13(%71: s32):
  %72: s32 = call %71 {target="post"}
  %73: s32 = const {value=1}
  %74: s32 = add %71, %73
  %75: u32 = icmp_slt %74, %1
  cond_br %75, ^bb13(%74), ^bb14()
^bb14():
  ret
}`;

test('a jump table whose arms continue a counted loop or leave it lifts as a `for`', () => {
  const ir = forJt();
  const { src, agreement, shipped } = judged(ir);
  expect(src).toContain('for (v0 = a0; a1 >= v0; v0 = v0 + 1) {');
  expect(src).toMatch(/default:\s*\n\s*continue;/);
  // the arms that leave the loop end the switch there, and the loop's `break;` follows it
  expect(src).toMatch(/}\n\s*break;\n\s*}\n\s*}\n/);
  expect(src).not.toContain('while (1)');
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
});

test('two arms entering a third case body are written back as copies inside the `for`', () => {
  // `case 0: if (u(i) == 1) continue; goto shared;` beside `case 2: case 3: shared: ..`, the
  // `sw_gotocase2` shape: at the loop's exit the shared body is an ordinary closed arm, so the
  // copies reading (`copySharedFallTargets`) gives it back to the arm above it.
  const ir = forJt()
    .replace('cond_br %15, ^bb11(), ^bb4()', 'cond_br %15, ^bb11(), ^bb7()')
    .replace(/\^bb4\(\):\n(?:  .*\n)*?(?=\^bb5)/, '');
  const { src, agreement, shipped } = judged(ir);
  expect(src).toContain('for (v0 = a0; a1 >= v0; v0 = v0 + 1) {');
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
});

test('a guard that is not the loop test refuses the `for`', () => {
  // `lo >= hi` skips a loop whose test is `hi < i + 1`: `lo == hi` runs the body once
  refusesFor(forJt({ guard: '%4: u32 = icmp_sge %0, %1\n  cond_br %4, ^bb12(), ^bb1(%0)' }));
});

test('a guard that reaches the exit through a relay block lifts as the `for`', () => {
  // agbcc's `ble .LCB; b .L4 @long jump` where the exit is past a conditional branch's range: the
  // guard's exit edge is a block whose one op jumps to the exit
  const ir = forJt({
    guard: '%4: u32 = icmp_slt %1, %0\n  cond_br %4, ^bb15(), ^bb1(%0)\n^bb15():\n  br ^bb12()',
  });
  const { src, agreement, shipped } = judged(ir);
  expect(src).toContain('for (v0 = a0; a1 >= v0; v0 = v0 + 1) {');
  expect(src).not.toContain('while (1)');
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
});

test('a relay block an arm enters too refuses the `for`', () => {
  // case 1 reaches the exit through the relay too, so the relay is not the guard's own edge
  const ir = forJt({
    guard: '%4: u32 = icmp_slt %1, %0\n  cond_br %4, ^bb15(), ^bb1(%0)\n^bb15():\n  br ^bb12()',
  }).replace('%24: s32 = call %23 {target="k"}\n  br ^bb12()', '%24: s32 = call %23 {target="k"}\n  br ^bb15()');
  expect(ir).toContain('br ^bb15()\n^bb7');
  // the `for` is not read through a relay something else enters, and the function declines as it
  // does with no `for` reading at all
  expect(() => judged(ir)).toThrow(/leaves its switch for a loop exit/);
});

test('a latch that runs a second update refuses the `for`', () => {
  // two loop variables would need a comma in the `for`'s update, which L3 does not spell
  const ir = forJt()
    .replace('^bb1(%5: s32):', '^bb1(%5: s32, %50: s32):')
    .replace('^bb1(%0)', '^bb1(%0, %0)')
    .replace('cond_br %37, ^bb12(), ^bb1(%36)', '%51: s32 = add %50, %36\n  cond_br %37, ^bb12(), ^bb1(%36, %51)')
    .replace('%34: s32 = call %5 {target="k"}', '%34: s32 = call %50 {target="k"}');
  refusesFor(ir);
});

test('a latch with an effect refuses the `for`', () => {
  const latch =
    '%35: s32 = const {value=1}\n  %36: s32 = add %5, %35\n  %52: s32 = call %36 {target="tick"}\n' +
    '  %37: u32 = icmp_slt %1, %36\n  cond_br %37, ^bb12(), ^bb1(%36)';
  refusesFor(forJt({ latch }));
});

test('an exit that takes a value refuses the `for`', () => {
  const ir = forJt({ exitParams: '%60: s32', exitTail: 'br ^bb13(%60)' })
    .replace('cond_br %4, ^bb12(), ^bb1(%0)', 'cond_br %4, ^bb12(%0), ^bb1(%0)')
    .replace('cond_br %37, ^bb12(), ^bb1(%36)', 'cond_br %37, ^bb12(%36), ^bb1(%36)');
  refusesFor(ir);
});

/** `for (i = 0; i < 40; i++)`: the first test on the constant start is true, so the compiler leaves
 *  no guard and the entry block's `br` enters the body at once. */
const constFor = (start: number) =>
  forJt({
    guard: `%2: s32 = const {value=${start}}\n  br ^bb1(%2)`,
    latch:
      '%35: s32 = const {value=1}\n  %36: s32 = add %5, %35\n  %38: s32 = const {value=40}\n' +
      '  %37: u32 = icmp_sge %36, %38\n  cond_br %37, ^bb12(), ^bb1(%36)',
  });

test('a counted loop whose first test the compiler folded away lifts as a `for` with no guard', () => {
  const { src, agreement, shipped } = judged(constFor(0));
  expect(src).toMatch(/for \(v0 = 0; v0 < 40; v0 = v0 \+ 1\) \{/);
  expect(src).not.toContain('while (1)');
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
});

test('a guardless loop whose test leaves on the entry values refuses the `for`', () => {
  // `i = 50; do { .. } while (++i < 40)` runs the body once, where a `for` would skip it
  refusesFor(constFor(50));
});

/** agbcc's `i + 1` kept from a body that reads it: the header computes the value the latch hands
 *  round, and the latch only tests it. */
const cseFor = (next: string) =>
  forJt({
    latch: '%37: u32 = icmp_slt %1, %6\n  cond_br %37, ^bb12(), ^bb1(%6)',
  })
    .replace('%7: s32 = call %5 {target="f"}', `${next}\n  %7: s32 = call %6 {target="f"}`)
    .replace('%20: s32 = call %5 {target="v"}', '%20: s32 = call %6 {target="v"}');

test('an update the header computes for the body lifts as the `for`s own', () => {
  const { src, agreement, shipped } = judged(cseFor('%60: s32 = const {value=1}\n  %6: s32 = add %5, %60'));
  expect(src).toMatch(/for \(v0 = a0; .*; v0 = .*\) \{/);
  expect(src).not.toContain('while (1)');
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
});

test('an update the header gets from a call refuses the `for`', () => {
  // the `for` would make the call again where it updates, once more than the asm does
  refusesFor(cseFor('%6: s32 = call %5 {target="nxt"}'));
});

/** `while (1) { k(0); if (gx(a)) { switch (next(a)) { case 0: if (g1(a)) continue; case 1: k(2); break;
 *  case 2: k(3); break; default: return; } } k(9); }`: case 0 reaches case 1 and the loop's header. */
const foreverJt = `fn forever {
^bb0(%0: s32):
  br ^bb1()
^bb1():
  %1: s32 = const {value=0}
  %2: s32 = call %1 {target="k"}
  %3: s32 = call %0 {target="gx"}
  %4: u32 = icmp_eq %3, %1
  cond_br %4, ^bb6(), ^bb2()
^bb2():
  %6: s32 = call %0 {target="next"}
  switch_br %6, ^bb3(), ^bb4(), ^bb5(), ^bb7() {cases=[0;1;2]}
^bb3():
  %7: s32 = call %0 {target="g1"}
  %8: u32 = icmp_eq %7, %1
  cond_br %8, ^bb4(), ^bb1()
^bb4():
  %9: s32 = const {value=2}
  %10: s32 = call %9 {target="k"}
  br ^bb6()
^bb5():
  %11: s32 = const {value=3}
  %12: s32 = call %11 {target="k"}
  br ^bb6()
^bb6():
  %13: s32 = const {value=9}
  %14: s32 = call %13 {target="k"}
  br ^bb1()
^bb7():
  ret
}`;

test('a case arm that continues a `while (1)` and falls into the next case lifts on the rerun', () => {
  const { src, agreement, shipped } = judged(foreverJt);
  expect(src).toContain('while (1)');
  expect(src).toMatch(/if \(g1\(a0\) != v0\) continue;\n\s*case 1:/);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
});

// `/for-continue` (rank.ts, `spellCountedLoopsFor`): where the default LIFTS, the `for` is a ranked
// alternative rather than a rerun. With the code after the loop a call and a `return`, every arm
// that leaves the loop copies it, so `while (1)` lifts and no rerun ever asks the loop; the option
// asks it on the first run, and the OFF structuring reports that it met a loop it could ask.
const tailRet = forJt({
  exitTail: '%70: s32 = const {value=99}\n  %69: s32 = call %70 {target="k"}\n  ret',
}).replace(/\^bb13\(%71[\s\S]*$/, '}');

const structured = (ir: string, spellCountedLoopsFor: boolean) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  let offered = 0;
  const sfn = structure(fn, { spellCountedLoopsFor }, { onForOffered: () => offered++ });
  return {
    src: cBackend.emit(sfn),
    offered,
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

test('/for-continue spells a counted loop the default lifts as `while (1)` as its `for`', () => {
  const off = structured(tailRet, false);
  expect(off.src).toContain('while (1)');
  expect(off.src).not.toContain('for (');
  expect(off.offered).toBeGreaterThan(0);
  const on = structured(tailRet, true);
  expect(on.src).toContain('for (v0 = a0; a1 >= v0; v0 = v0 + 1) {');
  expect(on.src).not.toContain('while (1)');
  expect(on.offered).toBe(0);
  for (const r of [off, on]) {
    expect(r.agreement.disagree).toBe(0);
    expect(r.shipped.disagree).toBe(0);
    expect(r.agreement.judged).toBe(SEEDS.length);
  }
});

test('/for-continue is not offered where no `while (1)` loop has a counted latch', () => {
  // the `while (1)` here has no latch that steps and tests a counter, so the option builds the same tree
  const off = structured(foreverJt, false);
  expect(off.offered).toBe(0);
  expect(structured(foreverJt, true).src).toBe(off.src);
});

test('/for-continue leaves a latch with an effect as `while (1)`, and offers nothing', () => {
  const latch =
    '%35: s32 = const {value=1}\n  %36: s32 = add %5, %35\n  %52: s32 = call %36 {target="tick"}\n' +
    '  %37: u32 = icmp_slt %1, %36\n  cond_br %37, ^bb12(), ^bb1(%36)';
  const ir = forJt({
    latch,
    exitTail: '%70: s32 = const {value=99}\n  %69: s32 = call %70 {target="k"}\n  ret',
  }).replace(/\^bb13\(%71[\s\S]*$/, '}');
  const off = structured(ir, false);
  expect(off.offered).toBe(0);
  expect(structured(ir, true).src).toBe(off.src);
});

test('/for-continue is not offered where a later check of the `for` refuses it', () => {
  // the loop passes the shape checks, but `lo >= hi` is not its test read on the entry values, so the
  // `for` is refused under the option too: offering it would only structure the same tree again
  const ir = forJt({
    guard: '%4: u32 = icmp_sge %0, %1\n  cond_br %4, ^bb12(), ^bb1(%0)',
    exitTail: '%70: s32 = const {value=99}\n  %69: s32 = call %70 {target="k"}\n  ret',
  }).replace(/\^bb13\(%71[\s\S]*$/, '}');
  const off = structured(ir, false);
  expect(off.src).toContain('while (1)');
  expect(off.offered).toBe(0);
  expect(structured(ir, true).src).toBe(off.src);
});
