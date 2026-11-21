// A guard-fused `while` over a pinned read. agbcc rotates a test-at-top loop: the exit test is
// duplicated into a guard ahead of the loop and a latch at its foot, so the asm reads the register
// at both sites. The structurer un-rotates that back into one `while`, whose condition renders the
// read once. Recompiled, the C makes both reads again. The effect contract used to count the
// condition once and refuse the function as a dropped device read. The fusion now records the
// reads the deleted guard made (`fusedGuardReads`), and the contract credits them to its dropped
// rule (contracts.ts `guardReadKey`).
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

const prototypes = { g: { params: [], returnsVoid: true } };

const allStmts = (body: Stmt[]): Stmt[] => body.flatMap((s) => [s, ...allStmts(stmtChildren(s))]);
const recorded = (body: Stmt[]) =>
  allStmts(body).flatMap((s) => (s.k === 'while' && s.fusedGuardReads !== undefined ? [s.fusedGuardReads] : []));

describe('a guard-fused wait on a pinned register', () => {
  test('the fused `while` records the read its deleted guard made, and the function lifts', () => {
    const r = decompile('p11', P11, ARMV4T_AGBCC, { prototypes });
    expect(r.source).toContain('    ((volatile s32 *)67109076)[2];\n');
    expect(r.source).toContain('    while ((((volatile s32 *)67109076)[2] & 128 << 24) != 0) {\n    }\n');
    expect(recorded(r.sfn.body)).toEqual([['device:r:0x40000dc']]);
  });

  test('the field is never printed', () => {
    expect(decompile('p11', P11, ARMV4T_AGBCC, { prototypes }).source).not.toMatch(/fusedGuardReads|device:r:/);
  });

  // The control: a kept guard renders its own test, so nothing is credited for it.
  test('a guard kept as an `if` around a `do-while` records nothing', () => {
    const r = decompile('p10', P10, ARMV4T_AGBCC);
    expect(r.source).toContain('    if ((((volatile s32 *)p0)[2] & 128 << 24) != 0) {\n        do {\n');
    expect(recorded(r.sfn.body)).toEqual([]);
  });
});
