// THE LOOP SHAPES `structure()` REFUSES, and what removing each refusal actually does.
//
// FOUR `continue`s in the do-while recognizer decide which loops it will judge at all, and the count
// is asserted against the source below so a fifth cannot be added without landing here. Each is
// named with what ablating it costs — its `continue;` replaced by a no-op, then the whole of
// `packages/core/test` (3,744 tests). The counts below EXCLUDE this file's own inventory assertion,
// which counts `continue;` tokens and so reddens on every ablation alike:
//
//   1. multi-latch        several latches                         left to `while (1)` — loop-forever.test.ts,
//                                                                 and THIS FILE's MULTILATCH
//   2. not admissible     an overlapping inner loop, or an entry   0 failed — UNWITNESSED
//                         into the body past the header
//                         (`admissible`, which `while (1)` asks too)
//   3. neither shape      no clean pre-tested/bottom-tested exit  left to `while (1)` — loop-forever.test.ts
//   4. multiple exits     `!singleExit`                           10 failed — loop-dowhile-break.test.ts,
//                                                                 loop-break-exit.test.ts and the two
//                                                                 loop-bearing fuzz sweeps
//
// A guarded self-loop is NOT refused: it is recognized and kept aside (`keptGuardDoWhiles`), so
// emitWhile spells it where a guard claims it, and where none does it is a do-while
// (GUARDED_SELFLOOP, GSL2 below).
//
// So ONE of the four is unwitnessed, and its irreducible half is this file's named debt,
// instrumented below. For its overlapping half all that is measured is the ablation — the whole
// core suite is green without it — which says no existing test distinguishes it and says nothing
// about whether a fixture could. #4 is where a `do-while` hands a break to `while (1)`: an edge into
// its exit that no early-return arm owns refuses it, and ablated, the do-while claims loops it cannot
// spell. A `while`'s edges to its own exit are admitted as `break`s ahead of #4
// (loop-break-exit.test.ts). Naming the unwitnessed one is the point: an unwitnessed refusal that
// nobody has written down reads exactly like a witnessed one.
//
// WHAT THE IR ORACLE SAYS ABOUT THEM IS NOT "they prevent a wrong program". The multi-latch
// fixture below, which #1 leaves to the `while (1)` recognizer, structures there correctly on all
// 64 seeds `irTraceOf` judges. So these are CAPABILITY limits of the do-while recognizer, and where
// no other recognizer takes the loop, the loud decline is the contract they ship under: a row that
// hits one gets an `ASMLIFT_ERROR` marker rather than a plausible wrong answer, which is this
// project's first hard rule. Pinning them is pinning that contract, so that widening the recognizer
// is a deliberate act with a measurement attached rather than a line someone deletes.
//
// EVERY TEST BELOW IS ABLATED AGAINST THE REFUSAL IT NAMES: a test that reads as a pin and passes
// with its rule deleted is worse than no test. Two of the fixtures need their own note:
//   • guarded self-loop — THE CORRECTNESS CLAIM IS PINNED BY THE TERMINATING FIXTURE.
//                    `GUARDED_SELFLOOP` CANNOT say anything about it, because its loop never
//                    terminates (every path into `^bb3` establishes `%0 < %1`, which is the latch
//                    test, re-read from the same two entry params): 0 of 64 seeds reach `f0` at all,
//                    so what the oracle judges is the seeds that SKIP the loop, and its spelling is
//                    read by hand below. `GSL2` is the terminating version — a latch test over a
//                    value the body increments — and it is the one that measures it: 0 capped, 44
//                    of 64 seeds actually running the loop, 64 of 64 judged, 0 differing. Reach at
//                    the sweep scale: with `generateSsaFn`'s `isLatch` widened by one character to
//                    emit self-loops (a probe, not committed), 349 of 4,000 depth-1 seeds structure
//                    through it, 0 of them disagreeing with the IR. Seed 327 declines: its post-loop
//                    read holds the init on a zero-trip run, which emitWhile refuses after it has
//                    emitted.
//   • irreducible  — the file's named debt: `irreducible` declines with `admissible` ablated too.
//                    Instrumented rather than assumed — a two-block loop entered at BOTH blocks from
//                    outside still declines with the whole of `admissible` ablated, and with the
//                    multi-latch refusal stacked on top of it — so whatever refuses the shape is
//                    UPSTREAM of this recognizer, and no fixture here can reach the single-entry
//                    check by ablating inside it.
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

/** A guarded self-loop no guard claims: `^bb3` is its own latch, and unlike `SELFLOOP` it is
 *  entered from TWO predecessors (`^bb1` and `^bb2`). `^bb2` claims its entry and spells it
 *  `while`; `^bb1`'s entry reaches the header as the do-while it is (`keptGuardDoWhiles`).
 *
 *  This loop, once entered, never exits: every path into `^bb3` establishes `%0 < %1` (via `^bb1`'s
 *  false arm, or via `^bb2`'s true arm, which IS that test) and `^bb3`'s back edge re-reads the same
 *  two entry params. So the IR oracle cannot referee it — 0 of its 64 seeds reach `f0` — and its
 *  spelling is read by hand. `GSL2` below is the fixture the oracle can referee. */
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

/** THE SAME SHAPE, ON A LOOP THAT TERMINATES — the fixture the widening's correctness claim rests
 *  on. Two predecessors again, and the one that matters is `^bb2`: a guard-shaped pred (header-or-
 *  exit) is what puts the header among the guarded self-loops. The near miss: two PLAIN `br` entries
 *  are an ordinary do-while either way.
 *
 *  The latch tests `%6 + 1` against the entry param rather than re-reading the entry params, so the
 *  body's increment decides the trip count: 44 of 64 oracle seeds run `f0` at least once and none
 *  cap. It structures into a `for` and a `do-while` (one per entry arm), and the oracle judges all 64
 *  with 0 disagreeing. */
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

test('a loop with several latches is left to the `while (1)` recognizer', () => {
  const fn = parse(MULTILATCH);
  verify(fn);
  recoverTypes(fn);
  const tree = structure(fn, {});
  expect(cBackend.emit(tree)).toContain('while (1) {');
  for (let seed = 1; seed <= 64; seed++) {
    expect(tracesDiffer({ off: irTraceOf(fn, seed), on: traceOf(tree, seed) }), `seed ${seed}`).toBe(false);
  }
});

test('a guarded self-loop entered from TWO predecessors is a `while` on one arm and a do-while on the other', () => {
  // Read by hand: `a0 < a1` is the latch test on both arms; `^bb2` enters under it (`while`), `^bb1`
  // only where `a1 >= a0` already holds it (do-while).
  const c = lift(GUARDED_SELFLOOP);
  expect(c).toMatch(/if \(a0 >= a1\) \{\n\s+while \(a0 < a1\) \{\n\s+f0\(a0\);/);
  expect(c).toMatch(/if \(a1 >= a0\) \{\n\s+do \{\n\s+f0\(a0\);\n\s+\} while \(a0 < a1\);/);
});

test('the same shape on a loop that TERMINATES, refereed by the oracle', () => {
  const fn = parse(GSL2);
  verify(fn);
  recoverTypes(fn);
  const tree = structure(fn, {});
  const c = cBackend.emit(tree);
  expect(c).toContain('for (');
  expect(c).toContain('do {');
  for (let seed = 1; seed <= 64; seed++) {
    expect(tracesDiffer({ off: irTraceOf(fn, seed), on: traceOf(tree, seed) }), `seed ${seed}`).toBe(false);
  }
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

// THE INVENTORY, LINKED TO THE CODE. The header above lists five refusals as prose, and nothing but
// this stops it drifting from them. Counting `continue;` in the recognizer's own region rather than
// pattern-matching a line, so the assertion survives reformatting — the same shape
// `locals-written.test.ts` uses over `rank.ts`. Five: the four shape refusals plus the inner-`for`
// skip of the already-counted exit edge in the single-exit walk, which is not a refusal.
test('the do-while recognizer has exactly the refusals this file inventories', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'structure', 'structure.ts'), 'utf8');
  const start = src.indexOf('const doWhileLoops = new Map<Block, DoWhileInfo>();');
  const end = src.indexOf('const varName = new Map<Value, string>();');
  expect(start, 'recognizer start anchor').toBeGreaterThan(0);
  expect(end, 'recognizer end anchor').toBeGreaterThan(start);
  const region = src.slice(start, end);
  expect(region.split('continue;').length - 1, 'four shape refusals + one inner-loop skip').toBe(5);
});

// NOT a refusal pin, and named so it cannot be counted as one. What it records is that the
// ONE-ENTRY shape never reaches the kept-aside do-while, because `emitWhile` claims it first — which
// is the reason `GUARDED_SELFLOOP` above needed a second predecessor.
test('a ONE-ENTRY guarded self-loop is spelled by the top-tested emitter', () => {
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
