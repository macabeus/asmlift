
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <sw_gotocase2>:
   0:	addiu	sp,sp,-40
   4:	sw	s1,28(sp)
   8:	slt	at,a1,a0
   c:	sw	ra,36(sp)
  10:	sw	s2,32(sp)
  14:	sw	s0,24(sp)
  18:	bnez	at,110 <sw_gotocase2+0x110>
  1c:	move	s1,a0
  20:	lui	t7,0x0
  24:	addiu	t7,t7,0
  28:	sll	t6,a0,0x3
  2c:	addu	v1,t6,t7
  30:	li	a2,1
  34:	lbu	t8,5(v1)
  38:	addiu	v0,a1,1
  3c:	slti	at,t8,27
  40:	beqz	at,104 <sw_gotocase2+0x104>
  44:	nop
  48:	lbu	t9,4(v1)
  4c:	addiu	t0,t9,-1
  50:	sltiu	at,t0,7
  54:	beqz	at,fc <sw_gotocase2+0xfc>
  58:	sll	t0,t0,0x2
  5c:	lui	at,0x0
  60:	addu	at,at,t0
  64:	lw	t0,0(at)
  68:	jr	t0
  6c:	nop
  70:	lbu	t1,6(v1)
  74:	bnel	a2,t1,9c <sw_gotocase2+0x9c>
  78:	lw	t3,0(v1)
  7c:	b	104 <sw_gotocase2+0x104>
  80:	addiu	v0,a1,1
  84:	lbu	t2,15(v1)
  88:	beqzl	t2,9c <sw_gotocase2+0x9c>
  8c:	lw	t3,0(v1)
  90:	b	104 <sw_gotocase2+0x104>
  94:	addiu	v0,a1,1
  98:	lw	t3,0(v1)
  9c:	slti	at,t3,21
  a0:	bnez	at,b0 <sw_gotocase2+0xb0>
  a4:	nop
  a8:	b	104 <sw_gotocase2+0x104>
  ac:	addiu	v0,a1,1
  b0:	lui	s2,0x0
  b4:	addiu	s2,s2,0
  b8:	sw	a2,0(s2)
  bc:	jal	0 <sw_gotocase2>
  c0:	move	a0,s1
  c4:	b	110 <sw_gotocase2+0x110>
  c8:	nop
  cc:	lw	t4,0(v1)
  d0:	bgezl	t4,e4 <sw_gotocase2+0xe4>
  d4:	sll	t5,s1,0x2
  d8:	b	104 <sw_gotocase2+0x104>
  dc:	addiu	v0,a1,1
  e0:	sll	t5,s1,0x2
  e4:	lui	a0,0x0
  e8:	addu	a0,a0,t5
  ec:	jal	0 <sw_gotocase2>
  f0:	lw	a0,0(a0)
  f4:	b	110 <sw_gotocase2+0x110>
  f8:	nop
  fc:	b	104 <sw_gotocase2+0x104>
 100:	addiu	v0,a1,1
 104:	addiu	s1,s1,1
 108:	bne	v0,s1,34 <sw_gotocase2+0x34>
 10c:	addiu	v1,v1,8
 110:	lui	s2,0x0
 114:	addiu	s2,s2,0
 118:	lw	t6,0(s2)
 11c:	move	s1,zero
 120:	blez	t6,14c <sw_gotocase2+0x14c>
 124:	lui	s0,0x0
 128:	addiu	s0,s0,0
 12c:	jal	0 <sw_gotocase2>
 130:	lw	a0,0(s0)
 134:	lw	t7,0(s2)
 138:	addiu	s1,s1,1
 13c:	addiu	s0,s0,4
 140:	slt	at,s1,t7
 144:	bnez	at,12c <sw_gotocase2+0x12c>
 148:	nop
 14c:	lw	ra,36(sp)
 150:	lw	s0,24(sp)
 154:	lw	s1,28(sp)
 158:	lw	s2,32(sp)
 15c:	jr	ra
 160:	addiu	sp,sp,40
	...
