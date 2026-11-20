	.text
	.align	2, 0
	.globl	cal
	.type	cal, %function
	.thumb
	.thumb_func
cal:
	push	{lr}
	mov	r1, #0x0
	ldr	r2, .Lp_cal
	str	r1, [r2]
	pop	{r0}
	bx	r0
	.align	2, 0
.Lp_cal:
	.4byte	gp
	.size	cal, .-cal
