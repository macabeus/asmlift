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
	.data
	.globl	gp
gp:	.4byte	0
