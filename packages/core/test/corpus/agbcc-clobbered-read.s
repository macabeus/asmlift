@ Hand-written, and it has to be: the ABI makes r1-r3 the callee's to destroy, so a compiler never
@ reads one back after a `bl`. The three functions are the three sides of the refusal in
@ frontend/ssa.ts — the value that is gone, the value the caller put back, and the value a callee
@ really does preserve but the call site cannot show.
	.code	16
.gcc2_compiled.:
.text
	.align	2, 0

@ THE WRONG VALUE. `r3` holds 42 before the call and the callee's leftovers after it, so the `add`
@ names bytes nothing in this function computed. Resolving it to the `mov` reads as `return 42`.
	.globl	clobbered_read
	.type	 clobbered_read,function
	.thumb_func
clobbered_read:
	push	{lr}
	mov	r3, #0x2a
	bl	callee
	add	r0, r3, #0
	pop	{r1}
	bx	r1
.Lfe1:
	.size	 clobbered_read,.Lfe1-clobbered_read

	.align	2, 0
@ THE SAME READ, PUT BACK. The `mov` after the call is what compiled code does instead, and it is
@ the reason the refusal is about the value rather than about the register.
	.globl	rematerialized_read
	.type	 rematerialized_read,function
	.thumb_func
rematerialized_read:
	push	{lr}
	bl	callee
	mov	r3, #0x2a
	add	r0, r3, #0
	pop	{r1}
	bx	r1
.Lfe2:
	.size	 rematerialized_read,.Lfe2-rematerialized_read

	.align	2, 0
@ THE COST, and it is the STRICT side of the guard. A hand-written callee is free to preserve r3,
@ and libgcc has such helpers — but the call site shows nothing either way, so this function
@ declines although it would have run correctly. That is a row, never a wrong answer.
	.globl	preserving_callee_read
	.type	 preserving_callee_read,function
	.thumb_func
preserving_callee_read:
	push	{lr}
	mov	r3, #0x2a
	bl	preserves_r3
	add	r0, r3, #0
	pop	{r1}
	bx	r1
.Lfe3:
	.size	 preserving_callee_read,.Lfe3-preserving_callee_read

	.align	2, 0
@ DESTROYED ON ONE PATH ONLY. Both edges into .L1 carry the same `mov`, so the join is one value and
@ not a merge — and on the path through the call that value is gone. A per-path fact, refused by the
@ union direction of the analysis.
	.globl	clobbered_on_one_path
	.type	 clobbered_on_one_path,function
	.thumb_func
clobbered_on_one_path:
	push	{lr}
	mov	r1, #0x7
	cmp	r0, #0
	beq	.L1	@cond_branch
	bl	callee
.L1:
	add	r0, r1, #0
	pop	{r1}
	bx	r1
.Lfe4:
	.size	 clobbered_on_one_path,.Lfe4-clobbered_on_one_path
