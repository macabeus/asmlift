// The trailing loop variable: a merge param that receives a loop variable's value from ONE
// ITERATION BACK. `for (fast = slow = head; node != fast; fast = fast->next) slow = fast;` —
// after the loop `slow` holds what `fast` held at the top of the last iteration, which no
// un-rotated `while` can say once its update has run. The copy is emitted inside the body ahead
// of the update instead, which is where the source wrote it.
//
// Both loop emitters that place the update at the bottom of the body are covered — the
// guard-fused `while` (which must also SEED the copy for the zero-trip path it fuses away) and
// the `do-while` (which needs no seed: its body always runs).
//
// A refusal test that declines for the WRONG reason reads as a pass, so each one pins the message
// and carries a positive control: either the accepted fixture emitted first, or — where the
// refusal turns on one fact — the same IR with that fact changed. The two body-rebind fixtures are
// the exception: the shape they refuse cannot be spelled without the rebind, so the message is all
// they pin.
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
      '    if (a0 > 0) {\n' +
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
      '    } else {\n' +
      '        v3 = 0;\n' +
      '    }\n' +
      '    return v3;\n' +
      '}\n',
  );
});

// The exit arg COMPUTES from the loop variable instead of being it. The copy is REBUILT at the top
// of the body, where the loop variable's name still holds the value the edge read, so the
// arithmetic is spelled again there rather than moved.
const TRAILING_PTR_EXPR = TRAILING_PTR.replace(
  '  cond_br %5, ^bb1(%4), ^bb2(%3, %4)',
  '  %9: s32* = add %3, %0\n  cond_br %5, ^bb1(%4), ^bb2(%9, %4)',
);

// The same one-fact edit at the `do-while`: ^bb2's exit edge carries `%7 + 1` instead of `%7`.
const TRAILING_DOWHILE_EXPR = TRAILING_DOWHILE.replace(
  '  cond_br %12, ^bb2(%8, %13, %11), ^bb3(%7)',
  '  %15: s32 = add %7, %10\n  cond_br %12, ^bb2(%8, %13, %11), ^bb3(%15)',
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

test('do-while: a PURE computed exit arg is rebuilt at the top of the body', () => {
  expect(TRAILING_DOWHILE_EXPR).not.toBe(TRAILING_DOWHILE); // the one-fact edit landed
  // `v3 = v0 + 1` where the bare-variable fixture writes `v3 = v0`: the same slot, the same place,
  // the arithmetic the edge carried spelled again over the name that still holds v0 there.
  expect(emit(TRAILING_DOWHILE_EXPR)).toBe(
    emit(TRAILING_DOWHILE).replace('            v3 = v0;\n', '            v3 = v0 + 1;\n'),
  );
});

test('the same edit under a fused guard sinks too, and the guard edge supplies the seed', () => {
  expect(TRAILING_PTR_EXPR).not.toBe(TRAILING_PTR);
  // The seed is the GUARD edge's own value (`&head`), not the loop's expression: a zero-trip run
  // never computed `v0 + a0`. Only the in-loop copy carries the arithmetic.
  expect(emit(TRAILING_PTR_EXPR)).toBe(
    emit(TRAILING_PTR).replace('        v1 = v0;\n', '        v1 = v0 + (s32)a0;\n'),
  );
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

// REFUSAL — an early-`return` arm lets an iteration leave the loop BEFORE the latch, so a tree
// rebuilt at the top of the body is one that iteration never evaluated. Harmless for arithmetic,
// not for a divide: at `a0 == 0` the IR returns without dividing and the C would divide first.
const SPECULATED_DIVIDE = `fn specarm {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: u32 = icmp_slt %1, %2
  cond_br %4, ^bb2(), ^bb3()
^bb2():
  br ^bb5()
^bb3():
  %5: u32 = icmp_eq %0, %2
  cond_br %5, ^bb6(%3), ^bb5()
^bb5():
  %6: s32 = const {value=1}
  %7: s32 = add %3, %6
  %8: u32 = icmp_slt %7, %1
  %9: s32 = sdiv %3, %0
  cond_br %8, ^bb1(%7), ^bb4(%9)
^bb6(%10: s32):
  ret %10
^bb4(%11: s32):
  ret %11
}
`;

test('a trapping op in the tree is not rebuilt at the top of the body — an arm may leave first', () => {
  // Positive control: the SAME shape with the divide replaced by a multiply does sink, so this is
  // a refusal about the opcode and not about the arm.
  expect(emit(SPECULATED_DIVIDE.replace('sdiv %3, %0', 'mul %3, %0'))).toContain('v1 = v0 * a0;');
  expect(() => emit(SPECULATED_DIVIDE)).toThrow(/pre-update loop variable/);
});

// REFUSAL — a merge inside the body writes a loop variable's NAME (a body param adopts it), and
// everything the loop emits after that arm reads the name raw. The emitted loop is wrong with or
// without a sunk copy — a naming-pipeline defect — so the sink stands down and leaves the function
// declining, rather than unlocking a loop it cannot make right.
const BODY_REBINDS_LOOP_VAR = `fn rebind {
^bb0(%0: s32, %1: s32):
  %2: s32* = gaddr {sym="gbuf"}
  %3: s32 = const {value=0}
  %4: s32 = const {value=1}
  br ^bb1(%3, %3, %3)
^bb1(%5: s32, %6: s32, %7: s32):
  %8: s32 = mul %7, %5
  %9: s32 = xor %7, %0
  %10: s32 = add %5, %1
  %11: u32 = icmp_slt %7, %9
  cond_br %11, ^bb2(%8), ^bb3(%9)
^bb2(%12: s32):
  %14: s32 = const {value=0}
  br ^bb4(%5)
^bb3(%13: s32):
  %15: s32 = or %13, %0
  %16: s32 = load %2 {off=8, signed=true, width=4}
  %17: s32 = load %2 {off=12, signed=true, width=4}
  br ^bb4(%0)
^bb4(%18: s32):
  %19: s32 = mul %1, %0
  %20: s32 = add %5, %4
  %21: u32 = icmp_slt %20, %0
  %22: s32 = mul %7, %6
  cond_br %21, ^bb1(%20, %0, %9), ^bb5(%22)
^bb5(%23: s32):
  ret %23
}
`;

test('the sink stands down where a body merge rewrites a loop variable name', () => {
  // Without this the loop emits `v2 = v2 ^ a0` in an arm and then reads `v2` in the update, which
  // for (a0, a1) = (3, -2) returns 9 where the IR returns 0.
  expect(() => emit(BODY_REBINDS_LOOP_VAR)).toThrow(/pre-update loop variable/);
});

// REFUSAL — the same body-rebind shape, with NOTHING reading the rebound name at the bottom of the
// loop: the update's own value never touches it and the test does not either. A screen over the
// READERS misses this one; the store in the latch reads it, and so would a call argument or an
// in-body condition. The refusal is on the name.
const BODY_REBIND_READ_BY_A_STORE = `fn rb2 {
^bb0(%0: s32):
  %1: s32* = gaddr {sym="gbuf"}
  %2: s32 = const {value=0}
  %3: s32 = const {value=1}
  br ^bb1(%2, %2)
^bb1(%4: s32, %5: s32):
  %6: s32 = mul %4, %4
  %7: u32 = icmp_slt %4, %0
  cond_br %7, ^bb2(%6), ^bb3()
^bb2(%8: s32):
  store %1, %8 {off=0, width=4}
  br ^bb3()
^bb3():
  store %1, %5 {off=4, width=4}
  %9: s32 = add %4, %3
  %10: u32 = icmp_slt %9, %0
  cond_br %10, ^bb1(%9, %6), ^bb4(%5)
^bb4(%11: s32):
  ret %11
}
`;

test('the stand-down is on the rebound NAME, not on who reads it', () => {
  // Sunk, this emits `gbuf[1] = v1` after an arm has overwritten v1: at a0 = 3 the IR stores
  // 0, 0, 1 and the emitted C stored 0, 1, 4.
  expect(() => emit(BODY_REBIND_READ_BY_A_STORE)).toThrow(/pre-update loop variable/);
});
