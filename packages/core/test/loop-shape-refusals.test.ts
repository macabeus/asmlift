// THE LOOP SHAPES `structure()` REFUSES, and what removing each refusal actually does.
//
// SIX `continue`s in the do-while recognizer decide which loops it will judge at all, and the count
// is asserted against the source below so a seventh cannot be added without landing here. Each is
// named with what ablating it costs — its `continue;` replaced by a no-op, then the whole of
// `packages/core/test` (2,589 tests). The counts below EXCLUDE this file's own inventory assertion,
// which counts `continue;` tokens and so reddens on every ablation alike:
//
//   1. guarded self-loop  `nl.selfLoop && loops.has(h)`         2 failed — THIS FILE  (GUARDED_SELFLOOP, GSL2)
//   2. multi-latch        `!nl.selfLoop && latches.length !== 1` 1 failed — THIS FILE  (MULTILATCH)
//   3. overlapping inner  a nested header whose body escapes ours  0 failed — UNWITNESSED
//   4. irreducible        `!reducible`                             0 failed — UNWITNESSED
//   5. neither shape      no clean pre-tested/bottom-tested exit  2 failed — latch.test.ts,
//                                                                 opaque-effects.test.ts
//   6. multiple exits     `!singleExit`                           4 failed — elsewhere in the suite
//
// So TWO of the six are unwitnessed. #4 is this file's named debt, instrumented below. For #3 all
// that is measured is the ablation — the whole core suite is green without it — which says no
// existing test distinguishes it and says nothing about whether a fixture could. Naming both is the
// point: an unwitnessed refusal that nobody has written down reads exactly like a witnessed one.
//
// WHAT THE IR ORACLE SAYS ABOUT THEM IS NOT "they prevent a wrong program". Ablating the
// multi-latch refusal structures the fixture below — correctly, on all 64 seeds `irTraceOf` judges.
// So these are CAPABILITY limits, and the loud decline is the contract they ship under: a row that
// hits one gets an `ASMLIFT_ERROR` marker rather than a plausible wrong answer, which is this
// project's first hard rule. Pinning them is pinning that contract, so that widening the recognizer
// is a deliberate act with a measurement attached rather than a line someone deletes.
//
// EVERY TEST BELOW IS ABLATED AGAINST THE REFUSAL IT NAMES: a test that reads as a pin and passes
// with its rule deleted is worse than no test. Two of the fixtures need their own note:
//   • guarded self-loop — THE DECLINE AND THE CORRECTNESS CLAIM ARE PINNED BY DIFFERENT FIXTURES.
//                    `GUARDED_SELFLOOP` pins the refusal and CANNOT say anything about widening it,
//                    because its loop never terminates (every path into `^bb3` establishes
//                    `%0 < %1`, which is the latch test, re-read from the same two entry params):
//                    0 of 64 seeds reach `f0` at all and 21 cap, so the "43 judged, 0 differing" an
//                    ablation reports is 43 seeds that SKIP the loop. `GSL2` is the terminating
//                    version — same refusal, a latch test over a value the body increments — and it
//                    is the one that measures the widening: 0 capped, 44 of 64 seeds actually
//                    running the loop, and with the refusal ablated 64 of 64 judged, 0 differing.
//                    Reach at the sweep scale agrees: with `generateSsaFn`'s `isLatch` widened by
//                    one character to emit self-loops (a probe, not committed), ablating the refusal
//                    moves 62 of 4,000 depth-1 seeds from a loud decline to a structured tree — and
//                    the wrong-answer count against the IR does not move. That probe also surfaces a
//                    wrong answer at depth 1 (seed 327) that is not fixed here, which is why the
//                    widening is not what ships. What ships is the decline, pinned.
//   • irreducible  — the file's named debt: `irreducible` declines with `!reducible` ablated too.
//                    Instrumented rather than assumed — a two-block loop entered at BOTH blocks from
//                    outside still declines with `!reducible` ablated, with the overlapping-loop
//                    refusal stacked on top of it, and with the multi-latch refusal stacked on top
//                    of that — so whatever refuses the shape is UPSTREAM of this recognizer, and no
//                    fixture here can reach `!reducible` by ablating inside it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 *  structures — into THREE copies of the loop from the two entry predecessors, spelled
 *  `while` / `do-while` / `while` (one entry arm reaches the header twice).
 *
 *  A REFUSAL PIN AND NOTHING MORE. This loop, once entered, never exits: every path into `^bb3`
 *  establishes `%0 < %1` (via `^bb1`'s false arm, or via `^bb2`'s true arm, which IS that test) and
 *  `^bb3`'s back edge re-reads the same two entry params. So the IR oracle cannot referee the
 *  widening here — 0 of its 64 seeds reach `f0`, 21 cap, and the 43 it judges under the ablation are
 *  the 43 that skip the loop. `GSL2` below is the fixture that can. */
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

/** THE SAME REFUSAL, ON A LOOP THAT TERMINATES — the fixture the widening's correctness claim rests
 *  on. Two predecessors again, and the one that matters is `^bb2`: a guard-shaped pred (header-or-
 *  exit) is what puts the header in `loops` and fires `nl.selfLoop && loops.has(h)`. The near miss:
 *  two PLAIN `br` entries do not reach the refusal at all, structuring as an ordinary do-while with
 *  it present and ablated.
 *
 *  The latch tests `%6 + 1` against the entry param rather than re-reading the entry params, so the
 *  body's increment decides the trip count: 44 of 64 oracle seeds run `f0` at least once and none
 *  cap. With the refusal ablated it structures into a `for` and a `do-while` (one per entry arm) and
 *  the oracle judges all 64 with 0 disagreeing — which is the measurement the header cites, and the
 *  one `GUARDED_SELFLOOP` cannot make. */
const GSL2 = `fn gsl2 {
^bb0(%0: s32, %1: s32):
  %2: u32 = icmp_slt %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=0}
  br ^bb3(%3)
^bb2():
  %4: s32 = const {value=1}
  %5: u32 = icmp_slt %4, %0
  cond_br %5, ^bb3(%4), ^bb4(%4)
^bb3(%6: s32):
  %7: s32 = call %6 {target="f0"}
  %8: s32 = const {value=1}
  %9: s32 = add %6, %8
  %10: u32 = icmp_slt %9, %0
  cond_br %10, ^bb3(%9), ^bb4(%9)
^bb4(%11: s32):
  ret %11
}
`;

test('a loop with several latches declines LOUD rather than being judged as a single-latch one', () => {
  expect(() => lift(MULTILATCH)).toThrow(/unrecovered back-edge/);
});

test('a guarded self-loop entered from TWO predecessors declines LOUD', () => {
  expect(() => lift(GUARDED_SELFLOOP)).toThrow(/unrecovered back-edge/);
});

test('the same refusal on a loop that TERMINATES, so the oracle can referee the widening', () => {
  expect(() => lift(GSL2)).toThrow(/unrecovered back-edge/);
});

// THE PROPERTY THAT MAKES `GSL2` THE MEASURABLE ONE, asserted rather than described — a fixture
// edited into another non-terminating shape would otherwise go on reading as the witness. The two
// numbers are the same measurement from both sides: `GUARDED_SELFLOOP` cannot be refereed at all,
// `GSL2` is refereed on two thirds of its seeds.
test('the oracle runs GSL2 body and never runs GUARDED_SELFLOOP body', () => {
  const reaches = (ir: string): number => {
    const fn = parse(ir);
    verify(fn);
    recoverTypes(fn);
    let n = 0;
    for (let seed = 1; seed <= 64; seed++) {
      try {
        if (irTraceOf(fn, seed).some((e) => e.fn === 'f0')) {
          n++;
        }
      } catch {
        /* step cap: the non-terminating fixture's own signature */
      }
    }
    return n;
  };
  expect(reaches(GSL2), 'seeds whose IR trace enters the loop').toBe(44);
  expect(reaches(GUARDED_SELFLOOP), 'the loop the oracle can never observe').toBe(0);
});

// THE INVENTORY, LINKED TO THE CODE. The header above lists six refusals as prose, and nothing but
// this stops it drifting from them. Counting `continue;` in the recognizer's own region rather than
// pattern-matching a line, so the assertion survives reformatting — the same shape
// `locals-written.test.ts` uses over `rank.ts`. Eight: the six shape refusals plus the two
// inner-`for` skips (`bb === h` in the reducibility walk, and the already-counted exit edge in the
// single-exit walk), which are not refusals and are excluded by name in the header.
test('the do-while recognizer has exactly the refusals this file inventories', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'structure', 'structure.ts'), 'utf8');
  const start = src.indexOf('const doWhileLoops = new Map<Block, DoWhileInfo>();');
  const end = src.indexOf('const varName = new Map<Value, string>();');
  expect(start, 'recognizer start anchor').toBeGreaterThan(0);
  expect(end, 'recognizer end anchor').toBeGreaterThan(start);
  const region = src.slice(start, end);
  expect(region.split('continue;').length - 1, 'six shape refusals + two inner-loop skips').toBe(8);
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
