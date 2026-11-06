@ IsRequestedTradeInPlayerParty, agbcc -mthumb-interwork -O2 -fhex-asm -g output of pokeemerald src/union_room.c
@ (the build's own .text, reassembled byte-equal), with the .stab debug lines dropped.
@ read by   : packages/core/test/cross-jumped-tail.test.ts
	.type	 IsRequestedTradeInPlayerParty,function
	.thumb_func
IsRequestedTradeInPlayerParty:
.LFB95:

	push	{r4, r5, r6, lr}
	add	r5, r0, #0


	mov	r0, #0xce
	lsl	r0, r0, #0x1
	cmp	r1, r0
	bne	.L1854	@cond_branch

	mov	r4, #0x0
	b	.L1871
.L1858:

	mov	r0, #0x64
	mul	r0, r0, r4
	ldr	r1, .L1872
	add	r0, r0, r1
	mov	r1, #0x41
	bl	GetMonData2
	add	r1, r0, #0

	mov	r0, #0xce
	lsl	r0, r0, #0x1
	cmp	r1, r0
	beq	.L1867	@cond_branch

	add	r4, r4, #0x1
.L1871:
	ldr	r0, .L1872+0x4
	ldrb	r0, [r0]
	cmp	r4, r0
	blt	.L1858	@cond_branch

	mov	r0, #0x2
	b	.L1869
.L1873:
	.align	2, 0
.L1872:
	.word	gPlayerParty
	.word	gPlayerPartyCount

.L1854:

	mov	r4, #0x0
	ldr	r0, .L1874
	ldrb	r0, [r0]
	cmp	r4, r0
	bge	.L1863	@cond_branch
	ldr	r6, .L1874+0x4
.L1865:

	mov	r0, #0x64
	mul	r0, r0, r4
	ldr	r1, .L1874+0x8
	add	r0, r0, r1
	mov	r1, #0x41
	bl	GetMonData2
	add	r1, r0, #0

	lsl	r0, r1, #0x3
	sub	r0, r0, r1
	lsl	r0, r0, #0x2
	add	r1, r0, r6
	ldrb	r0, [r1, #0x6]
	cmp	r0, r5
	beq	.L1867	@cond_branch
	ldrb	r0, [r1, #0x7]
	cmp	r0, r5
	bne	.L1864	@cond_branch
.L1867:

	mov	r0, #0x0
	b	.L1869
.L1875:
	.align	2, 0
.L1874:
	.word	gPlayerPartyCount
	.word	gSpeciesInfo
	.word	gPlayerParty

.L1864:
	add	r4, r4, #0x1
	ldr	r0, .L1876
	ldrb	r0, [r0]
	cmp	r4, r0
	blt	.L1865	@cond_branch
.L1863:

	mov	r0, #0x1
.L1869:

	pop	{r4, r5, r6}
	pop	{r1}
	bx	r1
.L1877:
	.align	2, 0
.L1876:
	.word	gPlayerPartyCount
.LFE95:
.Lfe95:
	.size	 IsRequestedTradeInPlayerParty,.Lfe95-IsRequestedTradeInPlayerParty
