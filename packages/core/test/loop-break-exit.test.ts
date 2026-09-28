// A `break` OUT OF A LOOP LANDS WHERE THE HEADER'S OWN EXIT DOES.
//
// A test-at-top `while` renders its exit region once, after the loop, and both of its exits reach
// it: the header's test, and any `break`. That region is rendered raw — no back-edge substitution —
// and on the header exit that is right, since the loop variables still hold the values the header
// read. A `break` from the latch leaves AFTER the latch's update copies, so a header value the region
// re-derives from an updated name would be computed one iteration on; that break is spelled ahead of
// the update instead.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile, readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';
import { irAgreement } from './helpers';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

/** `int g3(int a, int b, int c, int d){ int t = a, u = a; do { b = t ^ (b + t); if (c > 2) break; }
 *  while (--d > 0); a = b * u + b; return (b ^ a) * (u * a); }` at the synthetic tier's mwcc_242_81
 *  flags. The header computes `%8` and tests `c > 2`; the latch counts `d` down and hands `%8` back.
 *  After the loop `%8` is read on both exits. */
const HEADER_VALUE_READ_AFTER_BOTH_EXITS = `fn g3 {
^bb0(%0: s32, %1: s32, %2: s32, %3: s32):  ; writes=1
  br ^bb1(%1, %3) {fallthrough=true}  ; order ^bb1(-, -)
^bb1(%4: s32, %5: s32):  ; writes=2
  %6: s32 = const {value=2}
  %7: s32 = add %4, %0
  %8: s32 = xor %0, %7
  %9: u32 = icmp_sgt %2, %6
  cond_br %9, ^bb3(), ^bb2()  ; order ^bb3() ^bb2()
^bb2():  ; writes=1
  %10: s32 = const {value=-1}
  %11: s32 = add %5, %10
  %12: s32 = const {value=0}
  %13: u32 = icmp_sgt %11, %12
  cond_br %13, ^bb1(%8, %11), ^bb3()  ; order ^bb1(-, 0) ^bb3()
^bb3():  ; writes=5
  %14: s32 = mul %8, %0
  %15: s32 = add %8, %14
  %16: s32 = mul %0, %15
  %17: s32 = xor %8, %15
  %18: s32 = mul %17, %16
  ret %18
}`;

test('a header value read after a break is not re-derived from the updated name', () => {
  expect(emit(HEADER_VALUE_READ_AFTER_BOTH_EXITS)).toBe(
    's32 g3(s32 a0, s32 a1, s32 a2, s32 a3) {\n    s32 v0;\n    s32 v1;\n    v0 = a1;\n    v1 = a3;\n' +
      '    while (a2 <= 2) {\n        if (v1 + -1 <= 0) break;\n        v0 = a0 ^ v0 + a0;\n        v1 = v1 + -1;\n' +
      '    }\n    return (a0 ^ v0 + a0 ^ (a0 ^ v0 + a0) + (a0 ^ v0 + a0) * a0) * ' +
      '(a0 * ((a0 ^ v0 + a0) + (a0 ^ v0 + a0) * a0));\n}\n',
  );
});

// A `break` FROM INSIDE THE BODY, to that same exit. The edge leaves before the update, so the exit
// region reads the values the header read and the one rendering after the loop serves both exits.
// Each accepted fixture is also run against its own IR (`irAgreement`), so a break spelled on the
// wrong edge or with the wrong sense changes an observable rather than only a string. It is judged
// twice: as `structure()` returns it, and as it ships, after `readabilityRewrites` — a rewrite that
// mis-models the statement shape (a dce that lets a mid-body `break` fall through drops the copy it
// carries) is invisible to the first judgement.
//
// Refusals and their witnesses: header→exit copies (`HEADER_EXIT_COPIES`), a `do-while`
// (`DO_WHILE_BREAK`), and a latch `break` under an `if` whose join is the loop's exit
// (`IF_JOINING_AT_THE_EXIT`). A refusal is loud only where the exit is a live merge; an exit that ends
// in a `ret` can take the tail-copying spelling instead (`M8_RET_EXIT_WITH_COPIES`). A latch `break`
// the latch path refuses is spelled here, ahead of the update (`LATCH_READS_OLD_VALUE`). Three have no
// witness, and are kept as the conditions this spelling rests on rather than as rules any input is
// known to need: an edge out of a nested loop's body (a loop this recognizer admits leaves only to its
// own exit, which lies inside ours); an in-body branch whose other edge leaves the loop as well
// (if-recovery declines those branches first); and an exit region reading a name this iteration
// already wrote (naming gives no header value such a name).
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

type Agreement = { judged: number; disagree: number };
const judged = (ir: string): { src: string; agreement: Agreement; shipped: Agreement } => {
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

/** `sa3:VramMalloc:agbcc`'s inner loop: `for (j = 0; j < count; j++) { if (i + j >= max) return
 *  ewram_end; if (state[i + j] != 0) break; } if (j == count) …`. A latch of its own, an early
 *  `return` arm, and a `break` to a merge that reads `j` and does work before it returns. */
const INNER_BREAK_TO_MERGE = `fn vraminner {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  br ^bb1(%3)
^bb1(%4: s32):
  %5: u32 = icmp_slt %4, %0
  cond_br %5, ^bb2(), ^bb5()
^bb2():
  %6: s32 = add %1, %4
  %7: u32 = icmp_slt %6, %2
  cond_br %7, ^bb3(), ^bb7()
^bb3():
  %8: s32 = call %6 {target="f"}
  %9: s32 = const {value=0}
  %10: u32 = icmp_eq %8, %9
  cond_br %10, ^bb4(), ^bb5()
^bb4():
  %11: s32 = const {value=1}
  %12: s32 = add %4, %11
  br ^bb1(%12)
^bb5():
  %13: u32 = icmp_eq %4, %0
  cond_br %13, ^bb6(), ^bb8()
^bb6():
  %14: s32 = add %1, %4
  %16: s32 = call %14 {target="g"}
  ret %14
^bb7():
  %15: s32 = const {value=-1}
  ret %15
^bb8():
  ret %4
}`;

test('a mid-body `break` to the loop exit is spelled where it leaves', () => {
  const { src, agreement, shipped } = judged(INNER_BREAK_TO_MERGE);
  expect(src).toBe(
    's32 vraminner(s32 a0, s32 a1, s32 a2) {\n    s32 v0;\n    v0 = 0;\n    while (v0 < a0) {\n' +
      '        if (a1 + v0 >= a2) {\n            return -1;\n        } else {\n' +
      '            if (f(a1 + v0) != 0) break;\n            v0 = v0 + 1;\n        }\n    }\n' +
      '    if (v0 != a0) {\n        return v0;\n    } else {\n        g(a1 + v0);\n        return a1 + v0;\n    }\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** The break as the TAKEN edge, the body continuing on the fall-through. */
const BREAK_ON_TAKEN_EDGE = `fn breaktaken {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb4()
^bb2():
  %5: s32 = add %1, %3
  %6: s32 = call %5 {target="f"}
  %7: s32 = const {value=0}
  %8: u32 = icmp_eq %6, %7
  cond_br %8, ^bb4(), ^bb3()
^bb3():
  %9: s32 = const {value=1}
  %10: s32 = add %3, %9
  br ^bb1(%10)
^bb4():
  %11: s32 = call %3 {target="g"}
  ret %3
}`;

test('the break sense follows the edge that leaves', () => {
  const { src, agreement, shipped } = judged(BREAK_ON_TAKEN_EDGE);
  expect(src).toBe(
    's32 breaktaken(s32 a0, s32 a1) {\n    s32 v0;\n    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n' +
      '        if (f(a1 + v0) == 0) break;\n    }\n    g(v0);\n    return v0;\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** A merge inside the body before the break: its param is written on this iteration, under a name of
 *  its own, and the exit still reads the header's `v1`. */
const MERGE_BEFORE_BREAK = `fn mergebefore {
^bb0(%0: s32, %1: s32):
  br ^bb1(%1)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb6()
^bb2():
  %5: s32 = call %3 {target="f"}
  %6: s32 = const {value=0}
  %7: u32 = icmp_slt %5, %6
  cond_br %7, ^bb3(), ^bb4()
^bb3():
  %8: s32 = const {value=1}
  %9: s32 = add %3, %8
  br ^bb5(%9)
^bb4():
  %10: s32 = const {value=2}
  %11: s32 = add %3, %10
  br ^bb5(%11)
^bb5(%12: s32):
  %13: s32 = call %12 {target="h"}
  %14: u32 = icmp_eq %13, %6
  cond_br %14, ^bb6(), ^bb7()
^bb7():
  br ^bb1(%12)
^bb6():
  %15: s32 = call %3 {target="g"}
  ret %3
}`;

test('a body merge ahead of the break does not reach the exit', () => {
  const { src, agreement, shipped } = judged(MERGE_BEFORE_BREAK);
  expect(src).toBe(
    's32 mergebefore(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    v1 = a1;\n    while (v1 < a0) {\n' +
      '        v0 = 0;\n        if ((s32)f(v1) >= v0) {\n            v2 = v1 + 2;\n        } else {\n' +
      '            v2 = v1 + 1;\n        }\n        if (h(v2) == v0) break;\n        v1 = v2;\n    }\n' +
      '    g(v1);\n    return v1;\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** The break CARRIES a value: the exit takes a param, the header hands it the loop variable (an
 *  identity copy) and the break hands it this iteration's `g(v)`. The statement after the `if`
 *  overwrites the same name for the next iteration, so the copy inside the `if` is live only
 *  through the `break`. pokeemerald's `AgbRFU_checkID` (`id = Sio32IDMain(); if (id != 0) break;`
 *  … `return id;`) has this shape. The test is an `icmp_eq`: the IR oracle models no `icmp_ne`, and
 *  skips every seed that enters the loop when one is there. */
const BREAK_CARRIES_A_COPY = `fn brkcopy {
^bb0(%0: s32, %1: s32):
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(), ^bb4(%2)
^bb2():
  %4: s32 = call %2 {target="g"}
  %5: s32 = call %4 {target="f"}
  %6: s32 = const {value=0}
  %7: u32 = icmp_eq %5, %6
  cond_br %7, ^bb3(), ^bb4(%4)
^bb3():
  %8: s32 = const {value=2}
  %9: s32 = add %4, %8
  br ^bb1(%9)
^bb4(%10: s32):
  %11: s32 = call %10 {target="h"}
  ret %10
}`;

test('the copy a `break` carries survives the readability rewrites', () => {
  const { src, agreement, shipped } = judged(BREAK_CARRIES_A_COPY);
  expect(src).toBe(
    's32 brkcopy(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    v1 = a1;\n    while (v1 < a0) {\n' +
      '        v0 = g(v1);\n        if (f(v0) != 0) {\n            v1 = v0;\n            break;\n        }\n' +
      '        v1 = v0 + 2;\n    }\n    h(v1);\n    return v1;\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** The latch's own conditional `break`, to an exit that is not a `ret` block: the latch path spells
 *  it once the loop is admitted. */
const LATCH_BREAK_TO_LIVE_EXIT = `fn latchlive {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb3()
^bb2():
  %5: s32 = call %3 {target="f"}
  %6: s32 = const {value=1}
  %7: s32 = add %3, %6
  %9: u32 = icmp_eq %7, %1
  cond_br %9, ^bb3(), ^bb1(%7)
^bb3():
  %10: s32 = call %1 {target="g"}
  br ^bb4()
^bb4():
  ret %1
}`;

test('a latch `break` to an exit that is not a `ret` block is spelled by the latch path', () => {
  const { src, agreement, shipped } = judged(LATCH_BREAK_TO_LIVE_EXIT);
  expect(src).toBe(
    's32 latchlive(s32 a0, s32 a1) {\n    s32 v0;\n    v0 = 0;\n    while (v0 < a0) {\n        f(v0);\n' +
      '        v0 = v0 + 1;\n        if (v0 == a1) break;\n    }\n    g(a1);\n    return a1;\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** A `ret`-terminated exit with no effects: the shape `kleod:UpdateEntityAnimationInfoEntries:agbcc`
 *  has, whose source is a `for` with a `break`. */
const EDGE_TO_RET_EXIT = `fn retexit {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb4()
^bb2():
  %5: s32 = add %1, %3
  %6: s32 = call %5 {target="f"}
  %7: s32 = const {value=0}
  %8: u32 = icmp_eq %6, %7
  cond_br %8, ^bb3(), ^bb4()
^bb3():
  %9: s32 = const {value=1}
  %10: s32 = add %3, %9
  br ^bb1(%10)
^bb4():
  ret
}`;

test('an edge to a pure `ret` exit is a `break` too', () => {
  const { src, agreement, shipped } = judged(EDGE_TO_RET_EXIT);
  expect(src).toBe(
    'void retexit(s32 a0, s32 a1) {\n    s32 v0;\n    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n' +
      '        if (f(a1 + v0) != 0) break;\n    }\n    return;\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** agbcc -O2 of `int x(int n, int *p) { int i = 0; while (i < n) { if (f(p[i])) break; i++; }
 *  return i * 3 + n; }`. agbcc keeps a source-duplicated return tail duplicated: the tail-copying
 *  spelling (`if (f(*v1) != 0) { return v0 * 3 + a0; }`) compiles to 26 instructions, and only the
 *  `break` spelling gives back these 20. */
const PURE_TAIL_BREAK = `x:
	push	{r4, r5, r6, lr}
	add	r6, r0, #0
	mov	r5, #0x0
	add	r4, r1, #0
	b	.L3
.L6:
	add	r4, r4, #0x4
	add	r5, r5, #0x1
.L3:
	cmp	r5, r6
	bge	.L4
	ldr	r0, [r4]
	bl	f
	cmp	r0, #0
	beq	.L6
.L4:
	lsl	r0, r5, #0x1
	add	r0, r0, r5
	add	r0, r0, r6
	pop	{r4, r5, r6}
	pop	{r1}
	bx	r1
`;

test('an edge to an exit whose tail agbcc keeps single is spelled `break`', () => {
  const src = decompile('x', PURE_TAIL_BREAK, ARMV4T_AGBCC, {
    prototypes: { x: { params: 2 }, f: { params: 1 } },
  }).source;
  expect(src).toContain('break;');
  expect(src.match(/return /g)).toHaveLength(1);
});

/** The exit takes a param: `-1` from the header, `j` from the break. The header's copy runs after
 *  the loop, so a `break` would reach it and overwrite `j`. The exit is a live merge, not a `ret`
 *  block, so nothing else can spell the edge. */
const HEADER_EXIT_COPIES = `fn exitcopies {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  %20: s32 = const {value=-1}
  cond_br %4, ^bb2(), ^bb4(%20)
^bb2():
  %5: s32 = add %1, %3
  %6: s32 = call %5 {target="f"}
  %7: s32 = const {value=0}
  %8: u32 = icmp_eq %6, %7
  cond_br %8, ^bb3(), ^bb4(%3)
^bb3():
  %9: s32 = const {value=1}
  %10: s32 = add %3, %9
  br ^bb1(%10)
^bb4(%11: s32):
  %12: s32 = call %11 {target="g"}
  br ^bb5()
^bb5():
  ret %11
}`;

test('a `break` the header-exit copies would overwrite declines', () => {
  expect(() => emit(HEADER_EXIT_COPIES)).toThrow(/would run the copies the loop header hands its exit/);
});

/** The break test sits in the latch, after the update, and the exit reads the header's `v1`. The
 *  latch path spells a latch break update-first, which would hand the exit `v2`, and refuses; the
 *  break is spelled first instead, ahead of the update copy. `MERGE_BEFORE_BREAK` is the same
 *  program with the update copy in a block of its own, and lifts to the same C. */
const LATCH_READS_OLD_VALUE = `fn latchold {
^bb0(%0: s32, %1: s32):
  br ^bb1(%1)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb6()
^bb2():
  %5: s32 = call %3 {target="f"}
  %6: s32 = const {value=0}
  %7: u32 = icmp_slt %5, %6
  cond_br %7, ^bb3(), ^bb4()
^bb3():
  %8: s32 = const {value=1}
  %9: s32 = add %3, %8
  br ^bb5(%9)
^bb4():
  %10: s32 = const {value=2}
  %11: s32 = add %3, %10
  br ^bb5(%11)
^bb5(%12: s32):
  %13: s32 = call %12 {target="h"}
  %14: u32 = icmp_eq %13, %6
  cond_br %14, ^bb6(), ^bb1(%12)
^bb6():
  %15: s32 = call %3 {target="g"}
  ret %3
}`;

test('a latch `break` whose exit reads the value before the update leaves ahead of the update', () => {
  const { src, agreement, shipped } = judged(LATCH_READS_OLD_VALUE);
  expect(src).toBe(judged(MERGE_BEFORE_BREAK).src.replace('mergebefore', 'latchold'));
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** agbcc -O2 of `int m8(int *p, int n, int m, int k) { int i = 0; int x; while ((x = p[i]) != k) {
 *  if (*p == 0) return 1; if (k < m) break; i++; x = x + 1; if (i > n) break; } G = 0; return x; }`.
 *  The exit `.L4` ends in a return and takes `x` from three edges, so the header hands it a copy and
 *  the mid-body `break` is refused; the edge copies the exit's tail into its arm instead. */
const M8_RET_EXIT_WITH_COPIES = `m8:
	push	{r4, r5, r6, r7, lr}
	add	r5, r0, #0
	add	r7, r1, #0
	add	r6, r2, #0
	mov	r4, #0x0
	add	r1, r5, #0
.L3:
	ldr	r2, [r1]
	cmp	r2, r3
	beq	.L4
	ldr	r0, [r5]
	cmp	r0, #0
	bne	.L6
	mov	r0, #0x1
	b	.L10
.L6:
	cmp	r3, r6
	blt	.L4
	add	r1, r1, #0x4
	add	r4, r4, #0x1
	add	r2, r2, #0x1
	cmp	r4, r7
	ble	.L3
.L4:
	ldr	r1, .L11
	mov	r0, #0x0
	str	r0, [r1]
	add	r0, r2, #0
.L10:
	pop	{r4, r5, r6, r7}
	pop	{r1}
	bx	r1
.L11:
	.word	G
`;

test('a refused `break` to an exit that ends in a return copies the tail instead', () => {
  const src = decompile('m8', M8_RET_EXIT_WITH_COPIES, ARMV4T_AGBCC, { prototypes: { m8: { params: 4 } } }).source;
  expect(src).not.toContain('break');
  expect(src.match(/G = 0;/g)).toHaveLength(3);
});

/** agbcc -O2 of `int f(int *p, int n, int m, int k) { int t = 0; while (*p != k) { if (p[1] == m) {
 *  if (p[2] == 0) break; t += 3; } p++; if (--n < 0) break; } G = t; if (n > 5) t = 1; return t; }`.
 *  The `if (p[1] == m)` joins at `.L4`, the loop's exit, and both of its arms reach the latch's
 *  `if (--n < 0) break;`. Spelled with the latch's implicit continue, `G = t; …; return t;` would
 *  render after that `if` inside the body and the loop would run at most once. */
const IF_JOINING_AT_THE_EXIT = `f:
	push	{r4, r5, r6, lr}
	add	r4, r0, #0
	add	r5, r2, #0
	mov	r2, #0x0
	ldr	r6, .L11
.L3:
	ldr	r0, [r4]
	cmp	r0, r3
	beq	.L4
	ldr	r0, [r4, #0x4]
	cmp	r0, r5
	bne	.L6
	ldr	r0, [r4, #0x8]
	cmp	r0, #0
	beq	.L4
	add	r2, r2, #0x3
.L6:
	add	r4, r4, #0x4
	sub	r1, r1, #0x1
	cmp	r1, #0
	bge	.L3
.L4:
	str	r2, [r6]
	cmp	r1, #0x5
	ble	.L10
	mov	r2, #0x1
.L10:
	add	r0, r2, #0
	pop	{r4, r5, r6}
	pop	{r1}
	bx	r1
.L11:
	.word	G
`;

test('a latch break under an `if` that joins at the loop exit declines', () => {
  expect(() => decompile('f', IF_JOINING_AT_THE_EXIT, ARMV4T_AGBCC, { prototypes: { f: { params: 4 } } })).toThrow(
    /unrecovered back-edge/,
  );
});

/** A bottom-tested loop with a mid-body edge to its exit, which is not a `ret` block. */
const DO_WHILE_BREAK = `fn dwbreak {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %5: s32 = add %1, %3
  %6: s32 = call %5 {target="f"}
  %7: s32 = const {value=0}
  %8: u32 = icmp_eq %6, %7
  cond_br %8, ^bb3(), ^bb2()
^bb2():
  %9: s32 = const {value=1}
  %10: s32 = add %3, %9
  %4: u32 = icmp_slt %10, %0
  cond_br %4, ^bb1(%10), ^bb3()
^bb3():
  %11: s32 = call %3 {target="g"}
  br ^bb4()
^bb4():
  ret %3
}`;

test('a `do-while` with a mid-body `break` still declines', () => {
  expect(() => emit(DO_WHILE_BREAK)).toThrow(StructureError);
});
