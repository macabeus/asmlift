// THE LOOP SHAPES `structure()` REFUSES, and what removing each refusal actually does.
//
// Three `continue`s in the do-while recognizer decide which loops it will judge at all: a loop with
// several latches, an irreducible one, and a guarded self-loop the top-tested emitter already
// handles. All three were deletable with the whole core suite green, which is why they are here.
// Two of the three are now deletable only with this file red.
//
// WHAT THE IR ORACLE SAYS ABOUT THEM IS NOT "they prevent a wrong program". Ablating the
// multi-latch refusal structures the fixture below — correctly, on all 64 seeds `irTraceOf` judges.
// So these are CAPABILITY limits, and the loud decline is the contract they ship under: a row that
// hits one gets an `ASMLIFT_ERROR` marker rather than a plausible wrong answer, which is this
// project's first hard rule. Pinning them is pinning that contract, so that widening the recognizer
// is a deliberate act with a measurement attached rather than a line someone deletes.
//
// EVERY TEST BELOW IS ABLATED AGAINST THE REFUSAL IT NAMES, and the header says which of the three
// that leaves unwitnessed. A test that reads as a pin and passes with its rule deleted is worse
// than no test, so the status is per refusal and it is a measurement:
//   • multi-latch  — WITNESSED (`MULTILATCH`). Ablated: the fixture structures as a `while` with an
//                    `if` for the two back edges, 0 of 64 seeds disagreeing with its own IR, and
//                    this file reddens.
//   • guarded self-loop — WITNESSED (`GUARDED_SELFLOOP`), and the witness took a second predecessor
//                    to find. The one-entry `SELFLOOP` below does NOT reach it: that shape is
//                    spelled as a top-tested `for` with the refusal present AND ablated, which is
//                    why its test is named for the emitter and not for the refusal. Entered from
//                    two predecessors, the same loop declines loud with the refusal and structures
//                    without it. Reach at the sweep scale agrees: with `generateSsaFn`'s `isLatch`
//                    widened by one character to emit self-loops (a probe, not committed), ablating
//                    the refusal moves 62 of 4,000 depth-1 seeds from a loud decline to a
//                    structured tree — and the wrong-answer count against the IR does not move,
//                    i.e. the widening is correct on every shape the oracle can judge. That probe
//                    also surfaces a pre-existing wrong answer at depth 1 (seed 327), not fixed
//                    here, which is why the widening is not the thing being shipped. What IS
//                    shipped is the decline, pinned, so widening it is a deliberate act.
//   • irreducible  — STILL NOT WITNESSED, and this is the file's named debt. `irreducible` declines
//                    with `!reducible` ablated too. Instrumented rather than assumed: a two-block
//                    loop entered at BOTH blocks from outside still declines with `!reducible`
//                    ablated, with the overlapping-loop refusal stacked on top of it, and with the
//                    multi-latch refusal stacked on top of that — so whatever refuses the shape is
//                    UPSTREAM of this recognizer, and no fixture here can reach `!reducible` by
//                    ablating inside it. Named rather than claimed.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irTraceOf, traceOf, tracesDiffer } from './helpers';

const lift = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, {}));
};

/** `^bb1` has TWO latch blocks — `^bb2`'s taken edge and `^bb3`'s unconditional one. */
const MULTILATCH = `fn multilatch {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(%2), ^bb4(%2)
^bb2(%4: s32):
  %5: s32 = const {value=2}
  %6: s32 = add %4, %5
  %7: u32 = icmp_slt %6, %0
  cond_br %7, ^bb1(%6), ^bb3(%4)
^bb3(%8: s32):
  %9: s32 = const {value=1}
  %10: s32 = add %8, %9
  %11: s32 = call %10 {target="f0"}
  br ^bb1(%10)
^bb4(%12: s32):
  ret %12
}
`;

/** A guarded self-loop: `^bb1` is its own latch, entered under `^bb0`'s test. */
const SELFLOOP = `fn selfloop {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %1, %0
  cond_br %2, ^bb1(%1), ^bb2(%1)
^bb1(%3: s32):
  %4: s32 = call %3 {target="f0"}
  %5: s32 = const {value=1}
  %6: s32 = add %3, %5
  %7: u32 = icmp_slt %6, %0
  cond_br %7, ^bb1(%6), ^bb2(%6)
^bb2(%8: s32):
  ret %8
}
`;

/** The guarded self-loop the recognizer REFUSES: `^bb3` is its own latch, and unlike `SELFLOOP` it
 *  is entered from TWO predecessors (`^bb1` and `^bb2`), which is what the emitter that would
 *  otherwise claim it cannot spell. Ablate the refusal (`nl.selfLoop && loops.has(h)`) and this
 *  structures — into the loop duplicated once per entry arm, which is the widening the header
 *  measures as correct and this round does not ship. */
const GUARDED_SELFLOOP = `fn guardedselfloop {
^bb0(%0: s32, %1: s32):
  %2: u32 = icmp_slt %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: u32 = icmp_slt %1, %0
  cond_br %3, ^bb2(), ^bb3()
^bb2():
  %4: u32 = icmp_slt %0, %1
  cond_br %4, ^bb3(), ^bb4()
^bb3():
  %5: s32 = call %0 {target="f0"}
  %6: u32 = icmp_slt %0, %1
  cond_br %6, ^bb3(), ^bb4()
^bb4():
  ret %0
}
`;

test('a loop with several latches declines LOUD rather than being judged as a single-latch one', () => {
  expect(() => lift(MULTILATCH)).toThrow(/unrecovered back-edge/);
});

test('a guarded self-loop entered from TWO predecessors declines LOUD', () => {
  expect(() => lift(GUARDED_SELFLOOP)).toThrow(/unrecovered back-edge/);
});

// NOT a refusal pin, and named so it cannot be counted as one: this passes with the guarded
// self-loop refusal deleted. What it records is that the ONE-ENTRY shape never reaches that
// refusal, because `emitWhile` claims it first and spells it the same way either way — which is
// the reason `GUARDED_SELFLOOP` above needed a second predecessor.
test('a ONE-ENTRY guarded self-loop is spelled by the top-tested emitter, refusal or not', () => {
  const src = lift(SELFLOOP);
  expect(src).toContain('for (');
  expect(src).not.toContain('do {');
});

// The refusals are about SHAPE, not about naming, so a fixture the recognizer does accept has to
// keep computing what its IR does — otherwise "we refuse the hard shapes" would be hiding a defect
// in the easy ones.
test('the self-loop the recognizer DOES accept observes what its IR observes', () => {
  const fn = parse(SELFLOOP);
  verify(fn);
  recoverTypes(fn);
  const tree = structure(fn, {});
  let judged = 0;
  for (let seed = 1; seed <= 64; seed++) {
    expect(tracesDiffer({ off: irTraceOf(fn, seed), on: traceOf(tree, seed) }), `seed ${seed}`).toBe(false);
    judged++;
  }
  expect(judged).toBe(64);
});
