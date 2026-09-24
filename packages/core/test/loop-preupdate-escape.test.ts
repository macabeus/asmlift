// A LOOP VARIABLE READ AFTER THE LOOP IS ONE UPDATE BEHIND, and reading it under the loop's own
// name is a silent miscompile.
//
// Both loop emitters that place the update at the BOTTOM of the body — the self-loop `while` and
// the do-while — leave that name holding the value the test failed on. The back-edge ARG means
// that; the block PARAM means the value at the top of the last iteration, and `sub` maps only the
// former. `structure/hazards.ts` used to exempt every loop-carried param from the escape check on
// the grounds that a post-loop read of the updated name is exactly the intended final value —
// true of the arg, false of the param. The emitted C stored `i` where the reference stored `i-1`;
// it compiled, it scored, and no gate saw it, because regression, diff and corpus sweeps measure
// REACH and never correctness. agbcc spells the difference out by keeping a second register:
//
//   .L10: add r3, r1, #0   @ r3 = n            for (n = 0; n < i; n++) { ...; }
//         add r1, r3, #0x1 @ r1 = n + 1        *(s32 *)(b + m*24 + 4) = n;   <- n, not n+1
//         blt .L10
//         str r3, [r2, #0x4]
//
// WHICH ANSWER THE HAZARD GETS DEPENDS ON HOW SSA SPELLED THE VALUE, and all three spellings are
// here: crossing the exit as an edge ARG it is REPAIRED (`sinkablePreUpdateSlots` re-emits the copy
// inside the body, ahead of the update, which is the listing above); computed by a body OP and read
// after the loop it is NAMED at that op (`escapesAheadOfUpdate`, structure/analysis.ts); read from
// the header PARAM it DECLINES, there being neither an exit slot to sink nor an op to name. A
// refusal test that declines for the WRONG reason reads as a pass, so each case pins the message
// and carries a control differing in ONE fact.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 96 }, (_, k) => 1 + k * 4099);

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// The lifted shape of the agbcc listing above, reduced to one loop. ^bb1 is header and latch; the
// counter %2 is updated to %4 and the back edge carries %4, so post-loop the name holds %4's
// value. ^bb2 stores %2 — the PRE-update counter.
const STORE_PREUPDATE = `fn storepre {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2()
^bb2():
  store %0, %2 {off=4, width=4}
  ret
}
`;

// THE ONE FACT CHANGED: the store takes the POST-update value, which is what the name holds.
const STORE_POSTUPDATE = STORE_PREUPDATE.replace('store %0, %2 {off=4, width=4}', 'store %0, %4 {off=4, width=4}');

// THE SAME PROGRAM, SPELLED THE OTHER WAY: the pre-update value crosses the exit as an edge ARG
// into a merge param instead of being read from the header param. `sinkablePreUpdateSlots` REPAIRS
// this one — the copy moves into the body, ahead of the update — so the two spellings of one
// hazard get opposite answers, and the boundary between them is an SSA-construction artifact
// rather than a property of the program. Pinned here so the decline above is read as scoped to
// "no exit slot to sink", never as "this hazard is unrepairable".
const STORE_PREUPDATE_ON_EDGE = `fn storepre {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2(%2)
^bb2(%6: s32):
  store %0, %6 {off=4, width=4}
  ret
}
`;

test('a post-loop store of the PRE-update counter declines instead of storing the post-update one', () => {
  expect(() => emit(STORE_PREUPDATE)).toThrow(StructureError);
  expect(() => emit(STORE_PREUPDATE)).toThrow(/reads a pre-update loop variable/);
});

test('the same loop storing the POST-update counter emits, and stores the counter', () => {
  const out = emit(STORE_POSTUPDATE);
  expect(out).toMatch(/while \(|do \{/);
  // whatever the counter is named, the store takes it — not a second local
  const name = out.match(/(\w+) = \1 \+ 1;/)?.[1];
  expect(name).toBeDefined();
  expect(out).toContain(`= ${name};`);
});

test('the same pre-update value crossing the exit EDGE is repaired, not declined', () => {
  const out = emit(STORE_PREUPDATE_ON_EDGE);
  const counter = out.match(/(\w+) = \1 \+ 1;/)?.[1];
  expect(counter).toBeDefined();
  // the trailing copy sits inside the body AHEAD of the update, so it holds the pre-update value
  const trailing = out.match(new RegExp(`(\\w+) = ${counter};\\s+${counter} = ${counter} \\+ 1;`))?.[1];
  expect(trailing).toBeDefined();
  // and the post-loop store takes that copy, never the moved-on counter
  expect(out).toContain(`= ${trailing};`);
  expect(out).not.toContain(`= ${counter};\n    return`);
});

// A BODY OP'S VALUE READ AFTER THE LOOP. agbcc keeps it in a register of its own —
// `preupdate_escape`'s `add r3, r0, #0x4` inside the loop and `str r3, [r2]` after it — so the value
// is neither an exit arg nor a loop variable: %7 is `%2 * 3`, computed from the PRE-update counter,
// and read only by ^bb2.
const ESCAPED_OP = `fn escop {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %6: s32 = const {value=3}
  %7: s32 = mul %2, %6
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2()
^bb2():
  store %0, %7 {off=4, width=4}
  ret
}
`;

test('a body op read after the loop is named where it was computed, ahead of the update', () => {
  const out = emit(ESCAPED_OP);
  const m = out.match(/(\w+) = (\w+) \* 3;\s+\2 = \2 \+ 1;/);
  expect(m).not.toBeNull();
  expect(out).toContain(`a0[1] = ${m![1]};`);
});

// THE ONE FACT CHANGED: the op reads the BACK-EDGE ARG, the post-update counter, which is what the
// name holds after the loop — so it still renders at its reader.
test('a body op over the post-update counter renders at its reader, unnamed', () => {
  const out = emit(ESCAPED_OP.replace('%7: s32 = mul %2, %6', '%7: s32 = mul %4, %6'));
  expect(out).toMatch(/a0\[1\] = (\w+) \* 3;/);
  expect(out).not.toMatch(/\w+ = \w+ \* 3;\s+\w+ = \w+ \+ 1;/);
});

// A CALL under the value is named by the cross-block call rule wherever it would render outside its
// block, so what the post-loop read re-evaluates is the call's NAME — nothing reads the counter.
// Walking through it instead names `synthetic:esccast:agbcc`'s `(u16)` extension by default and
// takes that MATCH row's `/escape-home` candidate out of its fan.
test('a body op over a call renders at its reader, the call named in the loop', () => {
  const out = emit(
    ESCAPED_OP.replace(
      '%6: s32 = const {value=3}\n  %7: s32 = mul %2, %6',
      '%10: s32 = call %2 {target="cb"}\n  %6: s32 = const {value=3}\n  %7: s32 = add %10, %6',
    ),
  );
  const m = out.match(/(\w+) = cb\(\w+\);/);
  expect(m).not.toBeNull();
  expect(out).toContain(`a0[1] = ${m![1]} + 3;`);
});

// A reader in an early-RETURN arm leaves from the middle of the body, before the update, so the
// counter's name still holds the value the op read. Measured on `kleod:sub_08014184:agbcc`, whose
// arm spells `(struct Struct1 *)(v3 + v1)` inline and would otherwise gain a local.
const ESCAPED_TO_ARM = `fn escmid {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %6: s32 = const {value=3}
  %7: s32 = mul %2, %6
  br ^bb5()
^bb5():
  %8: u32 = icmp_eq %7, %1
  cond_br %8, ^bb3(), ^bb4()
^bb4():
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2()
^bb3():
  store %0, %7 {off=4, width=4}
  ret
^bb2():
  ret
}
`;

test('a body op read only by an early-return arm renders in the arm, unnamed', () => {
  const out = emit(ESCAPED_TO_ARM);
  expect(out).toMatch(/if \((\w+) \* 3 == a1\) \{\s+a0\[1\] = \1 \* 3;\s+return;/);
});

// A header that leaves the loop may become the loop's own test, and then the LATCH's exit is an arm
// rendered inside the body, ahead of the update — the reader above again, reached another way.
const LATCH_EXIT_AS_ARM = `fn escle {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %8: u32 = icmp_eq %2, %1
  cond_br %8, ^bb3(), ^bb4()
^bb4():
  %6: s32 = const {value=3}
  %7: s32 = mul %2, %6
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2()
^bb3():
  ret
^bb2():
  store %0, %7 {off=4, width=4}
  ret
}
`;

test('a latch op read past the latch exit of a loop its header also leaves renders at its reader', () => {
  const out = emit(LATCH_EXIT_AS_ARM);
  expect(out).toMatch(/while \((\w+) != a1\)/);
  expect(out).toMatch(/a0\[1\] = (\w+) \* 3;\s+return;/);
});

// A MEMORY READ is the same value home — `do { s = f->v; f = f->next; } while (--n); *out = s;` —
// and naming a load at its own position keeps the asm's read order as well.
const ESCAPED_LOAD = `fn escload {
^bb0(%0: s32*, %1: s32, %20: s32*):
  %9: s32 = const {value=0}
  br ^bb1(%9, %20)
^bb1(%2: s32, %21: s32*):
  %7: s32 = load %21 {off=4, signed=true, width=4}
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %22: s32* = load %21 {off=0, signed=false, width=4}
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4, %22), ^bb2()
^bb2():
  store %0, %7 {off=4, width=4}
  ret
}
`;

test('a body load read after the loop is named where it read, ahead of the update', () => {
  const out = emit(ESCAPED_LOAD);
  const m = out.match(/(\w+) = (\w+)\[1\];[\s\S]*\2 = \(s32 \*\)\*\2;/);
  expect(m).not.toBeNull();
  expect(out).toContain(`a0[1] = ${m![1]};`);
});

// A value another rule has already NAMED renders as that name after the loop, whatever it read:
// here a store between the load and its reader names the load, and the `+ 1` over it stays at the
// reader. The rule is asked only after the other rules settle, so it sees that name.
const OVER_A_NAMED_LOAD = `fn escnamed {
^bb0(%0: s32*, %1: s32, %20: s32*):
  %9: s32 = const {value=0}
  br ^bb1(%9, %20)
^bb1(%2: s32, %21: s32*):
  %7: s32 = load %21 {off=4, signed=true, width=4}
  %40: s32 = const {value=0}
  store %21, %40 {off=4, width=4}
  %41: s32 = const {value=1}
  %8: s32 = add %7, %41
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %22: s32* = load %21 {off=0, signed=false, width=4}
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4, %22), ^bb2()
^bb2():
  store %0, %8 {off=4, width=4}
  ret
}
`;

test('a body op over a load another rule named renders at its reader', () => {
  const out = emit(OVER_A_NAMED_LOAD);
  const m = out.match(/(\w+) = \w+\[1\];/);
  expect(m).not.toBeNull();
  expect(out).toContain(`a0[1] = ${m![1]} + 1;`);
});

// A def in an INNER loop's multi-block header has no seat there — that loop is a test-at-top
// `while` — so it is left unnamed and the outer loop declines on the pre-update read, which is the
// gap it has, rather than on the inner loop's shape.
const IN_AN_INNER_WHILE_HEADER = `fn escinner {
^bb0(%0: s32*, %1: s32):
  %9: s32 = const {value=0}
  br ^bb1(%9)
^bb1(%2: s32):
  %30: s32 = const {value=0}
  br ^bb5(%30)
^bb5(%31: s32):
  %6: s32 = const {value=3}
  %7: s32 = mul %2, %6
  %32: u32 = icmp_slt %31, %7
  cond_br %32, ^bb6(), ^bb7()
^bb6():
  %33: s32 = const {value=1}
  %34: s32 = add %31, %33
  br ^bb5(%34)
^bb7():
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(%4), ^bb2()
^bb2():
  store %0, %7 {off=4, width=4}
  ret
}
`;

test('a body op in an inner while header stays unnamed, and the loop declines on the pre-update read', () => {
  expect(() => emit(IN_AN_INNER_WHILE_HEADER)).toThrow(/reads a pre-update loop variable/);
});

// A body block param fed a loop variable's BACK-EDGE ARG does not take that variable's name (the
// rebind the sink stands down on, which would write it partway through the body). Here %10 is fed
// %2, the back-edge arg of %4, ahead of `%11 = sub %3, %4`; the loop keeps %4's value and the escaped
// `%11` is named at its def.
const BACK_EDGE_ALIAS_BESIDE_A_HOME = `fn escrebind {
^bb0(%0: s32, %1: s32):
  %2: s32 = add %0, %1
  %3: s32 = add %0, %2
  br ^bb1(%0)
^bb1(%4: s32):
  %5: s32 = call %1 {target="h"}
  br ^bb2(%2)
^bb2(%10: s32):
  %11: s32 = sub %3, %4
  %12: s32 = call %11 {target="f1"}
  %15: s32 = call %10 {target="g"}
  %24: u32 = icmp_slt %12, %1
  cond_br %24, ^bb7(), ^bb1(%2)
^bb7():
  %26: s32 = add %11, %15
  ret %26
}
`;

test('a pre-update home beside a merge fed a back-edge arg computes what the IR computes', () => {
  const fn = parse(BACK_EDGE_ALIAS_BESIDE_A_HOME);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn);
  const r = irAgreement(BACK_EDGE_ALIAS_BESIDE_A_HOME, sfn, SEEDS);
  expect(r.judged).toBe(29); // the other inputs run past the interpreter's step cap
  expect(r.disagree).toBe(0);
});
