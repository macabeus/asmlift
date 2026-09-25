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
// WHICH CORPUS ROWS REACH THE SINK, logged over the whole agbcc population (`pnpm bench run --tier
// synthetic --toolchain agbcc`, 315 rows, exit 0): five symbols sink a copy. `preupdate_exit` and
// `preupdate_exit_pure` are homed at the latch's SECOND op; the `reread` family's three MATCH
// controls — `ereadctl`, `ername`, `rereadctl` — at its first, whose def renders no statement of its
// own, so for them the two placements spell the same body. Emitting every admitted copy at the top
// of the body instead takes `preupdate_exit_pure` from MATCH to diff:2/14 and leaves those three
// MATCHing, so the position is load-bearing for a row and the three controls are indifferent to it
// rather than protected by it. A RECORD of a measurement, not a live check: the position is pinned
// by `a sunk copy is rebuilt at the op that computed its value` below, and at the seam by
// hazards.test.ts's `an admitted slot carries the position it was cleared at`.
//
// A refusal test that declines for the WRONG reason reads as a pass, so each one pins the message
// and carries a positive control: either the accepted fixture emitted first, or — where the
// refusal turns on one fact — the same IR with that fact changed. The two back-edge-alias fixtures
// pin the whole emitted function instead: under a loop variable's name their arm would rebind it,
// and what they hold is that the name stays with the loop.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { defOpMap, dominators } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { analyze } from '../src/structure/analysis';
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
    's32 trailingptr(s32 *a0) {\n' +
      '    s32 *v0;\n' +
      '    s32 *v1;\n' +
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

// The exit arg COMPUTES from the loop variable instead of being it. The copy is REBUILT inside the
// body, where the loop variable's name still holds the value the edge read, so the arithmetic is
// spelled again there rather than moved.
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

test('do-while: a PURE computed exit arg is rebuilt inside the body', () => {
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
    's32 trailingptr(s32 *a0, s32 *a1) {\n' +
      '    s32 *v0;\n' +
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

// WHERE the rebuilt copy lands. The body STORES before it computes the exit arg, so the two
// statements have an order the target's code fixes, and only one of them is the order the source
// wrote: the copy belongs at the shift, which is where the loop already evaluated it. Emitted
// opening the body instead it would re-evaluate the tree ahead of a store it originally followed —
// which is also the motion `arg-safe-to-reevaluate` exists to refuse.
const SUNK_AFTER_A_STORE = `fn sunkafterstore {
^bb0(%0: s32):
  %1: s32* = gaddr {sym="gbuf"}
  br ^bb1(%0)
^bb1(%2: s32):
  store %1, %2 {off=0, width=4}
  %3: s32 = const {value=3}
  %4: s32 = shl %2, %3
  %5: s32 = const {value=1}
  %6: s32 = sub %2, %5
  %7: s32 = const {value=0}
  %8: u32 = icmp_ne %6, %7
  cond_br %8, ^bb1(%6), ^bb2(%4)
^bb2(%9: s32):
  ret %9
}
`;

test('a sunk copy is rebuilt at the op that computed its value, not ahead of the body', () => {
  expect(emit(SUNK_AFTER_A_STORE)).toBe(
    's32 sunkafterstore(s32 a0) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    v0 = a0;\n' +
      '    do {\n' +
      '        gbuf = v0;\n' +
      '        v1 = v0 << 3;\n' +
      '        v0 = v0 - 1;\n' +
      '    } while (v0 != 0);\n' +
      '    return v1;\n' +
      '}\n',
  );
});

// An early-`return` arm lets an iteration leave the loop BEFORE the latch, so a tree rebuilt at the
// TOP of the body is one that iteration never evaluated — for a divide, a fault where the IR
// returned. Rebuilt at the divide's OWN position the question does not arise: that position is in
// the latch, which the arm has already declined to leave.
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

test('a trapping op is rebuilt at its own position, behind the arm that leaves first', () => {
  // The arm's `return` is emitted AHEAD of the copy, so the divide runs on exactly the iterations
  // the IR divided on. Replacing it with a multiply — the one fact the placement cannot depend on —
  // emits the same loop with the same statement in the same place.
  expect(emit(SPECULATED_DIVIDE)).toBe(
    's32 specarm(s32 a0, s32 a1) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    v0 = 0;\n' +
      '    do {\n' +
      '        if (a1 >= 0) {\n' +
      '            if (a0 == 0) return v0;\n' +
      '        }\n' +
      '        v1 = v0 / a0;\n' +
      '        v0 = v0 + 1;\n' +
      '    } while (v0 < a1);\n' +
      '    return v1;\n' +
      '}\n',
  );
  expect(emit(SPECULATED_DIVIDE.replace('sdiv %3, %0', 'mul %3, %0'))).toBe(
    emit(SPECULATED_DIVIDE).replace('v1 = v0 / a0;', 'v1 = v0 * a0;'),
  );
});

// A merge inside the body whose every edge passes ONE value may share that value's own name — but
// not a loop variable's name offered for it through the back edge: that name holds the value only
// once the back edge has run, and the arm's copy into it would be a real write partway through the
// body, read raw by everything after it (the rebind the sink stands down on). Here ^bb3's param is
// fed `%9`, the back-edge arg of `%7`, so the arm spells its own local and the update keeps `%7`'s
// name: the loop returns the IR's `%7 * %6` over the pre-update values.
const BACK_EDGE_ALIAS_IN_AN_ARM = `fn rebind {
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

test('a body merge fed a back-edge arg does not take the loop variable name', () => {
  // Under the loop variable's name the arm would write `v2 = v2 ^ a0` and the update then read `v2`:
  // 9 at (a0, a1) = (3, -2), where the IR returns 0.
  expect(emit(BACK_EDGE_ALIAS_IN_AN_ARM)).toBe(
    's32 rebind(s32 a0, s32 a1) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    s32 v2;\n' +
      '    s32 v3;\n' +
      '    s32 v4;\n' +
      '    s32 v5;\n' +
      '    s32 v6;\n' +
      '    v0 = 0;\n' +
      '    v1 = 0;\n' +
      '    v2 = 0;\n' +
      '    do {\n' +
      '        if (v2 >= (v2 ^ a0)) {\n' +
      '            v4 = v2 ^ a0;\n' +
      '            v5 = a0;\n' +
      '        } else {\n' +
      '            v3 = v2 * v0;\n' +
      '            v5 = v0;\n' +
      '        }\n' +
      '        v6 = v2 * v1;\n' +
      '        v1 = a0;\n' +
      '        v2 = v2 ^ a0;\n' +
      '        v0 = v0 + 1;\n' +
      '    } while (v0 < v1);\n' +
      '    return v6;\n' +
      '}\n',
  );
});

// The same shape with NOTHING reading the loop variable's name at the bottom of the loop but a
// store in the latch — the reader a screen over the update and the test would miss. The arm's merge
// is dead and takes no name; the latch stores `%5` before the update writes it, and the exit's
// pre-update copy of `%5` is sunk to the top of the body.
const BACK_EDGE_ALIAS_READ_BY_A_STORE = `fn rb2 {
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

test('a latch store of a loop variable reads it ahead of the update, with no arm writing it', () => {
  // Under the loop variable's name an arm would overwrite v1 ahead of `gbuf[1] = v1`: at a0 = 3 the
  // IR stores 0, 0, 1 and that C would store 0, 1, 4.
  expect(emit(BACK_EDGE_ALIAS_READ_BY_A_STORE)).toBe(
    's32 rb2(s32 a0) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    s32 v2;\n' +
      '    s32 v3;\n' +
      '    v0 = 0;\n' +
      '    v1 = 0;\n' +
      '    do {\n' +
      '        v3 = v1;\n' +
      '        if (v0 < a0) {\n' +
      '            v2 = v0 * v0;\n' +
      '            *(s32 *)&gbuf = v2;\n' +
      '        }\n' +
      '        ((s32 *)&gbuf)[1] = v1;\n' +
      '        v1 = v0 * v0;\n' +
      '        v0 = v0 + 1;\n' +
      '    } while (v0 < a0);\n' +
      '    return v3;\n' +
      '}\n',
  );
});

// ONE CALL, TWO EXIT SLOTS. The exit edge hands `f1(v2) + v2` to two merge params; sunk, each copy
// would rebuild the tree and run `f1` twice per iteration where the asm ran it once. A call riding
// an edge through the ops it is inlined into is named where it ran (`ridesEdge`,
// structure/analysis.ts), so both copies read the name. The control reads memory where the call
// was: two copies of a READ are two loads, a spelling rather than a different program, and both
// slots sink with the read inline.
const ONE_CALL_TWO_SLOTS = `fn dupcall {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(), ^bb3(%0, %0)
^bb1():
  br ^bb2(%1, %0)
^bb2(%4: s32, %5: s32):
  %6: s32 = call %5 {target="f1"}
  %7: s32 = add %6, %5
  %8: s32 = const {value=1}
  %9: s32 = sub %4, %8
  %10: s32 = add %5, %8
  %11: u32 = icmp_slt %2, %9
  cond_br %11, ^bb2(%9, %10), ^bb3(%7, %7)
^bb3(%12: s32, %13: s32):
  %14: s32 = add %12, %13
  ret %14
}
`;

test('two sunk exit slots never spell one call twice', () => {
  const calls = emit(ONE_CALL_TWO_SLOTS).split('do {')[1].split('} while')[0];
  expect(calls.match(/f1\(/g)).toHaveLength(1);
  expect(calls.match(/= v1 \+ v3;/g)).toHaveLength(2);
  const read = ONE_CALL_TWO_SLOTS.replace('call %5 {target="f1"}', 'load %5 {off=0, signed=true, width=4}');
  expect(read).not.toBe(ONE_CALL_TWO_SLOTS);
  const body = emit(read).split('do {')[1].split('} while')[0];
  expect(body.match(/= \*\(s32 \*\)v\d+ \+ v\d+;/g)).toHaveLength(2);
});

// THE CALL AHEAD OF A READ, `r = *q + cb(q)`: agbcc runs `bl cb; ldr r1,[q]; add`, so the exit
// arg's tree holds a call with the load between it and the add the copy is rebuilt at. The call rides
// the exit edge under the `add`, so the analysis names it where it ran — the order `t = cb(q); r =
// *q + t;` spells, byte-identical to the original on agbcc — and the sink rebuilds `*v1 + v0` at the
// add, behind the name. The control swaps ONE fact, the order of the load and the call: `int t =
// *q; r = t + cb(q);` compiles to `ldr; bl; add`, and the barrier scan names the read too (a read
// ahead of a call it shares a statement with). With both named the exit value reads no loop
// variable, so nothing is rebuilt in the body and the copy stays after the loop.
const CALL_THEN_LOAD = `fn calllast {
^bb0(%0: s32*, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_sle %1, %3
  cond_br %4, ^bb3(%2), ^bb1()
^bb1():
  br ^bb2(%0, %1)
^bb2(%7: s32*, %8: s32):
  %9: s32 = call %7 {target="cb"}
  %10: s32 = load %7 {off=0, signed=true, width=4}
  %11: s32 = add %10, %9
  %12: s32 = const {value=4}
  %13: s32* = sub %7, %12
  %14: s32 = const {value=1}
  %15: s32 = sub %8, %14
  %16: s32 = const {value=0}
  %17: u32 = icmp_ne %15, %16
  cond_br %17, ^bb2(%13, %15), ^bb3(%11)
^bb3(%18: s32):
  ret %18
}
`;
const LOAD_THEN_CALL = CALL_THEN_LOAD.replace(
  '  %9: s32 = call %7 {target="cb"}\n  %10: s32 = load %7 {off=0, signed=true, width=4}\n',
  '  %10: s32 = load %7 {off=0, signed=true, width=4}\n  %9: s32 = call %7 {target="cb"}\n',
);

const homedCalls = (ir: string): string[] => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const { materialize } = analyze(fn, false, { defs: defOpMap(fn), dom: dominators(fn) });
  return fn.blocks.flatMap((b) => b.ops).flatMap((op) => (op.opcode === 'call' && materialize.has(op) ? ['cb'] : []));
};

test('a call riding the exit edge under a read is named where it ran, in either order', () => {
  expect(LOAD_THEN_CALL).not.toBe(CALL_THEN_LOAD);
  expect(homedCalls(CALL_THEN_LOAD)).toEqual(['cb']);
  expect(homedCalls(LOAD_THEN_CALL)).toEqual(['cb']);
});

test('the named call is current at the copy, and the exit value is rebuilt behind it', () => {
  // `a2 = *v1 + v0` reads `v0` one statement after `v0 = cb(v1)` wrote it, on the same iteration,
  // and `v1` ahead of its update: the value the exit edge carried. In the load-first order both
  // are named and the copy after the loop reads only their names.
  expect(emit(CALL_THEN_LOAD)).toBe(
    's32 calllast(s32 *a0, s32 a1, s32 a2) {\n' +
      '    s32 v0;\n' +
      '    s32 *v1;\n' +
      '    s32 v2;\n' +
      '    if (a1 > 0) {\n' +
      '        v1 = a0;\n' +
      '        v2 = a1;\n' +
      '        do {\n' +
      '            v0 = cb(v1);\n' +
      '            a2 = *v1 + v0;\n' +
      '            v1 = v1 - 1;\n' +
      '            v2 = v2 - 1;\n' +
      '        } while (v2 != 0);\n' +
      '    }\n' +
      '    return a2;\n' +
      '}\n',
  );
  expect(emit(LOAD_THEN_CALL)).toContain(
    '            v0 = *v2;\n            v1 = cb(v2);\n            v2 = v2 - 1;\n            v3 = v3 - 1;\n' +
      '        } while (v3 != 0);\n        a2 = v0 + v1;\n',
  );
});
