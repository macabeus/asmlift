@ sel with its second table word one instruction past the case the linked table enters
	.text
	.align	2, 0
	.globl	sel
	.type	sel, %function
	.thumb
	.thumb_func
sel:
	cmp	r0, #0x1
	bhi	.Lout_sel
	lsl	r0, r0, #0x2
	ldr	r3, .Lpool_sel
	add	r0, r0, r3
	ldr	r0, [r0]
	mov	pc, r0
	.align	2, 0
.Lpool_sel:
	.4byte	.Ltab_sel
.Ltab_sel:
	.4byte	.Lc0_sel
	.4byte	.Lc1b_sel
.Lc0_sel:
	ldr	r3, .Lp_sel
	str	r1, [r3]
	b	.Lout_sel
.Lc1_sel:
	ldr	r3, .Lp_sel
	str	r2, [r3]
.Lc1b_sel:
	b	.Lout_sel
.Lout_sel:
	bx	lr
	.align	2, 0
.Lp_sel:
	.4byte	gp
	.size	sel, .-sel
