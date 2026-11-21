	.text
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
	bl	helper2
	pop	{r0}
	bx	r0
	.align	2, 0
.Lp_wrongbl:
	.4byte	gp
	.size	wrongbl, .-wrongbl
