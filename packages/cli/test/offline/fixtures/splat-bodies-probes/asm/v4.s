	thumb_func_start cal
cal:
	push {lr}
	ldr r2, _p
	str zz, [r2]
	pop {r0}
	bx r0
	.align 2, 0
_p: .4byte gp
	thumb_func_end cal
