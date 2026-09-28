// A LOOP WITH NO TEST OF ITS OWN: `while (1)`.
//
// A loop no other recognizer takes — latches that are no one latch, chain (`latch-chain.test.ts`)
// or nest (`header-nest.test.ts`), such as a `continue` in mid-body beside the bottom latch; or one
// latch under a header that computes before it tests — has no single test to put at its top or
// bottom. It is spelled `while (1)`: every edge back to the header is a
// continue (implicit at the foot of the region, `continue;` above it), every edge out is a `break`
// to the one exit the loop is given or an early `return`. An `if` in the body joins where the paths
// that do not end meet (`foreverJoin`), so an arm that continues does not drag the rest of the
// iteration into its sibling.
//
// Each accepted fixture is run against its own IR (`irAgreement`), as `structure()` returns it and
// as it ships after `readabilityRewrites`.
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

/** `i = 0; while (1) { t = f(i); if (t < a1) { i += 1; continue; } g(t); if (t >= a0) break; i += 2; }`
 *  and a live exit that reads both. */
const MID_CONTINUE = `fn midcont {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = call %3 {target="f"}
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb2(), ^bb3()
^bb2():
  %6: s32 = const {value=1}
  %7: s32 = add %3, %6
  br ^bb1(%7)
^bb3():
  %8: s32 = call %4 {target="g"}
  %9: u32 = icmp_sge %4, %0
  cond_br %9, ^bb5(%3), ^bb4()
^bb4():
  %10: s32 = const {value=2}
  %11: s32 = add %3, %10
  br ^bb1(%11)
^bb5(%12: s32):
  %13: s32 = call %12 {target="h"}
  %15: u32 = icmp_slt %13, %0
  cond_br %15, ^bb6(), ^bb7()
^bb6():
  %16: s32 = call %4 {target="k"}
  br ^bb7()
^bb7():
  ret %12
}`;
/** The continue sits under an `if` whose other arm falls into the rest of the iteration. */
const NESTED_CONTINUE = `fn nestcont {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = call %3 {target="f"}
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb2(), ^bb4()
^bb2():
  %6: u32 = icmp_eq %4, %0
  cond_br %6, ^bb3(), ^bb7()
^bb7():
  %7: s32 = const {value=1}
  %8: s32 = add %3, %7
  br ^bb1(%8)
^bb3():
  %9: s32 = call %4 {target="g"}
  br ^bb4()
^bb4():
  %10: s32 = call %4 {target="h"}
  %11: u32 = icmp_sge %4, %0
  cond_br %11, ^bb6(), ^bb5()
^bb5():
  %12: s32 = const {value=2}
  %13: s32 = add %3, %12
  br ^bb1(%13)
^bb6():
  ret %3
}`;
/** Two edges out, to two blocks that each call and then meet: neither is a `return` arm. */
const TWO_LIVE_EXITS = `fn twoexits {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = call %3 {target="f"}
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb2(), ^bb5()
^bb2():
  %6: u32 = icmp_eq %4, %0
  cond_br %6, ^bb6(), ^bb3()
^bb3():
  %7: s32 = const {value=1}
  %8: s32 = add %3, %7
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%8), ^bb4()
^bb4():
  %10: s32 = const {value=2}
  %11: s32 = add %3, %10
  br ^bb1(%11)
^bb5():
  %12: s32 = call %3 {target="a"}
  br ^bb7()
^bb6():
  %13: s32 = call %3 {target="b"}
  br ^bb7()
^bb7():
  %14: s32 = call %3 {target="m"}
  ret %3
}`;

/** A header that computes before it tests, over one unconditional latch — no pure test for a
 *  `while`, no bottom test for a `do-while`: `i = 0; while (1) { if (f(i) >= a0) break; i++; }`. */
const MID_TESTED = `fn midtest {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = call %3 {target="f"}
  %5: u32 = icmp_sge %4, %0
  cond_br %5, ^bb3(), ^bb2()
^bb2():
  %6: s32 = const {value=1}
  %7: s32 = add %3, %6
  br ^bb1(%7)
^bb3():
  ret %3
}`;

test('a mid-body continue beside the bottom latch is a `while (1)` with a `break` to its exit', () => {
  const r = judged(MID_CONTINUE);
  expect(r.src).toBe(
    's32 midcont(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n    while (1) {\n' +
      '        v0 = f(v1);\n        if (v0 < a1) {\n            v1 = v1 + 1;\n            continue;\n        }\n' +
      '        g(v0);\n        if (v0 >= a0) break;\n        v1 = v1 + 2;\n    }\n' +
      '    if ((s32)h(v1) < a0) k(v0);\n    return v1;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a continue nested under an `if` jumps, and the rest of the iteration is written once', () => {
  const r = judged(NESTED_CONTINUE);
  expect(r.src).toBe(
    's32 nestcont(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n    while (1) {\n' +
      '        v0 = f(v1);\n        if (v0 < a1) {\n            if (v0 != a0) {\n                v1 = v1 + 1;\n' +
      '                continue;\n            }\n            g(v0);\n        }\n        h(v0);\n' +
      '        if (v0 >= a0) break;\n        v1 = v1 + 2;\n    }\n    return v1;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a loop leaving for two live merges has no one exit, and declines LOUD', () => {
  expect(() => judged(TWO_LIVE_EXITS)).toThrow(/unrecovered back-edge/);
});

test('a header that computes before it tests is a `while (1)` with its test in mid-body', () => {
  const r = judged(MID_TESTED);
  expect(r.src).toBe(
    's32 midtest(s32 a0, s32 a1) {\n    s32 v0;\n    v0 = 0;\n    while (1) {\n' +
      '        if ((s32)f(v0) >= a0) break;\n        v0 = v0 + 1;\n    }\n    return v0;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});
