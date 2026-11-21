	.altmacro
	.macro mk n
	.macro n rd, imm
	adds \rd, \imm
	.endm
	.endm
	mk
	thumb_func_start cal
cal:
	push {lr}
	movs r1, #0
	ldr r2, _p
	str r1, [r2]
	pop {r0}
	bx r0
	.align 2, 0
_p: .4byte gp
	thumb_func_end cal
