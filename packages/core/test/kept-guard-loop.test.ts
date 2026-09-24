// The guarded self-loop's TWO emitted forms (structure.ts, the fusion site). A guard-shaped
// cond_br in front of a self-loop is fused into a `while` ONLY under the guard proof — the guard
// is provably the loop's own test, so the `while`'s re-test subsumes it. An UNPROVEN guard keeps
// its `if`, with the loop as a bottom-tested `do-while` inside it (gcc's "guard + do-while"
// lowering, emitted as itself): every test the asm performs appears in the C. The kept form also
// carries no header-purity restriction — its first test runs after the body — so a header holding
// a MATERIALIZED def structures instead of declining.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 96 }, (_, k) => 1 + k * 4099);

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// Guard `n <= 0` beside latch `n != 0` — the countdown-`for` lowering (agbcc/gcc reverse the
// induction variable, so the two predicates differ). Fusing to `while (v != 0)` would run a loop
// the source skipped for every negative n; the guard must survive as its own `if`.
const UNPROVEN = `fn keptguard {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sle %0, %1
  cond_br %2, ^bb2(%0), ^bb1(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  %6: u32 = icmp_ne %5, %1
  cond_br %6, ^bb1(%5), ^bb2(%5)
^bb2(%7: s32):
  ret %7
}
`;

test('an unproven guard keeps its if: guard + do-while, both tests emitted', () => {
  const c = emit(UNPROVEN);
  // the guard reads the loop variable the init just assigned — the parked register's spelling
  expect(c).toContain('if (v0 > 0)');
  expect(c).toContain('do {');
  expect(c).toContain('} while (v0 != 0);');
  expect(c).not.toContain('while (v0 != 0) {'); // not the fused while
});

// Same shape, but the guard `n != 0` IS the latch's test at entry (n-1 substituted back to n) —
// the proof holds and the fused `while` stays.
const PROVEN = `fn fusedguard {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  %6: u32 = icmp_ne %5, %1
  cond_br %6, ^bb1(%5), ^bb2(%5)
^bb2(%7: s32):
  ret %7
}
`;

test('a proven guard still fuses (for-recognition then folds the init in)', () => {
  const c = emit(PROVEN);
  expect(c).toContain('for (v0 = a0; v0 != 0; v0 = v0 - 1)');
  expect(c).not.toContain('do {');
});

// A MATERIALIZED def in the header (a call whose result is read twice must execute once). The
// fused `while`'s first test would read its temp before the body assigned it, so fusion is out —
// but the kept-guard do-while tests after the body and structures fine.
const MATERIALIZED_HEADER = `fn matheader {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = call {target="f"}
  %5: s32 = add %4, %4
  %6: s32 = sub %3, %5
  %7: u32 = icmp_ne %6, %1
  cond_br %7, ^bb1(%6), ^bb2(%6)
^bb2(%8: s32):
  ret %8
}
`;

test('a materialized header def structures as guard + do-while instead of declining', () => {
  const c = emit(MATERIALIZED_HEADER);
  // the shared `0` is materialized (two reads live across the call), hence `!= v0`; the guard
  // reads the counter through its loop-variable name
  expect(c).toContain('if (v2 != v0)');
  expect(c).toContain('= f();'); // the call's temp, assigned inside the body
  expect(c).toContain('do {');
});

// ZERO-TRIP hazard: a materialized header def (u reads sibling t → t materializes) carried on
// the exit edge. Inside `if (guard)` the temp is assigned only when the guard held, so a
// post-loop read of its name on the guard-false path is uninitialized — decline loud, for the
// proven-guard shape (kept only because the header holds materialized defs) and the unproven one.
const ZERO_TRIP_PROVEN = `fn zerotrip {
^bb0(%0: s32):
  %1: s32 = const {value=1}
  %2: s32 = sub %0, %1
  %3: s32 = const {value=5}
  %4: s32 = add %2, %3
  %5: s32 = const {value=0}
  %6: u32 = icmp_ne %0, %5
  cond_br %6, ^bb1(%0), ^bb2(%2, %4)
^bb1(%7: s32):
  %8: s32 = const {value=1}
  %9: s32 = sub %7, %8
  %10: s32 = const {value=5}
  %11: s32 = add %9, %10
  %12: s32 = const {value=2}
  %13: s32 = sub %7, %12
  %14: u32 = icmp_ne %13, %5
  cond_br %14, ^bb1(%13), ^bb2(%9, %11)
^bb2(%15: s32, %16: s32):
  %17: s32 = add %15, %16
  ret %17
}
`;
const ZERO_TRIP_UNPROVEN = ZERO_TRIP_PROVEN.replace('fn zerotrip', 'fn unproven').replace(
  '%6: u32 = icmp_ne %0, %5\n  cond_br %6, ^bb1(%0), ^bb2(%2, %4)',
  '%6: u32 = icmp_sle %0, %5\n  cond_br %6, ^bb2(%2, %4), ^bb1(%0)',
);

test('a materialized temp on the exit edge declines: the guarded body may never assign it', () => {
  expect(() => emit(ZERO_TRIP_PROVEN)).toThrow(/a post-loop read reaches a temp/);
  expect(() => emit(ZERO_TRIP_UNPROVEN)).toThrow(/a post-loop read reaches a temp/);
});

// A PURE PREHEADER between the guard and the self-loop — the compiler's loop-invariant motion
// parks a computation there (a busy poll's mask re-materialization) and the guard's branch is
// still the only decision. The claim requires a preheader def the LOOP BODY reads; its defs
// render inline, and with the guard proven the poll fuses to a plain `while`.
const PREHEADER_POLL = `fn poll {
^bb0(%0: s32):
  %1: s32 = load %0 {off=8, width=4, signed=1}
  %2: s32 = const {value=128}
  %3: s32 = add %2, %2
  %4: s32 = and %1, %3
  %5: s32 = const {value=0}
  %6: u32 = icmp_ne %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: s32 = const {value=128}
  %8: s32 = add %7, %7
  br ^bb3()
^bb3():
  %9: s32 = load %0 {off=8, width=4, signed=1}
  %10: s32 = and %9, %8
  %11: u32 = icmp_ne %10, %5
  cond_br %11, ^bb3(), ^bb2()
^bb2():
  ret %5
}
`;

test('a pure preheader between guard and self-loop still fuses the proven guard to a while', () => {
  const c = emit(PREHEADER_POLL);
  expect(c).toContain('while (');
  expect(c).not.toContain('do {');
  expect(c).not.toContain('if ('); // the guard is subsumed by the while's own test
});

// AFTER A GUARDED LOOP the exit copies and the exit region read a back-edge arg by its loop
// variable's name, which on a zero-trip run still holds the init. Everything the region reads
// dominates the guard, so an arg it reaches was computed before the loop — here `%1`, the value `p`
// is reloaded from, while `p` starts at `%2`. `h(p)` would pass `a2` whenever `a0 <= 0`, so the
// function declines.
const CARRIED_OUTSIDE_VALUE = `fn carried {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  cond_br %4, ^bb1(%2, %0), ^bb2()
^bb1(%5: s32, %6: s32):
  %7: s32 = call %5 {target="g"}
  %8: s32 = const {value=1}
  %9: s32 = sub %6, %8
  %10: u32 = icmp_ne %9, %3
  cond_br %10, ^bb1(%1, %9), ^bb2()
^bb2():
  %11: s32 = call %1 {target="h"}
  ret %11
}
`;
const ZERO_TRIP = /holds its initial value on a zero-trip run/;

test('after a guarded loop, a pre-loop value read by a loop variable holding another init declines', () => {
  expect(() => emit(CARRIED_OUTSIDE_VALUE)).toThrow(ZERO_TRIP);
});

// …and read through an op the region inlines, which is what the region renders.
test('after a guarded loop, an inlined op over such a value declines too', () => {
  expect(() =>
    emit(
      CARRIED_OUTSIDE_VALUE.replace(
        '%3: s32 = const {value=0}\n',
        '%3: s32 = const {value=0}\n  %20: s32 = add %1, %0\n',
      ).replace('call %1 {target="h"}', 'call %20 {target="h"}'),
    ),
  ).toThrow(ZERO_TRIP);
});

// THE ONE FACT CHANGED: `p` starts at `%1` too, so its name holds `%1` on both paths.
test('after a guarded loop, a value carried as its own init is read by its loop variable', () => {
  const out = emit(CARRIED_OUTSIDE_VALUE.replace('^bb1(%2, %0)', '^bb1(%1, %0)'));
  const p = out.match(/g\((\w+)\);/)?.[1];
  expect(p).toBeDefined();
  expect(out).toContain(`return h(${p});`);
});

// Under `coalesceLoopInit` the counter `%22` coalesces onto `a1`, which the loop bumps, while
// `v = a1 - a0`, computed ahead of the guard, is carried as its own init: read by the loop
// variable's name it is right on both paths, where `a1 - a0` re-derived after the loop is not.
const CARRIED_AS_ITS_OWN_INIT = `fn ownit {
^bb0(%0: s32, %1: s32):
  %c: u32 = icmp_slt %0, %1
  cond_br %c, ^bb1(), ^bb2()
^bb1():
  %x: s32 = call %0 {target="f0"}
  br ^bb3(%1)
^bb2():
  br ^bb3(%1)
^bb3(%11: s32):
  %16: s32 = const {value=4}
  %18: s32 = sub %11, %0
  %21: u32 = icmp_slt %11, %16
  cond_br %21, ^bb7(%1, %18), ^bb8()
^bb7(%22: s32, %23: s32):
  %g: s32 = call %23 {target="g"}
  %25: s32 = const {value=1}
  %26: s32 = add %22, %25
  %m: s32 = const {value=-100}
  %27: u32 = icmp_sge %26, %m
  cond_br %27, ^bb8(), ^bb7(%26, %18)
^bb8():
  ret %18
}
`;

test('after a guarded loop, a value carried as its own init computes what the IR computes', () => {
  const fn = parse(CARRIED_AS_ITS_OWN_INIT);
  verify(fn);
  recoverTypes(fn);
  const r = irAgreement(CARRIED_AS_ITS_OWN_INIT, structure(fn, { coalesceLoopInit: true }), SEEDS);
  expect(r.judged).toBe(SEEDS.length);
  expect(r.disagree).toBe(0);
});

// An exit COPY passing one value on both exit edges: `staleExit` sees the same value there and
// cannot tell. Here it is `%3 = h(a0) + a0`, over `%2`, which the loop carries back into `%6` from
// an init of `a1` — spelled through `%6`'s name it adds `a1` whenever the loop never ran.
const EXIT_COPY_OVER_A_CARRIED_VALUE = `fn exitcarried {
^bb0(%0: s32, %1: s32):
  %2: s32 = call %0 {target="h"}
  %3: s32 = add %2, %0
  %4: u32 = icmp_slt %1, %0
  cond_br %4, ^bb3(%3), ^bb2(%1, %1)
^bb2(%5: s32, %6: s32):
  %f: s32 = call %6 {target="g"}
  %7: s32 = const {value=1}
  %8: s32 = add %5, %7
  %9: u32 = icmp_sge %8, %0
  cond_br %9, ^bb3(%3), ^bb2(%8, %2)
^bb3(%11: s32):
  ret %11
}
`;

test('an exit copy passing one value that reads a carried pre-loop value declines', () => {
  expect(() => emit(EXIT_COPY_OVER_A_CARRIED_VALUE)).toThrow(ZERO_TRIP);
});

// A flag: `found = 0; while (i < n) { found = 1; i++; } return found;` with the 1 computed before the
// guard. The exit copy's arg differs across the two exit edges (1 against 0), so `staleExit` proves
// it and it keeps the loop variable's name — the value read as itself would be 1 on a zero-trip run.
const FLAG = `fn flag {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: s32 = const {value=1}
  %4: u32 = icmp_slt %0, %1
  cond_br %4, ^bb1(%0, %2), ^bb2(%2)
^bb1(%5: s32, %6: s32):
  %7: s32 = add %5, %3
  %8: u32 = icmp_slt %7, %1
  cond_br %8, ^bb1(%7, %3), ^bb2(%3)
^bb2(%9: s32):
  ret %9
}
`;

test('an exit copy of a pre-loop value that differs across the exit edges keeps its loop variable', () => {
  const fn = parse(FLAG);
  verify(fn);
  recoverTypes(fn);
  const r = irAgreement(FLAG, structure(fn), SEEDS);
  expect(r.judged).toBe(SEEDS.length);
  expect(r.disagree).toBe(0);
});

// A second guarded loop in the first one's exit region: the first loop's substitution is still in
// force there, and so is what it may not spell — `h(p)` after the inner loop is the same zero-trip
// read as above.
const AFTER_A_NESTED_GUARDED_LOOP = `fn nested {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  cond_br %4, ^bb1(%2, %0), ^bb2()
^bb1(%5: s32, %6: s32):
  %7: s32 = call %5 {target="g"}
  %8: s32 = const {value=1}
  %9: s32 = sub %6, %8
  %10: u32 = icmp_ne %9, %3
  cond_br %10, ^bb1(%1, %9), ^bb2()
^bb2():
  %20: u32 = icmp_sgt %2, %3
  cond_br %20, ^bb3(%2), ^bb4()
^bb3(%21: s32):
  %22: s32 = call %21 {target="k"}
  %23: s32 = const {value=1}
  %24: s32 = sub %21, %23
  %25: u32 = icmp_ne %24, %3
  cond_br %25, ^bb3(%24), ^bb4()
^bb4():
  %11: s32 = call %1 {target="h"}
  ret %11
}
`;

test('a zero-trip read after a nested guarded loop still declines', () => {
  expect(() => emit(AFTER_A_NESTED_GUARDED_LOOP)).toThrow(ZERO_TRIP);
});
