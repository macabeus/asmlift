// A guard-fused `while` over a pinned read. agbcc rotates a test-at-top loop: the exit test is
// duplicated into a guard ahead of the loop and a latch at its foot, so the asm reads the register
// at both sites. The structurer un-rotates that back into one `while`, whose condition renders the
// read once. Recompiled, the C makes both reads again. The fusion records the reads the deleted
// guard made by handing the loop the guard's test (`fusedGuard`, l3/ast.ts), and the contract
// credits its reads to its dropped rule (contracts.ts `fusedGuardCredit`), so it does not count the
// condition's one render as one read.
//
// Both functions below are agbcc output, compiled with
// `agbcc -mthumb-interwork -O2 -fhex-asm` from:
//
//   typedef volatile u32 vu32;
//   void p11(u32 n) {                       void p10(u16 v, u32 n) {
//       u16 t = gBgI[3];                        u16 t = v;
//       vu32 *d = (vu32 *)0x40000d4;            vu32 *d = (vu32 *)0x040000D4;
//       d[0] = (u32)&t;                         d[0] = (u32)&t;
//       d[1] = (u32)gPtrs[2];                   d[1] = (u32)gDst;
//       d[2] = 0x80000000 | (n >> 1);           d[2] = 0x80000000 | (n >> 1);
//       d[2];                                   d[2];
//       while (d[2] & 0x80000000);              while (d[2] & 0x80000000) ;
//       d[0] = (u32)gPtrs[3];                   gDst[0] = 0;
//       d[1] = (u32)gBuf;                   }
//       d[2] = 0x80000400;
//       g();
//   }
//
// The frame address handed to the DMA is what pins the accesses (frame-objects.ts). In p11 the
// guard and the latch test the same register, so the guard fuses. In p10 the latch's mask is a
// preheader copy (`add r1, r4, #0`), so the guard is kept as an `if` around a `do-while` and
// nothing is recorded.
//
// p12 is p11's wait written as a counted spin, compiled the same way:
//
//   s32 p12(u32 n) {
//       s32 i;
//       u16 t = gDvI[3];
//       vu32 *d = (vu32 *)0x40000d4;
//       d[0] = (u32)&t;
//       d[1] = (u32)gDvP[2];
//       d[2] = 0x80000000 | (n >> 1);
//       d[2];
//       i = 0;
//       while (d[2] > i) i++;
//       d[0] = (u32)gDvP[3];
//       d[1] = (u32)gDvBuf;
//       d[2] = 0x80000400;
//       g();
//       return i;
//   }
//
// The fused loop's test reads the counter, so the structurer re-spells it as a `for`
// (ast-rewrites.ts `recognizeForLoops`), which keeps the credit.
//
// p13 is p11 with a store to the DMA count after the call, so the DMA base lives in a callee-saved
// register and the structurer names it (`v0`). The guard's read then renders at no constant
// address, which is how the fusion hands it to the contract, so it is credited there:
//
//   void p13(u32 n) {
//       u16 t = gDvI[3];
//       vu32 *d = (vu32 *)0x40000d4;
//       d[0] = (u32)&t; d[1] = (u32)gDvP[2]; d[2] = 0x80000000 | (n >> 1); d[2];
//       while (d[2] & 0x80000000);
//       d[0] = (u32)gDvP[3]; d[1] = (u32)gDvBuf; d[2] = 0x80000400; g(); d[2] = 0;
//   }
//
// p14 reaches one wait from two arms, so the asm has one shared tail, which the structurer copies
// into both. The two copies of the loop name one guard (`site`), which the contract credits once:
//
//   void p14(u32 n, s32 k) {
//       u16 t = gDvI[3];
//       vu32 *d = (vu32 *)0x40000d4;
//       d[0] = (u32)&t; d[1] = (u32)gDvP[2];
//       if (k) { gDst[0] = 1; if (n & 4) goto w; gDst[2] = 7; return; }
//       gDst[5] = 5;
//   w:  d[2] = 0x80000000 | (n >> 1); d[2];
//       while (d[2] & 0x80000000);
//       d[0] = (u32)gS; g();
//   }
//
// p15, p17 and p18 are the DMA template (a frame address armed through 0x40000d4, then `d[2];`) followed
// by a wait whose body touches memory, compiled the same way, with `vu16` the `volatile u16`:
//
//   p15: while (d[2] & 0x80000000) { d[1] = 1; ((vu16 *)d)[1] = 2; }
//   p17: while (d[2] & 0x80000000) { ((vu16 *)d)[5] = n; }
//   p18: while (d[2] & 0x80000000) { ((vu8 *)d)[11] = n; }
//
// p15's guard fuses, and the asm stores the u16 every time round. The device pin leaves that store
// plain (device-pins.ts, the per-object policy), and plain, agbcc keeps the cell in a register for
// the loop and stores it once after (loop.c `load_mems`): the u16 store aliases nothing the loop
// reads, the s32 count. So the fused loop is credited nothing, and the contract refuses the plain
// store besides. p17 is a jump-to-test loop, which fuses nothing: the same plain store is refused
// there. p18's byte store may alias the count, which keeps it in the loop, so p18 lifts.
import { describe, expect, test } from 'vitest';

import type { Stmt } from '../src/l3/ast';
import { stmtChildren } from '../src/l3/ast';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const P11 = `
p11:
	push	{r4, lr}
	add	sp, sp, #-0x4
	ldr	r1, .L7
	ldrh	r2, [r1, #0x6]
	mov	r1, sp
	strh	r2, [r1]
	ldr	r3, .L7+0x4
	str	r1, [r3]
	ldr	r2, .L7+0x8
	ldr	r1, [r2, #0x8]
	str	r1, [r3, #0x4]
	lsr	r0, r0, #0x1
	mov	r1, #0x80
	lsl	r1, r1, #0x18
	orr	r0, r0, r1
	str	r0, [r3, #0x8]
	ldr	r0, [r3, #0x8]
	ldr	r0, [r3, #0x8]
	and	r0, r0, r1
	ldr	r4, .L7+0xc
	cmp	r0, #0
	beq	.L4	@cond_branch
.L3:
	ldr	r0, [r3, #0x8]
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L3	@cond_branch
.L4:
	ldr	r0, [r2, #0xc]
	str	r0, [r3]
	str	r4, [r3, #0x4]
	ldr	r0, .L7+0x10
	str	r0, [r3, #0x8]
	bl	g
	add	sp, sp, #0x4
	pop	{r4}
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	gBgI
	.word	0x40000d4
	.word	gPtrs
	.word	gBuf
	.word	-0x7ffffc00
`;

const P10 = `
p10:
	push	{r4, lr}
	add	sp, sp, #-0x4
	mov	r2, sp
	strh	r0, [r2]
	ldr	r3, .L7
	str	r2, [r3]
	ldr	r2, .L7+0x4
	str	r2, [r3, #0x4]
	lsr	r1, r1, #0x1
	mov	r4, #0x80
	lsl	r4, r4, #0x18
	orr	r1, r1, r4
	str	r1, [r3, #0x8]
	ldr	r0, [r3, #0x8]
	ldr	r0, [r3, #0x8]
	and	r0, r0, r4
	cmp	r0, #0
	beq	.L4	@cond_branch
	add	r1, r4, #0
.L3:
	ldr	r0, [r3, #0x8]
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L3	@cond_branch
.L4:
	mov	r0, #0x0
	str	r0, [r2]
	add	sp, sp, #0x4
	pop	{r4}
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	0x40000d4
	.word	gDst
`;

const P12 = `
p12:
	push	{r4, lr}
	add	sp, sp, #-0x4
	ldr	r1, .L7
	ldrh	r2, [r1, #0x6]
	mov	r1, sp
	strh	r2, [r1]
	ldr	r3, .L7+0x4
	str	r1, [r3]
	ldr	r2, .L7+0x8
	ldr	r1, [r2, #0x8]
	str	r1, [r3, #0x4]
	lsr	r0, r0, #0x1
	mov	r1, #0x80
	lsl	r1, r1, #0x18
	orr	r0, r0, r1
	str	r0, [r3, #0x8]
	ldr	r0, [r3, #0x8]
	mov	r4, #0x0
	ldr	r0, [r3, #0x8]
	ldr	r1, .L7+0xc
	cmp	r0, #0
	bls	.L4	@cond_branch
.L5:
	add	r4, r4, #0x1
	ldr	r0, [r3, #0x8]
	cmp	r0, r4
	bhi	.L5	@cond_branch
.L4:
	ldr	r0, [r2, #0xc]
	str	r0, [r3]
	str	r1, [r3, #0x4]
	ldr	r0, .L7+0x10
	str	r0, [r3, #0x8]
	bl	g
	add	r0, r4, #0
	add	sp, sp, #0x4
	pop	{r4}
	pop	{r1}
	bx	r1
.L8:
	.align	2, 0
.L7:
	.word	gDvI
	.word	0x40000d4
	.word	gDvP
	.word	gDvBuf
	.word	-0x7ffffc00
`;

const P13 = `
p13:
	push	{r4, lr}
	add	sp, sp, #-0x4
	ldr	r1, .L7
	ldrh	r2, [r1, #0x6]
	mov	r1, sp
	strh	r2, [r1]
	ldr	r4, .L7+0x4
	str	r1, [r4]
	ldr	r2, .L7+0x8
	ldr	r1, [r2, #0x8]
	str	r1, [r4, #0x4]
	lsr	r0, r0, #0x1
	mov	r1, #0x80
	lsl	r1, r1, #0x18
	orr	r0, r0, r1
	str	r0, [r4, #0x8]
	ldr	r0, [r4, #0x8]
	ldr	r0, [r4, #0x8]
	and	r0, r0, r1
	ldr	r3, .L7+0xc
	cmp	r0, #0
	beq	.L4	@cond_branch
.L3:
	ldr	r0, [r4, #0x8]
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L3	@cond_branch
.L4:
	ldr	r0, [r2, #0xc]
	str	r0, [r4]
	str	r3, [r4, #0x4]
	ldr	r0, .L7+0x10
	str	r0, [r4, #0x8]
	bl	g
	mov	r0, #0x0
	str	r0, [r4, #0x8]
	add	sp, sp, #0x4
	pop	{r4}
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	gDvI
	.word	0x40000d4
	.word	gDvP
	.word	gDvBuf
	.word	-0x7ffffc00
`;

const P14 = `
p14:
	push	{lr}
	add	sp, sp, #-0x4
	add	r3, r0, #0
	ldr	r0, .L10
	ldrh	r2, [r0, #0x6]
	mov	r0, sp
	strh	r2, [r0]
	ldr	r2, .L10+0x4
	str	r0, [r2]
	ldr	r0, .L10+0x8
	ldr	r0, [r0, #0x8]
	str	r0, [r2, #0x4]
	cmp	r1, #0
	beq	.L3	@cond_branch
	ldr	r1, .L10+0xc
	mov	r0, #0x1
	str	r0, [r1]
	mov	r0, #0x4
	and	r0, r0, r3
	cmp	r0, #0
	bne	.L5	@cond_branch
	mov	r0, #0x7
	str	r0, [r1, #0x8]
	b	.L2
.L11:
	.align	2, 0
.L10:
	.word	gDvI
	.word	0x40000d4
	.word	gDvP
	.word	gDst
.L3:
	ldr	r1, .L12
	mov	r0, #0x5
	str	r0, [r1, #0x14]
.L5:
	lsr	r0, r3, #0x1
	mov	r1, #0x80
	lsl	r1, r1, #0x18
	orr	r0, r0, r1
	str	r0, [r2, #0x8]
	ldr	r0, [r2, #0x8]
	ldr	r0, [r2, #0x8]
	and	r0, r0, r1
	ldr	r3, .L12+0x4
	cmp	r0, #0
	beq	.L7	@cond_branch
.L6:
	ldr	r0, [r2, #0x8]
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L6	@cond_branch
.L7:
	str	r3, [r2]
	bl	g
.L2:
	add	sp, sp, #0x4
	pop	{r0}
	bx	r0
.L13:
	.align	2, 0
.L12:
	.word	gDst
	.word	gS
`;

const P15 = `
p15:
	push	{r4, lr}
	add	sp, sp, #-0x4
	ldr	r1, .L7
	ldrh	r2, [r1, #0x6]
	mov	r1, sp
	strh	r2, [r1]
	ldr	r2, .L7+0x4
	str	r1, [r2]
	ldr	r1, .L7+0x8
	str	r1, [r2, #0x4]
	lsr	r0, r0, #0x1
	mov	r1, #0x80
	lsl	r1, r1, #0x18
	orr	r0, r0, r1
	str	r0, [r2, #0x8]
	ldr	r0, [r2, #0x8]
	ldr	r0, [r2, #0x8]
	and	r0, r0, r1
	cmp	r0, #0
	beq	.L4	@cond_branch
	mov	r4, #0x1
	mov	r3, #0x2
.L5:
	str	r4, [r2, #0x4]
	strh	r3, [r2, #0x2]
	ldr	r0, [r2, #0x8]
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L5	@cond_branch
.L4:
	bl	g
	add	sp, sp, #0x4
	pop	{r4}
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	gBgI
	.word	0x40000d4
	.word	gDst
`;

const P17 = `
p17:
	push	{lr}
	add	sp, sp, #-0x4
	add	r3, r0, #0
	ldr	r0, .L8
	ldrh	r1, [r0, #0x6]
	mov	r0, sp
	strh	r1, [r0]
	ldr	r1, .L8+0x4
	str	r0, [r1]
	ldr	r0, .L8+0x8
	str	r0, [r1, #0x4]
	lsr	r0, r3, #0x1
	mov	r2, #0x80
	lsl	r2, r2, #0x18
	orr	r0, r0, r2
	str	r0, [r1, #0x8]
	ldr	r0, [r1, #0x8]
	b	.L7
.L9:
	.align	2, 0
.L8:
	.word	gBgI
	.word	0x40000d4
	.word	gDst
.L5:
	strh	r3, [r1, #0xa]
.L7:
	ldr	r0, [r1, #0x8]
	and	r0, r0, r2
	cmp	r0, #0
	bne	.L5	@cond_branch
	bl	g
	add	sp, sp, #0x4
	pop	{r0}
	bx	r0
`;

const P18 = `
p18:
	push	{lr}
	add	sp, sp, #-0x4
	add	r3, r0, #0
	ldr	r0, .L8
	ldrh	r1, [r0, #0x6]
	mov	r0, sp
	strh	r1, [r0]
	ldr	r1, .L8+0x4
	str	r0, [r1]
	ldr	r0, .L8+0x8
	str	r0, [r1, #0x4]
	lsr	r0, r3, #0x1
	mov	r2, #0x80
	lsl	r2, r2, #0x18
	orr	r0, r0, r2
	str	r0, [r1, #0x8]
	ldr	r0, [r1, #0x8]
	b	.L7
.L9:
	.align	2, 0
.L8:
	.word	gBgI
	.word	0x40000d4
	.word	gDst
.L5:
	strb	r3, [r1, #0xb]
.L7:
	ldr	r0, [r1, #0x8]
	and	r0, r0, r2
	cmp	r0, #0
	bne	.L5	@cond_branch
	bl	g
	add	sp, sp, #0x4
	pop	{r0}
	bx	r0
`;

const prototypes = { g: { params: [], returnsVoid: true } };

const allStmts = (body: Stmt[]): Stmt[] => body.flatMap((s) => [s, ...allStmts(stmtChildren(s))]);
const recorded = (body: Stmt[]) =>
  allStmts(body).flatMap((s) =>
    (s.k === 'while' || s.k === 'for') && s.fusedGuard !== undefined ? [{ k: s.k, site: s.fusedGuard.site }] : [],
  );

describe('a guard-fused wait on a pinned register', () => {
  test('the fused `while` records its deleted guard, and the function lifts', () => {
    const r = decompile('p11', P11, ARMV4T_AGBCC, { prototypes });
    expect(r.source).toContain('    ((volatile s32 *)67109076)[2];\n');
    expect(r.source).toContain('    while ((((volatile s32 *)67109076)[2] & 128 << 24) != 0) {\n    }\n');
    expect(recorded(r.sfn.body).map((l) => l.k)).toEqual(['while']);
  });

  test('a fused wait re-spelled as a `for` keeps the credit, and the function lifts', () => {
    const r = decompile('p12', P12, ARMV4T_AGBCC, { prototypes });
    expect(r.source).toContain('    ((volatile s32 *)67109076)[2];\n');
    expect(r.source).toContain('    for (v0 = 0; ((volatile s32 *)67109076)[2] > v0; v0 = v0 + 1) {\n    }\n');
    expect(recorded(r.sfn.body).map((l) => l.k)).toEqual(['for']);
  });

  test('the field is never printed', () => {
    expect(decompile('p11', P11, ARMV4T_AGBCC, { prototypes }).source).not.toMatch(/fusedGuard|site|device:r:/);
  });

  test('a fused wait through a named DMA base is credited where it renders, and the function lifts', () => {
    const r = decompile('p13', P13, ARMV4T_AGBCC, { prototypes });
    expect(r.source).toContain('    ((volatile s32 *)v0)[2];\n');
    expect(r.source).toContain('    while ((((volatile s32 *)v0)[2] & 128 << 24) != 0) {\n    }\n');
    expect(recorded(r.sfn.body).map((l) => l.k)).toEqual(['while']);
  });

  test('a fused wait in a copied tail names one guard from both copies, and the function lifts', () => {
    const r = decompile('p14', P14, ARMV4T_AGBCC, { prototypes });
    const loops = recorded(r.sfn.body);
    expect(loops.map((l) => l.k)).toEqual(['while', 'while']);
    expect(loops[0].site).toBe(loops[1].site);
  });

  test('a fused wait whose body stores plain where agbcc would sink it declines', () => {
    expect(() => decompile('p15', P15, ARMV4T_AGBCC, { prototypes })).toThrow(
      "a loop that polls a device register writes memory plain at an address the loop never changes in 'p15'",
    );
  });

  test('a jump-to-test wait whose body stores plain where agbcc would sink it declines', () => {
    expect(() => decompile('p17', P17, ARMV4T_AGBCC, { prototypes })).toThrow(
      "a loop that polls a device register writes memory plain at an address the loop never changes in 'p17'",
    );
  });

  test('a wait whose plain byte store may alias the count lifts with the store in the loop', () => {
    const r = decompile('p18', P18, ARMV4T_AGBCC, { prototypes });
    expect(r.source).toMatch(/\n {4}while \([^\n]*\) \{\n {8}\(\(u8 \*\)67109076\)\[11\] = a0;\n {4}\}\n/);
  });

  // The control: a kept guard renders its own test, so nothing is credited for it.
  test('a guard kept as an `if` around a `do-while` records nothing', () => {
    const r = decompile('p10', P10, ARMV4T_AGBCC);
    expect(r.source).toContain('    if ((((volatile s32 *)p0)[2] & 128 << 24) != 0) {\n        do {\n');
    expect(recorded(r.sfn.body)).toEqual([]);
  });
});
