	.text
	.align	2, 0
	.globl	stale
	.type	stale, %function
	.thumb
	.thumb_func
stale:
	push	{lr}
	ldr	r1, .Lp_stale
	mov	r0, #0x2
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
