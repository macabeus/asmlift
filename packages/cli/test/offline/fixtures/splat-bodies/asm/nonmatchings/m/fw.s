	.text
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
