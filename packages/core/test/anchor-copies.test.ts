// Def-site anchoring of constant merge copies (structure.ts anchorConstCopies): an edge copy
// `v = K` whose constant the asm materialized EARLIER — `movs r9, #0` at entry ahead of a
// single-armed overwrite — is emitted at the const op's original position and the edge copy is
// suppressed. Off by default; rank.ts enumerates it as the `/defsite` axis.
//
// The refusal conditions are what make it sound, so they are what these tests pin hardest:
// in-loop shapes decline outright (per-iteration precedence is not dominance — the /preinit
// sticky-arm class), and a const whose write could clobber another anchored arg on a path to its
// edge keeps the edge placement.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string, anchor: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { anchorConstCopies: anchor }));
};

// v = 0 at entry, conditionally overwritten to 1 — the asm shape `movs r9, #0` … `bne skip;
// movs r9, #1`. Anchored: the pre-initialization above a single-armed POSITIVE if (the emptied
// arm flips the condition). Unanchored: the two-armed spelling.
const PREINIT = `fn preinit {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=7}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb2(%1), ^bb1()
^bb1():
  %4: s32 = const {value=1}
  br ^bb2(%4)
^bb2(%5: s32):
  ret %5
}
`;

test('an entry const anchors above the if; the emptied arm flips it single-armed positive', () => {
  expect(emit(PREINIT, true)).toBe(
    's32 preinit(s32 a0) {\n    s32 v0;\n    v0 = 0;\n    if (a0 == 7) v0 = 1;\n    return v0;\n}\n',
  );
});

test('off by default: the same IR keeps the two-armed edge placement', () => {
  const off = emit(PREINIT, false);
  expect(off).toContain('if (a0 == 7)');
  expect(off).toContain('v0 = 0;');
  expect(off).toContain('v0 = 1;');
  expect(emit(PREINIT, false)).toBe(off); // and the option default matches anchor:false
});

// v = 1 at the TOP of an arm, ahead of a nested if whose both exits carry it — the asm shape
// `movs r5, #1` before the inner branch. Anchored, the assignment opens the arm instead of
// tail-merging to its end.
const ARMTOP = `fn armtop {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %0, %2
  cond_br %3, ^bb1(), ^bb4(%2)
^bb1():
  %4: s32 = const {value=1}
  %5: s32 = const {value=99}
  %6: u32 = icmp_sle %0, %5
  cond_br %6, ^bb4(%4), ^bb2()
^bb2():
  %7: s32 = const {value=3}
  store %1, %7 {off=0, width=4}
  br ^bb4(%4)
^bb4(%8: s32):
  ret %8
}
`;

test('an arm-top const opens its arm, ahead of the nested if', () => {
  const out = emit(ARMTOP, true);
  const arm = out.indexOf('v0 = 1;');
  const inner = out.indexOf('if (a0 > 99)');
  expect(arm).toBeGreaterThan(-1);
  expect(inner).toBeGreaterThan(-1);
  expect(arm).toBeLessThan(inner); // the write PRECEDES the nested if, as the asm placed it
  expect(out).toContain('v0 = 0;\n    if (a0 == 0)'); // and the entry const still pre-initializes
});

// CLOBBER REFUSAL: two anchorable consts of the same variable where one's write lies on a path
// from the other to the other's edge (bb0's 0 → bb1's 1 → bb2 → the edge carrying 0). Anchoring
// both would deliver 1 where the SSA says 0, so the threatened one keeps its edge placement.
const CLOBBER = `fn clobber {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=7}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb2(), ^bb1()
^bb1():
  %4: s32 = const {value=1}
  %5: s32 = const {value=9}
  %6: u32 = icmp_ne %0, %5
  cond_br %6, ^bb3(%4), ^bb2()
^bb2():
  br ^bb3(%1)
^bb3(%7: s32):
  ret %7
}
`;

test('a const whose edge another anchored write could reach keeps its edge placement', () => {
  const out = emit(CLOBBER, true);
  // the threatened 0-copy stays ON its edge (inside an arm), never as a function-top pre-init
  expect(out.startsWith('s32 clobber(s32 a0) {\n    s32 v0;\n    v0 = 0;')).toBe(false);
  expect(out).toContain('v0 = 0;');
  expect(out).toContain('v0 = 1;');
});

// LOOP REFUSAL: the same diamond INSIDE a loop body declines outright — block-level dominance
// does not give per-iteration precedence, so an anchored write could go stale across iterations
// (the /preinit sticky-arm class). Output must be byte-identical to the unanchored spelling.
const IN_LOOP = `fn loopy {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(), ^bb5(%2)
^bb2():
  %4: s32 = const {value=5}
  %5: u32 = icmp_eq %2, %4
  cond_br %5, ^bb4(%4), ^bb3()
^bb3():
  %6: s32 = const {value=9}
  br ^bb4(%6)
^bb4(%7: s32):
  %8: s32 = add %2, %7
  br ^bb1(%8)
^bb5(%9: s32):
  ret %9
}
`;

test('an in-loop merge declines anchoring entirely', () => {
  expect(emit(IN_LOOP, true)).toBe(emit(IN_LOOP, false));
});

// SWITCH REFUSAL (adversarial round, CRITICAL 2): an eq-chain whose NON-ROOT test block carries
// an anchored write — `%3` feeds both ^bb1's compare and (via the ^bb4 case body) the merge arg,
// so it anchors at ^bb1, and collapsing the chain to a `switch` would DISCARD ^bb1's body while
// the edge copy stays suppressed: s(1) would return 0. The anchored spelling must fall back to
// the if-chain, which emits every block's statements.
const EQ_CHAIN = `fn swanchor {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_eq %0, %1
  cond_br %2, ^bb3(), ^bb1()
^bb1():
  %3: s32 = const {value=1}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb4(), ^bb2()
^bb2():
  %5: s32 = const {value=2}
  %6: u32 = icmp_eq %0, %5
  cond_br %6, ^bb5(), ^bb6()
^bb3():
  br ^bb7(%1)
^bb4():
  br ^bb7(%3)
^bb5():
  %7: s32 = const {value=9}
  br ^bb7(%7)
^bb6():
  %8: s32 = const {value=7}
  br ^bb7(%8)
^bb7(%9: s32):
  ret %9
}
`;

test('a test block carrying an anchored write is never consumed as a discarded test — the write survives', () => {
  const off = emit(EQ_CHAIN, false);
  expect(off).toContain('switch ('); // the shape IS a switch without anchoring
  // With anchoring, ^bb1 may not be swallowed as a pure test block; it becomes the ROOT of a
  // smaller switch instead — roots emit their statements (including the anchored write) before
  // the switch, so the write survives, ORDERED before the dispatch.
  const on = emit(EQ_CHAIN, true);
  const write = on.indexOf('v0 = 1;');
  expect(write).toBeGreaterThan(-1);
  const dispatch = on.indexOf('switch (');
  if (dispatch !== -1) {
    expect(write).toBeLessThan(dispatch);
  }
});

// LOOP-HEADER ENTRY ARG: the one merge arg whose def legitimately sits far above its edge —
// `int s = 0;` at the top of a function, ahead of a `for` that accumulates into it. The
// accumulator's back-edge value shares its name, which is why the blanket name-count rule cannot
// decide this shape; what makes it sound is that every OTHER claimant lives inside the body, so
// the only write to the name outside the loop is the anchored one.
const ACCUM = `fn accum {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: s32 = const {value=5}
  br ^bb3(%4)
^bb2():
  %5: s32 = const {value=9}
  br ^bb3(%5)
^bb3(%6: s32):
  br ^bb4(%2, %6)
^bb4(%7: s32, %8: s32):
  %9: s32 = add %7, %8
  %10: s32 = const {value=1}
  %11: s32 = sub %8, %10
  %12: s32 = const {value=0}
  %13: u32 = icmp_sge %11, %12
  cond_br %13, ^bb4(%9, %11), ^bb5()
^bb5():
  ret %9
}
`;

test("a loop header's entry const anchors at its def site, above the if the preheader sits under", () => {
  expect(emit(ACCUM, false)).toContain('    }\n    v0 = 0;\n'); // preheader placement, below the if
  expect(emit(ACCUM, true)).toContain(
    's32 accum(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    v0 = 0;\n    if (',
  );
});

// Two forward preds: each writes the name at its OWN edge, outside the body, so suppressing one
// leaves a path into the header carrying the other's value.
const TWO_PREHEADERS = `fn twopre {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: s32 = const {value=5}
  br ^bb4(%2, %4)
^bb2():
  %5: s32 = const {value=9}
  br ^bb4(%2, %5)
^bb4(%7: s32, %8: s32):
  %9: s32 = add %7, %8
  %10: s32 = const {value=1}
  %11: s32 = sub %8, %10
  %12: s32 = const {value=0}
  %13: u32 = icmp_sge %11, %12
  cond_br %13, ^bb4(%9, %11), ^bb5()
^bb5():
  ret %9
}
`;

test('a loop header entered from two preheaders declines', () => {
  expect(emit(TWO_PREHEADERS, true)).toBe(emit(TWO_PREHEADERS, false));
});

// The exit merge carries the accumulator under the SAME name from a block outside the body, so a
// write to it exists outside the loop and the "only the anchored one" premise fails.
const OUTSIDE_CLAIMANT = `fn outside {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: s32 = const {value=5}
  br ^bb3(%4)
^bb2():
  %5: s32 = const {value=9}
  br ^bb3(%5)
^bb3(%6: s32):
  br ^bb4(%2, %6)
^bb4(%7: s32, %8: s32):
  %9: s32 = add %7, %8
  %10: s32 = const {value=1}
  %11: s32 = sub %8, %10
  %12: s32 = const {value=0}
  %13: u32 = icmp_sge %11, %12
  cond_br %13, ^bb4(%9, %11), ^bb5(%9)
^bb5(%14: s32):
  %15: s32 = const {value=3}
  %16: s32 = mul %14, %15
  ret %16
}
`;

test('a name claimed by a value outside the loop body declines', () => {
  expect(emit(OUTSIDE_CLAIMANT, true)).toBe(emit(OUTSIDE_CLAIMANT, false));
});
