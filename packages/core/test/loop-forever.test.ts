// A LOOP WITH NO TEST OF ITS OWN: `while (1)`.
//
// A loop no other recognizer takes — several latches, such as a `continue` in mid-body beside the
// bottom latch, a `do-while` whose `||` test stayed as branches, or an inner self-loop on the outer
// loop's own header; or one latch under a header that computes before it tests — has no single test to put
// at its top or bottom. It is spelled `while (1)`: every edge back to the header is a continue
// (implicit at the foot of the region, `continue;` above it), every edge out is a `break` to the one
// exit the loop is given or an early `return`. An `if` in the body joins where the paths that do
// not end meet (`foreverJoin`), so an arm that continues does not drag the rest of the iteration
// into its sibling. The header's params are named as any loop's are, before the body's values: a
// value the body computes never takes the name of a param the body still reads.
//
// Each accepted fixture is run against its own IR (`irAgreement`), as `structure()` returns it and
// as it ships after `readabilityRewrites`.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { decompile, readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { CARRIER_NAME_GATES, StructureError, type StructureHooks, structure } from '../src/structure/structure';
import { PPC_MWCC } from '../src/target';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const lifted = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return fn;
};
const judged = (ir: string, hooks: StructureHooks = {}) => {
  const sfn = structure(lifted(ir), {}, hooks);
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

/** `do { t = f(a0); } while (t == a1 || g(t) < a0 || t < 3);` with the call keeping the `||`
 *  test as three branches, the header the first of them. */
const UNFOLDED_OR = `fn unfoldedor {
^bb0(%0: s32, %1: s32):
  br ^bb1()
^bb1():
  %2: s32 = call %0 {target="f"}
  %3: u32 = icmp_eq %2, %1
  cond_br %3, ^bb1(), ^bb2()
^bb2():
  %4: s32 = call %2 {target="g"}
  %5: u32 = icmp_slt %4, %0
  cond_br %5, ^bb1(), ^bb3()
^bb3():
  %6: s32 = const {value=3}
  %7: u32 = icmp_slt %2, %6
  cond_br %7, ^bb1(), ^bb4()
^bb4():
  ret %2
}`;

/** Two latches handing the header DIFFERENT values, one of them a constant: `i = 0; while (1) {
 *  t = f(i + 1); if (t == a1) { i = i + 1; continue; } if (g(t) >= a0) break; i = 1; } return
 *  i + 1;`. Named as the merge of its carriers, the param would take the constant's name, and the
 *  constant's assignment at the top of the body would overwrite the `i` the call still reads. */
const CONSTBACK = `fn constback {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = call %5 {target="f"}
  br ^bb4()
^bb4():
  %7: u32 = icmp_eq %6, %1
  cond_br %7, ^bb1(%5), ^bb2()
^bb2():
  %8: s32 = call %6 {target="g"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%4), ^bb3()
^bb3():
  ret %5
}`;

/** The same two back edges on a header that is its own first latch: `i = 0; while (1) { t =
 *  f(i + 1); if (t == a1) { i = i + 1; continue; } if (g(t) >= a0) break; i = 1; } return i + 1;`. */
const DIFFERENT_UPDATES = `fn diffupd {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = call %5 {target="f"}
  %7: u32 = icmp_eq %6, %1
  cond_br %7, ^bb1(%5), ^bb2()
^bb2():
  %8: s32 = call %6 {target="g"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%4), ^bb3()
^bb3():
  ret %5
}`;

/** A later test reading the value the header was entered with, which the first term's back edge
 *  replaces: `i = 0; while (1) { if (f(i + 1) == a1) { i = i + 1; continue; } if (g(i) >= a0)
 *  break; i = i + 1; } return i + 1;`. */
const TERM_READS_ENTRY = `fn termentry {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = call %5 {target="f"}
  %7: u32 = icmp_eq %6, %1
  cond_br %7, ^bb1(%5), ^bb2()
^bb2():
  %8: s32 = call %3 {target="g"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%5), ^bb3()
^bb3():
  ret %5
}`;

/** ONE latch, handing the header a value the header computes before it is done reading the param:
 *  `i = 0; for (;;) { t = g(a0); if (i == 5) break; h(i); i = t; } return i + i + t;`. Named after
 *  its back-edge value, `i` would be overwritten by the call. */
const MID_CLOBBER = `fn midclob {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = call %0 {target="g"}
  %4: s32 = const {value=5}
  %5: u32 = icmp_eq %2, %4
  cond_br %5, ^bb3(), ^bb2()
^bb2():
  %6: s32 = call %2 {target="h"}
  br ^bb1(%3)
^bb3():
  %8: s32 = add %2, %2
  %9: s32 = add %8, %3
  ret %9
}`;

/** The one edge out ends in a `return` tail with a call in it, which the body spells as an early
 *  `return`: `i = 1; while (1) { i = k(i, a0); if (9 < i) return f(i) + i; if (i == a1) h(i);
 *  else h(a0); }`. Nothing reaches the end of the loop. */
const RETURN_TAIL = `fn rettail {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=1}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = call %3, %0 {target="k"}
  %5: s32 = const {value=9}
  %6: u32 = icmp_slt %5, %4
  cond_br %6, ^bb3(), ^bb2()
^bb2():
  %7: u32 = icmp_eq %4, %1
  cond_br %7, ^bb4(), ^bb5()
^bb4():
  %8: s32 = call %4 {target="h"}
  br ^bb1(%4)
^bb5():
  %9: s32 = call %0 {target="h"}
  br ^bb1(%4)
^bb3():
  %10: s32 = call %4 {target="f"}
  %11: s32 = add %10, %4
  ret %11
}`;

/** A header that is its own latch beside one other, unconditional latch, which no `do-while` has for
 *  a bottom test. `for (;;) { i++; t = f(i); if (t == a0)
 *  continue; h(t); if (g(t) < a1) { h(i); continue; } break; } return i;` */
const NEST_WITHOUT_TEST = `fn nestfall {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = call %5 {target="f"}
  %7: u32 = icmp_eq %6, %0
  cond_br %7, ^bb1(%5), ^bb2()
^bb2():
  %8: s32 = call %6 {target="h"}
  %9: s32 = call %6 {target="g"}
  %10: u32 = icmp_slt %9, %1
  cond_br %10, ^bb3(), ^bb4()
^bb3():
  %11: s32 = call %5 {target="h"}
  br ^bb1(%5)
^bb4():
  ret %5
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

test('an `||` test left as branches is a `continue` per term and a `break` on the last', () => {
  const r = judged(UNFOLDED_OR);
  expect(r.src).toBe(
    's32 unfoldedor(s32 a0, s32 a1) {\n    s32 v0;\n    while (1) {\n        v0 = f(a0);\n' +
      '        if (v0 == a1) continue;\n        if ((s32)g(v0) < a0) continue;\n        if (v0 >= 3) break;\n' +
      '    }\n    return v0;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('latches handing the header different values leave the param a name of its own', () => {
  for (const ir of [CONSTBACK, DIFFERENT_UPDATES]) {
    const r = judged(ir);
    expect(r.src).toContain('v2 = 0;');
    expect(r.src).toContain('v1 = f(v2 + v0);');
    expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
    expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
  }
});

test('a later test reads the value the iteration was entered with, ahead of any back-edge copy', () => {
  const r = judged(TERM_READS_ENTRY);
  expect(r.src).toContain('if ((s32)g(v0) >= a0) break;');
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('one latch whose value the header computes before its last read of the param keeps the two apart', () => {
  const r = judged(MID_CLOBBER);
  expect(r.src).toBe(
    's32 midclob(s32 a0) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n    while (1) {\n' +
      '        v0 = g(a0);\n        if (v1 == 5) break;\n        h(v1);\n        v1 = v0;\n    }\n' +
      '    return v1 + v1 + v0;\n}\n',
  );
  const { judged: runs, disagree } = r.agreement;
  expect(disagree).toBe(0);
  expect(runs).toBeGreaterThan(100);
});

test('a loop whose only way out is an early `return` renders nothing after it', () => {
  const r = judged(RETURN_TAIL);
  expect(r.src.match(/f\(/g)).toHaveLength(1);
  expect(r.src).toMatch(/\n    }\n}\n$/);
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

/** An inner loop runs before every break, and the code after the loop reads its update:
 *  `i = 0; t = 1; while (1) { j = g(i); do { t = g(t); j += t; } while (g(t) < 9); i += j;
 *  if (40 < i) break; if (i >= a0) break; } return k(t, j);` */
const EXIT_READS_INNER = `fn foreverinner {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=1}
  br ^bb1(%1, %2)
^bb1(%3: s32, %4: s32):
  %5: s32 = call %3 {target="g"}
  br ^bb2(%5, %4)
^bb2(%6: s32, %7: s32):
  %8: s32 = call %7 {target="g"}
  %9: s32 = add %6, %8
  %10: s32 = call %8 {target="g"}
  %11: s32 = const {value=9}
  %12: u32 = icmp_slt %10, %11
  cond_br %12, ^bb2(%9, %8), ^bb3()
^bb3():
  %13: s32 = add %3, %9
  %14: s32 = const {value=40}
  %15: u32 = icmp_slt %14, %13
  cond_br %15, ^bb5(), ^bb4()
^bb4():
  %16: u32 = icmp_slt %13, %0
  cond_br %16, ^bb1(%13, %8), ^bb5()
^bb5():
  %17: s32 = call %8, %9 {target="k"}
  ret %17
}`;

test('the code after a `while (1)` reads an inner loop’s update in the name the inner loop left it in', () => {
  const r = judged(EXIT_READS_INNER);
  expect(r.src).toContain('while (1) {');
  expect(r.src).toMatch(/return k\(v\d+, v\d+\);/);
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

/** `EXIT_READS_INNER`'s refusal: the name the inner value `j + a0` would be read under is a merge
 *  the body writes after the inner loop, and `j`'s name holds its updated value by then, so neither
 *  reading is the value. `latch-inner-sub.test.ts`'s `T2_MERGE` with a break out of the outer loop.
 *  Run with the naming gate that keeps the merge off that name dropped, as `T2_MERGE`'s refusal is.
 *  In `INNER_INVARIANT` the value reads nothing the loops write, and the re-derivation is it. */
const INNER_REWRITTEN = `fn foreverrewritten {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=0}
  br ^bb1(%1, %2)
^bb1(%3: s32, %4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %3, %5
  %7: s32 = const {value=0}
  br ^bb2(%7, %4)
^bb2(%8: s32, %9: s32):
  %10: s32 = add %8, %0
  %12: s32 = const {value=1}
  %13: s32 = add %8, %12
  %14: s32 = const {value=3}
  %15: u32 = icmp_slt %13, %14
  cond_br %15, ^bb2(%13, %10), ^bb3()
^bb3():
  %16: u32 = icmp_slt %6, %0
  cond_br %16, ^bb5(%10), ^bb4()
^bb4():
  %30: s32 = const {value=7}
  %31: u32 = icmp_eq %6, %30
  cond_br %31, ^bb6(), ^bb7()
^bb7():
  %17: s32 = const {value=0}
  br ^bb5(%17)
^bb5(%18: s32):
  %20: s32 = const {value=2}
  %21: u32 = icmp_slt %6, %20
  cond_br %21, ^bb1(%6, %18), ^bb6()
^bb6():
  %19: s32 = call %10 {target="f1"}
  ret %19
}`;
const INNER_INVARIANT = INNER_REWRITTEN.replace(
  '%10: s32 = add %8, %0',
  '%40: s32 = const {value=3}\n  %10: s32 = add %0, %40',
);
const ADMIT_BACK_ARG: StructureHooks = { carrierNameGates: without(CARRIER_NAME_GATES, 'back-arg-live') };

/** mwcc_242_81's `x2`: `do { if (--gF < 0) return u; do { s = g(s) + s; } while (--gF > 0 && s > 2);
 *  if (g(u) == 1) break; u = 0; } while (1); h(c); return s * 5 + u * 11;`. The inner loop
 *  writes `s`, a name the outer header owns, before the break, and the code after the loop reads
 *  the inner update: under the inner loop's naming it is that name, not a re-derivation from it. */
const INNER_WRITES_CARRIER = `ref.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <x2>:
   0:	stwu    r1,-32(r1)
   4:	mflr    r0
   8:	stw     r0,36(r1)
   c:	stw     r31,28(r1)
  10:	li      r31,0
  14:	stw     r30,24(r1)
  18:	li      r30,2
  1c:	stw     r29,20(r1)
  20:	mr      r29,r5
  24:	lwz     r3,0(0)
			24: R_PPC_EMB_SDA21	gF
  28:	addic.  r0,r3,-1
  2c:	stw     r0,0(0)
			2c: R_PPC_EMB_SDA21	gF
  30:	bge-    3c <x2+0x3c>
  34:	mr      r3,r30
  38:	b       8c <x2+0x8c>
  3c:	mr      r3,r31
  40:	bl      40 <x2+0x40>
			40: R_PPC_REL24	g
  44:	lwz     r4,0(0)
			44: R_PPC_EMB_SDA21	gF
  48:	add     r31,r31,r3
  4c:	addic.  r0,r4,-1
  50:	stw     r0,0(0)
			50: R_PPC_EMB_SDA21	gF
  54:	ble-    60 <x2+0x60>
  58:	cmpwi   r31,2
  5c:	bgt+    3c <x2+0x3c>
  60:	mr      r3,r30
  64:	bl      64 <x2+0x64>
			64: R_PPC_REL24	g
  68:	cmpwi   r3,1
  6c:	beq-    78 <x2+0x78>
  70:	li      r30,0
  74:	b       24 <x2+0x24>
  78:	mr      r3,r29
  7c:	bl      7c <x2+0x7c>
			7c: R_PPC_REL24	h
  80:	mulli   r3,r31,5
  84:	mulli   r0,r30,11
  88:	add     r3,r3,r0
  8c:	lwz     r0,36(r1)
  90:	lwz     r31,28(r1)
  94:	lwz     r30,24(r1)
  98:	lwz     r29,20(r1)
  9c:	mtlr    r0
  a0:	addi    r1,r1,32
  a4:	blr
`;

test('a break judges the code after a `while (1)` under the inner loop’s naming', () => {
  const src = decompile('x2', INNER_WRITES_CARRIER, PPC_MWCC, {
    prototypes: { g: { params: 1 }, h: { params: 1, returnsVoid: true } },
  }).source;
  expect(src).toContain('while (1) {');
  expect(src).toMatch(/= (v\d+) \* 5 \+ v\d+ \* 11;[\s\S]*$/);
  expect(src).toMatch(/(v\d+) = \1 \+ v\d+;\n        } while/);
});

test('the code after a `while (1)` declines where neither reading is the inner loop’s value', () => {
  expect(() => structure(lifted(INNER_REWRITTEN), {}, ADMIT_BACK_ARG)).toThrow(StructureError);
  expect(() => structure(lifted(INNER_REWRITTEN), {}, ADMIT_BACK_ARG)).toThrow(/whose name was rewritten/);
  const r = judged(INNER_INVARIANT, ADMIT_BACK_ARG);
  expect(r.src).toContain('return f1(a0 + 3);');
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
});

/** The latch is where both arms of the body's last `if` meet: `while (1) { x = g(n); if (x == 0)
 *  break; if (x & 1) h(x); n += 3; } return n;` */
const LATCH_JOIN = `fn latchjoin {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = call %1 {target="g"}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %2, %3
  cond_br %4, ^bb5(), ^bb2()
^bb2():
  %5: s32 = const {value=1}
  %6: s32 = and %2, %5
  %7: s32 = const {value=0}
  %8: u32 = icmp_ne %6, %7
  cond_br %8, ^bb3(), ^bb4()
^bb3():
  %9: s32 = call %2 {target="h"}
  br ^bb4()
^bb4():
  %10: s32 = const {value=3}
  %11: s32 = add %1, %10
  br ^bb1(%11)
^bb5():
  ret %1
}`;

test('a latch both arms of an `if` reach is the `if`’s join, written once', () => {
  const r = judged(LATCH_JOIN);
  expect(r.src).not.toContain('continue');
  expect(r.src.match(/\+ 3;/g)).toHaveLength(1);
  // a seed whose `g` never returns 0 does not terminate, and is not judged
  for (const { judged: runs, disagree } of [r.agreement, r.shipped]) {
    expect(disagree).toBe(0);
    expect(runs).toBeGreaterThan(20);
  }
});

/** An early `return` laid out inside the loop's span, the code after the loop after it:
 *  `for (;;) { x = g(n); if (x == 0) break; if (x == 7) return 0; n += x; } h(n); return n;` */
const RETURN_INSIDE_SPAN = `fn retspan {
^bb0(%0: s32):
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = call %1 {target="g"}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %2, %3
  cond_br %4, ^bb4(), ^bb2()
^bb2():
  %5: s32 = const {value=7}
  %6: u32 = icmp_eq %2, %5
  cond_br %6, ^bb3(), ^bb5()
^bb3():
  %7: s32 = const {value=0}
  ret %7
^bb5():
  %8: s32 = add %1, %2
  br ^bb1(%8)
^bb4():
  %9: s32 = call %1 {target="h"}
  ret %1
}`;

test('the exit is the target laid out after the loop, not an early `return` inside its span', () => {
  const r = judged(RETURN_INSIDE_SPAN);
  expect(r.src).toMatch(/\n    }\n    h\(v\d+\);\n    return v\d+;\n}\n$/);
  for (const { judged: runs, disagree } of [r.agreement, r.shipped]) {
    expect(disagree).toBe(0);
    expect(runs).toBeGreaterThan(20);
  }
});

test('a header that is its own latch beside an unconditional latch is `while (1)`', () => {
  const r = judged(NEST_WITHOUT_TEST);
  expect(r.src).toContain('while (1) {');
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

// TWO LOOPS ON ONE HEADER. `do { while (c); … } while (d)` compiles to a block that branches back to
// itself and a later latch that branches back to the same block, which is also the CFG of one loop
// whose `||` test stayed as branches when the rest of the outer body fits in the latch block. The
// asm does not say which the source wrote, so both are `while (1)`, the header's own edge a
// `continue`.

/** `do { while ((m = f(a0)) < a1); g(m); } while (h(m) < 0);` */
const NEST = `fn nest {
^bb0(%0: s32, %1: s32):
  br ^bb1()
^bb1():
  %2: s32 = call %0 {target="f"}
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(), ^bb2()
^bb2():
  %4: s32 = call %2 {target="g"}
  br ^bb3()
^bb3():
  %5: s32 = call %2 {target="h"}
  %6: s32 = const {value=0}
  %7: u32 = icmp_slt %5, %6
  cond_br %7, ^bb1(), ^bb4()
^bb4():
  ret %2
}`;
/** A value both loops carry: `x = 0; do { do { x++; } while (x < a1); g(x); } while (h(x) < a0);` */
const NEST_CARRIED = `fn nestc {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %5, %1
  cond_br %6, ^bb1(%5), ^bb2()
^bb2():
  %7: s32 = call %5 {target="g"}
  br ^bb3()
^bb3():
  %8: s32 = call %5 {target="h"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%5), ^bb4()
^bb4():
  ret %5
}`;
/** The rest of the outer body reads the value the inner header was entered with. */
const NEST_READS_PRE_UPDATE = `fn nestpre {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %5, %1
  cond_br %6, ^bb1(%5), ^bb2()
^bb2():
  %7: s32 = call %3 {target="g"}
  br ^bb3()
^bb3():
  %8: s32 = call %5 {target="h"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%5), ^bb4()
^bb4():
  ret %5
}`;

test('a self-loop on the header of an enclosing loop is one `while (1)`', () => {
  const r = judged(NEST);
  expect(r.src).toBe(
    's32 nest(s32 a0, s32 a1) {\n    s32 v0;\n    while (1) {\n        v0 = f(a0);\n' +
      '        if (v0 < a1) continue;\n        g(v0);\n        if ((s32)h(v0) >= 0) break;\n    }\n' +
      '    return v0;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a value both loops carry, read after the inner loop at either version, keeps each reading', () => {
  for (const ir of [NEST_CARRIED, NEST_READS_PRE_UPDATE]) {
    const r = judged(ir);
    expect(r.src).toContain('while (1) {');
    expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
    expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
  }
});
