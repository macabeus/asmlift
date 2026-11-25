
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <sw_gotocase_inner>:
   0:	addiu	sp,sp,-40
   4:	sw	s3,32(sp)
   8:	sw	s0,20(sp)
   c:	slt	at,a1,a0
  10:	move	s3,a1
  14:	sw	ra,36(sp)
  18:	sw	s2,28(sp)
  1c:	sw	s1,24(sp)
  20:	bnez	at,1a8 <sw_gotocase_inner+0x1a8>
  24:	move	s0,a0
  28:	lui	t7,0x0
  2c:	addiu	t7,t7,0
  30:	sll	t6,a0,0x3
  34:	lui	s1,0x0
  38:	addiu	s1,s1,12
  3c:	addu	s2,t6,t7
  40:	lbu	t8,5(s2)
  44:	addiu	v0,s3,1
  48:	slti	at,t8,27
  4c:	beqz	at,19c <sw_gotocase_inner+0x19c>
  50:	nop
  54:	lbu	t9,4(s2)
  58:	addiu	t0,t9,-1
  5c:	sltiu	at,t0,7
  60:	beqz	at,194 <sw_gotocase_inner+0x194>
  64:	sll	t0,t0,0x2
  68:	lui	at,0x0
  6c:	addu	at,at,t0
  70:	lw	t0,0(at)
  74:	jr	t0
  78:	nop
  7c:	lbu	t1,6(s2)
  80:	sltiu	at,t1,5
  84:	beqz	at,100 <sw_gotocase_inner+0x100>
  88:	sll	t1,t1,0x2
  8c:	lui	at,0x0
  90:	addu	at,at,t1
  94:	lw	t1,28(at)
  98:	jr	t1
  9c:	nop
  a0:	jal	0 <sw_gotocase_inner>
  a4:	li	a0,10
  a8:	b	19c <sw_gotocase_inner+0x19c>
  ac:	addiu	v0,s3,1
  b0:	lui	v0,0x0
  b4:	addiu	v0,v0,0
  b8:	lw	t2,0(v0)
  bc:	addiu	v0,v0,4
  c0:	beql	s0,t2,10c <sw_gotocase_inner+0x10c>
  c4:	lw	t3,0(s2)
  c8:	bnel	v0,s1,bc <sw_gotocase_inner+0xbc>
  cc:	lw	t2,0(v0)
  d0:	b	19c <sw_gotocase_inner+0x19c>
  d4:	addiu	v0,s3,1
  d8:	jal	0 <sw_gotocase_inner>
  dc:	li	a0,12
  e0:	b	19c <sw_gotocase_inner+0x19c>
  e4:	addiu	v0,s3,1
  e8:	jal	0 <sw_gotocase_inner>
  ec:	li	a0,13
  f0:	b	19c <sw_gotocase_inner+0x19c>
  f4:	addiu	v0,s3,1
  f8:	jal	0 <sw_gotocase_inner>
  fc:	li	a0,14
 100:	b	19c <sw_gotocase_inner+0x19c>
 104:	addiu	v0,s3,1
 108:	lw	t3,0(s2)
 10c:	slti	at,t3,21
 110:	bnez	at,120 <sw_gotocase_inner+0x120>
 114:	nop
 118:	b	19c <sw_gotocase_inner+0x19c>
 11c:	addiu	v0,s3,1
 120:	lui	s2,0x0
 124:	addiu	s2,s2,0
 128:	li	t4,1
 12c:	sw	t4,0(s2)
 130:	jal	0 <sw_gotocase_inner>
 134:	move	a0,s0
 138:	b	1a8 <sw_gotocase_inner+0x1a8>
 13c:	nop
 140:	lbu	t5,15(s2)
 144:	beqz	t5,154 <sw_gotocase_inner+0x154>
 148:	nop
 14c:	b	19c <sw_gotocase_inner+0x19c>
 150:	addiu	v0,s3,1
 154:	jal	0 <sw_gotocase_inner>
 158:	li	a0,5
 15c:	b	1a8 <sw_gotocase_inner+0x1a8>
 160:	nop
 164:	lw	t6,0(s2)
 168:	bgezl	t6,17c <sw_gotocase_inner+0x17c>
 16c:	sll	t7,s0,0x2
 170:	b	19c <sw_gotocase_inner+0x19c>
 174:	addiu	v0,s3,1
 178:	sll	t7,s0,0x2
 17c:	lui	a0,0x0
 180:	addu	a0,a0,t7
 184:	jal	0 <sw_gotocase_inner>
 188:	lw	a0,0(a0)
 18c:	b	1a8 <sw_gotocase_inner+0x1a8>
 190:	nop
 194:	b	19c <sw_gotocase_inner+0x19c>
 198:	addiu	v0,s3,1
 19c:	addiu	s0,s0,1
 1a0:	bne	v0,s0,40 <sw_gotocase_inner+0x40>
 1a4:	addiu	s2,s2,8
 1a8:	lui	s2,0x0
 1ac:	addiu	s2,s2,0
 1b0:	lw	t8,0(s2)
 1b4:	move	s0,zero
 1b8:	blez	t8,1e4 <sw_gotocase_inner+0x1e4>
 1bc:	lui	s1,0x0
 1c0:	addiu	s1,s1,0
 1c4:	jal	0 <sw_gotocase_inner>
 1c8:	lw	a0,0(s1)
 1cc:	lw	t9,0(s2)
 1d0:	addiu	s0,s0,1
 1d4:	addiu	s1,s1,4
 1d8:	slt	at,s0,t9
 1dc:	bnez	at,1c4 <sw_gotocase_inner+0x1c4>
 1e0:	nop
 1e4:	lw	ra,36(sp)
 1e8:	lw	s0,20(sp)
 1ec:	lw	s1,24(sp)
 1f0:	lw	s2,28(sp)
 1f4:	lw	s3,32(sp)
 1f8:	jr	ra
 1fc:	addiu	sp,sp,40
