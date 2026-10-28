// A SECOND EXIT PAST THE CODE AFTER THE LOOP, spelled with a flag.
//
// `for (i…) { for (j…) { if (hit(j)) goto next; } k(i); next:; }` leaves the inner loop two ways:
// by its own exit, into `k(i)`, and from the search straight to the end of the outer body. L3 has
// no `goto`, so structure spells the second way out `f = 1; break;`, with `f = 0;` ahead of the loop
// and the code it skips under `if (f == 0)` after it (structure.ts `TwoLevelExit`). Every fixture is
// judged against its own IR by the trace oracle (`irAgreement`), as `structure()` returns it and as
// it ships after `readabilityRewrites`, and over enough seeds to cover a zero-trip inner loop, a hit
// on the first and on a later element, and no hit at all (`covers`). The decline fixtures are the
// shapes the reading does not take: a third exit target, a target outside the enclosing loop, the
// enclosing loop's header, a second exit out of a case body, and one into the switch arm its own
// arm falls into.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { tallying, without } from '../src/l3/gates';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import {
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

/** The hit leaves BOTH loops (`goto done` past the outer one, a merge that also takes the outer
 *  loop's own exit): a flag read after the inner loop cannot reach it without a second `break`, and
 *  the loop declines before the inner loop is asked for a two-level exit. */
const TARGET_PAST_THE_ENCLOSING_LOOP = `fn pastouter {
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

test.each([
  ['a third exit target', THREE_EXIT_TARGETS],
  ['a target outside the enclosing loop', TARGET_PAST_THE_ENCLOSING_LOOP],
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
  ] as const;
  expect(() =>
    judged(ir, {
      twoLevelExitGates: tables[0].gates,
      twoLevelRegionGates: tables[1].gates,
      twoLevelBreakGates: tables[2].gates,
    }),
  ).toThrow(/cannot structure/);
  return tables.flatMap((t) => t.refusals().map(([id]) => id)).sort();
};

test('each decline is refused by the two-level rule its shape names', () => {
  expect(refusalsOf(THREE_EXIT_TARGETS)).toEqual(['exit-never-meets-target', 'second-target-elsewhere']);
  expect(refusalsOf(TARGET_IS_THE_ENCLOSING_HEADER)).toEqual(['skip-reenters-loop', 'target-is-enclosing-header']);
  expect(refusalsOf(SECOND_EXIT_FROM_A_CASE_BODY)).toEqual(['from-a-case-body']);
  expect(refusalsOf(GOTO_INTO_NEXT_ARM)).toEqual(['skips-region-end']);
  // the `goto` out of both loops declines before the inner loop is asked for a two-level exit
  expect(refusalsOf(TARGET_PAST_THE_ENCLOSING_LOOP)).toEqual([]);
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
