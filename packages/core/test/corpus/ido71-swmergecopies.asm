
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <f>:
   0:	addiu	sp,sp,-40
   4:	sw	s2,28(sp)
   8:	li	s2,3
   c:	sw	ra,36(sp)
  10:	sw	s3,32(sp)
  14:	sw	s1,24(sp)
  18:	sw	s0,20(sp)
  1c:	sw	a1,44(sp)
  20:	beq	a0,s2,44 <f+0x44>
  24:	sw	a2,48(sp)
  28:	li	at,4
  2c:	beq	a0,at,5c <f+0x5c>
  30:	li	at,7
  34:	beq	a0,at,108 <f+0x108>
  38:	nop
  3c:	b	120 <f+0x120>
  40:	nop
  44:	jal	0 <f>
  48:	li	a0,1
  4c:	jal	0 <f>
  50:	li	a0,2
  54:	b	128 <f+0x128>
  58:	nop
  5c:	jal	0 <f>
  60:	move	a0,s2
  64:	lw	v0,44(sp)
  68:	li	at,1
  6c:	andi	v0,v0,0x3
  70:	beqz	v0,88 <f+0x88>
  74:	nop
  78:	beq	v0,at,e8 <f+0xe8>
  7c:	lui	s3,0x0
  80:	b	f8 <f+0xf8>
  84:	addiu	s3,s3,0
  88:	jal	0 <f>
  8c:	li	a0,4
  90:	lui	s3,0x0
  94:	addiu	s3,s3,0
  98:	move	s0,zero
  9c:	lw	s1,44(sp)
  a0:	jal	0 <f>
  a4:	li	a0,5
  a8:	andi	t6,s1,0xf
  ac:	sll	t7,t6,0x2
  b0:	addu	t8,s3,t7
  b4:	lw	t9,0(t8)
  b8:	addiu	s0,s0,1
  bc:	slti	at,t9,5
  c0:	bnez	at,d8 <f+0xd8>
  c4:	nop
  c8:	jal	0 <f>
  cc:	li	a0,6
  d0:	b	134 <f+0x134>
  d4:	lw	t1,48(sp)
  d8:	bne	s0,s2,a0 <f+0xa0>
  dc:	addiu	s1,s1,1
  e0:	b	f8 <f+0xf8>
  e4:	nop
  e8:	jal	0 <f>
  ec:	li	a0,7
  f0:	lui	s3,0x0
  f4:	addiu	s3,s3,0
  f8:	jal	0 <f>
  fc:	li	a0,8
 100:	b	134 <f+0x134>
 104:	lw	t1,48(sp)
 108:	jal	0 <f>
 10c:	li	a0,9
 110:	jal	0 <f>
 114:	li	a0,10
 118:	b	128 <f+0x128>
 11c:	nop
 120:	jal	0 <f>
 124:	li	a0,11
 128:	lui	s3,0x0
 12c:	addiu	s3,s3,0
 130:	lw	t1,48(sp)
 134:	lw	ra,36(sp)
 138:	lw	t6,44(sp)
 13c:	andi	t2,t1,0x3
 140:	sll	t3,t2,0x2
 144:	addu	t4,s3,t3
 148:	lw	t5,0(t4)
 14c:	lw	s3,32(sp)
 150:	lw	s0,20(sp)
 154:	lw	s1,24(sp)
 158:	lw	s2,28(sp)
 15c:	addiu	sp,sp,40
 160:	jr	ra
 164:	addu	v0,t5,t6
	...
