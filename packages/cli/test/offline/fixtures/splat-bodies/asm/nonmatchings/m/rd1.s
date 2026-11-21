	.text
	.align	2, 0
	.globl	rd1
	.type	rd1, %function
	.thumb
	.thumb_func
rd1:
	add	r0, r0, #0x1
	bx	lr
	.size	rd1, .-rd1
