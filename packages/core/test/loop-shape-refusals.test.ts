// THE LOOP SHAPES `structure()` REFUSES, and what removing each refusal actually does.
//
// Three `continue`s in the do-while recognizer decide which loops it will judge at all: a loop with
// several latches, an irreducible one, and a guarded self-loop the top-tested emitter already
// handles. All three were deletable with the whole core suite green, which is why they are here.
//
// WHAT THE IR ORACLE SAYS ABOUT THEM IS NOT "they prevent a wrong program". Ablating the
// multi-latch refusal structures the fixture below — correctly, on all 64 seeds `irTraceOf` judges.
// So these are CAPABILITY limits, and the loud decline is the contract they ship under: a row that
// hits one gets an `ASMLIFT_ERROR` marker rather than a plausible wrong answer, which is this
// project's first hard rule. Pinning them is pinning that contract, so that widening the recognizer
// is a deliberate act with a measurement attached rather than a line someone deletes.
//
// MEASURED, per refusal, on this file's fixtures and on `generateSsaFn`:
//   • multi-latch  — pinned below. Ablated: `multilatch` structures as a `while` with an `if` for
//                    the two back edges, 0 of 64 seeds disagreeing with its own IR.
//   • irreducible  — NOT witnessed here. `irreducible` declines with the refusal ablated too, so
//                    something earlier refuses it first; the shape that reaches `!reducible` is not
//                    built. Named rather than claimed.
//   • guarded self-loop — NOT witnessed here. `selfloop` is spelled as a top-tested `for` with the
//                    refusal present AND ablated. Reaching it needs a generator that emits
//                    self-loops: built as a probe (one character in `generateSsaFn`'s `isLatch`),
//                    ablating the refusal then moves 53 of 4,000 seeds from a loud decline to a
//                    structured tree with the wrong-answer count unchanged at 28 — i.e. the
//                    widening is correct on every shape the oracle could judge. That probe also
//                    surfaces a pre-existing wrong answer at depth 1 (seed 327) that this round did
//                    not fix, so it is not committed.
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

test('a loop with several latches declines LOUD rather than being judged as a single-latch one', () => {
  expect(() => lift(MULTILATCH)).toThrow(/unrecovered back-edge/);
});

test('a guarded self-loop is spelled by the TOP-TESTED emitter, not as a do-while', () => {
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
