// A SECOND EXIT PAST THE CODE AFTER THE LOOP, spelled with a flag.
//
// `for (i…) { for (j…) { if (hit(j)) goto next; } k(i); next:; }` leaves the inner loop two ways:
// by its own exit, into `k(i)`, and from the search straight to the end of the outer body. L3 has
// no `goto`, so structure spells the second way out `f = 1; break;`, with `f = 0;` ahead of the loop
// and the code it skips under `if (f == 0)` after it (structure.ts `TwoLevelExit`); where the target
// is the end of the switch arm the loop sits in, the flag reads `if (f != 0) break;`. Every fixture
// is judged against its own IR by the trace oracle (`irAgreement`), as `structure()` returns it and
// as it ships after `readabilityRewrites`, and over enough seeds to cover a zero-trip inner loop
// (where it has one), a hit on the first and on a later element, and no hit at all (`covers`).
// A `goto` out of BOTH loops hands the flag out (`TwoLevelExit.outward`): the hit runs the code past
// both loops on its way to the enclosing loop's exit, then `f = 1; break;`, and `if (f != 0) break;`
// follows the inner loop at once, and its switch too where the loop sits in a case body. The decline
// fixtures are the shapes the reading does not take: a third exit target, the enclosing loop's
// header, a second exit out of a case body, one into the switch arm its own arm falls into, a `goto`
// out of three loops, and one through a switch in a switch.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { tallying, without } from '../src/l3/gates';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import {
  OUTWARD_EXIT_GATES,
  type StructureHooks,
  TWO_LEVEL_BREAK_GATES,
  TWO_LEVEL_EXIT_GATES,
  TWO_LEVEL_REGION_GATES,
  structure,
} from '../src/structure/structure';
import { irAgreement, irTraceOf } from './helpers';

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

const judged = (ir: string, hooks: StructureHooks = {}) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, {}, hooks);
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

/** What the seeds exercise, read off the IR's own traces: per outer iteration (each `mark`), how
 *  many `probe` calls ran and whether `k` followed. A hit is an iteration that probed and skipped
 *  `k`; a first-element hit probed once; a zero-trip one ran `k` without probing, and one that did
 *  neither took a path around the loop (another case arm). */
const covers = (ir: string) => {
  const fn = parse(ir);
  const seen = { zeroTrips: 0, firstHit: 0, laterHit: 0, noHit: 0, noLoop: 0 };
  for (const seed of SEEDS) {
    let trace;
    try {
      trace = irTraceOf(fn, seed);
    } catch {
      continue;
    }
    const iterations: { probes: number; k: boolean }[] = [];
    for (const ev of trace) {
      if (ev.fn === 'mark') {
        iterations.push({ probes: 0, k: false });
      } else if (ev.fn === 'probe' && iterations.length > 0) {
        iterations[iterations.length - 1].probes++;
      } else if (ev.fn === 'k' && iterations.length > 0) {
        iterations[iterations.length - 1].k = true;
      }
    }
    for (const it of iterations) {
      if (it.probes === 0) {
        if (it.k) {
          seen.zeroTrips++;
        } else {
          seen.noLoop++;
        }
      } else if (it.k) {
        seen.noHit++;
      } else if (it.probes === 1) {
        seen.firstHit++;
      } else {
        seen.laterHit++;
      }
    }
  }
  return seen;
};

const expectCovered = (ir: string) => {
  const seen = covers(ir);
  expect(seen.zeroTrips).toBeGreaterThan(0);
  expect(seen.firstHit).toBeGreaterThan(0);
  expect(seen.laterHit).toBeGreaterThan(0);
  expect(seen.noHit).toBeGreaterThan(0);
};

/** `synthetic:brk2lvl:agbcc`'s shape with its loads as calls: the outer loop a guarded do-while, the
 *  inner one guarded (`m < 0` skips it into `k(i)`) and rotated, its header testing for the hit and
 *  leaving to the outer latch, its latch testing the count and leaving to `k(i)`. */
const GOTO_NEXT = `fn gotonext {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %8: s32 = add %5, %7
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb2()
^bb2():
  br ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb6():
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

test('a `goto` past the code after an inner loop lifts as a flag', () => {
  const { src, agreement, shipped } = judged(GOTO_NEXT);
  expect(src).toBe(
    'void gotonext(s32 a0, s32 a1, s32 a2) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 v3;\n    s32 v4;\n' +
      '    v0 = 0;\n    if (v0 < a0) {\n        v2 = v0;\n        do {\n            mark(v2);\n            v1 = 1;\n' +
      '            if (a1 >= v0) {\n                v3 = v0;\n                v4 = 0;\n                while (1) {\n' +
      '                    if (probe(v3, v2) == a2) {\n                        v4 = 1;\n                        break;\n' +
      '                    }\n                    v3 = v3 + v1;\n                    if (a1 < v3) break;\n                }\n' +
      '                if (v4 == 0) k(v2);\n            } else {\n                k(v2);\n            }\n' +
      '            v2 = v2 + v1;\n        } while (v2 < a0);\n    }\n    return;\n}\n',
  );
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(GOTO_NEXT);
});

/** ido7.1's spelling of the same loop: the hit test leaves first, the count test is the latch, and
 *  the skipped code reads the inner loop's own counter (`k(j)`), which only its exit hands it. */
const SKIPPED_CODE_READS_THE_COUNTER = `fn readscounter {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(%3), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(%13), ^bb3(%13)
^bb5(%17: s32):
  %15: s32 = call %17, %5 {target="k"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

test('the skipped code reads the value the inner loop hands its own exit', () => {
  const { agreement, shipped } = judged(SKIPPED_CODE_READS_THE_COUNTER);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(SKIPPED_CODE_READS_THE_COUNTER);
});

/** The second target takes a parameter: the hit hands it the matching element (`probe`'s result),
 *  the exit path hands it `-1`, and the code after reads it. The flag's `break` carries its own copy,
 *  and the skipped code writes the other one on its way to the target. */
const TARGET_TAKES_A_VALUE = `fn targetvalue {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(%11), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %18: s32 = sub %3, %7
  br ^bb6(%18)
^bb6(%19: s32):
  %20: s32 = call %19 {target="use"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

test('a second target with a parameter takes each way out its own value', () => {
  const { agreement, shipped } = judged(TARGET_TAKES_A_VALUE);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(TARGET_TAKES_A_VALUE);
});

/** No loop around it: `for (j…) { if (hit) goto out; } k(); out: for (…) after(c);`. The code past
 *  the target holds a loop, so no early `return` can copy it into the hit's arm, and the flag is
 *  the reading left. */
const NO_ENCLOSING_LOOP = `fn nolooparound {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %5: s32 = call %0 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %0 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %0 {target="k"}
  br ^bb6()
^bb6():
  br ^bb8(%3)
^bb8(%21: s32):
  %20: s32 = call %21 {target="after"}
  %22: s32 = add %21, %7
  %23: u32 = icmp_slt %22, %0
  cond_br %23, ^bb8(%22), ^bb9()
^bb9():
  ret
}`;

test('a two-level exit needs no loop around it', () => {
  const { agreement, shipped } = judged(NO_ENCLOSING_LOOP);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(NO_ENCLOSING_LOOP);
});

/** The loop in a SWITCH ARM, its `goto` landing on the arm's `break` (`synthetic:brk2sw_one`'s
 *  shape: `case 0: case 1: case 4: for (j…) { if (hit) goto out; } k(i); out: break; case 2:
 *  h(i); break;`). The hit's edge goes to the switch's merge, which a `break;` cannot reach from
 *  inside the loop: it is the loop's two-level exit. The zero-trip guard around the loop joins at
 *  `k(i)`, the code the exit skips, so the flag reads `if (f != 0) break;` inside the guard, where
 *  that `break;` leaves the switch, and `k(i)` renders once, after the guard. */
const GOTO_ARM_END = `fn gotoarmend {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb2(), ^bb8(), ^bb2(), ^bb6() {cases=[0;1;2;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb8():
  %17: s32 = call %5 {target="h"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

test('a `goto` to the end of its switch arm lifts as a flag inside the arm', () => {
  const { src, agreement, shipped } = judged(GOTO_ARM_END);
  expect(src).toBe(
    'void gotoarmend(s32 a0, s32 a1, s32 a2) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 v3;\n    s32 v4;\n' +
      '    v0 = 0;\n    if (v0 < a0) {\n        v2 = v0;\n        do {\n            mark(v2);\n            v1 = 1;\n' +
      '            switch (v2) {\n                case 0:\n                case 1:\n                case 4:\n' +
      '                    if (a1 >= v0) {\n                        v3 = v0;\n                        v4 = 0;\n' +
      '                        while (1) {\n                            if (probe(v3, v2) == a2) {\n' +
      '                                v4 = 1;\n                                break;\n                            }\n' +
      '                            v3 = v3 + v1;\n                            if (a1 < v3) break;\n                        }\n' +
      '                        if (v4 != 0) break;\n                    }\n                    k(v2);\n' +
      '                    break;\n                case 2:\n                    h(v2);\n' +
      '                    break;\n            }\n            v2 = v2 + v1;\n        } while (v2 < a0);\n    }\n' +
      '    return;\n}\n',
  );
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(GOTO_ARM_END);
  expect(covers(GOTO_ARM_END).noLoop).toBeGreaterThan(0);
});

/** The hit leaves BOTH loops (`goto done` past the outer one, a merge that also takes the outer
 *  loop's own exit, and its value): `f = 1; break;` hands the flag out, and `if (f != 0) break;`
 *  right after the inner loop leaves the outer one ahead of `k(i)`, the code between the loops. */
const OUT_OF_BOTH_LOOPS = `fn pastouter {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7(%3)
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb7(%11), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7(%8)
^bb7(%21: s32):
  %20: s32 = call %21 {target="after"}
  ret
}`;

test('a `goto` out of both loops hands its flag out to the enclosing loop', () => {
  const { src, agreement, shipped } = judged(OUT_OF_BOTH_LOOPS);
  expect(src).toMatch(/v(\d+) = 1;\n\s*break;\n\s*}\n(?:.*\n)*?\s*}\n\s*if \(v\1 != 0\) break;\n\s*}\n\s*k\(/);
  expect(src.match(/\bk\(v\d+\);/g)).toHaveLength(1);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(OUT_OF_BOTH_LOOPS);
});

/** The hit runs code past both loops on its way to the outer exit (`if (hit) { s(j, r); goto
 *  done; }`, which agbcc lays out past the loop): that code is the hit's own, written in its arm
 *  ahead of `f = 1; break;`. Laid out after the exit, so the exit is tried first. */
const CODE_PAST_BOTH_LOOPS = `fn codepastboth {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb8(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  %20: s32 = call %0 {target="after"}
  br ^bb11(%3)
^bb8():
  %17: s32 = call %10, %11 {target="s"}
  br ^bb7()
^bb11(%21: s32):
  %22: s32 = call %21 {target="tail"}
  %23: s32 = add %21, %7
  %24: u32 = icmp_slt %23, %0
  cond_br %24, ^bb11(%23), ^bb12()
^bb12():
  ret
}`;

test('the code a `goto` out of both loops runs is written in its arm', () => {
  const { src, agreement, shipped } = judged(CODE_PAST_BOTH_LOOPS);
  expect(src).toMatch(/s\(v\d+, v\d+\);\n\s*v(\d+) = 1;\n\s*break;/);
  expect(src.match(/\bs\(/g)).toHaveLength(1);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(CODE_PAST_BOTH_LOOPS);
});

/** The hit's code laid out past the loop AHEAD of the code after it, the two blocks swapped: taking
 *  the hit's code for the outer loop's exit would read the latch's way out as a second flag the asm
 *  does not hold, so the outward rung tries every exit with no flag of the loop's own first, and both
 *  layouts read with the one flag. */
const HIT_CODE_LAID_OUT_FIRST = (hitFirst: boolean) => {
  const hit = `^bb8():
  %17: s32 = call %10, %11 {target="s"}
  br ^bb9()
`;
  const fin = `^bb9():
  %20: s32 = call %0 {target="fin"}
  ret
`;
  return `fn hitlaidout {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb9()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb8(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb9()
${hitFirst ? hit + fin : fin + hit}}`;
};

test.each([true, false])(
  'a `goto` out of both loops takes one flag whichever of its code and the code after the loop is laid out first (hit first: %s)',
  (hitFirst) => {
    const ir = HIT_CODE_LAID_OUT_FIRST(hitFirst);
    const { src, agreement, shipped } = judged(ir);
    expect(src.match(/if \(v\d+ [!=]= 0\)/g)).toHaveLength(1);
    expect(src).toMatch(/s\(v\d+, v\d+\);\n\s*v(\d+) = 1;\n\s*break;/);
    expect(agreement.disagree).toBe(0);
    expect(shipped.disagree).toBe(0);
    expect(agreement.judged).toBe(SEEDS.length);
    expectCovered(ir);
  },
);

/** The same code entered from before the loop too (`if (n <= 0) goto s; … s: s(n);`): the edge from
 *  the body is a `break` to a block others enter, which the duplication policy writes once, after the
 *  loop (`codeBreakArm`, `not-a-break-arm`), and the reading that takes it for the outer loop's exit,
 *  with the outer loop's own two-level exit past it, does. */
const CODE_PAST_BOTH_SHARED = `fn codepastshared {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb8()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb8(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  %20: s32 = call %0 {target="after"}
  br ^bb11(%3)
^bb8():
  %17: s32 = call %0 {target="s"}
  br ^bb7()
^bb11(%21: s32):
  %22: s32 = call %21 {target="tail"}
  %23: s32 = add %21, %7
  %24: u32 = icmp_slt %23, %0
  cond_br %24, ^bb11(%23), ^bb12()
^bb12():
  ret
}`;
/** The code past both loops holding a loop of its own (`s: for (m…) s(m); goto done;`), entered by
 *  the hit alone: written once wherever it sits, so the hit writes it ahead of `f = 1; break;`. */
const CODE_PAST_BOTH_CYCLIC = `fn codepastcyclic {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb8(%3), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  %20: s32 = call %0 {target="after"}
  br ^bb11(%3)
^bb8(%40: s32):
  %41: s32 = call %40 {target="s"}
  %42: s32 = add %40, %7
  %43: u32 = icmp_slt %42, %10
  cond_br %43, ^bb8(%42), ^bb7()
^bb11(%21: s32):
  %22: s32 = call %21 {target="tail"}
  %23: s32 = add %21, %7
  %24: u32 = icmp_slt %23, %0
  cond_br %24, ^bb11(%23), ^bb12()
^bb12():
  ret
}`;

/** The code past both loops runs on into a block the `else` before the loop enters too (`if (n <= 0)
 *  goto z; … if (hit) { s(j); z: z(n); goto done; }`), which the loop's exit path never runs: the
 *  duplication policy writes it once per path, in the hit's arm and where the `else` sits. */
const CODE_PAST_BOTH_TAIL_SHARED = `fn codepasttailshared {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb9()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb8(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  %20: s32 = call %0 {target="after"}
  br ^bb11(%3)
^bb8():
  %17: s32 = call %10, %11 {target="s"}
  br ^bb9()
^bb9():
  %18: s32 = call %0 {target="z"}
  br ^bb7()
^bb11(%21: s32):
  %22: s32 = call %21 {target="tail"}
  %23: s32 = add %21, %7
  %24: u32 = icmp_slt %23, %0
  cond_br %24, ^bb11(%23), ^bb12()
^bb12():
  ret
}`;

test.each([
  ['its head entered from before the loop', CODE_PAST_BOTH_SHARED, 2, 2],
  ['a loop of its own', CODE_PAST_BOTH_CYCLIC, 1, 1],
  ['a tail entered from before the loop', CODE_PAST_BOTH_TAIL_SHARED, 1, 1],
])('code past both loops with %s takes the break-arm policy', (_, ir, flags, sCalls) => {
  const outward = tallying(OUTWARD_EXIT_GATES);
  const { src, agreement, shipped } = judged(ir, { outwardExitGates: outward.gates });
  // the head only the policy refuses: the outer loop takes it for its exit, behind a flag of its own
  expect(outward.refusals().map(([r]) => r)).toEqual(flags === 2 ? ['not-a-break-arm'] : []);
  expect(new Set(src.match(/\bv\d+(?= = 1;\n\s*break;)/g)).size).toBe(flags);
  expect(src.match(/\bs\(/g)).toHaveLength(sCalls);
  if (ir === CODE_PAST_BOTH_TAIL_SHARED) {
    expect(src.match(/\bz\(/g)).toHaveLength(2);
  }
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(ir);
});

/** A `goto` out of both loops whose code never reaches the outer loop's exit (`if (hit) { y(j);
 *  goto join; } … } after(); join: …`): `if (f != 0) break;` would land on `after()`, which the
 *  hit skips (`not-a-break-arm`). The join is a return tail holding a loop, which the hit copies
 *  at `while (1)`'s last rung (A LOOP IN THE TAIL, at `earlyReturnArm`), with no flag. */
const MISSES_THE_EXIT = `fn missesexit {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb8(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb8():
  %17: s32 = call %10 {target="y"}
  br ^bb10()
^bb7():
  %20: s32 = call %0 {target="after"}
  br ^bb10()
^bb10():
  br ^bb11(%3)
^bb11(%21: s32):
  %22: s32 = call %21 {target="tail"}
  %23: s32 = add %21, %7
  %24: u32 = icmp_slt %23, %0
  cond_br %24, ^bb11(%23), ^bb12()
^bb12():
  ret
}`;

test('a `goto` out of both loops whose code misses the outer exit copies its return tail, loop and all', () => {
  const { src, agreement, shipped } = judged(MISSES_THE_EXIT);
  expect(src).not.toMatch(/= 1;\n\s*break;/);
  expect(src.match(/\btail\(v\d+\);/g)).toHaveLength(2);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(MISSES_THE_EXIT);
});

/** The inner loop in a CASE BODY of a switch in the outer loop (`synthetic:brk2out_sw`'s shape:
 *  `switch (i) { case 0: case 4: for (j…) { if (hit) goto done; } k(i); break; case 1: h(i); }
 *  g(i);`). In the case body `if (f != 0) break;` leaves only the switch, so a second one follows
 *  the switch, ahead of `g(i)`, and `f = 0;` goes ahead of the switch, which a path that never
 *  enters the inner loop also leaves. */
const THROUGH_A_SWITCH = `fn throughswitch {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb9()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb8(), ^bb2(), ^bb10() {cases=[0;1;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb8():
  %17: s32 = call %5 {target="h"}
  br ^bb10()
^bb10():
  %18: s32 = call %5 {target="g"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb9()
^bb9():
  %20: s32 = call %0 {target="after"}
  ret
}`;

/** The same, the switch's arms leaving the outer loop themselves (`case 1: h(i); goto done;`). */
const THROUGH_A_SWITCH_TO_ITS_EXIT = `fn throughswitchexit {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb9()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb8(), ^bb2(), ^bb6() {cases=[0;1;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb8():
  %17: s32 = call %5 {target="h"}
  br ^bb9()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb9()
^bb9():
  %20: s32 = call %0 {target="after"}
  ret
}`;

test.each([
  ['code after it', THROUGH_A_SWITCH],
  ['arms that leave the loop', THROUGH_A_SWITCH_TO_ITS_EXIT],
])('a `goto` out of both loops from a case body hands its flag out through the switch, with %s', (_, ir) => {
  const { src, agreement, shipped } = judged(ir);
  expect(src).toMatch(/v(\d+) = 0;\n\s*switch [^]*if \(v\1 != 0\) break;\n(?:.*\n)*?\s*}\n\s*if \(v\1 != 0\) break;/);
  expect(src.match(/\bk\(v\d+\);/g)).toHaveLength(1);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(ir);
  expect(covers(ir).noLoop).toBeGreaterThan(0);
});

/** The seeds whose trace runs `fn` and then `after` at once: the hits of the search that calls it. */
const hitsOf = (ir: string, fn: string) => {
  const parsed = parse(ir);
  return SEEDS.filter((seed) => {
    try {
      const trace = irTraceOf(parsed, seed);
      return trace.some((ev, i) => ev.fn === fn && trace[i + 1]?.fn === 'after');
    } catch {
      return false;
    }
  }).length;
};

/** Two search loops in one enclosing loop, each with a `goto` out of both (sub_0800D188's
 *  `no_continue` and `no_continue2`): in two case arms of one switch, and one after the other with
 *  no switch. Each hands its own flag out, and the enclosing loop tests both. The switch's case
 *  arms are swapped to search each loop: only the iteration whose counter selects an arm runs it. */
const TWO_HAND_OUTS_THROUGH_A_SWITCH = `fn twosw {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb9()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb22(), ^bb2(), ^bb10() {cases=[0;1;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb22():
  %29: u32 = icmp_slt %1, %3
  cond_br %29, ^bb25(), ^bb23(%3)
^bb23(%30: s32):
  %31: s32 = call %30, %5 {target="probe2"}
  %32: u32 = icmp_eq %31, %2
  cond_br %32, ^bb9(), ^bb24()
^bb24():
  %33: s32 = add %30, %7
  %34: u32 = icmp_slt %1, %33
  cond_br %34, ^bb25(), ^bb23(%33)
^bb25():
  %35: s32 = call %5 {target="k2"}
  br ^bb6()
^bb10():
  %18: s32 = call %5 {target="g"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb9()
^bb9():
  %20: s32 = call %0 {target="after"}
  ret
}`;

const TWO_HAND_OUTS_IN_SEQUENCE = `fn twoseq {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb9()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %29: u32 = icmp_slt %1, %3
  cond_br %29, ^bb25(), ^bb23(%3)
^bb23(%30: s32):
  %31: s32 = call %30, %5 {target="probe2"}
  %32: u32 = icmp_eq %31, %2
  cond_br %32, ^bb9(), ^bb24()
^bb24():
  %33: s32 = add %30, %7
  %34: u32 = icmp_slt %1, %33
  cond_br %34, ^bb25(), ^bb23(%33)
^bb25():
  %35: s32 = call %5 {target="k2"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb9()
^bb9():
  %20: s32 = call %0 {target="after"}
  ret
}`;

test.each([
  ['in two case arms of one switch, the first searched', TWO_HAND_OUTS_THROUGH_A_SWITCH, ['probe']],
  [
    'in two case arms of one switch, the second searched',
    TWO_HAND_OUTS_THROUGH_A_SWITCH.replace('^bb2(), ^bb22(), ^bb2(),', '^bb22(), ^bb2(), ^bb22(),'),
    ['probe2'],
  ],
  ['one after the other', TWO_HAND_OUTS_IN_SEQUENCE, ['probe', 'probe2']],
])('two `goto`s out of both loops %s each hand their own flag out', (_, ir, searched) => {
  const { src, agreement, shipped } = judged(ir);
  const flags = [...src.matchAll(/v(\d+) = 1;\n\s*break;/g)].map((m) => m[1]);
  expect(new Set(flags).size).toBe(2);
  for (const f of flags) {
    expect(src).toContain(`if (v${f} != 0) break;`);
  }
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  for (const probe of searched) {
    expect(hitsOf(ir, probe)).toBeGreaterThan(0);
  }
});

/** The skipped code may itself leave the enclosing loop: `if (k(i) == a2) break;` sits between the
 *  inner loop's exit and the target, so it renders inside the `if`, as the enclosing loop's break. */
const SKIPPED_CODE_LEAVES = `fn skippedleaves {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %18: u32 = icmp_eq %15, %2
  cond_br %18, ^bb7(), ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  %20: s32 = call %0 {target="after"}
  ret
}`;

test('the skipped code may leave the enclosing loop from inside the `if`', () => {
  const { agreement, shipped } = judged(SKIPPED_CODE_LEAVES);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
});

// ── declines ──────────────────────────────────────────────────────────────────────────────────

/** Two second targets: one hit goes to the end of the outer body, another to `h(i)` ahead of it.
 *  One flag cannot say which, so the loop stays unrecovered. */
const THREE_EXIT_TARGETS = `fn threetargets {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb2()
^bb2():
  %17: u32 = icmp_slt %11, %2
  cond_br %17, ^bb8(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb8()
^bb8():
  %18: s32 = call %5 {target="h"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

/** The hit goes straight to the enclosing loop's header (a two-level `continue`, `goto next` with
 *  `next:` at the top of the outer body). Read with the count exit for the loop's exit, the target is
 *  the header; read the other way round, the walk from the header runs back into the loop. Both are
 *  refused (`TWO_LEVEL_EXIT_GATES`), and the loop stays declined. */
const TARGET_IS_THE_ENCLOSING_HEADER = `fn outerheader {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %8: s32 = add %5, %7
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb1(%8), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

/** The hit sits in a case body of a switch inside the inner loop, a case that falls into the next
 *  one when it misses (agbcc -O2's layout of `switch (probe(j)) { case 0: if (a(j) == x) goto
 *  next; case 1: b(j); }`). `break` there would leave only the switch, so the second exit cannot
 *  set the flag and break. Two refusals in structure.ts each decline it: the two-level one and the
 *  one for a case body that leaves its switch for a loop exit past the switch's end. */
const SECOND_EXIT_FROM_A_CASE_BODY = `fn casebody {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  switch_br %11, ^bb20(), ^bb21(), ^bb4() {cases=[0;1]}
^bb20():
  %30: s32 = call %10 {target="a"}
  %32: u32 = icmp_eq %30, %2
  cond_br %32, ^bb6(), ^bb21()
^bb21():
  %31: s32 = call %10 {target="b"}
  br ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

/** The same arm FALLING into the next one: `k(i)` runs on into `case 2: h(i); break;`, and the
 *  hit's `goto` lands past both, on the switch's merge (agbcc cross-jumps a post-loop `k(i)` into a
 *  sibling `case 2: k(i); break;` this way). The arm ends where it falls, inside the code the exit
 *  skips, and a `break;` after the loop still reaches the merge: `if (f != 0) break;`, then the
 *  fall. */
const FALLING_ARM = `fn fallingarm {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb2(), ^bb8(), ^bb2(), ^bb6() {cases=[0;1;2;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb8()
^bb8():
  %17: s32 = call %5 {target="h"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

test('a `goto` out of a switch arm that falls into the next lifts as a flag break before the fall', () => {
  const { src, agreement, shipped } = judged(FALLING_ARM);
  expect(src).toMatch(/if \(v\d+ != 0\) break;\n\s*}\n\s*k\(v\d+\);\n\s*case 2:/);
  expect(src.match(/h\(v\d+\);/g)).toHaveLength(1);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(FALLING_ARM);
});

/** Two search loops in one arm, each `goto`ing the arm's end (`for (j…) { if (hit) goto out; }
 *  k(i); for (j…) { if (j == i) goto out; } g(i); out: break;`). Each zero-trip guard joins at its
 *  own loop's exit, so each loop and each call renders once: read to the merge instead, every
 *  guard's `else` would copy the rest of the arm, doubling per loop. */
const TWO_LOOPS_IN_ARM = `fn twoloops {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb2(), ^bb8(), ^bb2(), ^bb6() {cases=[0;1;2;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  cond_br %9, ^bb10(), ^bb11(%3)
^bb11(%20: s32):
  %21: s32 = call %20, %5 {target="probe"}
  %22: u32 = icmp_eq %21, %5
  cond_br %22, ^bb6(), ^bb12()
^bb12():
  %23: s32 = add %20, %7
  %24: u32 = icmp_slt %1, %23
  cond_br %24, ^bb10(), ^bb11(%23)
^bb10():
  %25: s32 = call %5 {target="g"}
  br ^bb6()
^bb8():
  %17: s32 = call %5 {target="h"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

test('two loops `goto`ing the end of one switch arm each render once', () => {
  const { src, agreement, shipped } = judged(TWO_LOOPS_IN_ARM);
  expect(src.match(/while \(1\)/g)).toHaveLength(2);
  expect(src.match(/\bk\(v\d+\);/g)).toHaveLength(1);
  expect(src.match(/g\(v\d+\);/g)).toHaveLength(1);
  expect(src.match(/if \(v\d+ != 0\) break;/g)).toHaveLength(2);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(TWO_LOOPS_IN_ARM);
});

/** The switch is the function's last statement (`synthetic:brk2sw_one`'s shape on the MIPS gcc
 *  lanes: `switch (i) { case 0: case 1: case 4: for (j…) { if (hit) goto out; } k(i); out: break;
 *  case 2: h(i); break; } t(i);`), so the arm's merge ends in `ret`. The inner loop is a guarded
 *  do-while, and its hit's edge into that merge is a ret target it could copy as `t(i); return;`.
 *  Read as that do-while, the edge reaches the merge from inside the loop, where no `break;` can say
 *  so, and the switch declines; the structuring is run again with the copy behind every `while (1)`
 *  reading (`RetCopyRanking`), and the two-level one takes the loop: `if (f != 0) break;` leaves
 *  the switch, and `t(i)` renders once. */
const GOTO_RET_MERGE = `fn gotoretmerge {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %6: s32 = call %0 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %0, ^bb2(), ^bb2(), ^bb8(), ^bb2(), ^bb6() {cases=[0;1;2;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %0 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb6(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %0 {target="k"}
  br ^bb6()
^bb8():
  %17: s32 = call %0 {target="h"}
  br ^bb6()
^bb6():
  %18: s32 = call %0 {target="t"}
  ret
}`;

test('a `goto` to the end of a switch arm whose merge returns lifts as a flag, not a copied tail', () => {
  const { src, agreement, shipped } = judged(GOTO_RET_MERGE);
  expect(src.match(/if \(v\d+ != 0\) break;/g)).toHaveLength(1);
  expect(src.match(/\bt\(a0\);/g)).toHaveLength(1);
  expect(src.match(/\bk\(a0\);/g)).toHaveLength(1);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(GOTO_RET_MERGE);
  expect(covers(GOTO_RET_MERGE).noLoop).toBeGreaterThan(0);
});

/** `for (j = 0; j < 8; j++) { if (skip(i) < x && probe(j, i) == x) goto out; } k(i); out: t(i);`
 *  as gcc2.7.2kmc lays it out: no zero-trip guard, so the loop's header dominates `t(i); return`,
 *  and the do-while reading copies it into the hit. Emission finds that hit's branch no join in the
 *  body ("unrecovered back-edge"), and the structuring run again with the copy last
 *  (`RetCopyRanking`) spells the loop `while (1)`. */
const CONST_TRIP_RET = `fn consttripret {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: s32 = call %0 {target="mark"}
  br ^bb1(%3)
^bb1(%5: s32):
  %6: s32 = call %0 {target="skip"}
  %7: u32 = icmp_slt %6, %2
  cond_br %7, ^bb3(), ^bb2()
^bb2():
  %10: s32 = const {value=8}
  %11: s32 = add %5, %10
  br ^bb4(%11)
^bb3():
  %13: s32 = call %5, %0 {target="probe"}
  %14: u32 = icmp_eq %13, %2
  %15: s32 = const {value=8}
  %16: s32 = add %5, %15
  cond_br %14, ^bb6(), ^bb4(%16)
^bb4(%17: s32):
  %18: s32 = const {value=64}
  %19: u32 = icmp_slt %17, %18
  cond_br %19, ^bb1(%17), ^bb5()
^bb5():
  %20: s32 = call %0 {target="k"}
  br ^bb6()
^bb6():
  %21: s32 = call %0 {target="t"}
  ret
}`;

test('a ret-tail copy emission cannot spell falls back to `while (1)`, the tail written once', () => {
  const { src, agreement, shipped } = judged(CONST_TRIP_RET);
  expect(src).toContain('while (1) {');
  expect(src.match(/\bt\(a0\);/g)).toHaveLength(1);
  expect(src.match(/\bk\(a0\);/g)).toHaveLength(1);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  const seen = covers(CONST_TRIP_RET);
  expect(seen.firstHit + seen.laterHit).toBeGreaterThan(0);
  expect(seen.noHit).toBeGreaterThan(0);
});

/** agbcc's cross-jumped `for (…) if (hit) { s->f = i; return; }` (pokeemerald
 *  `DecideStop_NoBias_Reel3_Bet1`): the search loop's hit enters the function's last block, which
 *  code around the loop enters too, and its own exit runs on into a loop another path also enters,
 *  so no `while (1)` reading without a variable takes it. The do-while that copies the tail as an
 *  early `return` goes ahead of the two-level exit, whose flag the asm does not hold. */
const SHARED_TAIL_LOOP_AFTER = `fn sharedtailloop {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: s32 = const {value=1}
  %5: s32 = call %0 {target="mark"}
  %6: u32 = icmp_slt %1, %3
  cond_br %6, ^bb6(), ^bb7()
^bb7():
  %18: u32 = icmp_slt %0, %3
  cond_br %18, ^bb3(%3), ^bb1(%3)
^bb1(%7: s32):
  %8: s32 = call %7, %0 {target="probe"}
  %9: u32 = icmp_eq %8, %2
  cond_br %9, ^bb6(), ^bb2()
^bb2():
  %10: s32 = add %7, %4
  %11: u32 = icmp_slt %1, %10
  cond_br %11, ^bb3(%3), ^bb1(%10)
^bb3(%12: s32):
  %13: s32 = call %12 {target="k"}
  %14: u32 = icmp_eq %13, %2
  cond_br %14, ^bb6(), ^bb4()
^bb4():
  %15: s32 = add %12, %4
  %16: u32 = icmp_slt %15, %1
  cond_br %16, ^bb3(%15), ^bb6()
^bb6():
  %17: s32 = call %0 {target="t"}
  ret
}`;

test('a shared ret tail no flag-free `while (1)` takes is copied, not flagged', () => {
  const { src, agreement, shipped } = judged(SHARED_TAIL_LOOP_AFTER);
  expect(src).toContain('            do {\n                if (probe(v2, a0) == a2) {\n                    t(a0);\n');
  expect(src).not.toMatch(/= 1;\n\s*break;/);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(SHARED_TAIL_LOOP_AFTER);
});

/** mwcc_242_81's `for (i…) { for (j…) if (probe(j, i) == x) goto out; k(i); } out: t(i);`: the
 *  hit's ret-tail copy is refused where it is emitted on the first structuring, and lifts once the
 *  ret copies rank last. The outward flag, a variable the asm does not hold, is asked only of a
 *  structuring every reading without it declines (`OutwardRanking`). */
const RET_COPY_RANKED_LAST = `fn retlast {
^bb0(%0: s32, %1: s32, %2: s32):
  br ^bb6(%0)
^bb1():
  %3: s32 = call %14 {target="mark"}
  %4: s32 = const {value=0}
  br ^bb4(%4)
^bb2():
  %5: s32 = call %10, %14 {target="probe"}
  %7: u32 = icmp_eq %5, %2
  cond_br %7, ^bb7(), ^bb3()
^bb3():
  %8: s32 = const {value=1}
  %9: s32 = add %10, %8
  br ^bb4(%9)
^bb4(%10: s32):
  %11: u32 = icmp_slt %10, %1
  cond_br %11, ^bb2(), ^bb5()
^bb5():
  %18: s32 = call %14 {target="k"}
  %12: s32 = const {value=1}
  %13: s32 = add %14, %12
  br ^bb6(%13)
^bb6(%14: s32):
  %15: u32 = icmp_slt %14, %1
  cond_br %15, ^bb1(), ^bb7()
^bb7():
  %16: s32 = call %14 {target="t"}
  ret
}`;

test('a `goto` out of both loops that a ranked-last ret-tail copy spells takes no flag', () => {
  const { src, agreement, shipped } = judged(RET_COPY_RANKED_LAST);
  expect(src).not.toMatch(/= 1;\n\s*break;/);
  expect(src.match(/\bt\(v\d+\);\n\s*return;/g)).toHaveLength(2);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(RET_COPY_RANKED_LAST);
});

/** The falling arm's `goto` lands INSIDE the arm it falls into (`… k(i); case 2: h(i); out: g(i);
 *  break;`, agbcc's cross-jump of a shared `g(i); break;` tail). No `break;` reaches that target,
 *  and the flag's `if (f == 0)` would run past the arm's end into the arm the switch renders after
 *  it (`TWO_LEVEL_REGION_GATES`, `skips-region-end`). */
const GOTO_INTO_NEXT_ARM = `fn intonextarm {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb2(), ^bb8(), ^bb2(), ^bb6() {cases=[0;1;2;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb8()
^bb8():
  %17: s32 = call %5 {target="h"}
  br ^bb9()
^bb9():
  %18: s32 = call %5 {target="g"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

/** A `goto` out of THREE loops: the flag is handed out one loop at a time, to the loop just around
 *  the one it leaves, and the middle loop's exit is not where the code from the target goes. */
const OUT_OF_THREE_LOOPS = `fn threeloops {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  br ^bb20(%3)
^bb20(%30: s32):
  %31: s32 = call %30 {target="mid"}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb7(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  %32: s32 = add %30, %7
  %33: u32 = icmp_slt %32, %1
  cond_br %33, ^bb20(%32), ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  %20: s32 = call %0 {target="after"}
  br ^bb11(%3)
^bb11(%21: s32):
  %22: s32 = call %21 {target="tail"}
  %23: s32 = add %21, %7
  %24: u32 = icmp_slt %23, %0
  cond_br %24, ^bb11(%23), ^bb12()
^bb12():
  ret
}`;

/** The inner loop in a case body of a switch nested in a case body of a switch in the outer loop:
 *  one `if (f != 0) break;` after the inner switch would leave only the outer switch. */
const THROUGH_A_SWITCH_IN_A_SWITCH = `fn switchinswitch {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %7: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb9()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  switch_br %5, ^bb20(), ^bb8(), ^bb6() {cases=[0;1]}
^bb20():
  %30: s32 = call %5 {target="sel"}
  switch_br %30, ^bb2(), ^bb21(), ^bb6() {cases=[0;1]}
^bb21():
  %31: s32 = call %5 {target="h"}
  br ^bb6()
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb8():
  %17: s32 = call %5 {target="g"}
  br ^bb6()
^bb6():
  %18: s32 = call %5 {target="latch"}
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb9()
^bb9():
  %20: s32 = call %0 {target="after"}
  br ^bb11(%3)
^bb11(%21: s32):
  %22: s32 = call %21 {target="tail"}
  %23: s32 = add %21, %7
  %24: u32 = icmp_slt %23, %0
  cond_br %24, ^bb11(%23), ^bb12()
^bb12():
  ret
}`;

test.each([
  ['a third exit target', THREE_EXIT_TARGETS],
  ['a `goto` out of three loops', OUT_OF_THREE_LOOPS],
  ['a `goto` out of both loops through a switch in a switch', THROUGH_A_SWITCH_IN_A_SWITCH],
  ["the enclosing loop's header", TARGET_IS_THE_ENCLOSING_HEADER],
  ['a second exit out of a case body', SECOND_EXIT_FROM_A_CASE_BODY],
  ['a second exit into the switch arm its own arm falls into', GOTO_INTO_NEXT_ARM],
])('%s stays declined', (_, ir) => {
  expect(() => judged(ir)).toThrow(/cannot structure/);
});

/** Which rule of the two-level tables refuses each decline fixture, counted with `tallying`: the
 *  census the tables exist for, read without editing the pass. */
const refusalsOf = (ir: string): string[] => {
  const tables = [
    tallying(TWO_LEVEL_EXIT_GATES),
    tallying(TWO_LEVEL_REGION_GATES),
    tallying(TWO_LEVEL_BREAK_GATES),
    tallying(OUTWARD_EXIT_GATES),
  ] as const;
  expect(() =>
    judged(ir, {
      twoLevelExitGates: tables[0].gates,
      twoLevelRegionGates: tables[1].gates,
      twoLevelBreakGates: tables[2].gates,
      outwardExitGates: tables[3].gates,
    }),
  ).toThrow(/cannot structure/);
  return tables.flatMap((t) => t.refusals().map(([id]) => id)).sort();
};

test('each decline is refused by the two-level rule its shape names', () => {
  // `own-target-held-back` is the outward rung's first pass, which weighs every exit of a loop
  expect(refusalsOf(THREE_EXIT_TARGETS)).toEqual([
    'exit-never-meets-target',
    'own-target-held-back',
    'second-target-elsewhere',
  ]);
  expect(refusalsOf(TARGET_IS_THE_ENCLOSING_HEADER)).toEqual([
    'own-target-held-back',
    'skip-reenters-loop',
    'target-is-enclosing-header',
  ]);
  expect(refusalsOf(SECOND_EXIT_FROM_A_CASE_BODY)).toEqual(['from-a-case-body']);
  expect(refusalsOf(GOTO_INTO_NEXT_ARM)).toEqual(['skips-region-end']);
  expect(refusalsOf(OUT_OF_THREE_LOOPS)).toContain('not-a-break-arm');
});

test('without the three-loop rules a `goto` out of three loops is still refused by the middle loop', () => {
  // `target-two-loops-out` and `from-a-deeper-loop` are DEFENSIVE: the middle loop never takes the
  // hand-out, since the code from the target misses its exit
  const outward = tallying(without(OUTWARD_EXIT_GATES, 'from-a-deeper-loop'));
  expect(() =>
    judged(OUT_OF_THREE_LOOPS, {
      twoLevelExitGates: without(TWO_LEVEL_EXIT_GATES, 'target-two-loops-out'),
      outwardExitGates: outward.gates,
    }),
  ).toThrow(/cannot structure/);
  expect(outward.refusals().map(([r]) => r)).toEqual(['not-a-break-arm']);
});

test('without second-target-elsewhere a third exit target is still refused where its break is written', () => {
  expect(() =>
    judged(THREE_EXIT_TARGETS, { twoLevelExitGates: without(TWO_LEVEL_EXIT_GATES, 'second-target-elsewhere') }),
  ).toThrow(/a break out of block #\d+ has no edge beside it that stays in the loop/);
});

test('without from-a-case-body the case-body exit is refused by the switch-exit rule behind it', () => {
  expect(() => judged(SECOND_EXIT_FROM_A_CASE_BODY, { twoLevelBreakGates: [] })).toThrow(
    /a case body leaves its switch for a loop exit past the switch's end/,
  );
});

test('without skip-reenters-loop the two-level continue lifts, and agrees: the rule refuses a correct reading', () => {
  const { src, agreement, shipped } = judged(TARGET_IS_THE_ENCLOSING_HEADER, {
    twoLevelExitGates: without(TWO_LEVEL_EXIT_GATES, 'skip-reenters-loop'),
  });
  expect(src).toMatch(/if \(v\d+ == 0\) continue;/);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(TARGET_IS_THE_ENCLOSING_HEADER);
});

test('without skips-region-end the goto into the next arm lifts, and agrees: the rule refuses a correct reading', () => {
  // the arm it falls into renders twice, once inside `if (f == 0)` ahead of the target and once as
  // its own case; each copy ends in a jump, so neither falls into the other
  const { src, agreement, shipped } = judged(GOTO_INTO_NEXT_ARM, { twoLevelRegionGates: [] });
  expect(src.match(/h\(v\d+\);/g)).toHaveLength(2);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(GOTO_INTO_NEXT_ARM);
});

test('without own-target-held-back the hit code laid out first takes a second flag, and agrees: the rule picks the reading', () => {
  const ir = HIT_CODE_LAID_OUT_FIRST(true);
  const { src, agreement, shipped } = judged(ir, {
    twoLevelExitGates: without(TWO_LEVEL_EXIT_GATES, 'own-target-held-back'),
  });
  expect(src.match(/if \(v\d+ [!=]= 0\)/g)).toHaveLength(2);
  expect(agreement.disagree).toBe(0);
  expect(shipped.disagree).toBe(0);
  expect(agreement.judged).toBe(SEEDS.length);
  expectCovered(ir);
});
