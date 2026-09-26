// A NAME ADOPTED WHILE SOMETHING STILL READS ITS OLD CONTENTS.
//
// `structure.ts`'s `canTakeName` asks which values live at the merge are STORED under the name it
// is about to overwrite. That is the whole question only while every value is stored somewhere. An
// inlined value is not: it is re-derived at its use out of whatever its operands are called then,
// so a value live across the merge whose expression mentions the name reads the merge's assignment
// rather than what it was defined from — and the emitted C computes a different number, at the
// same score, in ordinary-looking C.
//
// The fixtures below are what a compiler really emits for the C in their comments, so this is a
// property of the committed path and not of hand-written IR. The rule is the structurer's, so it
// is given its own input here rather than reached through a frontend.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { CARRIER_NAME_GATES, structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const emit = (ir: string, drop?: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, {}, drop ? { carrierNameGates: without(CARRIER_NAME_GATES, drop) } : {}));
};

/** `s32 t = a - b; if (a > 0) { a = a + b; } return a + t;` — agbcc: `sub r2,r0,r1 / cmp r0,#0 /
 *  ble .L3 / add r0,r0,r1 / .L3: add r0,r0,r2`. `%2` has no name and is live across the merge. */
const RE_DERIVED_ACROSS_MERGE = `fn f {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = sub %0, %1
  %3: unk32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: unk32 = add %0, %1
  br ^bb3(%5)
^bb2():
  br ^bb3(%0)
^bb3(%6: unk32):
  %7: unk32 = add %6, %2
  ret %7
}
`;

describe('a merge may not adopt a name an unnamed live value re-derives from', () => {
  test('the inlined difference keeps reading the value the asm computed it from', () => {
    const src = emit(RE_DERIVED_ACROSS_MERGE);
    // `a0 - a1` must be read from the ORIGINAL a0 — so a0 is never the merge's home here
    expect(src).not.toMatch(/a0 = a0 \+ a1/);
    expect(src).toContain('(a0 - a1)');
    // and the merge lands in a name of its own
    expect(src).toMatch(/v0 \+ \(a0 - a1\)/);
  });

  test('with nothing live across it the same merge still takes the name', () => {
    // The control that says the rule is not "never adopt": drop the one unnamed live value and the
    // adoption is sound again, which is the coalescing every loop and branch row depends on.
    const ir = RE_DERIVED_ACROSS_MERGE.replace('  %2: unk32 = sub %0, %1\n', '').replace('add %6, %2', 'add %6, %1');
    expect(emit(ir)).toMatch(/a0 = a0 \+ a1/);
  });
});

/** `int g4(int a, int b, int c, int d){ int t = a, u = a; do { u = (t ^ b) * -u; { int w = b; b = u;
 *  u = w; } u = (a + t) + u; } while (--d > 0); b = u + t; return (c != 1 ? u : b) * u; }` at the
 *  synthetic tier's mwcc_242_81 flags. The loop's exit value `%14` (`u`) has no `varName` of its own:
 *  it is the back-edge argument of `%5`, so it carries `v0` through `backArgName`, and after the loop
 *  it renders as `v0`. The merge `%19` may not take that name — the final multiply still reads `u`. */
const BACK_ARG_NAMED_LIVE_ACROSS_MERGE = `fn g4 {
^bb0(%0: s32, %1: s32, %2: s32, %3: s32):  ; writes=2
  %4: s32 = add %0, %0
  br ^bb1(%0, %1, %3) {fallthrough=true}  ; order ^bb1(0, -, -)
^bb1(%5: s32, %6: s32, %7: s32):  ; writes=6
  %8: s32 = neg %5
  %9: s32 = xor %0, %6
  %10: s32 = mul %8, %9
  %11: s32 = const {value=-1}
  %12: s32 = add %7, %11
  %13: s32 = const {value=0}
  %14: s32 = add %6, %4
  %15: u32 = icmp_sgt %12, %13
  cond_br %15, ^bb1(%14, %10, %12), ^bb2()  ; order ^bb1(4, 5, 3) ^bb2()
^bb2():  ; writes=1
  %16: s32 = const {value=1}
  %17: s32 = add %14, %0
  %18: u32 = icmp_eq %2, %16
  cond_br %18, ^bb4(%17), ^bb3()  ; order ^bb4(0) ^bb3()
^bb3():  ; writes=1
  br ^bb4(%14) {fallthrough=true}  ; order ^bb4(0)
^bb4(%19: s32):  ; writes=1
  %20: s32 = mul %14, %19
  ret %20
}`;

describe('a back-edge argument live across a merge reads the name it carries', () => {
  test('the merge takes a fresh name', () => {
    expect(emit(BACK_ARG_NAMED_LIVE_ACROSS_MERGE)).toBe(
      's32 g4(s32 a0, s32 a1, s32 a2, s32 a3) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 v3;\n    s32 t0;\n' +
        '    v0 = a0;\n    v1 = a1;\n    v2 = a3;\n    do {\n        v2 = v2 + -1;\n        t0 = v1;\n' +
        '        v1 = -v0 * (a0 ^ v1);\n        v0 = t0 + (a0 + a0);\n    } while (v2 > 0);\n    if (a2 != 1) {\n' +
        '        v3 = v0;\n    } else {\n        v3 = v0 + a0;\n    }\n    return v0 * v3;\n}\n',
    );
  });

  test('ablating back-arg-live overwrites the loop value the multiply still reads', () => {
    const src = emit(BACK_ARG_NAMED_LIVE_ACROSS_MERGE, 'back-arg-live');
    expect(src).toContain('v0 = v0 + a0;');
    expect(src).toContain('return v0 * v0;');
  });
});

/** `do { obs(u); d--; u = b + d; } while (d > 0); x = u + c; r = u; if (c >= 0) { pre(c); q = b; do {
 *  r = q; q = q + obs(x); } while (q < 10); } fin(r); return r;`, as IR. The first loop's exit value
 *  `%14` has no name: it is that self-loop's back-edge argument, so it renders as the loop variable's
 *  name after it, and `x = %14 + c` (`%20`) is inlined inside the second loop as that name plus `c`.
 *  The merge `%40` is offered the same name, and the second loop's exit copy `r = q` is sunk into
 *  its body — ahead of the read. `%20` is dead at the merge, so only the second loop's header shows
 *  it, and it reads the name through a back-edge argument, which the sink gate does not look for. */
const BACK_ARG_READ_PAST_SUNK_COPY = `fn t1 {
^bb0(%0: s32, %1: s32, %2: s32, %3: s32):
  br ^bb1(%0, %3)
^bb1(%5: s32, %7: s32):
  %8: s32 = call %5 {target="obs"}
  %9: s32 = const {value=1}
  %10: s32 = sub %7, %9
  %14: s32 = add %1, %10
  %11: s32 = const {value=0}
  %15: u32 = icmp_slt %11, %10
  cond_br %15, ^bb1(%14, %10), ^bb2()
^bb2():
  %20: s32 = add %14, %2
  %21: s32 = const {value=0}
  %22: u32 = icmp_slt %2, %21
  cond_br %22, ^bb4(%14), ^bb6()
^bb6():
  %50: s32 = call %2 {target="pre"}
  br ^bb3(%1)
^bb3(%30: s32):
  %31: s32 = call %20 {target="obs"}
  %32: s32 = add %30, %31
  %34: s32 = const {value=10}
  %33: u32 = icmp_slt %32, %34
  cond_br %33, ^bb3(%32), ^bb4(%30)
^bb4(%40: s32):
  %41: s32 = call %40 {target="fin"}
  ret %40
}
`;

describe('a back-edge argument read inside the loop a merge copy sinks into', () => {
  // `irTraceOf` seeds parameter i from bits 3i up, so a small seed pins the last two; spread them.
  const SEEDS = Array.from({ length: 4000 }, (_, i) => i * 37 + 1);
  const judge = (drop?: string) => {
    const fn = parse(BACK_ARG_READ_PAST_SUNK_COPY);
    verify(fn);
    recoverTypes(fn);
    const hooks = drop ? { carrierNameGates: without(CARRIER_NAME_GATES, drop) } : {};
    return irAgreement(BACK_ARG_READ_PAST_SUNK_COPY, structure(fn, {}, hooks), SEEDS);
  };

  test('the merge takes a fresh name, and the lift computes what the IR does', () => {
    expect(judge()).toEqual({ judged: 4000, disagree: 0 });
  });

  test('ablating back-arg-live sinks the copy into the name the loop still reads', () => {
    expect(judge('back-arg-live').disagree).toBeGreaterThan(1000);
  });
});
