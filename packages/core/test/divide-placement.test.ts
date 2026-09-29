// AN OP THE ASM CALLED A RUNTIME HELPER FOR stays where the asm called it.
//
// `expr()` renders a pure op at its use, so a divide inlined past a store or a call moves behind it.
// On agbcc the divide is a call to `__divsi3`, over a constant divisor too, and a 64-bit shift a
// call to `__ashldi3`; agbcc leaves the call where the source computes it, so the inlined spelling
// never recompiles to the target. raise/softdiv.ts and raise/widehelpers.ts stamp the op each call
// becomes with the helper's name (runtime-helpers.ts `helperOp`), and the rule
// (structure/analysis.ts, the helper clause) places a stamped op as the call it was: named at its
// def when an effect or another named helper op lies between it and a render position, when it
// renders outside its block or rides a branch's edge copy, or when it sits in a `&&`/`||` guarded
// cone. A divide the ISA computes carries no stamp and renders at its use.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { frontendFor } from '../src/frontend/registry';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { applyIdiomPatterns, decompile, raiseRecovered } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// `t = k / n; *q = n; return t + 1;`, the divide a `bl __divsi3`
const DIV_STORE = `fn f {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = sdiv %2, %1 {helper="__divsi3"}
  store %0, %1 {off=0, width=4}
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  ret %5
}
`;

test('a helper divide ahead of a store is named where it ran', () => {
  const src = emit(DIV_STORE);
  expect(src).toMatch(/v0 = a2 \/ a1;\n\s+\*a0 = a1;\n\s+return v0 \+ 1;/);
});

test.each(['udiv', 'smod', 'umod'])('%s is placed the same way', (opcode) => {
  const src = emit(DIV_STORE.replace('sdiv', opcode).replace('__divsi3', `__${opcode}si3`));
  expect(src).toMatch(/v0 = (\(u32\))?a2 [/%] a1;\n\s+\*a0 = a1;/);
});

test('a call between the divide and its use names it too', () => {
  const src = emit(DIV_STORE.replace('store %0, %1 {off=0, width=4}', '%9: s32 = call %1 {target="g"}'));
  expect(src).toMatch(/v0 = a2 \/ a1;\n\s+g\(a1\);\n\s+return v0 \+ 1;/);
});

test('with no effect between, the divide stays inline', () => {
  const src = emit(DIV_STORE.replace('store %0, %1 {off=0, width=4}\n', ''));
  expect(src).toMatch(/return a2 \/ a1 \+ 1;/);
});

test('a store after the use is not between them', () => {
  const src = emit(`fn f {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = sdiv %2, %1
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  store %0, %5 {off=0, width=4}
  store %0, %1 {off=4, width=4}
  ret %1
}
`);
  expect(src).toMatch(/\*a0 = a2 \/ a1 \+ 1;/);
});

test('a divide the ISA computes renders at its use', () => {
  const src = emit(DIV_STORE.replace(' {helper="__divsi3"}', ''));
  expect(src).toMatch(/\*a0 = a1;\n\s+return a2 \/ a1 \+ 1;/);
});

// `t = k / n; if (a > 0 && t != 0)`, the connective already built. raise/shortcircuit.ts drops the
// stamp from a helper op it hoists out of the arm it guards, so one in the guarded cone that still
// carries it ran above the branch, where C's short circuit would skip it; an unstamped divide may
// have been hoisted there by the fold, so its def block says nothing and it stays in the connective.
const GUARDED_DIV = `fn f {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = sdiv %2, %1 {helper="__divsi3"}
  %4: s32 = const {value=0}
  %5: u32 = icmp_sgt %1, %4
  %6: u32 = icmp_ne %3, %4
  %7: u32 = logic_and %5, %6
  cond_br %7, ^bb1(), ^bb2()
^bb1():
  ret %1
^bb2():
  ret %4
}
`;

test('a helper divide in a connective’s guarded operand is named above the branch', () => {
  expect(emit(GUARDED_DIV)).toMatch(/v0 = a2 \/ a1;\n\s+if \(a1 <= 0 \|\| v0 == 0\)/);
});

test('an unstamped divide stays in the guarded operand', () => {
  expect(emit(GUARDED_DIV.replace(' {helper="__divsi3"}', ''))).toMatch(/if \(a1 <= 0 \|\| a2 \/ a1 == 0\)/);
});

// agbcc: `int t = k / n; if (a > 0 && t != 0) return g(1); return 0;` runs the `bl __divsi3` above
// both compares, and `if (a > 0 && k / n != 0)` runs it under the first. The two lift to two C.
const THUMB_DIV_ABOVE_AND = `gd:
	push	{r4, lr}
	add	r4, r0, #0
	add	r0, r1, #0
	add	r1, r2, #0
	bl	__divsi3
	cmp	r4, #0
	ble	.L3	@cond_branch
	cmp	r0, #0
	beq	.L3	@cond_branch
	mov	r0, #0x1
	bl	g
	b	.L4
.L3:
	mov	r0, #0x0
.L4:
	pop	{r4}
	pop	{r1}
	bx	r1
`;
const THUMB_DIV_UNDER_AND = `gd2:
	push	{lr}
	cmp	r0, #0
	ble	.L3	@cond_branch
	add	r0, r1, #0
	add	r1, r2, #0
	bl	__divsi3
	cmp	r0, #0
	beq	.L3	@cond_branch
	mov	r0, #0x1
	bl	g
	b	.L4
.L3:
	mov	r0, #0x0
.L4:
	pop	{r1}
	bx	r1
`;

test('agbcc’s __divsi3 above a `&&` and under it lift to where each ran', () => {
  const prototypes = { gd: { params: 3 }, gd2: { params: 3 }, g: { params: 1 } };
  const above = decompile('gd', THUMB_DIV_ABOVE_AND, ARMV4T_AGBCC, { prototypes }).source;
  const under = decompile('gd2', THUMB_DIV_UNDER_AND, ARMV4T_AGBCC, { prototypes }).source;
  expect(above).toMatch(/(v\d+) = a1 \/ a2;\n\s+if \(a0 > 0 && \1 != 0\)/);
  expect(under).toMatch(/if \(a0 > 0 && a1 \/ a2 != 0\)/);
});

// agbcc: `t = k / n; *q = n; return t + 1;` — the `bl __divsi3` ahead of the `str`, which
// raise/softdiv.ts folds to the `sdiv` the rule places.
const THUMB_DIV_STORE = `sl:
	push	{r4, r5, lr}
	add	r5, r0, #0
	add	r4, r1, #0
	add	r0, r2, #0
	add	r1, r4, #0
	bl	__divsi3
	str	r4, [r5]
	add	r0, r0, #0x1
	pop	{r4, r5}
	pop	{r1}
	bx	r1
`;

test('agbcc’s __divsi3 ahead of a store stays ahead of it through the pipeline', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('sl', THUMB_DIV_STORE, ARMV4T_AGBCC, { sl: { params: 3 } });
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, { params: 3 });
  const src = cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)));
  expect(src).toMatch(/v0 = a2 \/ a1;\n\s+\*a0 = a1;\n\s+return v0 \+ 1;/);
});

test('a divide by a constant is placed the same way', () => {
  const src = emit(DIV_STORE.replace('%3: s32 = sdiv %2, %1', '%8: s32 = const {value=15}\n  %3: s32 = sdiv %2, %8'));
  expect(src).toMatch(/v0 = a2 \/ 15;\n\s+\*a0 = a1;\n\s+return v0 \+ 1;/);
});

// agbcc: `int t = k / 5; *q = n; return t + 1;` — `mov r1, #5; bl __divsi3` ahead of the `str`.
const THUMB_CONST_DIV_STORE = `c5:
	push	{r4, r5, lr}
	add	r5, r0, #0
	add	r4, r1, #0
	add	r0, r2, #0
	mov	r1, #0x5
	bl	__divsi3
	str	r4, [r5]
	add	r0, r0, #0x1
	pop	{r4, r5}
	pop	{r1}
	bx	r1
`;

test('agbcc’s __divsi3 over a constant divisor stays ahead of the store too', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('c5', THUMB_CONST_DIV_STORE, ARMV4T_AGBCC, { c5: { params: 3 } });
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, { params: 3 });
  const src = cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)));
  expect(src).toMatch(/v0 = a2 \/ 5;\n\s+\*a0 = a1;\n\s+return v0 \+ 1;/);
});

// `int t = g(i); int u = s / i; if (t > i) h(u); return u + 1;` — agbcc runs `bl g`, then `bl
// __divsi3`, then the compare. The divide is named, since `h` lies between it and `return u + 1`;
// `g`'s value renders in the compare, behind that named divide, so it is named where it ran.
test('a call the asm ran ahead of a named divide stays ahead of it', () => {
  const src = emit(`fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = call %0 {target="g"}
  %3: s32 = sdiv %1, %0 {helper="__divsi3"}
  %4: u32 = icmp_sgt %2, %0
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %8: s32 = call %3 {target="h"}
  br ^bb2()
^bb2():
  %5: s32 = const {value=1}
  %6: s32 = add %3, %5
  ret %6
}
`);
  expect(src).toMatch(/v0 = g\(a0\);\n\s+v1 = a1 \/ a0;\n\s+if \(v0 > a0\) h\(v1\);/);
});

// `int t1 = a / c; int t2 = d / a; h(t1); gA = t2;` — two `bl __divsi3` in that order.
test('two divides keep the order the asm ran them in', () => {
  const src = emit(`fn f {
^bb0(%0: s32, %1: s32, %2: s32, %9: unk32):
  %3: s32 = sdiv %0, %1 {helper="__divsi3"}
  %4: s32 = sdiv %2, %0 {helper="__divsi3"}
  %8: s32 = call %3 {target="h"}
  store %9, %4 {off=0, width=4}
  %5: s32 = const {value=0}
  ret %5
}
`);
  expect(src).toMatch(/v0 = a0 \/ a1;\n\s+v1 = a2 \/ a0;\n\s+h\(v0\);\n\s+\*a3 = v1;/);
});

// agbcc, `do { t = g(i); u = s / i; if (s != 1) s += u; } while (t <= i && g(4) > 3); gA = f();
// return s + t + u;`. The named divide leaves the loop two exits, and the structurer copies the exit
// tail — `gA = f(); return …;` — into each, which is still one call to `f` on any path.
const THUMB_TWO_EXITS = `z1:
	push	{r4, r5, r6, r7, lr}
	add	r4, r0, #0
	mov	r5, #0x0
.L3:
	add	r0, r4, #0
	bl	g
	add	r6, r0, #0
	add	r0, r5, #0
	add	r1, r4, #0
	bl	__divsi3
	add	r7, r0, #0
	cmp	r5, #0x1
	beq	.L5
	add	r5, r5, r0
.L5:
	cmp	r6, r4
	bgt	.L4
	mov	r0, #0x4
	bl	g
	cmp	r0, #0x3
	bgt	.L3
.L4:
	bl	f
	ldr	r1, .L10
	str	r0, [r1]
	add	r0, r5, r6
	add	r0, r0, r7
	pop	{r4, r5, r6, r7}
	pop	{r1}
	bx	r1
.L10:
	.word	gA
`;

test('an exit tail copied into two returns is one call on each path', () => {
  const prototypes = { z1: { params: 1 }, g: { params: 1 }, f: { params: 0 } };
  const src = decompile('z1', THUMB_TWO_EXITS, ARMV4T_AGBCC, { prototypes }).source;
  expect(src.match(/= f\(\);/g)).toHaveLength(2);
  expect(src).toMatch(/v\d+ = g\(a0\);\n\s+v\d+ = v\d+ \/ a0;/);
});

// `t = k / n; if (c) return t + 1; return t - 3;` with the divide above the branch and its two uses
// in the arms.
const DIV_ARMS = `fn f {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = sdiv %0, %1 {helper="__divsi3"}
  %4: s32 = const {value=0}
  %5: u32 = icmp_ne %2, %4
  cond_br %5, ^bb1(), ^bb2()
^bb1():
  %6: s32 = const {value=1}
  %7: s32 = add %3, %6
  ret %7
^bb2():
  %8: s32 = const {value=3}
  %9: s32 = sub %3, %8
  ret %9
}
`;

test('where the divide is a call, it runs once above the branch the asm ran it above', () => {
  const src = emit(DIV_ARMS);
  expect(src).toMatch(/v0 = a0 \/ a1;\n\s+if /);
  expect(src.match(/ \/ /g)).toHaveLength(1);
});

test('where the divide is an instruction, it renders in the arms like any pure op', () => {
  expect(emit(DIV_ARMS.replace(' {helper="__divsi3"}', '')).match(/a0 \/ a1/g)).toHaveLength(2);
});

// agbcc's own spelling of the same function: one `bl __divsi3` ahead of the `cmp`.
const THUMB_DIV_ARMS = `a3:
	push	{r4, lr}
	add	r4, r2, #0
	bl	__divsi3
	cmp	r4, #0
	bne	.L3
	sub	r0, r0, #0x3
	b	.L5
.L3:
	add	r0, r0, #0x1
.L5:
	pop	{r4}
	pop	{r1}
	bx	r1
`;

test('agbcc’s __divsi3 above a branch is named there through the pipeline', () => {
  const src = decompile('a3', THUMB_DIV_ARMS, ARMV4T_AGBCC, { prototypes: { a3: { params: 3 } } }).source;
  expect(src).toMatch(/v0 = a0 \/ a1;\n\s+if /);
  expect(src.match(/ \/ /g)).toHaveLength(1);
});

// agbcc, `int t = 0, i; for (i = 0; i < a; i++) { t = k / (i + n); h(4); } return t;`. The divide
// is named ahead of `h`, in the loop's only block, and it is also the value the loop exits with:
// a loop that never ran exits with the guard's 0. The named value writes the exit's name in the
// body, so the guard's value seeds it ahead of the loop.
const THUMB_DIV_LOOP_EXIT = `s2:
	push	{r4, r5, r6, r7, lr}
	mov	r7, r8
	push	{r7}
	mov	r8, r0
	add	r7, r1, #0
	add	r5, r2, #0
	mov	r6, #0x0
	mov	r4, #0x0
	cmp	r6, r5
	bge	.L4
.L6:
	add	r1, r4, r7
	mov	r0, r8
	bl	__divsi3
	add	r6, r0, #0
	mov	r0, #0x4
	bl	h
	add	r4, r4, #0x1
	cmp	r4, r5
	blt	.L6
.L4:
	add	r0, r6, #0
	pop	{r3}
	mov	r8, r3
	pop	{r4, r5, r6, r7}
	pop	{r1}
	bx	r1
`;

test('a named divide a loop exits with is seeded for the loop that never runs', () => {
  const prototypes = { s2: { params: 3 }, h: { params: 1, returnsVoid: true } };
  const src = decompile('s2', THUMB_DIV_LOOP_EXIT, ARMV4T_AGBCC, { prototypes }).source;
  expect(src).toMatch(/(v\d+) = 0;[^]*do \{\n\s+\1 = a0 \/ \(v\d+ \+ a1\);\n\s+h\(4\);[^]*return \1;/);
});

// agbcc: `s64 t = a << n; *q = n; return t + 1;` — `bl __ashldi3` ahead of the `str`, which
// raise/widehelpers.ts folds to the `shl` the rule places. A shift is no trap; what places it is the
// call it was.
const THUMB_SHL64_STORE = `shl64:
	push	{r4, r5, lr}
	add	r5, r2, #0
	add	r4, r3, #0
	add	r2, r4, #0
	bl	__ashldi3
	add	r3, r1, #0
	add	r2, r0, #0
	str	r4, [r5]
	mov	r0, #0x1
	mov	r1, #0
	add	r0, r0, r2
	adc	r1, r1, r3
	pop	{r4, r5}
	pop	{r2}
	bx	r2
`;

test('agbcc’s __ashldi3 ahead of a store stays ahead of it', () => {
  const prototypes = { shl64: { params: 4, returns: 's64' } };
  const src = decompile('shl64', THUMB_SHL64_STORE, ARMV4T_AGBCC, { prototypes }).source;
  expect(src).toMatch(/(v\d+) = a0 << a2;\n\s+\*a1 = a2;\n\s+return [^;]*\1;/);
});

// agbcc: `int v = gB; int t = v / n; if (t > 2) { q[3] = t; return 1; } q[1] = v; return 0;` — one
// `ldr` of gB, kept in r4 across the `bl __divsi3` for the arm that stores it.
const THUMB_READ_ACROSS_DIV = `l2:
	push	{r4, r5, lr}
	add	r5, r0, #0
	ldr	r0, .L5
	ldr	r4, [r0]
	add	r0, r4, #0
	bl	__divsi3
	cmp	r0, #0x2
	bgt	.L3	@cond_branch
	str	r4, [r5, #0x4]
	mov	r0, #0x0
	b	.L4
.L6:
	.align	2, 0
.L5:
	.word	gB
.L3:
	str	r0, [r5, #0xc]
	mov	r0, #0x1
.L4:
	pop	{r4, r5}
	pop	{r1}
	bx	r1
`;

test('a read the asm kept across a named helper divide is read once', () => {
  const src = decompile('l2', THUMB_READ_ACROSS_DIV, ARMV4T_AGBCC, { prototypes: { l2: { params: 2 } } }).source;
  expect(src.match(/gB/g)).toHaveLength(1);
  expect(src).toMatch(/(v\d+) = gB;\n\s+(v\d+) = \1 \/ a1;/);
});
