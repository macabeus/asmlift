// A `break` OUT OF A DO-WHILE, TO A LIVE EXIT.
//
// `for (i = 0; i < n; i++) if (f(i) == k) break; if (i == n) g(i);` is rotated into a guard and a
// do-while whose body has a second edge to the loop's exit. The latch hands the exit the updated
// counter and the break the one the iteration read, and the copy after the loop reads the
// counter's NAME — which holds exactly that on the break path, since the update never ran. So the
// break carries no copies of its own and falls into the latch's (`doWhileBreakRule`).
//
// Refused, each measured by ablating it (the rule's `if` replaced with `false`) against its own
// fixture's IR over 300 seeds, 39 of which the emitted tree then gets wrong:
//   • a break carrying a value the copy after the loop does not spell (`BREAK_CARRIES_ANOTHER_VALUE`);
//   • an exit region reading a value the latch's update hands the header, which after the loop is
//     spelled by the loop variable's name and on the break path still holds the old one
//     (`EXIT_READS_THE_UPDATE`).
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

test('a break from the header falls into the copy the latch hands the exit', () => {
  const r = judged(HEADER_BREAK);
  expect(r.src).toBe(
    's32 hbrk(s32 a0, s32 a1) {\n    s32 v0;\n    if (0 >= a0) {\n        v0 = 0;\n    } else {\n' +
      '        v0 = 0;\n        do {\n            if (f(v0) == a1) break;\n            v0 = v0 + 1;\n' +
      '        } while (v0 < a0);\n    }\n    if (v0 == a0) g(v0);\n    return v0;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a break from deeper in the body does too', () => {
  const r = judged(MID_BODY_BREAK);
  expect(r.src).toContain('if (g(v0) == a1) break;');
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a break carrying a value the copy after the loop does not spell declines LOUD', () => {
  expect(() => judged(BREAK_CARRIES_ANOTHER_VALUE)).toThrow(
    /a break out of block #1 carries a value the copies after the do-while do not spell/,
  );
});

test("an exit region reading the latch's update declines LOUD", () => {
  expect(() => judged(EXIT_READS_THE_UPDATE)).toThrow(
    /a break out of block #1 reaches an exit region that reads a value the latch's update hands the header/,
  );
});
