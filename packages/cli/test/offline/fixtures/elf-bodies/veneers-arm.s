@ Thumb->ARM interworking veneers in kleod's shape (asm/thunk.s), each `bx pc; nop` then an ARM `b`
@ at the next word, and the ARM bodies they enter (asm/rand_arm.s). No `.size`: like kleod's, every
@ FUNC is size 0 and its range runs to the next symbol.
	.text
	.macro veneer name, body
	.align	2, 0
	.globl	\name
	.type	\name, %function
	.thumb
	.thumb_func
\name:
	bx	pc
	nop
	.arm
	b	\body
	.endm

	veneer	thunk_rnd, rnd_arm
	veneer	thunk_rd1, rd1_arm
	veneer	thunk_br, br_arm
	veneer	thunk_cond, cond_arm
	veneer	thunk_call, call_arm
	.weak	thunk_wk
	veneer	thunk_wk, rnd_arm

	.align	2, 0
	.globl	plain
	.type	plain, %function
	.thumb
	.thumb_func
plain:
	mov	r0, #1
	bx	lr

	.arm
	.align	2, 0
	.globl	rnd_arm
	.type	rnd_arm, %function
rnd_arm:
	@ kleod's GetRandomValue: r0 = gRngTable[gRngState] & 0xFF; gRngState += gRngCount | 1
	ldr	r0, .Ltable
	ldr	r3, .Lstate
	ldrb	r2, [r3]
	add	ip, r2, r0
	ldr	r0, [ip]
	and	r0, r0, #0xff
	ldr	r1, .Lcount
	ldrb	ip, [r1]
	orr	ip, ip, #1
	add	r2, r2, ip
	strb	r2, [r3]
	bx	lr
.Ltable:
	.word	0x02000000
.Lstate:
	.word	0x02000100
.Lcount:
	.word	0x02000104

	.globl	rd1_arm
	.type	rd1_arm, %function
rd1_arm:
	add	r0, r0, #1
	bx	lr

	.globl	br_arm
	.type	br_arm, %function
br_arm:
	mov	r0, #1
	b	1f
1:
	bx	lr

	.globl	cond_arm
	.type	cond_arm, %function
cond_arm:
	movs	r0, #1
	moveq	r0, #2
	bx	lr

	.globl	call_arm
	.type	call_arm, %function
call_arm:
	mov	r0, #0
	bl	rnd_arm
	bx	lr

	.globl	last
	.type	last, %function
last:
	bx	lr
