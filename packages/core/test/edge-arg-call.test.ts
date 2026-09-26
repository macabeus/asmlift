// A CALL WHOSE VALUE RIDES A `cond_br` EDGE runs on one path in the C and on every path in the asm.
//
// `structure/analysis.ts`'s `anchored` calls a terminator ONE render position, which is true of the
// branch itself and false of its edge copies: those are emitted inside the arms. So a call whose
// only consumer is a successor argument was inlined into one arm and skipped on the other — an
// effect the asm performs unconditionally, performed sometimes. `assertEffectsPreserved` cannot see
// it: the call IS emitted (its `total` is 1) and no path emits it twice, and the two counts that
// contract keeps are exactly those. The rule that stops it is a placement one — materialize the
// call at the position the asm ran it — and this is its guard.
//
// Reached from ordinary source, not only from hand-built IR — the compiled pair is in analysis.ts,
// and the shape is 2 of klonoa's 412 functions and 0 of 2288 sa3 ones. Toolchain-free.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

const EDGE_CALL = `fn f {
^bb0(%0: unk32):
  %1: unk32 = call %0 {target="f2"}
  %2: unk32 = const {value=0}
  %3: u32 = icmp_sgt %0, %2
  cond_br %3, ^bb1(%1), ^bb1(%2)
^bb1(%4: unk32):
  ret %4
}
`;

test('a call whose only consumer is a branch argument is emitted on every path', () => {
  const src = emit(EDGE_CALL);
  // the call is a statement of its own, ahead of the branch — not an arm's edge copy
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*if /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
  // and nothing has made the OTHER arm's constant conditional in its place
  expect(src).toContain('v0 = 0;');
});

test('a `switch_br` arm hides the call the same way, and is covered by the same rule', () => {
  // The scope is every multi-successor terminator, not `cond_br` alone: a jump table's edge copies
  // are arm bodies too. Narrowed to `cond_br` this fixture calls `f2` under `case 0:` only.
  const ir = `fn f {
^bb0(%0: unk32):
  %1: unk32 = call %0 {target="f2"}
  %2: unk32 = const {value=0}
  switch_br %0, ^bb1(%1), ^bb2(), ^bb3() {cases=[0;1]}
^bb1(%3: unk32):
  ret %3
^bb2():
  ret %2
^bb3():
  ret %0
}
`;
  const src = emit(ir);
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*switch /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
});

test('the same call with a second consumer still materializes — the older rule', () => {
  // A second operand slot duplicates the call, which `sites.length > 1` already refused. The new
  // rule is about the SOLE-use case, so this one must keep passing for the reason it always did.
  const ir = EDGE_CALL.replace('  ret %4', '  %5: unk32 = add %4, %1\n  ret %5');
  expect(emit(ir).match(/f2\(/g)).toHaveLength(1);
});

// A CALL UNDER A PURE OP OF A POST-LOOP COPY. The do-while's exit edge carries `f1(a0) - %6`, a
// call the body makes every iteration under a `sub` it feeds nothing else. Inlined, the copy
// renders after the loop and the call with it — `a0 = f1(a0) - v2;`, once instead of once per
// iteration — so the analysis names a call that rides an edge through the ops it is inlined into
// (`ridesEdge`, structure/analysis.ts), exactly as it names one that rides it bare.
const CALL_UNDER_EXIT_COPY = `fn movedcall {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(), ^bb3(%0)
^bb1():
  br ^bb2(%1, %2, %2)
^bb2(%4: s32, %5: s32, %6: s32):
  %7: s32 = call %0 {target="f1"}
  %8: s32 = sub %7, %6
  %9: s32 = const {value=1}
  %10: s32 = sub %4, %9
  %11: u32 = icmp_slt %2, %10
  cond_br %11, ^bb2(%10, %6, %5), ^bb3(%8)
^bb3(%12: s32):
  ret %12
}
`;

test('a call under a pure op of a post-loop copy is named in the loop', () => {
  const out = emit(CALL_UNDER_EXIT_COPY);
  expect(out).toMatch(/do \{\s*\n\s*v1 = f1\(a0\);/);
  expect(out.match(/f1\(/g)).toHaveLength(1);
  expect(out).toContain('    a0 = v1 - v3;\n');
});

// A CALL RIDING THE BACK EDGE under a pure op renders in the update copy at the foot of the body,
// behind everything the latch ran after it — here a second call, in the exit copy, which renders as
// a statement of its own ahead of the update, so inlined the two ran `f1` then `f0` where the asm
// ran `f0` then `f1`. `ridesEdge` does not name `f0`: one back-edge arg carries it, so it renders
// once. The barrier scan does, because `f1` renders in another part of the terminator and so is a
// call it would cross.
const BACK_EDGE_CALL = `fn backcall {
^bb0(%0: s32, %1: s32, %2: s32):
  %4: s32 = const {value=0}
  %5: u32 = icmp_slt %4, %1
  cond_br %5, ^bb1(), ^bb3(%2)
^bb1():
  br ^bb2(%1, %0)
^bb2(%6: s32, %7: s32):
  %10: s32 = call %7 {target="f0"}
  %11: s32 = const {value=1}
  %12: s32 = add %10, %11
  %13: s32 = call %6 {target="f1"}
  %14: s32 = add %13, %7
  %15: s32 = sub %6, %11
  %16: s32 = const {value=0}
  %17: u32 = icmp_slt %16, %15
  cond_br %17, ^bb2(%15, %12), ^bb3(%14)
^bb3(%18: s32):
  ret %18
}
`;

test('a call in a back-edge copy is named when a call in a sibling edge copy follows it', () => {
  const body = emit(BACK_EDGE_CALL).split('do {')[1].split('} while')[0];
  expect(body.indexOf('f0(')).toBeGreaterThanOrEqual(0);
  expect(body.indexOf('f0(')).toBeLessThan(body.indexOf('f1('));
});

test('a call under a back-edge copy with nothing order-sensitive behind it stays inline', () => {
  // The one-fact edit: the exit value no longer calls `f1`, so nothing the latch runs after `f0`
  // is a barrier, and the update keeps its inline spelling (`s = s + g(i)`).
  const alone = BACK_EDGE_CALL.replace('  %13: s32 = call %6 {target="f1"}\n', '  %13: s32 = add %6, %11\n');
  expect(alone).not.toBe(BACK_EDGE_CALL);
  expect(emit(alone)).toMatch(/v\d+ = f0\(v\d+\) \+ /);
});

// A BACK EDGE FROM A LATCH THAT IS NOT THE LOOP'S ONLY EXIT. agbcc, `int u = 0; while (n-- > 0) { q =
// q - 1; if (u == k) return *q; t = cg(t) + H[n & 3] & cb(q + 1); } return m + k;`: the header leaves the loop
// too, so the structurer keeps it as the `while` test and renders the latch's `bgt` as an `if` in the
// body, with the back-edge copy in its `else` arm. `bl cb` runs ahead of that `bgt` on every
// iteration; inlined into the copy it ran only on the iterations that went round again.
const MID_EXIT_LOOP = `wl:
	push	{r4, r5, r6, r7, lr}
	mov	r7, sl
	mov	r6, r9
	mov	r5, r8
	push	{r5, r6, r7}
	add	r5, r1, #0
	add	r7, r3, #0
	mov	sl, r2
	mov	r9, r7
	mov	r4, #0x0
	add	r6, r0, #0
	add	r0, r5, #0
	sub	r5, r5, #0x1
	cmp	r0, #0
	ble	.L4	@cond_branch
	ldr	r0, .L10
	mov	r8, r0
.L5:
	sub	r6, r6, #0x4
	mov	r0, #0x0
	cmp	r0, r7
	bne	.L6	@cond_branch
	ldr	r0, [r6]
	b	.L9
.L11:
	.align	2, 0
.L10:
	.word	H
.L6:
	add	r0, r4, #0
	bl	cg
	add	r4, r0, #0
	add	r0, r6, #0x4
	bl	cb
	mov	r1, #0x3
	and	r1, r1, r5
	lsl	r1, r1, #0x2
	add	r1, r1, r8
	ldr	r1, [r1]
	add	r4, r4, r1
	and	r4, r4, r0
	add	r0, r5, #0
	sub	r5, r5, #0x1
	cmp	r0, #0
	bgt	.L5	@cond_branch
.L4:
	mov	r0, sl
	add	r0, r0, r9
.L9:
	pop	{r3, r4, r5}
	mov	r8, r3
	mov	r9, r4
	mov	sl, r5
	pop	{r4, r5, r6, r7}
	pop	{r1}
	bx	r1
`;

test('a call riding the back edge of a loop that also exits elsewhere runs on every iteration', () => {
  const src = decompile('wl', MID_EXIT_LOOP, ARMV4T_AGBCC, {
    prototypes: { cg: { params: 1 }, cb: { params: 1 }, wl: { params: 4 } },
  }).source;
  const body = src.split('while (')[1];
  expect(body.indexOf('cb(')).toBeGreaterThan(0);
  expect(body.indexOf('cb(')).toBeLessThan(body.indexOf('if ('));
  expect(src.match(/cb\(/g)).toHaveLength(1);
});

// A BACK EDGE IS A DOMINANCE FACT, NOT A LAYOUT ONE. `^bb1`, the return tail, is laid out above the
// branch that jumps to it, and nothing about that edge is a loop: `^bb1` does not dominate `^bb2`.
// Read by layout, the edge took the back-edge reading (the value renders once, at the foot of a
// body) and `f1` was inlined into the `if` arm, called only when `a1 > 0` where the IR calls it on
// every path. The control is the same function with `^bb1` laid out last.
const BACKWARD_TAIL = `fn backtail {
^bb0(%0: s32, %1: s32):
  br ^bb2()
^bb1(%6: s32):
  ret %6
^bb2():
  %3: s32 = call %0 {target="f1"}
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %7: s32 = const {value=0}
  %8: u32 = icmp_sgt %1, %7
  cond_br %8, ^bb1(%5), ^bb3()
^bb3():
  br ^bb1(%1)
}
`;

test('a forward edge laid out backward still names the call it carries', () => {
  const tailLast = BACKWARD_TAIL.replace('^bb1(%6: s32):\n  ret %6\n', '');
  const control = tailLast.replace(/\}\n$/, '^bb1(%6: s32):\n  ret %6\n}\n');
  expect(control).not.toBe(BACKWARD_TAIL);
  for (const ir of [BACKWARD_TAIL, control]) {
    expect(emit(ir)).toMatch(/v0 = f1\(a0\);\n\s+if \(a1 > 0\) a1 = v0 \+ 1;/);
  }
});

// ONE `br`, TWO EDGE COPIES: a call's value and a read's. agbcc, `if (n > 0) { int t = cb(p); a = *p;
// b = t + m; } return a - b;` runs `bl cb; ldr r1, [r5]; add` and falls into the merge. The copies
// are two statements, so a read in one and the call in the other are not one expression's operands:
// inlined, `a1 = *a0; a2 = cb(a0) + a2;` read before the call. The call is named where it ran. The
// control moves the read into the same copy as the call, where one expression gives the order back.
const SIBLING_COPIES = `fn brc {
^bb0(%0: s32*, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_sle %1, %3
  cond_br %4, ^bb2(%2, %1), ^bb1()
^bb1():
  %5: s32 = call %0 {target="cb"}
  %6: s32 = load %0 {off=0, signed=true, width=4}
  %7: s32 = add %5, %2
  br ^bb2(%7, %6)
^bb2(%8: s32, %9: s32):
  %10: s32 = sub %9, %8
  ret %10
}
`;

test('a call and a read in sibling edge copies keep the order the asm ran them in', () => {
  expect(emit(SIBLING_COPIES)).toMatch(/v0 = cb\(a0\);\n\s+a1 = \*a0;\n\s+a2 = v0 \+ a2;/);
  const oneCopy = SIBLING_COPIES.replace('%7: s32 = add %5, %2', '%7: s32 = add %5, %6').replace(
    'br ^bb2(%7, %6)',
    'br ^bb2(%7, %2)',
  );
  expect(oneCopy).not.toBe(SIBLING_COPIES);
  expect(emit(oneCopy)).toContain('a2 = cb(a0) + *a0;');
});
