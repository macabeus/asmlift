
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <sw_loopret>:
   0:	addiu	sp,sp,-64
   4:	sw	s3,36(sp)
   8:	sw	s2,32(sp)
   c:	move	s2,a0
  10:	sw	ra,60(sp)
  14:	sw	s8,56(sp)
  18:	sw	s7,52(sp)
  1c:	sw	s6,48(sp)
  20:	sw	s5,44(sp)
  24:	sw	s4,40(sp)
  28:	sw	s1,28(sp)
  2c:	sw	s0,24(sp)
  30:	bltz	a1,114 <sw_loopret+0x114>
  34:	move	s3,zero
  38:	lui	s0,0x0
  3c:	lui	s1,0x0
  40:	addiu	s1,s1,0
  44:	addiu	s0,s0,0
  48:	li	s8,2
  4c:	li	s7,3
  50:	li	s6,4
  54:	li	s5,5
  58:	li	s4,1
  5c:	lbu	t6,4(s0)
  60:	addiu	t7,t6,-5
  64:	sltiu	at,t7,8
  68:	beqz	at,104 <sw_loopret+0x104>
  6c:	sll	t7,t7,0x2
  70:	lui	at,0x0
  74:	addu	at,at,t7
  78:	lw	t7,0(at)
  7c:	jr	t7
  80:	nop
  84:	lw	t8,0(s0)
  88:	bne	s2,t8,a0 <sw_loopret+0xa0>
  8c:	nop
  90:	jal	0 <sw_loopret>
  94:	move	a0,s2
  98:	b	144 <sw_loopret+0x144>
  9c:	lw	ra,60(sp)
  a0:	b	104 <sw_loopret+0x104>
  a4:	sw	s4,0(s1)
  a8:	lw	t9,0(s0)
  ac:	slt	at,s2,t9
  b0:	beqzl	at,108 <sw_loopret+0x108>
  b4:	addiu	s3,s3,1
  b8:	b	104 <sw_loopret+0x104>
  bc:	sw	s8,0(s1)
  c0:	lw	t0,0(s0)
  c4:	slt	at,t0,s2
  c8:	beqzl	at,108 <sw_loopret+0x108>
  cc:	addiu	s3,s3,1
  d0:	b	104 <sw_loopret+0x104>
  d4:	sw	s7,0(s1)
  d8:	b	104 <sw_loopret+0x104>
  dc:	sw	s6,0(s1)
  e0:	lw	t1,0(s0)
  e4:	beql	s2,t1,108 <sw_loopret+0x108>
  e8:	addiu	s3,s3,1
  ec:	b	104 <sw_loopret+0x104>
  f0:	sw	s5,0(s1)
  f4:	move	a0,s3
  f8:	jal	0 <sw_loopret>
  fc:	sw	a1,68(sp)
 100:	lw	a1,68(sp)
 104:	addiu	s3,s3,1
 108:	addiu	t2,a1,1
 10c:	bne	t2,s3,5c <sw_loopret+0x5c>
 110:	addiu	s0,s0,8
 114:	lui	s1,0x0
 118:	addiu	s1,s1,0
 11c:	lw	t3,0(s1)
 120:	li	t4,9
 124:	bnel	s2,t3,140 <sw_loopret+0x140>
 128:	sw	t4,0(s1)
 12c:	jal	0 <sw_loopret>
 130:	li	a0,7
 134:	b	144 <sw_loopret+0x144>
 138:	lw	ra,60(sp)
 13c:	sw	t4,0(s1)
 140:	lw	ra,60(sp)
 144:	lw	s0,24(sp)
 148:	lw	s1,28(sp)
 14c:	lw	s2,32(sp)
 150:	lw	s3,36(sp)
 154:	lw	s4,40(sp)
 158:	lw	s5,44(sp)
 15c:	lw	s6,48(sp)
 160:	lw	s7,52(sp)
 164:	lw	s8,56(sp)
 168:	jr	ra
 16c:	addiu	sp,sp,64
