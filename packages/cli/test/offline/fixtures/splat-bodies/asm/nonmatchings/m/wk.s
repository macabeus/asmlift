	.text
	.weak	wk
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
