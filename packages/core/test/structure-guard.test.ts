// Structurer crash-hardening + loop recovery (P1–P3). Control flow the structurer cannot recover
// must BAIL EXPLICITLY (a catchable StructureError), never stack-overflow (an unrecovered
// multi-block back-edge means unbounded recursion in `structureRegion` — RangeError) — and the
// shapes it CAN recover must produce the right loop. Irreducible cycles always decline loud.
//
// Toolchain-free: the CFG is built from canonical IR text, so this runs on any machine.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';

// A test-at-top `while`: header ^bb1 tests i<n, body ^bb2 increments and loops back. Also pins the
// F3 polarity invariant: the continue edge is the TAKEN body edge, so the condition stays `<`
// (NOT the self-loop-relative negation → `>=`).
const TEST_AT_TOP_WHILE = `fn loopmulti {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(%2), ^bb3(%2)
^bb2(%4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %4, %5
  br ^bb1(%6)
^bb3(%7: s32):
  ret %7
}
`;

// A bottom-test loop (do-while): body ^bb1 runs first (entered unconditionally), the test is in the
// latch ^bb2 at the BOTTOM. P2 recovers this as `do { … } while (cond);`.
const BOTTOM_TEST_DOWHILE = `fn dowhileshape {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%0, %1)
^bb1(%2: s32, %3: s32):
  %4: s32 = add %3, %2
  br ^bb2(%2, %4)
^bb2(%5: s32, %6: s32):
  %7: s32 = const {value=1}
  %8: s32 = sub %5, %7
  %9: u32 = icmp_sge %8, %6
  cond_br %9, ^bb1(%8, %6), ^bb3(%6)
^bb3(%10: s32):
  ret %10
}
`;

// A NESTED loop (outer header ^bb1, inner loop ^bb2↔^bb3). P3 RECOVERS this — the outer `while` whose
// body is the inner `while` (the inner is properly contained). This fixture's outer back-edge carries
// the outer counter UNCHANGED (a degenerate/infinite outer loop) — recovery must reproduce that exactly.
const NESTED_LOOP = `fn nestedshape {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(%2, %2), ^bb4(%2)
^bb2(%4: s32, %5: s32):
  %6: u32 = icmp_slt %5, %0
  cond_br %6, ^bb3(%4, %5), ^bb1(%4)
^bb3(%7: s32, %8: s32):
  %9: s32 = const {value=1}
  %10: s32 = add %8, %9
  br ^bb2(%7, %10)
^bb4(%11: s32):
  ret %11
}
`;

// An IRREDUCIBLE loop: ^bb1 and ^bb2 form a cycle entered at BOTH blocks from ^bb0, so no single block
// dominates the cycle — there is no reducible header. This must ALWAYS decline (loud-fail); it pins
// the StructureError path that reducible-nesting recovery (P3) must never absorb.
const IRREDUCIBLE = `fn irred {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sgt %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  br ^bb2(%5)
^bb2(%6: s32):
  %7: s32 = const {value=0}
  %8: u32 = icmp_sgt %6, %7
  cond_br %8, ^bb1(%6), ^bb3(%6)
^bb3(%9: s32):
  ret %9
}
`;

// A MERGED-RETURN loop (agbcc's shared epilogue): header ^bb1 tests `(v & 1) == 0`; the else-arm ^bb2
// (`return i`) and the bound-exit ^bb4 (`return 0`) BOTH trampoline through the one `ret` block ^bb5.
// P2 recovers this as a `while` with an in-body early `return` — the return-trampoline unlock, not a
// `break` to a live merge. (This is the shape of pokeemerald's `CountTrailingZeroBits`.)
const MERGED_RETURN_LOOP = `fn earlyret {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=1}
  br ^bb1(%0, %1)
^bb1(%3: s32, %4: s32):
  %5: s32 = and %3, %2
  %6: s32 = const {value=0}
  %7: u32 = icmp_eq %5, %6
  cond_br %7, ^bb3(), ^bb2()
^bb2():
  br ^bb5(%4)
^bb3():
  %8: s32 = shr_u %3 {imm=1}
  %9: s32 = const {value=1}
  %10: s32 = add %4, %9
  %11: u32 = zext %10 {width=8}
  %12: u32 = const {value=31}
  %13: u32 = icmp_ule %11, %12
  cond_br %13, ^bb1(%8, %11), ^bb4()
^bb4():
  %14: s32 = const {value=0}
  br ^bb5(%14)
^bb5(%15: s32):
  ret %15
}
`;

// A latch that conditionally BREAKS to the loop's live exit block (not a return): the body's second
// cond_br has one edge back to the header (continue) and one to the loop exit ^bb4 that carries on to
// post-loop code. P2 emits a `break;` (the exit block is structured ONCE after the loop). Distinct from
// the merged-return shape above, where the second exit is a `return` trampoline.
const LATCH_BREAK = `fn latchbreak {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%0, %1)
^bb1(%2: s32, %3: s32):
  %4: s32 = const {value=0}
  %5: u32 = icmp_ne %2, %4
  cond_br %5, ^bb2(%2, %3), ^bb4(%3)
^bb2(%6: s32, %7: s32):
  %8: s32 = add %7, %6
  %9: s32 = const {value=1}
  %10: s32 = sub %6, %9
  %11: s32 = const {value=100}
  %12: u32 = icmp_sgt %8, %11
  cond_br %12, ^bb4(%8), ^bb1(%10, %8)
^bb4(%13: s32):
  ret %13
}
`;

// SOUNDNESS (pre-update-read hazard): a conditional-latch loop
// whose EXIT TEST reads the PRE-update induction value (`%6`, the loop-top counter) while the update
// decrements it (`%10 = %6 - 1`). Emitting the update before the test would make `if (v0 <= 3) break;`
// read the DECREMENTED v0 → break one iteration early (a silent miscompile). Must DECLINE (loud-fail),
// not recover. Contrast MERGED_RETURN_LOOP, whose test reads the POST-update back-edge arg (safe).
const PREUPDATE_READ_HAZARD = `fn breakoldval {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%0, %1)
^bb1(%2: s32, %3: s32):
  %4: s32 = const {value=0}
  %5: u32 = icmp_ne %2, %4
  cond_br %5, ^bb2(%2, %3), ^bb4(%3)
^bb2(%6: s32, %7: s32):
  %8: s32 = add %7, %6
  %9: s32 = const {value=1}
  %10: s32 = sub %6, %9
  %11: s32 = const {value=3}
  %12: u32 = icmp_sle %6, %11
  cond_br %12, ^bb4(%8), ^bb1(%10, %8)
^bb4(%13: s32):
  ret %13
}
`;

test('P1 recovers a test-at-top `while`', () => {
  const fn = parse(TEST_AT_TOP_WHILE);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  // The recovered test-at-top `while` (init `v0=0` before it, increment `v0=v0+1` as its last body stmt)
  // is re-spelled as a `for` by recognizeForLoops — a pure cosmetic re-bracketing, same semantics.
  expect(src).toBe(
    's32 loopmulti(s32 a0) {\n    s32 v0;\n    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n    }\n    return v0;\n}\n',
  );
});

test('P2 recovers a bottom-test `do-while`', () => {
  const fn = parse(BOTTOM_TEST_DOWHILE);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  // Body runs before the test; the update (`v0 = v0 - 1`) sits at the bottom of the body and the
  // loop-continue condition is read post-update on the header var names.
  expect(src).toContain('do {');
  expect(src).toContain('} while (v0 >= v1);');
  expect(src).not.toContain('while (1)'); // not an infinite-loop fallback
});

test('P2 recovers a merged-return loop with an in-body early `return` (return-trampoline)', () => {
  const fn = parse(MERGED_RETURN_LOOP);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  expect(src).toContain('while ((v0 & 1) == 0) {'); // header test kept as the loop condition
  expect(src).toContain('if (v1 > 31) {'); // the bound exit becomes an in-body early return
  expect(src).toContain('return v1;'); // both exits return (the else-arm value merge)
  expect(src).not.toContain('break;'); // it is a RETURN trampoline, not a break
  // update lands before the bound test: shift then increment, then the conditional return
  expect(src).toContain('v0 = v0 >> 1;');
  expect(src).toContain('v1 = (u8)(v1 + 1);');
});

test("P2 recovers a conditional latch `break` to the loop's live exit", () => {
  const fn = parse(LATCH_BREAK);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  expect(src).toBe(
    's32 latchbreak(s32 a0) {\n    s32 v0;\n    s32 v1;\n    v0 = a0;\n    v1 = 0;\n' +
      '    while (v0 != 0) {\n        v1 = v1 + v0;\n        v0 = v0 - 1;\n        if (v1 > 100) break;\n    }\n    return v1;\n}\n',
  );
});

test('P2 DECLINES a conditional-latch loop whose exit test reads the pre-update induction value', () => {
  const fn = parse(PREUPDATE_READ_HAZARD);
  verify(fn);
  recoverTypes(fn);
  // The exit test reads `%6` (loop-top counter) but the update overwrites its name with `%6 - 1`;
  // recovering would emit a break that fires one iteration early. Loud-fail instead of miscompiling.
  expect(() => structure(fn)).toThrow(StructureError);
});

// Two CRITICAL dropped-phi-copy miscompiles, regression-locked.
// F1: a test-at-top header that COMPUTES a value (i+1) and carries it into the body on a non-identity
// block-arg. The header→bodyEntry copy must open the loop body; dropping it reads an uninitialised local.
const F1_HEADER_CARRIES_COMPUTED = `fn f1 {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %3, %0
  cond_br %6, ^bb2(%3, %5), ^bb3(%3)
^bb2(%7: s32, %8: s32):
  store %1, %8 {off=0, width=4}
  br ^bb1(%8)
^bb3(%9: s32):
  ret %9
}
`;

// F2: a guard-fused self-loop whose EXIT param merges the guard-false value and the loop's final value.
// The header→exit copy must be emitted (under the un-rotation substitution) — dropping it returns a
// stale value; emitting it with the raw expr double-counts the decrement.
const F2_SELFLOOP_EXIT_MERGE = `fn f2 {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sgt %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  %6: s32 = const {value=0}
  %7: u32 = icmp_sgt %5, %6
  cond_br %7, ^bb1(%5), ^bb2(%5)
^bb2(%8: s32):
  ret %8
}
`;

test('F1: test-at-top header carrying a computed value emits the body-entry copy (no uninit read)', () => {
  const fn = parse(F1_HEADER_CARRIES_COMPUTED);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  expect(src).toContain('v1 = v0 + 1;'); // the dropped copy is restored
  expect(src).toContain('*a1 = v1;');
  expect(src).toContain('v0 = v1;');
});

test('F2: guard-fused self-loop emits the exit-merge copy under the un-rotation substitution', () => {
  const fn = parse(F2_SELFLOOP_EXIT_MERGE);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  // The self-loop (`v0=a0` init, `v0=v0-1` last body stmt) is re-spelled as a `for` by
  // recognizeForLoops; the point of this test is the exit-merge copy `a0 = v0` AFTER the loop,
  // which the re-bracketing leaves intact.
  expect(src).toContain('for (v0 = a0; v0 > 0; v0 = v0 - 1) {');
  expect(src).toContain('a0 = v0;'); // exit merge: NOT `a0 = v0 - 1` (double-count) or dropped
  expect(src).not.toContain('a0 = v0 - 1;');
});

// SOUNDNESS (cross-level name collision under coalesceLoopInit): the inner loop var (%4) is
// INITIALISED from the outer var (%1) but is a distinct variable; the outer var stays live (the
// outer latch ^bb4 reads %1 to decrement it). The inner must NOT coalesce onto the outer's name —
// else the inner loop mutates the outer variable (returns -1 instead of 0 for n>0).
const CROSS_LEVEL_COLLIDE = `fn collide2 {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_sgt %1, %2
  cond_br %3, ^bb2(%1), ^bb5(%1)
^bb2(%4: s32):
  %5: s32 = const {value=0}
  %6: u32 = icmp_sgt %4, %5
  cond_br %6, ^bb3(%4), ^bb4()
^bb3(%7: s32):
  %8: s32 = const {value=1}
  %9: s32 = sub %7, %8
  br ^bb2(%9)
^bb4():
  %10: s32 = const {value=1}
  %11: s32 = sub %1, %10
  br ^bb1(%11)
^bb5(%12: s32):
  ret %12
}
`;

test('does NOT coalesce an inner loop var onto a live enclosing loop var (coalesceLoopInit)', () => {
  const fn = parse(CROSS_LEVEL_COLLIDE);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn, { coalesceLoopInit: true }));
  // The OUTER var coalesces onto its init register `a0` (that's the option working); the INNER var's
  // init reads `a0`, but `a0` is excluded (live enclosing induction var) so it takes a fresh local.
  expect(src).toBe(
    's32 collide2(s32 a0) {\n    s32 v0;\n' +
      '    while (a0 > 0) {\n        for (v0 = a0; v0 > 0; v0 = v0 - 1) {\n        }\n' +
      '        a0 = a0 - 1;\n    }\n    return a0;\n}\n',
  );
});

test('fresh-locals spelling: no coalescing when coalesceLoopInit is off', () => {
  const fn = parse(CROSS_LEVEL_COLLIDE);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  expect(src).toBe(
    's32 collide2(s32 a0) {\n    s32 v0;\n    s32 v1;\n' +
      '    for (v0 = a0; v0 > 0; v0 = v0 - 1) {\n        for (v1 = v0; v1 > 0; v1 = v1 - 1) {\n        }\n' +
      '    }\n    return v0;\n}\n',
  );
});

test('P3 recovers a reducible nested loop (outer `while` wrapping an inner `while`)', () => {
  const fn = parse(NESTED_LOOP);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  // outer while whose body is the inner loop; the degenerate outer back-edge carries the counter
  // unchanged (`v0 = v1` with `v1 = v0`), so the recovery is an infinite outer loop — faithful to
  // the IR. The INNER loop is a clean counted loop → recognizeForLoops re-spells it `for`; the
  // OUTER correctly STAYS `while` because its last stmt `v0 = v1` is not a self-update of v0
  // (the for-recognizer's increment guard).
  expect(src).toBe(
    's32 nestedshape(s32 a0) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    v0 = 0;\n' +
      '    while (v0 < a0) {\n        v1 = v0;\n        for (v2 = v0; v2 < a0; v2 = v2 + 1) {\n' +
      '        }\n        v0 = v1;\n    }\n    return v0;\n}\n',
  );
});

test('StructureError message names the function and points at the unsupported control flow', () => {
  const fn = parse(IRREDUCIBLE);
  recoverTypes(fn);
  try {
    structure(fn);
    throw new Error('expected structure() to throw');
  } catch (e) {
    expect(e).toBeInstanceOf(StructureError);
    expect((e as Error).message).toContain('irred');
    expect((e as Error).message).toContain('back-edge');
  }
});

// F6: the UNGUARDED self-loop is a single-block do-while (header === latch riding emitDoWhile).
// Offline CI gate for the emitter — the benchmark rows (dowhile:agbcc/mwcc, byte-exact) are the
// scoreboard; this is the loud pin (the regspell lesson: capabilities without offline pins
// regress silently).
test('F6: an unguarded self-loop structures as a single-block do-while', () => {
  const fn = parse(`fn dw {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1, %0)
^bb1(%2: s32, %3: s32):
  %4: s32 = add %2, %3
  %5: s32 = const {value=1}
  %6: s32 = sub %3, %5
  %7: s32 = const {value=0}
  %8: u32 = icmp_sgt %6, %7
  cond_br %8, ^bb1(%4, %6), ^bb2(%4)
^bb2(%9: s32):
  ret %9
}
`);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  expect(src).toContain('do {');
  expect(src).toContain('} while (');
  expect(src).toContain('v1 - 1'); // the update renders raw inside the body
  const opens = (src.match(/\{/g) ?? []).length;
  expect((src.match(/\}/g) ?? []).length).toBe(opens);
});

test('F6: a GUARDED self-loop keeps the emitWhile un-rotation (ownership is exclusive)', () => {
  const fn = parse(`fn gw {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sgt %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  %6: s32 = const {value=0}
  %7: u32 = icmp_sgt %5, %6
  cond_br %7, ^bb1(%5), ^bb2(%5)
^bb2(%8: s32):
  ret %8
}
`);
  verify(fn);
  recoverTypes(fn);
  const src = cBackend.emit(structure(fn));
  expect(src).not.toContain('do {'); // the guarded path un-rotates to while/for, never do-while
});
