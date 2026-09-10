// THE LATCH IS POST-LOOP FOR AN INNER LOOP — `latchInnerSub` in `structure/structure.ts`.
//
// A bottom-tested loop renders its latch (side effects, update copies, test) outside the body
// region, so an inner loop's exit substitution never reached it. An inner back-edge value read there
// was RE-DERIVED from the inner variable's name, which already held it — the last iteration counted
// twice. Every spelling the structurer can produce had it, the admit-nothing reference included, so
// the naming fuzzes (which compare spellings with each other) could not see it: these compare the
// structured tree with the IR itself (`irTraceOf`).
//
// `LATCH_SUM` is the `acc += a[i][j]` nest agbcc compiles to one-block inner loop, the load spelled
// as a call so both interpreters can run it. `fz643` is the generated witness that found the same
// defect in a side effect and the loop test. `fz16501` is the witness for the narrowing: the first
// version of the substitution rewrote an ENTRY value handed round the inner back edge, after the
// exit copy had already rewritten the name it substituted.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irTraceOf, traceOf } from './helpers';

const LATCH_SUM = `fn latchsum {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=0}
  br ^bb1(%1, %2)
^bb1(%3: s32, %4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %3, %5
  %7: s32 = const {value=0}
  br ^bb2(%7, %4)
^bb2(%8: s32, %9: s32):
  %10: s32 = call %8 {target="f0"}
  %11: s32 = add %9, %10
  %12: s32 = const {value=1}
  %13: s32 = add %8, %12
  %14: s32 = const {value=3}
  %15: u32 = icmp_slt %13, %14
  cond_br %15, ^bb2(%13, %11), ^bb3()
^bb3():
  %16: s32 = call %11 {target="f1"}
  %17: s32 = const {value=2}
  %18: u32 = icmp_slt %6, %17
  cond_br %18, ^bb1(%6, %11), ^bb4()
^bb4():
  ret %11
}
`;

const FZ643 = `fn fz643 {
^bb0(%0: s32, %1: s32):
  %2: s32 = sub %1, %0
  %3: s32 = sub %0, %2
  %4: s32 = call %3 {target="f0"}
  br ^bb1()
^bb1():
  br ^bb2(%2, %3)
^bb2(%5: s32, %6: s32):
  br ^bb3(%6)
^bb3(%7: s32):
  %8: s32 = add %3, %7
  %9: s32 = add %1, %8
  %10: u32 = icmp_slt %1, %7
  cond_br %10, ^bb2(%7, %8), ^bb4()
^bb4():
  %11: s32 = add %2, %9
  %12: s32 = call %8 {target="f1"}
  %13: u32 = icmp_slt %0, %11
  cond_br %13, ^bb1(), ^bb5(%1, %8)
^bb5(%14: s32, %15: s32):
  %16: s32 = call %0 {target="f0"}
  %17: s32 = call %0 {target="f1"}
  ret %2
}
`;

const FZ16501 = `fn fz16501 {
^bb0(%0: s32, %1: s32):
  %2: s32 = sub %1, %1
  %3: s32 = call %0 {target="f1"}
  br ^bb1()
^bb1():
  %4: s32 = add %1, %1
  br ^bb2(%2, %4)
^bb2(%5: s32, %6: s32):
  %7: s32 = sub %2, %1
  %8: s32 = add %0, %7
  br ^bb3(%8, %6)
^bb3(%9: s32, %10: s32):
  %11: s32 = sub %1, %2
  %12: s32 = sub %0, %11
  %13: s32 = call %12 {target="f2"}
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb2(%10, %2), ^bb4(%10)
^bb4(%15: s32):
  %16: s32 = call %2 {target="f0"}
  %17: s32 = call %3 {target="f1"}
  %18: s32 = call %0 {target="f2"}
  %19: u32 = icmp_slt %18, %2
  cond_br %19, ^bb1(), ^bb5()
^bb5():
  %20: s32 = sub %3, %0
  %21: s32 = call %3 {target="f1"}
  %22: s32 = call %21 {target="f2"}
  br ^bb6(%20)
^bb6(%23: s32):
  %24: s32 = call %0 {target="f0"}
  ret %24
}
`;

const lifted = (ir: string): Fn => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return fn;
};

/** Seeds whose run both interpreters finish (the generated witnesses loop forever on some), and
 *  the count of those that disagree. */
const disagreements = (ir: string): { judged: number; differ: number } => {
  const fn = lifted(ir);
  const tree = structure(fn);
  let judged = 0;
  let differ = 0;
  for (let seed = 1; seed <= 64; seed++) {
    let want;
    let got;
    try {
      want = irTraceOf(fn, seed);
      got = traceOf(tree, seed);
    } catch {
      continue;
    }
    judged++;
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      differ++;
    }
  }
  return { judged, differ };
};

test('the enclosing latch reads an inner back-edge value under the name the inner loop left it in', () => {
  expect(disagreements(LATCH_SUM)).toEqual({ judged: 64, differ: 0 });
  const out = cBackend.emit(structure(lifted(LATCH_SUM)));
  // the inner update is the only place the addition is spelled; the latch reads its result by name
  expect(out.match(/ \+ v\d+;/g)?.length).toBe(1);
});

test('a generated nest whose latch side effect and loop test read the inner value (fz643)', () => {
  const r = disagreements(FZ643);
  expect(r.judged).toBeGreaterThan(0);
  expect(r.differ).toBe(0);
});

test('an entry value handed round the inner back edge keeps its raw reading once the exit copy rewrote the name (fz16501)', () => {
  const r = disagreements(FZ16501);
  expect(r.judged).toBeGreaterThan(0);
  expect(r.differ).toBe(0);
});
