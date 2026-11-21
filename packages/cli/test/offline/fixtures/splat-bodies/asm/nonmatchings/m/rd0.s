	.text
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
