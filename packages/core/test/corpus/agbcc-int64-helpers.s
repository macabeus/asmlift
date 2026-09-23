@ agbcc 2.9-arm-000512, -O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix, from:
@   s64 llmul(s64 a, s64 b){ return a*b; }
@   s64 llmulw(s32 a, s32 b){ return (s64)a*(s64)b; }
@   s32 llhalfuse(s64 a, s32 b){ return (s32)(a>>b) + b; }
@   s32 lomul(s64 a, s64 b){ return (s32)(a*b); }
@   s32 halfshare(s64 a, s64 b){ return (s32)(a*b) + (s32)a; }
@   s32 himul(s64 a, s64 b){ return (s32)((a*b)>>32); }
@   void g(void); s64 llkeep(s64 a, s64 b){ s64 x = a*b; g(); return x; }
@   s64 llmuljoin(s64 a, s64 b, s32 c){ if (c) return a*b; return 0; }
@   s32 llmintarm(s32 x){ if (x) x = (s32)((s64)x * x / 3); return x; }
@
@ Each function was compiled on its own; its local labels carry a suffix so that one file holds them all.
@
@ The third one is a parameter this function uses as a WORD: `b` is both the shift count and an
@ addend, and it arrives in r2 — a third argument register that is no part of the pair in r0:r1.
@ So what it pins is the fusion declining to take a lone word INTO a pair.
@
@ THE FIFTH ONE is the other side, and it is the one the fusion's use-count condition is really
@ about: `add r4,r0,#0` copies out r0, which is ALSO the low half of the pair the `concat` names.
@ A half the function separately uses on its own is a word, so fusing that pair would delete the
@ copy's operand — the parameter it reads stops existing.
@
@ THE LAST ONE is the HIGH half of a pair, where `lomul` is the low one: the shift by 32 is the
@ only projection whose C spelling needs its operand to RENDER 64 bits wide, and here it already
@ does — `a*b` is a multiply over two 64-bit parameters. So it is the row that fails when the
@ high half is cast to 64 bits unconditionally rather than only where the rank is missing.
@
@ `llkeep` holds the pair across a call in r4:r5 and copies it back into r0:r1: the call destroys r1
@ without naming it, and the copy out of a register the call preserves is what returns the pair.
@
@ `llmul` AND `lomul` ARE THE WIDTH PAIR, and they differ in one register. `llmul` returns the
@ pair and pops its scratch into r2; `lomul` returns a word and pops into r1, which is the pair's high
@ register — so the epilogue is where the return width is written down, and the two are otherwise
@ the same four instructions.
@
@ `llmuljoin` calls the helper in one arm and returns from the join, where r0 and r1 are phis.
@
@ `llmintarm` returns a word from a join one arm of which holds a helper's pair, and r1 has no
@ definition on the other path, so asking what r1 holds must not READ it: a read there mints a parameter.
	.code	16
.gcc2_compiled.:
.text
	.align	2, 0
	.globl	llmul
	.type	 llmul,function
	.thumb_func
llmul:
	push	{lr}
	bl	__muldi3
	pop	{r2}
	bx	r2
.Lfe1:
	.size	 llmul,.Lfe1-llmul
	.align	2, 0
	.globl	llmulw
	.type	 llmulw,function
	.thumb_func
llmulw:
	push	{r4, r5, lr}
	add	r4, r0, #0
	add	r2, r1, #0
	asr	r5, r4, #0x1f
	asr	r3, r2, #0x1f
	add	r1, r5, #0
	add	r0, r4, #0
	bl	__muldi3
	pop	{r4, r5}
	pop	{r2}
	bx	r2
.Lfe2:
	.size	 llmulw,.Lfe2-llmulw
	.align	2, 0
	.globl	llhalfuse
	.type	 llhalfuse,function
	.thumb_func
llhalfuse:
	push	{r4, lr}
	add	r4, r2, #0
	bl	__ashrdi3
	add	r4, r4, r0
	add	r0, r4, #0
	pop	{r4}
	pop	{r1}
	bx	r1
.Lfe3:
	.size	 llhalfuse,.Lfe3-llhalfuse
	.align	2, 0
	.globl	lomul
	.type	 lomul,function
	.thumb_func
lomul:
	push	{lr}
	bl	__muldi3
	pop	{r1}
	bx	r1
.Lfe4:
	.size	 lomul,.Lfe4-lomul
	.align	2, 0
	.globl	halfshare
	.type	 halfshare,function
	.thumb_func
halfshare:
	push	{r4, r5, lr}
	add	r5, r1, #0
	add	r4, r0, #0
	bl	__muldi3
	add	r0, r0, r4
	pop	{r4, r5}
	pop	{r1}
	bx	r1
.Lfe5:
	.size	 halfshare,.Lfe5-halfshare
	.align	2, 0
	.globl	himul
	.type	 himul,function
	.thumb_func
himul:
	push	{lr}
	bl	__muldi3
	add	r0, r1, #0
	pop	{r1}
	bx	r1
.Lfe6:
	.size	 himul,.Lfe6-himul
	.align	2, 0
	.globl	llkeep
	.type	 llkeep,function
	.thumb_func
llkeep:
	push	{r4, r5, lr}
	bl	__muldi3
	add	r5, r1, #0
	add	r4, r0, #0
	bl	g
	add	r1, r5, #0
	add	r0, r4, #0
	pop	{r4, r5}
	pop	{r2}
	bx	r2
.Lfe7:
	.size	 llkeep,.Lfe7-llkeep
	.align	2, 0
	.globl	llmuljoin
	.type	 llmuljoin,function
	.thumb_func
llmuljoin:
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
	add	r1, r5, #0
	add	r0, r4, #0
	bl	__muldi3
.L4j:
	pop	{r4, r5}
	pop	{r2}
	bx	r2
.Lfe8:
	.size	 llmuljoin,.Lfe8-llmuljoin
	.align	2, 0
	.globl	llmintarm
	.type	 llmintarm,function
	.thumb_func
llmintarm:
	push	{lr}
	cmp	r0, #0
	beq	.L3ll	@cond_branch
	add	r2, r0, #0
	asr	r3, r0, #0x1f
	add	r1, r3, #0
	add	r0, r2, #0
	bl	__muldi3
	mov	r2, #0x3
	mov	r3, #0
	bl	__divdi3
.L3ll:
	pop	{r1}
	bx	r1
.Lfe9:
	.size	 llmintarm,.Lfe9-llmintarm
