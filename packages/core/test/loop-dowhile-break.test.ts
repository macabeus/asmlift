// A `break` OUT OF A BOTTOM-TESTED LOOP is `while (1)`'s, not the do-while's.
//
// `for (i = 0; i < n; i++) if (f(i) == k) break; if (i == n) g(i);` is rotated into a guard and a
// bottom-tested loop whose body has a second edge to the loop's exit. A do-while spelling would
// leave that edge with no copies of its own, falling into the ones the latch hands the exit, which
// read the loop variables' names after the loop: sound only where the two edges hand the exit what
// those names spell, a condition three fixtures below break. `while (1)` spells each edge out with
// its own copies and its own test, so it takes the loop whether or not they agree, and whether the
// exit is a live merge or a return tail (`RET_TAIL_BREAK`, which the do-while claimed and then
// declined on).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const judged = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn);
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

/** The header tests and breaks: the rotated `for` with an early `break`. */
const HEADER_BREAK = `fn hbrk {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb1(%2), ^bb3(%2)
^bb1(%4: s32):
  %5: s32 = call %4 {target="f"}
  %6: u32 = icmp_eq %5, %1
  cond_br %6, ^bb3(%4), ^bb2()
^bb2():
  %7: s32 = const {value=1}
  %8: s32 = add %4, %7
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%8), ^bb3(%8)
^bb3(%10: s32):
  %11: u32 = icmp_eq %10, %0
  cond_br %11, ^bb4(), ^bb5()
^bb4():
  %12: s32 = call %10 {target="g"}
  br ^bb5()
^bb5():
  ret %10
}`;
/** The break sits under an `if` in the body, below the header. */
const MID_BODY_BREAK = `fn mbrk {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%4: s32):
  %5: s32 = call %4 {target="f"}
  %6: u32 = icmp_slt %5, %1
  cond_br %6, ^bb2(), ^bb4()
^bb2():
  %7: s32 = call %5 {target="g"}
  %13: u32 = icmp_eq %7, %1
  cond_br %13, ^bb3(%4), ^bb4()
^bb4():
  %8: s32 = const {value=1}
  %9: s32 = add %4, %8
  %10: u32 = icmp_slt %9, %0
  cond_br %10, ^bb1(%9), ^bb3(%9)
^bb3(%11: s32):
  %12: u32 = icmp_eq %11, %0
  cond_br %12, ^bb5(), ^bb6()
^bb5():
  %14: s32 = call %11 {target="h"}
  br ^bb6()
^bb6():
  ret %11
}`;
/** The break hands the exit `f(i)`, the latch hands it the counter. */
const BREAK_CARRIES_ANOTHER_VALUE = `fn obrk {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%4: s32):
  %5: s32 = call %4 {target="f"}
  %6: u32 = icmp_eq %5, %1
  cond_br %6, ^bb3(%5), ^bb2()
^bb2():
  %7: s32 = const {value=1}
  %8: s32 = add %4, %7
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%8), ^bb3(%8)
^bb3(%10: s32):
  %11: u32 = icmp_eq %10, %0
  cond_br %11, ^bb4(), ^bb5()
^bb4():
  %12: s32 = call %10 {target="g"}
  br ^bb5()
^bb5():
  ret %10
}`;
/** The header computes `i + 1` for the latch, and the exit reads it on both edges. */
const EXIT_READS_THE_UPDATE = `fn ubrk {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%4: s32):
  %7: s32 = const {value=1}
  %8: s32 = add %4, %7
  %5: s32 = call %4 {target="f"}
  %6: u32 = icmp_eq %5, %1
  cond_br %6, ^bb3(), ^bb2()
^bb2():
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%8), ^bb3()
^bb3():
  %11: u32 = icmp_eq %8, %0
  cond_br %11, ^bb4(), ^bb5()
^bb4():
  %12: s32 = call %8 {target="g"}
  br ^bb5()
^bb5():
  ret %8
}`;

/** `u = 0; do { u += 4; if (g(a1) < 4) break; } while (g(0) < 10); return g(1) < 20 ? u : a0;` —
 *  the exit reads the update `u + 4` only as the argument of an edge. */
const EXIT_HANDS_ON_THE_UPDATE = `fn hbrku {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=4}
  %5: s32 = add %3, %4
  %6: s32 = call %1 {target="g"}
  %7: s32 = const {value=4}
  %8: u32 = icmp_slt %6, %7
  cond_br %8, ^bb3(), ^bb2()
^bb2():
  %9: s32 = const {value=0}
  %10: s32 = call %9 {target="g"}
  %11: s32 = const {value=10}
  %12: u32 = icmp_slt %10, %11
  cond_br %12, ^bb1(%5), ^bb3()
^bb3():
  %13: s32 = const {value=1}
  %14: s32 = call %13 {target="g"}
  %15: s32 = const {value=20}
  %16: u32 = icmp_slt %14, %15
  cond_br %16, ^bb4(%5), ^bb4(%0)
^bb4(%17: s32):
  ret %17
}`;

/** `do { if (g(i) == 3) break; s += i; i++; } while (i < n); h(s); return i + s;` — the exit is
 *  the return tail both edges reach. */
const RET_TAIL_BREAK = `fn rbrk {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1, %1)
^bb1(%2: s32, %3: s32):
  %4: s32 = call %2 {target="g"}
  %5: s32 = const {value=3}
  %6: u32 = icmp_eq %4, %5
  cond_br %6, ^bb3(%2, %3), ^bb2()
^bb2():
  %7: s32 = add %3, %2
  %8: s32 = const {value=1}
  %9: s32 = add %2, %8
  %10: u32 = icmp_slt %9, %0
  cond_br %10, ^bb1(%9, %7), ^bb3(%9, %7)
^bb3(%11: s32, %12: s32):
  %13: s32 = call %12 {target="h"}
  %14: s32 = add %11, %12
  ret %14
}`;

const agrees = (r: ReturnType<typeof judged>) => {
  expect(r.src).toContain('while (1) {');
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
};

test('a break from the header leaves a while (1) with the copies of its own edge', () => {
  const r = judged(HEADER_BREAK);
  expect(r.src).toBe(
    's32 hbrk(s32 a0, s32 a1) {\n    s32 v0;\n    if (0 >= a0) {\n        v0 = 0;\n    } else {\n' +
      '        v0 = 0;\n        while (1) {\n            if (f(v0) == a1) break;\n            v0 = v0 + 1;\n' +
      '            if (v0 >= a0) break;\n        }\n    }\n    if (v0 == a0) g(v0);\n    return v0;\n}\n',
  );
  agrees(r);
});

test('a break from deeper in the body does too', () => {
  const r = judged(MID_BODY_BREAK);
  expect(r.src).toContain('if (g(v0) == a1) break;');
  agrees(r);
});

test('a break into a return tail does too', () => {
  const r = judged(RET_TAIL_BREAK);
  expect(r.src).toContain('if (g(v0) == 3) break;');
  agrees(r);
});

test('a break carrying another value than the latch hands the exit carries its own copy', () => {
  const r = judged(BREAK_CARRIES_ANOTHER_VALUE);
  expect(r.src).toContain('v0 = v1;\n            break;');
  agrees(r);
});

test("an exit reading the latch's update reads what each edge handed it", () => {
  agrees(judged(EXIT_READS_THE_UPDATE));
  agrees(judged(EXIT_HANDS_ON_THE_UPDATE));
});
