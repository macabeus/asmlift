	.text
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
