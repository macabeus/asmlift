
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <sw_gotocase_inner>:
   0:	addiu	sp,sp,-40
   4:	sw	s2,32(sp)
   8:	sw	s1,28(sp)
   c:	slt	at,a1,a0
  10:	move	s1,a1
  14:	sw	ra,36(sp)
  18:	sw	s0,24(sp)
  1c:	bnez	at,174 <sw_gotocase_inner+0x174>
  20:	move	s2,a0
  24:	lui	t7,0x0
  28:	addiu	t7,t7,0
  2c:	sll	t6,a0,0x3
  30:	addu	s0,t6,t7
  34:	lbu	t8,5(s0)
  38:	addiu	v0,s1,1
  3c:	slti	at,t8,27
  40:	beqz	at,168 <sw_gotocase_inner+0x168>
  44:	nop
  48:	lbu	t9,4(s0)
  4c:	addiu	t0,t9,-1
  50:	sltiu	at,t0,7
  54:	beqz	at,160 <sw_gotocase_inner+0x160>
  58:	sll	t0,t0,0x2
  5c:	lui	at,0x0
  60:	addu	at,at,t0
  64:	lw	t0,0(at)
  68:	jr	t0
  6c:	nop
  70:	lbu	t1,6(s0)
  74:	sltiu	at,t1,5
  78:	beqz	at,cc <sw_gotocase_inner+0xcc>
  7c:	sll	t1,t1,0x2
  80:	lui	at,0x0
  84:	addu	at,at,t1
  88:	lw	t1,28(at)
  8c:	jr	t1
  90:	nop
  94:	jal	0 <sw_gotocase_inner>
  98:	li	a0,10
  9c:	b	168 <sw_gotocase_inner+0x168>
  a0:	addiu	v0,s1,1
  a4:	jal	0 <sw_gotocase_inner>
  a8:	li	a0,12
  ac:	b	168 <sw_gotocase_inner+0x168>
  b0:	addiu	v0,s1,1
  b4:	jal	0 <sw_gotocase_inner>
  b8:	li	a0,13
  bc:	b	168 <sw_gotocase_inner+0x168>
  c0:	addiu	v0,s1,1
  c4:	jal	0 <sw_gotocase_inner>
  c8:	li	a0,14
  cc:	b	168 <sw_gotocase_inner+0x168>
  d0:	addiu	v0,s1,1
  d4:	lw	t2,0(s0)
  d8:	slti	at,t2,21
  dc:	bnez	at,ec <sw_gotocase_inner+0xec>
  e0:	nop
  e4:	b	168 <sw_gotocase_inner+0x168>
  e8:	addiu	v0,s1,1
  ec:	lui	s1,0x0
  f0:	addiu	s1,s1,0
  f4:	li	t3,1
  f8:	sw	t3,0(s1)
  fc:	jal	0 <sw_gotocase_inner>
 100:	move	a0,s2
 104:	b	174 <sw_gotocase_inner+0x174>
 108:	nop
 10c:	lbu	t4,15(s0)
 110:	beqz	t4,120 <sw_gotocase_inner+0x120>
 114:	nop
 118:	b	168 <sw_gotocase_inner+0x168>
 11c:	addiu	v0,s1,1
 120:	jal	0 <sw_gotocase_inner>
 124:	li	a0,5
 128:	b	174 <sw_gotocase_inner+0x174>
 12c:	nop
 130:	lw	t5,0(s0)
 134:	bgezl	t5,148 <sw_gotocase_inner+0x148>
 138:	sll	t6,s2,0x2
 13c:	b	168 <sw_gotocase_inner+0x168>
 140:	addiu	v0,s1,1
 144:	sll	t6,s2,0x2
 148:	lui	a0,0x0
 14c:	addu	a0,a0,t6
 150:	jal	0 <sw_gotocase_inner>
 154:	lw	a0,0(a0)
 158:	b	174 <sw_gotocase_inner+0x174>
 15c:	nop
 160:	b	168 <sw_gotocase_inner+0x168>
 164:	addiu	v0,s1,1
 168:	addiu	s2,s2,1
 16c:	bne	v0,s2,34 <sw_gotocase_inner+0x34>
 170:	addiu	s0,s0,8
 174:	lui	s1,0x0
 178:	addiu	s1,s1,0
 17c:	lw	t7,0(s1)
 180:	move	s2,zero
 184:	blez	t7,1b0 <sw_gotocase_inner+0x1b0>
 188:	lui	s0,0x0
 18c:	addiu	s0,s0,0
 190:	jal	0 <sw_gotocase_inner>
 194:	lw	a0,0(s0)
 198:	lw	t8,0(s1)
 19c:	addiu	s2,s2,1
 1a0:	addiu	s0,s0,4
 1a4:	slt	at,s2,t8
 1a8:	bnez	at,190 <sw_gotocase_inner+0x190>
 1ac:	nop
 1b0:	lw	ra,36(sp)
 1b4:	lw	s0,24(sp)
 1b8:	lw	s1,28(sp)
 1bc:	lw	s2,32(sp)
 1c0:	jr	ra
 1c4:	addiu	sp,sp,40
	...
