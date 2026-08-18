// The trailing loop variable: a merge param that receives a loop variable's value from ONE
// ITERATION BACK. `for (fast = slow = head; node != fast; fast = fast->next) slow = fast;` —
// after the loop `slow` holds what `fast` held at the top of the last iteration, which no
// un-rotated `while` can say once its update has run. asmlift declined this whole family; it now
// emits the copy inside the body, ahead of the update, which is where the source wrote it.
//
// Both loop emitters that place the update at the bottom of the body are covered — the
// guard-fused `while` (which must also SEED the copy for the zero-trip path it fuses away) and
// the `do-while` (which needs no seed: its body always runs). Each refusal case is a one-fact
// edit of an accepted fixture and asserts it differs, so a decline for the wrong reason cannot
// read as a pass.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// A guard-fused self-loop walking a list with a trailing pointer. ^bb1 is header AND latch; its
// exit edge hands ^bb2 both %3 (the pre-update pointer — the trailing one) and %4 (post-update).
// The guard edge ^bb0 → ^bb2 carries the values the zero-trip path needs.
const TRAILING_PTR = `fn trailingptr {
^bb0(%0: s32*):
  %1: s32* = gaddr {sym="head"}
  %2: u32 = icmp_eq %0, %1
  cond_br %2, ^bb2(%1, %1), ^bb1(%1)
^bb1(%3: s32*):
  %4: s32* = load %3 {off=0, signed=true, width=4}
  %5: u32 = icmp_ne %0, %4
  cond_br %5, ^bb1(%4), ^bb2(%3, %4)
^bb2(%6: s32*, %7: s32*):
  %8: s32 = load %6 {off=4, signed=true, width=4}
  ret %8
}
`;

// The same trailing carry at a `do-while`: fibonacci's `a`, which is the previous iteration's `b`.
// ^bb2 is header and latch; the exit arg %7 is its own param, read before the update.
const TRAILING_DOWHILE = `fn trailingdw {
^bb0(%0: s32):
  %1: s32 = const {value=1}
  %2: s32 = const {value=0}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sle %0, %3
  %5: s32 = const {value=0}
  cond_br %4, ^bb3(%5), ^bb1()
^bb1():
  %6: s32 = const {value=1}
  br ^bb2(%1, %6, %2)
^bb2(%7: s32, %8: s32, %9: s32):
  %10: s32 = const {value=1}
  %11: s32 = add %9, %10
  %12: u32 = icmp_slt %11, %0
  %13: s32 = add %7, %8
  cond_br %12, ^bb2(%8, %13, %11), ^bb3(%7)
^bb3(%14: s32):
  ret %14
}
`;

test('guard-fused `while`: the trailing copy moves into the body, seeded for the zero-trip path', () => {
  // `v1 = &head` before the loop is the seed the fusion would otherwise lose: the guard is gone,
  // so a zero-trip run would reach `return v1[1]` with nothing having assigned v1.
  expect(emit(TRAILING_PTR)).toBe(
    's32 trailingptr(s32 * a0) {\n' +
      '    s32 * v0;\n' +
      '    s32 * v1;\n' +
      '    v1 = (s32 *)&head;\n' +
      '    for (v0 = (s32 *)&head; a0 != v0; v0 = (s32 *)*v0) {\n' +
      '        v1 = v0;\n' +
      '    }\n' +
      '    return v1[1];\n' +
      '}\n',
  );
});

test('do-while: the trailing copy opens the body and leaves nothing behind after the loop', () => {
  // `v3 = v0` captures v0 before the update rewrites it, so reading v3 after the loop is the last
  // iteration's ENTRY value — what the exit edge carries. A copy left after the loop as well
  // would overwrite it with the post-update value, the miscompile this replaces.
  expect(emit(TRAILING_DOWHILE)).toBe(
    's32 trailingdw(s32 a0) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    s32 v2;\n' +
      '    s32 v3;\n' +
      '    s32 t0;\n' +
      '    if (a0 <= 0) {\n' +
      '        v3 = 0;\n' +
      '    } else {\n' +
      '        v0 = 1;\n' +
      '        v2 = 0;\n' +
      '        v1 = 1;\n' +
      '        do {\n' +
      '            v3 = v0;\n' +
      '            v2 = v2 + 1;\n' +
      '            t0 = v0;\n' +
      '            v0 = v1;\n' +
      '            v1 = t0 + v1;\n' +
      '        } while (v2 < a0);\n' +
      '    }\n' +
      '    return v3;\n' +
      '}\n',
  );
});

// REFUSAL — the exit arg COMPUTES from the loop variable instead of being it. Sinking that would
// evaluate `%3 + %0` every iteration rather than once, and an effectful arg would run a different
// number of times, so the decline stands.
const TRAILING_PTR_EXPR = TRAILING_PTR.replace(
  '  cond_br %5, ^bb1(%4), ^bb2(%3, %4)',
  '  %9: s32* = add %3, %0\n  cond_br %5, ^bb1(%4), ^bb2(%9, %4)',
);

// REFUSAL — the guard tests something the loop does not. `isGuardShapedPred` only asks whether the
// block branches to the header and to the exit; an `if` on an unrelated value has that shape, and
// fusing it away deletes it, running a loop the source skipped.
const UNRELATED_GUARD = `fn badguard {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  %10: s32* = gaddr {sym="head"}
  %2: u32 = icmp_eq %1, %9
  cond_br %2, ^bb2(%10, %10), ^bb1(%10)
^bb1(%3: s32*):
  %4: s32* = load %3 {off=0, signed=true, width=4}
  %5: u32 = icmp_ne %0, %4
  cond_br %5, ^bb1(%4), ^bb2(%3, %4)
^bb2(%6: s32*, %7: s32*):
  %8: s32 = load %6 {off=4, signed=true, width=4}
  ret %8
}
`;

// REFUSAL — the guard→exit edge carries a value (const 5) that the post-loop copies do not
// reproduce on a zero-trip run. That edge is not emitted at all once the guard is fused away, so
// the zero-trip path would read the loop's value instead.
const ZERO_TRIP_VALUE_LOST = `fn fusedrop {
^bb0(%0: s32*):
  %1: s32* = gaddr {sym="head"}
  %2: u32 = icmp_eq %0, %1
  %20: s32 = const {value=5}
  cond_br %2, ^bb2(%20), ^bb1(%1)
^bb1(%3: s32*):
  %4: s32* = load %3 {off=0, signed=true, width=4}
  %5: u32 = icmp_ne %0, %4
  %6: s32 = load %1 {off=8, signed=true, width=4}
  cond_br %5, ^bb1(%4), ^bb2(%6)
^bb2(%7: s32):
  ret %7
}
`;

test('an exit arg that COMPUTES from the loop variable is not sinkable — still declines', () => {
  expect(TRAILING_PTR_EXPR).not.toBe(TRAILING_PTR); // the one-fact edit landed
  expect(() => emit(TRAILING_PTR)).not.toThrow(); // control: the base shape IS accepted
  expect(() => emit(TRAILING_PTR_EXPR)).toThrow(StructureError);
});

test('a guard not provably the loop test is not sinkable — declines instead of vanishing', () => {
  // Same CFG as TRAILING_PTR, which IS accepted; only the guard's condition differs. Guard fusion
  // drops the test, so sinking — which makes the zero-trip path load-bearing — must first prove
  // the `while` re-asks the same question.
  expect(() => emit(TRAILING_PTR)).not.toThrow();
  expect(() => emit(UNRELATED_GUARD)).toThrow(StructureError);
});

test('a zero-trip value the post-loop copies cannot reproduce declines instead of being dropped', () => {
  expect(() => emit(TRAILING_PTR)).not.toThrow();
  expect(() => emit(ZERO_TRIP_VALUE_LOST)).toThrow(/zero-trip run/);
});

// The trailing variable may be the PARAMETER the list head came from: the guard→exit edge then
// carries it unchanged, so the seed is an identity and the loop writes the parameter directly.
test('a trailing copy into an existing name needs no seed', () => {
  const NAMED_HEAD = TRAILING_PTR.replace(
    '^bb0(%0: s32*):\n  %1: s32* = gaddr {sym="head"}\n',
    '^bb0(%0: s32*, %1: s32*):\n',
  );
  expect(NAMED_HEAD).not.toBe(TRAILING_PTR);
  expect(emit(NAMED_HEAD)).toBe(
    's32 trailingptr(s32 * a0, s32 * a1) {\n' +
      '    s32 * v0;\n' +
      '    for (v0 = a1; a0 != v0; v0 = (s32 *)*v0) {\n' +
      '        a1 = v0;\n' +
      '    }\n' +
      '    return a1[1];\n' +
      '}\n',
  );
});

// REFUSAL — the seed and the loop init are two copy groups from the same block with nothing
// sequentialising them against each other. Here the exit block has a THIRD predecessor, so its
// param takes its name from that edge and the seed becomes a real write to `a1` — the value the
// init reads on the next line.
const SEED_CLOBBERS_INIT = `fn seedclash {
^bb0(%0: s32*, %1: s32*, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %2, %3
  cond_br %4, ^bb3(), ^bb4()
^bb3():
  br ^bb2(%1)
^bb4():
  %5: u32 = icmp_eq %0, %1
  %6: s32* = gaddr {sym="head"}
  cond_br %5, ^bb2(%6), ^bb1(%1)
^bb1(%7: s32*):
  %8: s32* = load %7 {off=0, signed=true, width=4}
  %9: u32 = icmp_ne %0, %8
  cond_br %9, ^bb1(%8), ^bb2(%7)
^bb2(%10: s32*):
  %12: s32 = load %10 {off=4, signed=true, width=4}
  ret %12
}
`;

test('a seed that would overwrite a value the loop init reads declines', () => {
  // Control: the same sink WITHOUT the clash is accepted, so this is not a decline for some
  // unrelated reason. Without the gate the loop starts at `&head` instead of the caller's pointer.
  expect(() => emit(TRAILING_PTR)).not.toThrow();
  expect(() => emit(SEED_CLOBBERS_INIT)).toThrow(/loop initialisation reads/);
});
