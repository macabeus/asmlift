// THE LATCH IS POST-LOOP FOR AN INNER LOOP — `latchInnerSub` in `structure/structure.ts`.
//
// A bottom-tested loop renders its latch (side effects, update copies, test) outside the body
// region, so an inner loop's exit substitution never reached it. An inner back-edge value read there
// was RE-DERIVED from the inner variable's name, which already held it — the last iteration counted
// twice. Every spelling the structurer can produce had it, the admit-nothing reference included, so
// the naming fuzzes (which compare spellings with each other) could not see it: these compare the
// structured tree with the IR itself (`irTraceOf`). NO SWEEP RE-FINDS A SINGLE TERM — the 2-deep
// generator, and six hand-written shapes up to 3 deep at 6,000 seeds each, move by 0 wrong answers
// when this substitution's terms are dropped ONE AT A TIME — so every term is pinned by a fixture.
// A generator reaches the defect only with the substitution absent ALTOGETHER, which is where the
// two `fz` fixtures below come from.
//
// `LATCH_SUM` is the `acc += a[i][j]` nest agbcc compiles to a one-block inner loop, the load
// spelled as a call so both interpreters can run it; measured, it is also where the rule COMPOSES
// with `enclosingCarrierName` (the inner accumulator takes the outer header's name). `fz643` is the
// generated witness that found the same defect in a side effect and the loop test. `fz16501` is the
// generated witness that found the first version substituting an ENTRY value handed round the inner
// back edge, after the exit copy had already rewritten the name it substituted — held by either of
// the two narrowings (dropping one at a time leaves it green). `GRANDCHILD` is the depth the
// substitution first missed; `T2_MERGE` / `T2_INVARIANT` / `IDENTITY_MERGE` the refusal where a
// name was written before the latch; `ACTIVE_SUB` and `TEST_AFTER_UPDATE` the two maps the latch's
// other lines read under. Each is red with its term dropped (measured, one term at a time).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Block, Fn, Value } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';
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

/** Parsed, and — for `measured` — given the most permissive write-order record there is (every
 *  block measured, nothing written), the one under which `enclosingCarrierName` fires wherever the
 *  CFG lets it. */
const lifted = (ir: string, measured = false): Fn => {
  const fn = parse(ir);
  if (measured) {
    fn.writeOrder = {
      lastWrite: new Map<Block, Map<Value, number>>(),
      writes: new Map(fn.blocks.map((b) => [b, 0] as const)),
    };
  }
  verify(fn);
  recoverTypes(fn);
  return fn;
};

/** Seeds whose run both interpreters finish (the generated witnesses loop forever on some), and
 *  the count of those that disagree. */
const disagreements = (ir: string, measured = false): { judged: number; differ: number } => {
  const fn = lifted(ir, measured);
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

test('an entry value handed round the inner back edge keeps its raw reading (fz16501)', () => {
  const r = disagreements(FZ16501);
  expect(r.judged).toBeGreaterThan(0);
  expect(r.differ).toBe(0);
});

// ── the composition with `enclosingCarrierName` ───────────────────────────────────────────────
// Measured (every block writing nothing), the inner accumulator takes the OUTER header's name, so
// the name the latch substitution reads the inner value under is that header's — the one name
// `latchInnerSub`'s "rewritten" scan must exempt, because the update copies that write it read
// under the substitution themselves. Without the exemption the entry is refused and the latch
// declines; before the refusal was loud it re-derived the last element twice (`v2 = v2 + v0;`),
// a wrong answer that out-scored the right one on agbcc's `acc += gT[i][j] * 2` nest. Nothing else
// in the suite has the substitution firing on a value whose name the enclosing loop shares.
test('the latch substitution composes with the enclosing loop sharing the inner accumulator', () => {
  expect(disagreements(LATCH_SUM, true)).toEqual({ judged: 64, differ: 0 });
  const out = cBackend.emit(structure(lifted(LATCH_SUM, true)));
  expect(out.match(/\bv\d+ = v\d+;/g) ?? []).toEqual([]); // one variable across the nest
  expect(out.match(/ \+ v\d+;/g)?.length).toBe(1);
});

// ── depth: a grandchild's value at the outermost latch ────────────────────────────────────────
// `for i { for j { s = j; for k { s += f0(k); } } f1(s); }` — the middle loop carries only `j`
// and re-seeds `s`, so the innermost loop's back-edge value reaches the outer latch raw. Counting
// only CHILD loops, the latch spelled `f1(v4 + v0)` (the last element twice), 64 of 64 inputs.
const GRANDCHILD = `fn grandchild {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: s32 = const {value=0}
  br ^bb2(%5)
^bb2(%6: s32):
  %7: s32 = const {value=1}
  %8: s32 = add %6, %7
  %9: s32 = const {value=0}
  %10: s32 = const {value=0}
  br ^bb3(%9, %10)
^bb3(%11: s32, %12: s32):
  %13: s32 = call %11 {target="f0"}
  %14: s32 = add %12, %13
  %15: s32 = const {value=1}
  %16: s32 = add %11, %15
  %17: s32 = const {value=3}
  %18: u32 = icmp_slt %16, %17
  cond_br %18, ^bb3(%16, %14), ^bb4()
^bb4():
  %19: s32 = const {value=2}
  %20: u32 = icmp_slt %8, %19
  cond_br %20, ^bb2(%8), ^bb5()
^bb5():
  %21: s32 = call %14 {target="f1"}
  %22: s32 = const {value=2}
  %23: u32 = icmp_slt %4, %22
  cond_br %23, ^bb1(%4), ^bb6()
^bb6():
  ret %0
}
`;

test('the outer latch reads a grandchild loop value under its name when the middle loop does not carry it', () => {
  expect(disagreements(GRANDCHILD)).toEqual({ judged: 64, differ: 0 });
  expect(cBackend.emit(structure(lifted(GRANDCHILD)))).toMatch(/f1\(v\d+\);/);
});

// ── a name rewritten between the inner loop and the latch ─────────────────────────────────────
// The inner loop leaves `x` in its variable; a merge after it (`if (c) x' = x; else x' = 0;`)
// takes that same name, and the latch still reads the pre-merge `x` (`f1(x)`). `re-derives` does
// not refuse the merge: the inner value re-derives from the INDUCTION variable's name, not from
// the one the merge takes. So the name no longer holds the value, and the latch must not
// substitute it — `f1(v3)` reads the merge (41 of 64 inputs wrong, measured).
//
// Whether the re-derivation is right then depends on what it reads. In `T2_MERGE` the value is
// `j + a0`, and `j`'s name holds the loop's UPDATED `j` by the time the latch runs: `f1(v2 + a0)`
// is one iteration off (64 of 64 inputs wrong). Neither reading is the value, so it declines.
// In `T2_INVARIANT` the value is `a0 + 3` — nothing the loop wrote — and the re-derivation is it.
const T2_MERGE = `fn t2merge {
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
  %10: s32 = add %8, %0
  %12: s32 = const {value=1}
  %13: s32 = add %8, %12
  %14: s32 = const {value=3}
  %15: u32 = icmp_slt %13, %14
  cond_br %15, ^bb2(%13, %10), ^bb3()
^bb3():
  %16: u32 = icmp_slt %6, %0
  cond_br %16, ^bb5(%10), ^bb4()
^bb4():
  %17: s32 = const {value=0}
  br ^bb5(%17)
^bb5(%18: s32):
  %19: s32 = call %10 {target="f1"}
  %20: s32 = const {value=2}
  %21: u32 = icmp_slt %6, %20
  cond_br %21, ^bb1(%6, %18), ^bb6()
^bb6():
  ret %18
}
`;
const T2_INVARIANT = T2_MERGE.replace('%10: s32 = add %8, %0', '%30: s32 = const {value=3}\n  %10: s32 = add %0, %30');

test('a latch reader of an inner value whose name was rewritten, and whose re-derivation is stale, declines', () => {
  for (const measured of [false, true]) {
    expect(() => structure(lifted(T2_MERGE, measured))).toThrow(StructureError);
    expect(() => structure(lifted(T2_MERGE, measured))).toThrow(/whose name was rewritten/);
  }
});

test('a latch reader of an inner value whose name was rewritten re-derives it when nothing it reads changed', () => {
  for (const measured of [false, true]) {
    expect(disagreements(T2_INVARIANT, measured)).toEqual({ judged: 64, differ: 0 });
    expect(cBackend.emit(structure(lifted(T2_INVARIANT, measured)))).toMatch(/f1\(a0 \+ 3\);/);
  }
});

// An IDENTITY merge (`if (…) f3(); x' = x;` on both arms) writes the name with the value it already
// holds, so the name still holds it and the latch substitutes. A per-NAME refusal counted it as a
// rewrite and fell back to the stale re-derivation (64 of 64 inputs wrong). The frontend keeps a
// trivial phi like this off pipeline input (`raiseRecovered`), but generated IR reaches it: six of
// the hand-written 3-deep and sibling shapes did, and declined once the refusal was loud.
const IDENTITY_MERGE = `fn identitymerge {
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
  %16: s32 = call %6 {target="f2"}
  %17: u32 = icmp_slt %16, %0
  cond_br %17, ^bb4(%11), ^bb5()
^bb5():
  %18: s32 = call %0 {target="f3"}
  br ^bb4(%11)
^bb4(%19: s32):
  %20: s32 = call %11 {target="f1"}
  %21: s32 = const {value=2}
  %22: u32 = icmp_slt %6, %21
  cond_br %22, ^bb1(%6, %19), ^bb6()
^bb6():
  ret %19
}
`;

test('an identity merge after the inner loop leaves the name holding the inner value', () => {
  expect(disagreements(IDENTITY_MERGE)).toEqual({ judged: 64, differ: 0 });
});

// ── the two other maps the latch reads under ──────────────────────────────────────────────────
// `ACTIVE_SUB`: the whole nest sits in the EXIT REGION of an earlier loop, so an enclosing
// post-loop naming is active while it is emitted (`n` holds that loop's final `n + 1`). The outer
// update reads it (`acc = acc_inner + n`). The update copies take the latch's map, which replaces
// the ambient one, so it carries that naming too — without it the copy re-derives `n + 1` and
// adds one more than the machine did.
const ACTIVE_SUB = `fn activesub {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %0
  cond_br %5, ^bb1(%4), ^bb2()
^bb2():
  %6: s32 = const {value=0}
  %7: s32 = const {value=0}
  br ^bb3(%6, %7)
^bb3(%8: s32, %9: s32):
  %10: s32 = const {value=1}
  %11: s32 = add %8, %10
  %12: s32 = const {value=0}
  br ^bb4(%12, %9)
^bb4(%13: s32, %14: s32):
  %15: s32 = call %13 {target="f0"}
  %16: s32 = add %14, %15
  %17: s32 = const {value=1}
  %18: s32 = add %13, %17
  %19: s32 = const {value=3}
  %20: u32 = icmp_slt %18, %19
  cond_br %20, ^bb4(%18, %16), ^bb5()
^bb5():
  %21: s32 = call %16 {target="f1"}
  %22: s32 = add %16, %4
  %23: s32 = const {value=2}
  %24: u32 = icmp_slt %11, %23
  cond_br %24, ^bb3(%11, %22), ^bb6()
^bb6():
  ret %22
}
`;

test('the update copies read an enclosing loop’s post-loop naming while the inner substitution is active', () => {
  for (const measured of [false, true]) {
    expect(disagreements(ACTIVE_SUB, measured)).toEqual({ judged: 64, differ: 0 });
  }
});

// `TEST_AFTER_UPDATE`: measured, the inner value's slot shares the outer header's name, and the
// outer update WRITES that name (from a merge inside the inner loop that keeps its own name). The
// test runs after the update, so it must not read the inner value (`a0 + 3`) under the name the
// update just overwrote: it re-derives it, which is right because nothing it reads changed.
const TEST_AFTER_UPDATE = `fn testafterupdate {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=0}
  br ^bb1(%1, %2)
^bb1(%4: s32, %5: s32):
  %7: s32 = const {value=1}
  %8: s32 = add %4, %7
  %10: s32 = const {value=0}
  br ^bb2(%5, %10)
^bb2(%11: s32, %13: s32):
  %14: s32 = call %13 {target="f0"}
  %30: s32 = const {value=3}
  %15: s32 = add %0, %30
  %16: u32 = icmp_slt %14, %0
  cond_br %16, ^bb4(%15), ^bb3()
^bb3():
  br ^bb4(%11)
^bb4(%19: s32):
  %22: s32 = const {value=1}
  %23: s32 = add %13, %22
  %24: s32 = const {value=3}
  %25: u32 = icmp_slt %23, %24
  cond_br %25, ^bb2(%15, %23), ^bb5()
^bb5():
  %27: u32 = icmp_slt %8, %15
  cond_br %27, ^bb1(%8, %19), ^bb6()
^bb6():
  ret %19
}
`;

test('the latch test does not read an inner value under a name the update copies just wrote', () => {
  expect(disagreements(TEST_AFTER_UPDATE, true)).toEqual({ judged: 64, differ: 0 });
  const out = cBackend.emit(structure(lifted(TEST_AFTER_UPDATE, true)));
  expect(out).toMatch(/while \(v\d+ < a0 \+ 3\);/);
});

// The same test reading an inner value that re-derives from the inner INDUCTION variable (`j + a0`),
// whose name holds the loop's updated `j` by then: neither reading is the value, so it declines
// (it emitted a loop test 41 of 64 inputs got wrong). Unmeasured, the name is not shared, nothing
// rewrote it, and it emits the right program.
const TEST_AFTER_UPDATE_STALE = TEST_AFTER_UPDATE.replace('%15: s32 = add %0, %30', '%15: s32 = add %13, %0');

test('a latch test that can read an inner value under neither name declines', () => {
  expect(() => structure(lifted(TEST_AFTER_UPDATE_STALE, true))).toThrow(/whose name was rewritten/);
});
