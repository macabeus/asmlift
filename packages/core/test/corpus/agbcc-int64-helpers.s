@ agbcc 2.9-arm-000512, -O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix, from:
@   s64 llmul(s64 a, s64 b){ return a*b; }
@   s64 llmulw(s32 a, s32 b){ return (s64)a*(s64)b; }
@   s32 llhalfuse(s64 a, s32 b){ return (s32)(a>>b) + b; }
@   s32 lomul(s64 a, s64 b){ return (s32)(a*b); }
@
@ The third one is why the parameter fusion needs its second condition: `b` is BOTH the shift
@ count and an addend, so it is a word this function uses as a word.
@
@ THE LAST TWO ARE THE WIDTH PAIR, and they differ in one register. `llmul` returns the pair and
@ pops its scratch into r2; `lomul` returns a word and pops into r1, which is the pair's high
@ register — so the epilogue is where the return width is written down, and the two are otherwise
@ the same four instructions.
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
