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
import { foldExitTrampolines } from '../src/raise/latch';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
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
// Refusals and their witnesses: header→exit copies the break cannot share (`HEADER_EXIT_COPIES`,
// and `LATCH_BREAK_SHARES_UPDATED_NAME` for copies reading a name the update wrote,
// `LATCH_BREAK_SHARES_IDENTITY_SLOT` for an exit value whose copy renders nothing; a break handing
// the exit the header's own values shares them, `BREAK_SHARES_HEADER_COPIES`), and a latch `break`
// under an `if` whose join is the loop's exit, where the implicit continue does not hold
// (`IF_JOINING_AT_THE_EXIT`, refused whatever the exit holds). A
// refusal is otherwise loud only where the exit is a live merge; an exit that ends in a `ret` can
// take the tail-copying spelling instead (`M8_RET_EXIT_WITH_COPIES`). A latch `break` the latch path
// refuses is spelled here, ahead of the update (`LATCH_READS_OLD_VALUE`). Three have no
// witness, and are kept as the conditions this spelling rests on rather than as rules any input is
// known to need: an edge out of a nested loop's body (a loop this recognizer admits leaves only to its
// own exit, which lies inside ours); an in-body branch whose other edge leaves the loop as well
// (if-recovery declines those branches first); and an exit region reading a name this iteration
// already wrote (naming gives no header value such a name). A bottom-tested loop with a `break` is
// no `do-while` at all: `while (1)` takes it (`DO_WHILE_BREAK`, and `loop-dowhile-break.test.ts`).
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

// ── EMPTY EXIT TRAMPOLINES (raise/latch.ts `foldExitTrampolines`) ──────────────────────────────

const folded = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const n = foldExitTrampolines(fn);
  verify(fn);
  const sfn = structure(fn);
  return {
    n,
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

/** agbcc -O2 of `synthetic:break_value`, `r = 1; for (i = 1; i < 9; i++) { if (t[i] == 28) { r = i;
 *  break; } } return u[r];`, as it reaches the structurer once the test agbcc peels into the entry is
 *  re-rolled (`raise/reroll.ts`): the break's `r = i` is an edge argument on a block that holds nothing
 *  but its `br` to the code after the loop, which the latch's test also reaches, handing it `1`. */
const BREAK_TRAMPOLINE = `fn brktramp {
^bb0(%0: s32):
  %1: s32 = const {value=1}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = call %2 {target="t"}
  %4: s32 = const {value=28}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb3(), ^bb2()
^bb2():
  %6: s32 = const {value=1}
  %7: s32 = add %2, %6
  %8: s32 = const {value=8}
  %9: u32 = icmp_slt %8, %7
  cond_br %9, ^bb4(%1), ^bb1(%7)
^bb3():
  br ^bb4(%2)
^bb4(%10: s32):
  %11: s32 = call %10 {target="u"}
  ret %11
}`;
/** kleod `sub_0801E664`'s side of the same thing: the trampoline sits on the LATCH's way out, and the
 *  mid-body break reaches the code after the loop directly. */
const LATCH_TRAMPOLINE = `fn latchtramp {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = call %2 {target="t"}
  %4: s32 = const {value=28}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb4(%2), ^bb2()
^bb2():
  %6: s32 = const {value=1}
  %7: s32 = add %2, %6
  %8: u32 = icmp_slt %7, %0
  cond_br %8, ^bb1(%7), ^bb3()
^bb3():
  %9: s32 = const {value=-1}
  br ^bb4(%9)
^bb4(%10: s32):
  %11: s32 = call %10 {target="u"}
  ret %11
}`;

test('an empty block on a break edge folds into the edge, and the break carries its copy', () => {
  const r = folded(BREAK_TRAMPOLINE);
  expect(r.n).toBe(1);
  expect(r.src).toContain('break;');
  expect(r.agreement).toEqual({ judged: 300, disagree: 0 });
  expect(r.shipped).toEqual({ judged: 300, disagree: 0 });
});

test('an empty block on the latch’s exit edge folds the same way', () => {
  const r = folded(
    LATCH_TRAMPOLINE.replace('%9: s32 = const {value=-1}\n  ', '').replace('br ^bb4(%9)', 'br ^bb4(%7)'),
  );
  expect(r.n).toBe(1);
  expect(r.agreement).toEqual({ judged: 300, disagree: 0 });
  expect(r.shipped).toEqual({ judged: 300, disagree: 0 });
});

test('an empty exit block whose target only returns keeps its early-`return` spelling', () => {
  const pureRet = BREAK_TRAMPOLINE.replace('%11: s32 = call %10 {target="u"}\n  ret %11', 'ret %10');
  expect(folded(pureRet).n).toBe(0);
});

test('an empty exit block is folded only beside another exit to the same target', () => {
  // the latch leaves for ^bb5 instead, so ^bb3 is the break's own way to ^bb4
  const lone = BREAK_TRAMPOLINE.replace('cond_br %9, ^bb4(%1), ^bb1(%7)', 'cond_br %9, ^bb5(), ^bb1(%7)').replace(
    '  ret %11\n}',
    '  ret %11\n^bb5():\n  ret %1\n}',
  );
  const fn = parse(lone);
  verify(fn);
  expect(foldExitTrampolines(fn)).toBe(0);
});

/** A loop rotated so its header computes `i + 1` and hands it to the exit, and a mid-body `break`
 *  that hands the exit that same value: agbcc's layout of `for (i = 0; i < n; i++) if (…) break;
 *  return i;` (pokeemerald `FindFirstActiveTask`). The header's copy runs after the loop on both
 *  paths, so the break leaves bare. `f` returns 2 on its first call, so every seed that enters the
 *  loop takes the break at once: a break that carried its own copy too would add 1 twice. */
const BREAK_SHARES_HEADER_COPIES = `fn midshare {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %0
  cond_br %5, ^bb2(), ^bb4(%4)
^bb2():
  %6: s32 = call %4 {target="f"}
  %7: s32 = const {value=2}
  %8: u32 = icmp_eq %6, %7
  cond_br %8, ^bb4(%4), ^bb3()
^bb3():
  %9: s32 = call {target="h"}
  br ^bb1(%4)
^bb4(%10: s32):
  %11: s32 = call %10 {target="g"}
  ret %10
}`;

test('a `break` that hands the exit what the header hands it shares the header copies', () => {
  const { src, agreement, shipped } = judged(BREAK_SHARES_HEADER_COPIES);
  expect(src).toBe(
    's32 midshare(s32 a0) {\n    s32 v0;\n    for (v0 = 0; v0 + 1 < a0; v0 = v0 + 1) {\n' +
      '        if (f(v0 + 1) == 2) break;\n        h();\n    }\n    v0 = v0 + 1;\n    g(v0);\n    return v0;\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** The same values from the LATCH. The latch path spells a latch break after the update, and the
 *  header's copy `v0 = v0 + 1` reads the name that update wrote: shared, the loop would add 1 twice
 *  on the break path. The latch path refuses, and the break is spelled ahead of the update. */
const LATCH_BREAK_SHARES_UPDATED_NAME = `fn latchshare {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = const {value=1}
  %4: s32 = add %2, %3
  %5: u32 = icmp_slt %4, %0
  cond_br %5, ^bb2(), ^bb3(%4)
^bb2():
  %6: s32 = call {target="f"}
  %7: s32 = const {value=2}
  %8: u32 = icmp_eq %6, %7
  cond_br %8, ^bb3(%4), ^bb1(%4)
^bb3(%9: s32):
  %10: s32 = call %9 {target="g"}
  ret %9
}`;

test('a latch `break` does not share header copies that read a name its update wrote', () => {
  const { src, agreement, shipped } = judged(LATCH_BREAK_SHARES_UPDATED_NAME);
  expect(src).toBe(
    's32 latchshare(s32 a0) {\n    s32 v0;\n    for (v0 = 0; v0 + 1 < a0; v0 = v0 + 1) {\n' +
      '        if (f() == 2) break;\n    }\n    v0 = v0 + 1;\n    g(v0);\n    return v0;\n}\n',
  );
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** A latch break handing the exit the header's own values, where one of them needs no copy at all:
 *  the exit parameter takes the header parameter's own name, so the header's exit edge renders
 *  nothing for it. The latch path writes that name in its update (`v0 = v0 + 1`, and `v1 = v0` for
 *  the second header parameter) before `if (…) break;`, so a bare break would reach the exit with
 *  the updated value where the IR hands it the old one. The break rule judges every exit argument
 *  the header hands on, rendered or not, refuses the share, and the break is spelled ahead of the
 *  update. agbcc -O2 lays out `for (;;) { acc += prev; prev = cur; if (cur >= n) break; cv(acc);
 *  cur++; if (cg(prev) > k) break; } cv(prev);` this way. */
const LATCH_BREAK_SHARES_IDENTITY_SLOT = `fn latchident {
^bb0(%0: s32, %1: s32, %2: s32):
  %20: s32 = const {value=7}
  %3: u32 = icmp_slt %0, %1
  cond_br %3, ^bb6(%20, %1), ^bb1(%2, %1)
^bb1(%4: s32, %5: s32):
  %8: u32 = icmp_slt %4, %1
  cond_br %8, ^bb5(), ^bb6(%4, %0)
^bb5():
  %9: s32 = call %4 {target="f0"}
  %13: s32 = const {value=1}
  %14: s32 = add %4, %13
  %15: u32 = icmp_eq %9, %14
  cond_br %15, ^bb1(%14, %4), ^bb6(%4, %0)
^bb6(%16: s32, %17: s32):
  %19: s32 = call %16 {target="f1"}
  %21: s32 = call %17 {target="f2"}
  ret %16
}`;

test('a latch `break` does not share a header exit value whose copy renders nothing', () => {
  const { agreement, shipped } = judged(LATCH_BREAK_SHARES_IDENTITY_SLOT);
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
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
 *  The exit `.L4` ends in a return and takes `x` from three edges, so the header hands it a copy.
 *  The mid-body `if (k < m) break;` hands it the header's own `x` and shares that copy; the latch
 *  break hands it `x + 1`, is refused, and copies the exit's tail into its arm instead. */
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
  expect(src).toContain('            if (a3 < a2) break;\n');
  expect(src.match(/break/g)).toHaveLength(1);
  expect(src.match(/G = 0;/g)).toHaveLength(2);
});

/** agbcc -O2 of `int f(int *p, int n, int m, int k) { int t = 0; while (*p != k) { if (p[1] == m) {
 *  if (p[2] == 0) break; t += 3; } p++; if (--n < 0) break; } G = t; if (n > 5) t = 1; return t; }`.
 *  The `if (p[1] == m)` has `.L4`, the loop's exit, as its CFG join, since its inner `break` leaves
 *  for it. Joined there, `G = t; …; return t;` would render inside the body; joined where its paths
 *  that stay in the body meet (`loopJoin`), the function is its own source. */
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

test('a latch break under an `if` whose CFG join is the loop exit joins inside the body', () => {
  expect(decompile('f', IF_JOINING_AT_THE_EXIT, ARMV4T_AGBCC, { prototypes: { f: { params: 4 } } }).source).toContain(
    '    while (*v0 != a3) {\n        if (v0[1] == a2) {\n            if (v0[2] == 0) break;\n' +
      '            v1 = v1 + 3;\n        }\n        v0 = v0 + 1;\n        v2 = v2 - 1;\n        if (v2 < 0) break;\n' +
      '    }\n    G = v1;\n    if (v2 > 5) v1 = 1;\n    return v1;\n',
  );
});

/** A bottom-tested loop with a mid-body edge to its exit, which is not a `ret` block. The exit reads
 *  the counter the header read, on the latch's edge as well as the break's. */
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

test('a bottom-tested loop with a mid-body `break` is `while (1)`', () => {
  const r = judged(DO_WHILE_BREAK);
  expect(r.src).toContain('while (1) {');
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

// ── A `break` WHOSE ARM RUNS CODE (structure.ts `codeBreakArm`) ─────────────────────────────────
//
// `for (i = 0; i < n; i++) { if (t(i) == 7) { hit(i); break; } } out();` — the arm's block never
// reaches the latch, so it sits outside the natural loop and is a second exit target. It is one exit
// with code on the way: entered by its edge alone, it leaves only for the loop's exit. The loop is a
// `while (1)` and the arm renders inside the `if`, ahead of its `break`.

/** The header computes before it tests (a call), so no `while` form is offered. */
const CODE_ARM = `fn codearm {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = call %2 {target="t"}
  %4: s32 = const {value=7}
  %5: u32 = icmp_eq %3, %4
  cond_br %5, ^bb2(), ^bb3()
^bb2():
  %6: s32 = call %2 {target="hit"}
  br ^bb4()
^bb3():
  %7: s32 = const {value=1}
  %8: s32 = add %2, %7
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%8), ^bb4()
^bb4():
  %10: s32 = call {target="out"}
  ret %10
}`;
/** The header is a pure test of a value the previous iteration loaded (ido7.1 and mwcc_242_81's
 *  `synthetic:break_code`), which the `while` classifier would take with the arm as its exit. */
const CODE_ARM_PURE_HEADER = `fn codearmpure {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = call %1 {target="t"}
  br ^bb1(%1, %2)
^bb1(%3: s32, %4: s32):
  %5: s32 = const {value=7}
  %6: u32 = icmp_eq %4, %5
  cond_br %6, ^bb2(), ^bb3()
^bb2():
  %7: s32 = call %3 {target="hit"}
  br ^bb4()
^bb3():
  %8: s32 = const {value=1}
  %9: s32 = add %3, %8
  %10: u32 = icmp_slt %9, %0
  cond_br %10, ^bb5(), ^bb4()
^bb5():
  %11: s32 = call %9 {target="t"}
  br ^bb1(%9, %11)
^bb4():
  %12: s32 = call {target="out"}
  ret %12
}`;

test('a `break` whose arm runs code renders the arm ahead of the `break`', () => {
  for (const ir of [CODE_ARM, CODE_ARM_PURE_HEADER]) {
    const { src, agreement, shipped } = judged(ir);
    expect(src).toContain('while (1) {');
    expect(src).toMatch(/\{\n {12}hit\(v\d\);\n {12}break;\n {8}\}/);
    expect(src.match(/hit\(/g)).toHaveLength(1);
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  }
});

test('an arm another path also enters is not a `break` arm, and the loop declines', () => {
  // ^bb0 enters the arm too (agbcc's peeled first test in `synthetic:break_code`, kleod
  // `TextBoxInit`'s out-of-loop merge): rendering it inside the loop would drop that path's copy.
  const shared = CODE_ARM.replace(
    '  %1: s32 = const {value=0}\n  br ^bb1(%1)',
    '  %1: s32 = const {value=0}\n  %20: u32 = icmp_slt %0, %1\n  cond_br %20, ^bb2(), ^bb1(%1)',
  ).replace('%6: s32 = call %2 {target="hit"}', '%6: s32 = call {target="hit"}');
  expect(() => emit(shared)).toThrow(/unrecovered back-edge/);
});

// ── AN `else break;` INSIDE A TESTED LOOP (structure.ts `loopJoin`) ─────────────────────────
//
// `for (i = 0; i < 3; i++) { if (a(v)) v = x(v); else if (b(v)) v = y(v); else break; z(v); } out();`
// — `synthetic:loop_elsebreak`'s shape. The first `if`'s paths meet at `z(v)` inside the body, but one
// of them can leave by the `break`, so its CFG post-dominator is the loop's exit. Joined there, its
// in-body arm would walk through the latch back into the header (`onStack`). Its join is the body's.
const ELSE_BREAK = `fn elsebreak {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1, %0)
^bb1(%2: s32, %3: s32):
  %4: s32 = const {value=3}
  %5: u32 = icmp_slt %2, %4
  cond_br %5, ^bb2(), ^bb7()
^bb2():
  %6: s32 = call %3 {target="a"}
  %7: s32 = const {value=0}
  %8: u32 = icmp_eq %6, %7
  cond_br %8, ^bb4(), ^bb3()
^bb3():
  %9: s32 = call %3 {target="x"}
  br ^bb6(%9)
^bb4():
  %10: s32 = call %3 {target="b"}
  %11: u32 = icmp_eq %10, %7
  cond_br %11, ^bb7(), ^bb5()
^bb5():
  %12: s32 = call %3 {target="y"}
  br ^bb6(%12)
^bb6(%13: s32):
  %14: s32 = call %13 {target="z"}
  %15: s32 = const {value=1}
  %16: s32 = add %2, %15
  br ^bb1(%16, %13)
^bb7():
  %17: s32 = call {target="out"}
  ret %17
}`;

test('an `else break;` in a tested loop joins its `if` inside the body', () => {
  const { src, agreement, shipped } = judged(ELSE_BREAK);
  expect(src).toContain('            if (b(v2) == v0) break;\n            v3 = y(v2);\n        }\n        z(v3);\n');
  expect(src.match(/z\(/g)).toHaveLength(1);
  expect(src.match(/out\(/g)).toHaveLength(1);
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

// The same arm in a loop that tests at its top: the header is a pure test into an exit that takes
// no copies, so the loop is a `while` and the arm a `break` inside it, as in a `for` whose body
// breaks after running code (`synthetic:break_code:agbcc`, re-rolled with its top test restored).
const CODE_ARM_TOP_TESTED = `fn codearmtop {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(), ^bb4()
^bb2():
  %4: s32 = call %2 {target="t"}
  %5: s32 = const {value=7}
  %6: u32 = icmp_eq %4, %5
  cond_br %6, ^bb3(), ^bb5()
^bb3():
  %7: s32 = call %2 {target="hit"}
  br ^bb4()
^bb5():
  %8: s32 = const {value=1}
  %9: s32 = add %2, %8
  br ^bb1(%9)
^bb4():
  %10: s32 = call {target="out"}
  ret %10
}`;

test('a top-tested loop whose `break` arm runs code is a `while`, the arm ahead of the `break`', () => {
  const { src, agreement, shipped } = judged(CODE_ARM_TOP_TESTED);
  expect(src).toContain('for (v0 = 0; v0 < a0; v0 = v0 + 1) {');
  expect(src).not.toContain('while (1)');
  expect(src).toMatch(/\{\n {12}hit\(v\d\);\n {12}break;\n {8}\}/);
  expect(src.match(/hit\(/g)).toHaveLength(1);
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

test('an arm into an exit that takes copies keeps the loop `while (1)`', () => {
  // the exit takes the counter: the header hands it `i`, the arm `-1`
  const copies = CODE_ARM_TOP_TESTED.replace('cond_br %3, ^bb2(), ^bb4()', 'cond_br %3, ^bb2(), ^bb4(%2)')
    .replace('  br ^bb4()\n^bb5():', '  %11: s32 = const {value=-1}\n  br ^bb4(%11)\n^bb5():')
    .replace('^bb4():\n  %10: s32 = call {target="out"}', '^bb4(%12: s32):\n  %10: s32 = call %12 {target="out"}');
  const { src, agreement } = judged(copies);
  expect(src).toContain('while (1) {');
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
});

test('an arm into an exit that only returns is a `break`, not a copy of the return', () => {
  // the exit holds no effect, so `earlyReturnArm` would also take the arm and copy `return 5` into it
  const pure = CODE_ARM_TOP_TESTED.replace('%10: s32 = call {target="out"}', '%10: s32 = const {value=5}');
  const { src, agreement, shipped } = judged(pure);
  expect(src).toContain('for (v0 = 0; v0 < a0; v0 = v0 + 1) {');
  expect(src).toMatch(/\{\n {12}hit\(v\d\);\n {12}break;\n {8}\}/);
  expect(src.match(/return 5;/g)).toHaveLength(1);
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});
