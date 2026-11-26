@ the linked code of every callee the CLI test asks (see splat-bodies.test.ts)
	.text
	.align	2, 0
	.globl	helper
	.type	helper, %function
	.thumb
	.thumb_func
helper:
	bx	lr
	.size	helper, .-helper
	.align	2, 0
	.globl	helper2
	.type	helper2, %function
	.thumb
	.thumb_func
helper2:
	bx	lr
	.size	helper2, .-helper2
	.align	2, 0
	.globl	rd0
	.type	rd0, %function
	.thumb
	.thumb_func
rd0:
	push	{lr}
	ldr	r1, .Lp_rd0
	mov	r0, #0x1
	str	r0, [r1]
	mov	r2, #0x0
	mov	r3, #0x0
	bl	helper
	pop	{r0}
	bx	r0
	.align	2, 0
.Lp_rd0:
	.4byte	gp
	.size	rd0, .-rd0
	.align	2, 0
	.globl	rd1
	.type	rd1, %function
	.thumb
	.thumb_func
rd1:
	add	r0, r0, #0x1
	bx	lr
	.size	rd1, .-rd1
	.align	2, 0
	.globl	stale
	.type	stale, %function
	.thumb
	.thumb_func
stale:
	push	{lr}
	ldr	r1, .Lp_stale
	mov	r0, #0x1
	str	r0, [r1]
	mov	r2, #0x0
	mov	r3, #0x0
	bl	helper
	pop	{r0}
	bx	r0
	.align	2, 0
.Lp_stale:
	.4byte	gp
	.size	stale, .-stale
	.align	2, 0
	.globl	wk
	.type	wk, %function
	.thumb
	.thumb_func
wk:
	push	{lr}
	ldr	r1, .Lp_wk
	mov	r0, #0x1
	str	r0, [r1]
	mov	r2, #0x0
	mov	r3, #0x0
	bl	helper
	pop	{r0}
	bx	r0
	.align	2, 0
.Lp_wk:
	.4byte	gp
	.size	wk, .-wk
	.align	2, 0
	.globl	wrongbl
	.type	wrongbl, %function
	.thumb
	.thumb_func
wrongbl:
	push	{lr}
	ldr	r1, .Lp_wrongbl
	mov	r0, #0x1
	str	r0, [r1]
	mov	r2, #0x0
	mov	r3, #0x0
	bl	helper
	pop	{r0}
	bx	r0
	.align	2, 0
.Lp_wrongbl:
	.4byte	gp
	.size	wrongbl, .-wrongbl
	.align	2, 0
	.globl	dup
	.type	dup, %function
	.thumb
	.thumb_func
dup:
	push	{lr}
	ldr	r1, .Lp_dup
	mov	r0, #0x1
	str	r0, [r1]
	mov	r2, #0x0
	mov	r3, #0x0
	bl	helper
	pop	{r0}
	bx	r0
	.align	2, 0
.Lp_dup:
	.4byte	gp
	.size	dup, .-dup
	.align	2, 0
	.globl	sel
	.type	sel, %function
	.thumb
	.thumb_func
sel:
	cmp	r0, #0x1
	bhi	.Lout_sel
	lsl	r0, r0, #0x2
	ldr	r3, .Lpool_sel
	add	r0, r0, r3
	ldr	r0, [r0]
	mov	pc, r0
	.align	2, 0
.Lpool_sel:
	.4byte	.Ltab_sel
.Ltab_sel:
	.4byte	.Lc0_sel
	.4byte	.Lc1_sel
.Lc0_sel:
	ldr	r3, .Lp_sel
	str	r1, [r3]
	b	.Lout_sel
.Lc1_sel:
	ldr	r3, .Lp_sel
	str	r2, [r3]
.Lc1b_sel:
	b	.Lout_sel
.Lout_sel:
	bx	lr
	.align	2, 0
.Lp_sel:
	.4byte	gp
	.size	sel, .-sel
	.align	2, 0
	.globl	fw
	.type	fw, %function
	.thumb
	.thumb_func
fw:
	push	{lr}
	bl	rd1
	pop	{r0}
	bx	r0
	.size	fw, .-fw
	.data
	.globl	gp
gp:	.4byte	0
