// The poll-read pin (frontend/poll-reads.ts): a read a call-free loop makes each time round at an
// address the loop never changes is `volatile`, at a level that moves loop-invariant code, and the
// poll-store rule (contracts.ts `sunkPollStore`) judges the stores such a loop makes. Compiled:
//
//   agbcc -mthumb-interwork -O2 -fhex-asm
//     void w1(void) { do { } while (((vu32 *)0x40000d4)[2] & 0x80000000); g(); }
//     void w7(u32 a) { do { if (a & 1) a = a * 3; else a >>= 1; } while (*(vu16 *)0x4000006 != 3); h(a); }
//     void hr(s32 a0) { while (((volatile s32 *)0x40000d4)[2] & 0x80000000) ((s32 *)0x40000d4)[5] = a0; g(); }
//     void p04(s32 a0) { while (((volatile s32 *)0x40000d4)[2] & 0x80000000) { if (a0 & 1) ((s32 *)0x40000d4)[5] = a0; } g(); }
//     s32 t07(void) { while (*(vu16 *)0x4000006 != 160) { if (*(vu16 *)0x4000004 & 1) return 1; } g(); return 0; }
//     void n06(s32 a0, s32 a1) { s32 v; do { s32 i; v = ((volatile s32 *)0x40000d4)[2];
//       for (i = 0; i < a1; i++) ((volatile s32 *)0x40000e0)[1] = a0; } while (v & 0x80000000); g(); }
//     void st1(s32 *p) { while (*(vu16 *)0x4000006 != 160) *p++ = 0; g(); }
//     void se(s32 *p) { while (*(u8 *)0x4000006 != 160) *p++ = 0; g(); }
//     void kq(u8 *q, u8 *p) { while (((volatile u8 *)q)[3] != 160) *p++ = 0; g(); }
//   IDO 7.1 cc -O2 -mips2 -32 -non_shared -G 0
//     void iv(void) { while (*(vu32 *)0xA4600010 & 3) ; }
//     void v1(s32 a0) { while (((vu32 *)0xA4600010)[0] & 3) { ((vu32 *)0xA4600000)[5] = a0; } }
//     void i13(s32 a0) { while (*(vs32 *)&gF == 0) { ((vu32 *)0xA4600000)[5] = a0; } g(); }
//     void h1(s32 a0, s32 a1) { while (((vu32 *)0xA4600010)[0] & 3) {
//       ((s32 *)0xA4600000)[5] = a0; ((u16 *)0xA4500000)[2] = a1; } g(); }
//     void j13(s32 a0, s32 a1) { s32 n = 0; while (*(vu32 *)0xA4000010 & 3) {
//       ((vs32 *)0xA0001000)[5] = a0; if (a1 & 1) n++; } return n; }
//     void q4(s32 a0) { do { ((s32 *)0xA4000000)[5] = a0; }
//       while ((*(vu32 *)0xA4600010 & 3) || (*(vu32 *)0xA4600014 & 1)); }
//     void i04(s32 a0) { while (*(vu32 *)0xA4600010 & 3) {
//       ((vs32 *)0xA4000000)[5] = a0; ((vs32 *)0xA4000000)[5] = a0; } }
//     void u4(s32 a0, s32 a1) { while (*(vu32 *)0xA4000010 & 3) { ((s32 *)0xA0001000)[1] = a0; gVA[2] = a1; } }
//     void e6(s32 a0, s32 a1, s32 *p) { while (*(vu32 *)0xA4000010 & 3) { gW = a0; p[3] = a1; } }
//   agbcc -mthumb-interwork -O2 -fhex-asm, again
//     void e2(s32 *q) { while (*(vu16 *)0x3000100 != 50) { *(vu16 *)0x3000100 = 7; *q++ = 0; } }
//     void e7(s32 *q) { while (*(vu8 *)0x3000100 != 50) { *(vu8 *)0x3000100 = 7; *q++ = 0; } }
//     void o6(s32 a0) { while (*(vu8 *)0x4000108 & 1) { *(u16 *)0x4000104 = a0; *(u8 *)0x4000105 = a0; } }
//     void k16c(s32 a0) { s32 s = 0; while (s < 100 && (*(vu32 *)0x4000104 & 3)) { s++; } }
//   agbcc -mthumb-interwork -O1 -fhex-asm
//     s32 m15(s32 a0, s32 *q) { s32 s = 0; while (*(volatile s32 *)0x4000104 & 3) {
//       ((volatile s32 *)0x3001000)[1] = a0; s += *q++; } return s; }
//   KMC gcc 2.7.2 -O2 -G0 -mips3 -mgp32 -mfp32
//     s32 m4(s32 *q) { s32 s = 0; while (*(vu32 *)0xA4000010 & 3) {
//       ((vs32 *)0xA0001000)[1] = 5; s += *q++; } return s; }
//     void m7(s32 a0) { s32 i; for (i = 0; i < 10; i++) {
//       while (*(vu32 *)0xA4000010 & 3); ((s32 *)0xA0001000)[1] = a0; } }
//   mwcc 2.4.2 -O4,p
//     void qw(void) { while (*(vu32 *)0xCC006010 & 3) ; g(); }
//
// Recompiled with the read plain, w1, iv and qw are a branch to itself; hr's store and read both
// leave the loop (agbcc `load_mems`), and v1's store is written once ahead of it (IDO). t07's
// DISPSTAT read, in a loop that returns from inside, is loaded once ahead of the loop (agbcc
// `scan_loop`, which does not ask how many places the loop is left for). n06's inner `for` writes
// its cell once, after it (agbcc runs `load_mems` on the inner loop too); st1's `u16` read is
// loaded once ahead of the loop beside the `s32` store, and se's `u8` read stays in it,
// while kq's, through a parameter, is loaded once ahead of the loop beside a byte store. i13's store
// is written once ahead of the loop compiled against `extern volatile s32 gF;`, and h1, recompiled
// plain, is the original. Recompiled plain, j13's store is written once ahead of the loop (IDO, past
// the `if`), q4's second read is loaded once ahead of it (IDO), i04's two stores are one, written
// ahead of it; e2's read and store leave the loop together (agbcc `load_mems`) while e7's byte cell
// keeps both; o6's two overlapping stores stay; k16c's body read is the guard's again and goes;
// m15 (agbcc -O1) and m4 (KMC) load their poll once, and m4's store is then written once ahead of
// the loop, as it is with the poll spelled volatile; m7's inner guard read leaves the outer loop.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { globalsFromContext } from '../src/proto-context';
import { MIPS_IDO, PPC_MWCC, targetFor } from '../src/target';

const W1 = `
w1:
	push	{lr}
	ldr	r2, .L8
	ldr	r0, [r2]
	mov	r1, #0x80
	lsl	r1, r1, #0x18
	cmp	r0, #0
	bge	.L4	@cond_branch
.L5:
	ldr	r0, [r2]
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L5	@cond_branch
.L4:
	bl	g
	pop	{r0}
	bx	r0
.L9:
	.align	2, 0
.L8:
	.word	0x40000dc
.Lfe1:
`;
const W7 = `
w7:
	push	{lr}
	add	r1, r0, #0
	mov	r3, #0x1
	ldr	r2, .L10
.L3:
	add	r0, r1, #0
	and	r0, r0, r3
	cmp	r0, #0
	beq	.L6	@cond_branch
	lsl	r0, r1, #0x1
	add	r1, r0, r1
	b	.L5
.L11:
	.align	2, 0
.L10:
	.word	0x4000006
.L6:
	lsr	r1, r1, #0x1
.L5:
	ldrh	r0, [r2]
	cmp	r0, #0x3
	bne	.L3	@cond_branch
	add	r0, r1, #0
	bl	h
	pop	{r0}
	bx	r0
.Lfe1:
`;
const HR = `
hr:
	push	{r4, lr}
	add	r4, r0, #0
	ldr	r1, .L7
	ldr	r0, [r1]
	mov	r2, #0x80
	lsl	r2, r2, #0x18
	cmp	r0, #0
	bge	.L4	@cond_branch
	ldr	r3, .L7+0x4
.L5:
	str	r4, [r3]
	ldr	r0, [r1]
	and	r0, r0, r2
	cmp	r0, #0
	bne	.L5	@cond_branch
.L4:
	bl	g
	pop	{r4}
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	0x40000dc
	.word	0x40000e8
.Lfe1:
`;
const P04 = `
p04:
	push	{r4, r5, lr}
	add	r1, r0, #0
	ldr	r4, .L8
	ldr	r0, [r4]
	mov	r3, #0x80
	lsl	r3, r3, #0x18
	cmp	r0, #0
	bge	.L4	@cond_branch
	mov	r2, #0x1
	and	r2, r2, r1
	ldr	r5, .L8+0x4
.L5:
	cmp	r2, #0
	beq	.L3	@cond_branch
	str	r1, [r5]
.L3:
	ldr	r0, [r4]
	and	r0, r0, r3
	cmp	r0, #0
	bne	.L5	@cond_branch
.L4:
	bl	g
	pop	{r4, r5}
	pop	{r0}
	bx	r0
.L9:
	.align	2, 0
.L8:
	.word	0x40000dc
	.word	0x40000e8
.Lfe1:
`;
const T07 = `
t07:
	push	{r4, lr}
	ldr	r1, .L9
	ldrh	r0, [r1]
	cmp	r0, #0xa0
	beq	.L4	@cond_branch
	ldr	r3, .L9+0x4
	mov	r4, #0x1
	add	r2, r1, #0
.L5:
	ldrh	r1, [r3]
	add	r0, r4, #0
	and	r0, r0, r1
	cmp	r0, #0
	beq	.L3	@cond_branch
	mov	r0, #0x1
	b	.L8
.L10:
	.align	2, 0
.L9:
	.word	0x4000006
	.word	0x4000004
.L3:
	ldrh	r0, [r2]
	cmp	r0, #0xa0
	bne	.L5	@cond_branch
.L4:
	bl	g
	mov	r0, #0x0
.L8:
	pop	{r4}
	pop	{r1}
	bx	r1
.Lfe1:
`;
const IV = `
00000000 <iv>:
   0:	lui	v0,0xa460
   4:	ori	v0,v0,0x10
   8:	lw	t6,0(v0)
   c:	andi	t7,t6,0x3
  10:	beqz	t7,28 <iv+0x28>
  14:	nop
  18:	lw	t8,0(v0)
  1c:	andi	t9,t8,0x3
  20:	bnezl	t9,1c <iv+0x1c>
  24:	lw	t8,0(v0)
  28:	jr	ra
  2c:	nop
`;
const V1 = `
00000030 <v1>:
  30:	lui	v0,0xa460
  34:	ori	v0,v0,0x10
  38:	lw	t6,0(v0)
  3c:	lui	v1,0xa460
  40:	ori	v1,v1,0x14
  44:	andi	t7,t6,0x3
  48:	beqz	t7,64 <v1+0x34>
  4c:	nop
  50:	sw	a0,0(v1)
  54:	lw	t8,0(v0)
  58:	andi	t9,t8,0x3
  5c:	bnezl	t9,54 <v1+0x24>
  60:	sw	a0,0(v1)
  64:	jr	ra
  68:	nop
  6c:	nop
`;
const QW = `
00000000 <qw>:
   0:	stwu    r1,-16(r1)
   4:	mflr    r0
   8:	lis     r3,-13312
   c:	stw     r0,20(r1)
  10:	lwz     r0,24592(r3)
  14:	clrlwi. r0,r0,30
  18:	bne+    10 <qw+0x10>
  1c:	bl      1c <qw+0x1c>
			1c: R_PPC_REL24	g
  20:	lwz     r0,20(r1)
  24:	mtlr    r0
  28:	addi    r1,r1,16
  2c:	blr
`;

const N06 = `
n06:
	push	{r4, r5, r6, lr}
	add	r4, r0, #0
	ldr	r6, .L13
	mov	r5, #0x80
	lsl	r5, r5, #0x18
.L3:
	ldr	r3, [r6]
	cmp	r1, #0
	ble	.L5	@cond_branch
	ldr	r0, .L13+0x4
	add	r2, r1, #0
.L9:
	str	r4, [r0]
	sub	r2, r2, #0x1
	cmp	r2, #0
	bne	.L9	@cond_branch
.L5:
	and	r3, r3, r5
	cmp	r3, #0
	bne	.L3	@cond_branch
	bl	g
	pop	{r4, r5, r6}
	pop	{r0}
	bx	r0
.L14:
	.align	2, 0
.L13:
	.word	0x40000dc
	.word	0x40000e4
.Lfe1:
`;
const ST1 = `
st1:
	push	{lr}
	add	r2, r0, #0
	ldr	r1, .L7
	ldrh	r0, [r1]
	cmp	r0, #0xa0
	beq	.L4	@cond_branch
	mov	r3, #0x0
.L5:
	stmia	r2!, {r3}
	ldrh	r0, [r1]
	cmp	r0, #0xa0
	bne	.L5	@cond_branch
.L4:
	bl	g
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	0x4000006
.Lfe1:
`;
const KQ = `
kq:
	push	{lr}
	add	r2, r0, #0
	ldrb	r0, [r2, #0x3]
	cmp	r0, #0xa0
	beq	.L4	@cond_branch
	mov	r3, #0x0
.L5:
	strb	r3, [r1]
	add	r1, r1, #0x1
	ldrb	r0, [r2, #0x3]
	cmp	r0, #0xa0
	bne	.L5	@cond_branch
.L4:
	bl	g
	pop	{r0}
	bx	r0
.Lfe1:
`;
const SE = `
se:
	push	{lr}
	add	r2, r0, #0
	ldr	r1, .L7
	ldrb	r0, [r1]
	cmp	r0, #0xa0
	beq	.L4	@cond_branch
	mov	r3, #0x0
.L5:
	stmia	r2!, {r3}
	ldrb	r0, [r1]
	cmp	r0, #0xa0
	bne	.L5	@cond_branch
.L4:
	bl	g
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	0x4000006
.Lfe1:
`;
const I13 = `
00000000 <i13>:
   0:	lui	v1,0x0
   4:	addiu	v1,v1,0
   8:	lw	t6,0(v1)
   c:	addiu	sp,sp,-24
  10:	sw	ra,20(sp)
  14:	bnez	t6,30 <i13+0x30>
  18:	lui	v0,0xa460
  1c:	ori	v0,v0,0x14
  20:	sw	a0,0(v0)
  24:	lw	t7,0(v1)
  28:	beqzl	t7,24 <i13+0x24>
  2c:	sw	a0,0(v0)
  30:	jal	0 <i13>
  34:	nop
  38:	lw	ra,20(sp)
  3c:	addiu	sp,sp,24
  40:	jr	ra
  44:	nop
	...
`;
const H1 = `
00000000 <h1>:
   0:	addiu	sp,sp,-24
   4:	lui	a2,0xa460
   8:	ori	a2,a2,0x10
   c:	sw	ra,20(sp)
  10:	lw	t6,0(a2)
  14:	lui	v1,0xa450
  18:	ori	v1,v1,0x4
  1c:	andi	t7,t6,0x3
  20:	beqz	t7,44 <h1+0x44>
  24:	lui	v0,0xa460
  28:	ori	v0,v0,0x14
  2c:	sw	a0,0(v0)
  30:	sh	a1,0(v1)
  34:	lw	t8,0(a2)
  38:	andi	t9,t8,0x3
  3c:	bnezl	t9,30 <h1+0x30>
  40:	sw	a0,0(v0)
  44:	jal	0 <h1>
  48:	nop
  4c:	lw	ra,20(sp)
  50:	addiu	sp,sp,24
  54:	jr	ra
  58:	nop
  5c:	nop
`;

const E2 = `
e2:
	push	{r4, lr}
	add	r3, r0, #0
	ldr	r1, .L7
	ldrh	r0, [r1]
	cmp	r0, #0x32
	beq	.L4	@cond_branch
	mov	r4, #0x7
	mov	r2, #0x0
.L5:
	strh	r4, [r1]
	stmia	r3!, {r2}
	ldrh	r0, [r1]
	cmp	r0, #0x32
	bne	.L5	@cond_branch
.L4:
	pop	{r4}
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	0x3000100
.Lfe1:
`;
const E7 = E2.replaceAll('e2', 'e7').replaceAll('strh', 'strb').replaceAll('ldrh', 'ldrb');
const O6 = `
o6:
	push	{r4, r5, r6, lr}
	add	r2, r0, #0
	ldr	r3, .L7
	ldrb	r1, [r3]
	mov	r0, #0x1
	and	r0, r0, r1
	cmp	r0, #0
	beq	.L4	@cond_branch
	ldr	r6, .L7+0x4
	ldr	r5, .L7+0x8
	mov	r4, #0x1
.L5:
	strh	r2, [r6]
	strb	r2, [r5]
	ldrb	r1, [r3]
	add	r0, r4, #0
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L5	@cond_branch
.L4:
	pop	{r4, r5, r6}
	pop	{r0}
	bx	r0
.L8:
	.align	2, 0
.L7:
	.word	0x4000108
	.word	0x4000104
	.word	0x4000105
.Lfe1:
`;
const K16C = `
k16c:
	push	{lr}
	mov	r2, #0x0
	ldr	r3, .L9
	ldr	r0, [r3]
	mov	r1, #0x3
	b	.L8
.L10:
	.align	2, 0
.L9:
	.word	0x4000104
.L5:
	add	r2, r2, #0x1
	cmp	r2, #0x63
	bgt	.L4	@cond_branch
	ldr	r0, [r3]
.L8:
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L5	@cond_branch
.L4:
	pop	{r0}
	bx	r0
.Lfe1:
`;
const M15 = `
m15:
	push	{r4, r5, r6, lr}
	add	r4, r0, #0
	add	r5, r1, #0
	mov	r2, #0x0
	ldr	r0, .L7
	add	r3, r0, #0
	mov	r1, #0x3
	ldr	r0, [r0]
	and	r0, r0, r1
	cmp	r0, #0
	beq	.L4	@cond_branch
	ldr	r6, .L7+0x4
.L5:
	str	r4, [r6]
	ldmia	r5!, {r0}
	add	r2, r2, r0
	ldr	r0, [r3]
	and	r0, r0, r1
	cmp	r0, #0
	bne	.L5	@cond_branch
.L4:
	add	r0, r2, #0
	pop	{r4, r5, r6}
	pop	{r1}
	bx	r1
.L8:
	.align	2, 0
.L7:
	.word	0x4000104
	.word	0x3001004
.Lfe1:
`;
const M4 = `
00000000 <m4>:
   0:	lui	v0,0xa400
   4:	ori	v0,v0,0x10
   8:	lw	v0,0(v0)
   c:	andi	v0,v0,0x3
  10:	beqz	v0,48 <m4+0x48>
  14:	move	a1,zero
  18:	lui	a3,0xa000
  1c:	ori	a3,a3,0x1004
  20:	li	t0,5
  24:	lui	a2,0xa400
  28:	ori	a2,a2,0x10
  2c:	sw	t0,0(a3)
  30:	lw	v1,0(a0)
  34:	lw	v0,0(a2)
  38:	addiu	a0,a0,4
  3c:	andi	v0,v0,0x3
  40:	bnez	v0,2c <m4+0x2c>
  44:	addu	a1,a1,v1
  48:	jr	ra
  4c:	move	v0,a1
`;
const M7 = `
00000000 <m7>:
   0:	move	a1,zero
   4:	lui	a3,0xa400
   8:	ori	a3,a3,0x10
   c:	lui	a2,0xa000
  10:	ori	a2,a2,0x1004
  14:	lw	v0,0(a3)
  18:	andi	v0,v0,0x3
  1c:	beqzl	v0,40 <m7+0x40>
  20:	addiu	a1,a1,1
  24:	lui	v1,0xa400
  28:	ori	v1,v1,0x10
  2c:	lw	v0,0(v1)
  30:	andi	v0,v0,0x3
  34:	bnez	v0,2c <m7+0x2c>
  38:	nop
  3c:	addiu	a1,a1,1
  40:	slti	v0,a1,10
  44:	bnez	v0,14 <m7+0x14>
  48:	sw	a0,0(a2)
  4c:	jr	ra
  50:	nop
`;
const J13 = `
00000000 <j13>:
   0:	lui	a2,0xa400
   4:	ori	a2,a2,0x10
   8:	lw	t6,0(a2)
   c:	andi	v0,a1,0x1
  10:	lui	a1,0xa000
  14:	andi	t7,t6,0x3
  18:	beqz	t7,40 <j13+0x40>
  1c:	move	v1,zero
  20:	ori	a1,a1,0x1014
  24:	beqz	v0,30 <j13+0x30>
  28:	sw	a0,0(a1)
  2c:	addiu	v1,v1,1
  30:	lw	t8,0(a2)
  34:	andi	t9,t8,0x3
  38:	bnez	t9,24 <j13+0x24>
  3c:	nop
  40:	jr	ra
  44:	move	v0,v1
`;
const Q4 = `
00000000 <q4>:
   0:	lui	t6,0xa400
   4:	lui	v1,0xa460
   8:	lui	v0,0xa460
   c:	ori	v0,v0,0x10
  10:	ori	v1,v1,0x14
  14:	sw	a0,20(t6)
  18:	lw	t7,0(v0)
  1c:	andi	t8,t7,0x3
  20:	bnezl	t8,1c <q4+0x1c>
  24:	lw	t7,0(v0)
  28:	lw	t9,0(v1)
  2c:	andi	t0,t9,0x1
  30:	bnezl	t0,1c <q4+0x1c>
  34:	lw	t7,0(v0)
  38:	jr	ra
  3c:	nop
`;
const I04 = `
00000000 <i04>:
   0:	lui	v0,0xa460
   4:	ori	v0,v0,0x10
   8:	lw	t6,0(v0)
   c:	lui	v1,0xa400
  10:	ori	v1,v1,0x14
  14:	andi	t7,t6,0x3
  18:	beqz	t7,38 <i04+0x38>
  1c:	nop
  20:	sw	a0,0(v1)
  24:	sw	a0,0(v1)
  28:	lw	t8,0(v0)
  2c:	andi	t9,t8,0x3
  30:	bnezl	t9,24 <i04+0x24>
  34:	sw	a0,0(v1)
  38:	jr	ra
  3c:	nop
`;

const U4 = `
00000000 <u4>:
   0:	lui	v0,0xa400
   4:	ori	v0,v0,0x10
   8:	lw	t6,0(v0)
   c:	lui	a2,0x0
  10:	addiu	a2,a2,0
  14:	andi	t7,t6,0x3
  18:	beqz	t7,3c <u4+0x3c>
  1c:	lui	v1,0xa000
  20:	ori	v1,v1,0x1004
  24:	sw	a0,0(v1)
  28:	sw	a1,8(a2)
  2c:	lw	t8,0(v0)
  30:	andi	t9,t8,0x3
  34:	bnezl	t9,28 <u4+0x28>
  38:	sw	a0,0(v1)
  3c:	jr	ra
  40:	nop
`;
const E6 = `
00000000 <e6>:
   0:	lui	v0,0xa400
   4:	ori	v0,v0,0x10
   8:	lw	t6,0(v0)
   c:	lui	v1,0x0
  10:	addiu	v1,v1,0
  14:	andi	t7,t6,0x3
  18:	beqz	t7,38 <e6+0x38>
  1c:	nop
  20:	sw	a0,0(v1)
  24:	sw	a1,12(a2)
  28:	lw	t8,0(v0)
  2c:	andi	t9,t8,0x3
  30:	bnezl	t9,24 <e6+0x24>
  34:	sw	a0,0(v1)
  38:	jr	ra
  3c:	nop
`;

/** The relocations the object file gives IDO's text: `gF`'s address and the call to `g`. */
const relocs = (list: Array<[number, string, string]>): AsmData => ({
  sections: new Map(),
  relocs: list.map(([offset, type, sym]) => ({ section: '.text', offset, type, sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});
const I13_RELOCS = relocs([
  [0, 'R_MIPS_HI16', 'gF'],
  [4, 'R_MIPS_LO16', 'gF'],
  [0x30, 'R_MIPS_26', 'g'],
]);
const H1_RELOCS = relocs([[0x44, 'R_MIPS_26', 'g']]);
const U4_RELOCS = relocs([
  [0xc, 'R_MIPS_HI16', 'gVA'],
  [0x10, 'R_MIPS_LO16', 'gVA'],
]);
const E6_RELOCS = relocs([
  [0xc, 'R_MIPS_HI16', 'gW'],
  [0x10, 'R_MIPS_LO16', 'gW'],
]);

const AGBCC = targetFor('agbcc', ['-mthumb-interwork', '-O2', '-fhex-asm']).target;
const prototypes = { g: { params: [], returnsVoid: true }, h: { params: ['u32'], returnsVoid: true } };
const SINKS = 'a loop that polls a device register writes memory plain at an address the loop never changes';

describe('a poll read the compiler would move out of its loop is pinned volatile', () => {
  test('agbcc: a store-free DMA wait reads its register volatile', () => {
    expect(decompile('w1', W1, AGBCC, { prototypes }).source).toContain(
      '} while ((*(volatile s32 *)67109084 & 128 << 24) != 0);',
    );
  });

  test('agbcc at -O0, which moves nothing, leaves it plain', () => {
    const o0 = targetFor('agbcc', ['-mthumb-interwork', '-O0']).target;
    expect(decompile('w1', W1, o0, { prototypes }).source).not.toContain('volatile');
  });

  test("agbcc: a read past a branch of the loop stays plain (maybe_never keeps it), a rotated poll's is pinned", () => {
    expect(decompile('w7', W7, AGBCC, { prototypes }).source).toContain('} while (*(u16 *)67108870 != 3);');
    // the body's read the loop's test is passed, a rotated poll's, which `gcse` deletes plain
    expect(decompile('k16c', K16C, AGBCC).source).toMatch(/v\d = \*\(volatile s32 \*\)67109124;/);
  });

  test('IDO: a read past a branch of the loop that its exit tests is pinned', () => {
    expect(decompile('q4', Q4, MIPS_IDO).source).toContain('(*(volatile s32 *)-1537212396 & 1) == 0');
  });

  test('a read whose address moves keeps no poll read beside it: agbcc -O1, KMC', () => {
    const o1 = targetFor('agbcc', ['-mthumb-interwork', '-O1', '-fhex-asm']).target;
    expect(() => decompile('m15', M15, o1)).toThrow(SINKS);
    const kmc = targetFor('gcc2.7.2kmc', ['-O2']).target;
    expect(() => decompile('m4', M4, kmc)).toThrow(SINKS);
  });

  test('agbcc: a cell the loop writes keeps its read beside a moving access only where a byte conflicts', () => {
    expect(() => decompile('e2', E2, AGBCC)).toThrow(SINKS);
    expect(decompile('e7', E7, AGBCC).source).toContain('while (*(u8 *)50331904 != 50) {');
  });

  test("KMC: an inner poll's guard, a constant built with `or`, is pinned with it", () => {
    const kmc = targetFor('gcc2.7.2kmc', ['-O2']).target;
    const src = decompile('m7', M7, kmc).source;
    expect(src).toContain('while ((*(volatile s32 *)-1543503856 & 3) != 0) {');
    expect(src).not.toContain('(*(s32 *)-1543503856');
  });

  test('agbcc: a read beside a store through a stepped pointer is pinned unless a byte keeps it', () => {
    expect(decompile('st1', ST1, AGBCC, { prototypes }).source).toContain('while (*(volatile u16 *)67108870 != 160) {');
    expect(decompile('se', SE, AGBCC, { prototypes }).source).toContain('while (*(u8 *)67108870 != 160) {');
    expect(decompile('kq', KQ, AGBCC, { prototypes }).source).toContain('while (((volatile u8 *)a0)[3] != 160) {');
    const o1 = targetFor('agbcc', ['-mthumb-interwork', '-O1']).target;
    expect(decompile('st1', ST1, o1, { prototypes }).source).toContain('while (*(u16 *)67108870 != 160) {');
  });

  test('agbcc: a header read of a loop left for two places is pinned', () => {
    expect(decompile('t07', T07, AGBCC, { prototypes }).source).toContain(
      'if ((1 & *(volatile u16 *)67108868) != 0) return 1;',
    );
  });

  test('IDO 7.1 at -O2 pins it; at -O1 it does not', () => {
    expect(decompile('iv', IV, MIPS_IDO).source).toContain('while ((*(volatile s32 *)-1537212400 & 3) != 0) {');
    const o1 = targetFor('ido7.1', ['-mips2', '-O1', '-32']).target;
    expect(decompile('iv', IV, o1).source).not.toContain('volatile');
  });

  test('mwcc at -O4,p pins it; at -O2, which keeps the read, it does not', () => {
    expect(decompile('qw', QW, PPC_MWCC).source).toContain('volatile s32 *');
    const o2 = targetFor('mwcc_242_81', ['-O2', '-proc', 'gekko']).target;
    expect(decompile('qw', QW, o2).source).not.toContain('volatile');
  });
});

describe('a poll loop that stores is judged by how the compiler moves the store', () => {
  test('agbcc: a straight-line poll whose plain store no access provably keeps declines', () => {
    expect(() => decompile('hr', HR, AGBCC, { prototypes })).toThrow(SINKS);
  });

  test('agbcc: the store under an `if` of the loop is kept, and the function lifts', () => {
    expect(decompile('p04', P04, AGBCC, { prototypes }).source).toContain('*(s32 *)67109096 = a0;');
  });

  test('agbcc: a store in a straight loop nested in a poll is judged by that loop, and declines', () => {
    expect(() => decompile('n06', N06, AGBCC, { prototypes })).toThrow(SINKS);
  });

  test('IDO: a lone store of an invariant value in a poll is hoisted, so it declines', () => {
    expect(() => decompile('v1', V1, MIPS_IDO)).toThrow(SINKS);
  });

  test('IDO: a poll of a global declared volatile hoists the store too', () => {
    const contextGlobals = globalsFromContext('typedef int s32; extern volatile s32 gF;', 'c');
    expect(() => decompile('i13', I13, MIPS_IDO, { prototypes, contextGlobals, asmData: I13_RELOCS })).toThrow(SINKS);
  });

  test('agbcc: two plain stores whose bytes overlap, one a byte, keep each other', () => {
    const src = decompile('o6', O6, AGBCC).source;
    expect(src).toContain('*(u16 *)67109124 = a0;');
    expect(src).toContain('*(u8 *)67109125 = a0;');
  });

  test('IDO: control flow beside the store is no keep, and two stores to one cell are one', () => {
    expect(() => decompile('j13', J13, MIPS_IDO)).toThrow(SINKS);
    expect(() => decompile('i04', I04, MIPS_IDO)).toThrow(SINKS);
  });

  test("IDO: a symbol's store beside a constant address's is hoisted, beside a pointer's it is kept", () => {
    expect(() => decompile('u4', U4, MIPS_IDO, { asmData: U4_RELOCS })).toThrow(SINKS);
    const src = decompile('e6', E6, MIPS_IDO, { asmData: E6_RELOCS }).source;
    expect(src).toContain('gW = a0;');
    expect(src).toContain('a2[3] = a1;');
  });

  test('IDO: two stores keep each other, and the fused guard of their poll is credited', () => {
    const src = decompile('h1', H1, MIPS_IDO, { prototypes, asmData: H1_RELOCS }).source;
    expect(src).toContain('while ((*(volatile s32 *)-1537212400 & 3) != 0) {');
    expect(src).toContain('*(s32 *)-1537212396 = a0;');
  });
});
