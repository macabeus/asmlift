@ agbcc 2.9-arm-000512, -O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix, from:
@   s64 lladd(s64 a, s64 b){ return a+b; }
@   s64 llsub(s64 a, s64 b){ return a-b; }
@   s64 lladdw(s64 a, s32 b){ return a+b; }
@   u64 lladdu(u64 a, u32 b){ return a+b; }
@   s32 llhisum(s64 a, s64 b){ return (a+b)>>32; }
@   s64 lladd3(s64 a, s64 b, s64 c){ return a+b+c; }
@   s64 lltimes3(s64 a){ return a*3; }
@   void g(void);
@   s64 llkeepadd(s64 a, s64 b){ s64 x = a+b; g(); return x; }
@   s64 lljoin(s64 a, s64 b, s32 c){ if (c) return a+b; return 0; }
@   s64 llmuldiv(s32 x, s32 y){ s64 r = x; r *= y; r /= 256; return r; }
@
@ Each function was compiled on its own; its local labels carry a suffix so that one file holds them all.
@
@ Every 64-bit add and subtract agbcc emits is ONE insn (`adddi3`/`subdi3` in thumb.md): the low
@ words' `add`/`sub` and the high words' `adc`/`sbc` side by side, nothing between.
@
@ `lladdw` and `lladdu` widen a word into the pair (`asr #0x1f` / `mov #0`), and both hand the
@ result back through register COPIES (`add r1,r3,#0`) rather than computing it in r0:r1, which
@ is what makes the return width a question about the value r1 holds and not about which
@ instructions mention it. `llhisum` keeps only the high half. `lladd3` reads its third pair off
@ the stack. `lltimes3` reaches `adddi3` from a multiply, `(a<<1)+a`, whose shifted pair is not a
@ widen — so it is the shape whose `concat` must stay the structurer's loud gap.
@
@ `llkeepadd` holds its sum across a call in r4:r5 and copies it back into r0:r1 afterwards — the
@ carry-pair twin of `llkeep` in agbcc-int64-helpers.s.
@
@ `lljoin` builds its sum in one arm and returns from the join, where r0 and r1 are phis.
@
@ `llmuldiv` builds its high word from shifts of a join, so no pair reaches r0:r1 — and its epilogue
@ pops into r2, which agbcc does only for an 8-byte return.
	.code	16
.gcc2_compiled.:
.text
	.align	2, 0
	.globl	lladd
	.type	 lladd,function
	.thumb_func
lladd:
	add	r0, r0, r2
	adc	r1, r1, r3
	bx	lr
.Lfe1:
	.size	 lladd,.Lfe1-lladd
	.align	2, 0
	.globl	llsub
	.type	 llsub,function
	.thumb_func
llsub:
	sub	r0, r0, r2
	sbc	r1, r1, r3
	bx	lr
.Lfe2:
	.size	 llsub,.Lfe2-llsub
	.align	2, 0
	.globl	lladdw
	.type	 lladdw,function
	.thumb_func
lladdw:
	asr	r3, r2, #0x1f
	add	r2, r2, r0
	adc	r3, r3, r1
	add	r1, r3, #0
	add	r0, r2, #0
	bx	lr
.Lfe3:
	.size	 lladdw,.Lfe3-lladdw
	.align	2, 0
	.globl	lladdu
	.type	 lladdu,function
	.thumb_func
lladdu:
	mov	r3, #0x0
	add	r2, r2, r0
	adc	r3, r3, r1
	add	r1, r3, #0
	add	r0, r2, #0
	bx	lr
.Lfe4:
	.size	 lladdu,.Lfe4-lladdu
	.align	2, 0
	.globl	llhisum
	.type	 llhisum,function
	.thumb_func
llhisum:
	add	r0, r0, r2
	adc	r1, r1, r3
	add	r0, r1, #0
	bx	lr
.Lfe5:
	.size	 llhisum,.Lfe5-llhisum
	.align	2, 0
	.globl	lladd3
	.type	 lladd3,function
	.thumb_func
lladd3:
	push	{r4, r5, lr}
	ldr	r4, [sp, #0xc]		@ created by thumb_load_double_from_address
	ldr	r5, [sp, #0x10]		@ created by thumb_load_double_from_address
	add	r0, r0, r2
	adc	r1, r1, r3
	add	r4, r4, r0
	adc	r5, r5, r1
	add	r1, r5, #0
	add	r0, r4, #0
	pop	{r4, r5}
	pop	{r2}
	bx	r2
.Lfe6:
	.size	 lladd3,.Lfe6-lladd3
	.align	2, 0
	.globl	lltimes3
	.type	 lltimes3,function
	.thumb_func
lltimes3:
	push	{r4, r5, lr}
	add	r3, r1, #0
	add	r2, r0, #0
	lsr	r5, r2, #0x1f
	lsl	r4, r3, #0x1
	add	r1, r5, #0
	orr	r1, r1, r4
	lsl	r0, r2, #0x1
	add	r0, r0, r2
	adc	r1, r1, r3
	pop	{r4, r5}
	pop	{r2}
	bx	r2
.Lfe7:
	.size	 lltimes3,.Lfe7-lltimes3
	.align	2, 0
	.globl	llkeepadd
	.type	 llkeepadd,function
	.thumb_func
llkeepadd:
	push	{r4, r5, lr}
	add	r5, r1, #0
	add	r4, r0, #0
	add	r4, r4, r2
	adc	r5, r5, r3
	bl	g
	add	r1, r5, #0
	add	r0, r4, #0
	pop	{r4, r5}
	pop	{r2}
	bx	r2
.Lfe8:
	.size	 llkeepadd,.Lfe8-llkeepadd
	.align	2, 0
	.globl	lljoin
	.type	 lljoin,function
	.thumb_func
lljoin:
	push	{r4, r5, lr}
	add	r5, r1, #0
	add	r4, r0, #0
	ldr	r0, [sp, #0xc]
	cmp	r0, #0
	bne	.L3j	@cond_branch
	mov	r0, #0x0
	mov	r1, #0
	b	.L4j
.L3j:
	add	r4, r4, r2
	adc	r5, r5, r3
	add	r1, r5, #0
	add	r0, r4, #0
.L4j:
	pop	{r4, r5}
	pop	{r2}
	bx	r2
.Lfe9:
	.size	 lljoin,.Lfe9-lljoin
	.align	2, 0
	.globl	llmuldiv
	.type	 llmuldiv,function
	.thumb_func
llmuldiv:
	push	{r4, r5, r6, r7, lr}
	add	r2, r1, #0
	add	r4, r0, #0
	asr	r5, r0, #0x1f
	asr	r3, r2, #0x1f
	add	r1, r5, #0
	add	r0, r4, #0
	bl	__muldi3
	add	r5, r1, #0
	add	r4, r0, #0
	add	r7, r5, #0
	add	r6, r4, #0
	cmp	r5, #0
	bge	.L3ll	@cond_branch
	mov	r6, #0xff
	mov	r7, #0
	add	r6, r6, r4
	adc	r7, r7, r5
.L3ll:
	lsl	r3, r7, #0x18
	lsr	r2, r6, #0x8
	add	r0, r3, #0
	orr	r0, r0, r2
	asr	r1, r7, #0x8
	add	r5, r1, #0
	add	r4, r0, #0
	pop	{r4, r5, r6, r7}
	pop	{r2}
	bx	r2
.Lfe10:
	.size	 llmuldiv,.Lfe10-llmuldiv
