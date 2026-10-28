
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <q242>:
   0:	addiu	sp,sp,-48
   4:	sw	s2,28(sp)
   8:	sw	s5,40(sp)
   c:	sw	s4,36(sp)
  10:	sw	s3,32(sp)
  14:	lui	s2,0x0
  18:	move	s5,a0
  1c:	sw	ra,44(sp)
  20:	sw	s1,24(sp)
  24:	sw	s0,20(sp)
  28:	sw	a1,52(sp)
  2c:	li	s3,-1
  30:	addiu	s2,s2,0
  34:	li	s4,20
  38:	lw	t6,52(sp)
  3c:	addiu	s3,s3,1
  40:	sll	t7,s3,0x2
  44:	slt	at,t6,s3
  48:	bnez	at,17c <q242+0x17c>
  4c:	lui	t8,0x0
  50:	addiu	t8,t8,0
  54:	addu	s1,t7,t8
  58:	lw	s0,0(s1)
  5c:	li	at,1
  60:	beql	s0,at,3c <q242+0x3c>
  64:	lw	t6,52(sp)
  68:	lui	t9,0x0
  6c:	addu	t9,t9,s3
  70:	lbu	t9,0(t9)
  74:	sltiu	at,t9,8
  78:	beqz	at,16c <q242+0x16c>
  7c:	sll	t9,t9,0x2
  80:	lui	at,0x0
  84:	addu	at,at,t9
  88:	lw	t9,0(at)
  8c:	jr	t9
  90:	nop
  94:	sw	s4,0(s2)
  98:	jal	0 <q242>
  9c:	move	a0,s3
  a0:	b	170 <q242+0x170>
  a4:	lw	t5,0(s2)
  a8:	andi	v0,s0,0x7
  ac:	beqz	v0,d8 <q242+0xd8>
  b0:	slt	at,s0,s5
  b4:	li	at,4
  b8:	beq	v0,at,e8 <q242+0xe8>
  bc:	li	at,6
  c0:	beq	v0,at,fc <q242+0xfc>
  c4:	li	at,7
  c8:	beq	v0,at,110 <q242+0x110>
  cc:	li	t1,27
  d0:	b	118 <q242+0x118>
  d4:	lw	t2,0(s2)
  d8:	beqz	at,120 <q242+0x120>
  dc:	nop
  e0:	b	120 <q242+0x120>
  e4:	sw	s4,0(s2)
  e8:	li	at,24
  ec:	bne	s0,at,120 <q242+0x120>
  f0:	nop
  f4:	b	1a4 <q242+0x1a4>
  f8:	lw	ra,44(sp)
  fc:	slt	at,s0,s5
 100:	beqz	at,120 <q242+0x120>
 104:	li	t0,26
 108:	b	120 <q242+0x120>
 10c:	sw	t0,0(s2)
 110:	sw	t1,0(s2)
 114:	lw	t2,0(s2)
 118:	addiu	t3,t2,-1
 11c:	sw	t3,0(s2)
 120:	jal	0 <q242>
 124:	li	a0,55
 128:	b	170 <q242+0x170>
 12c:	lw	t5,0(s2)
 130:	li	at,25
 134:	bnel	s0,at,170 <q242+0x170>
 138:	lw	t5,0(s2)
 13c:	b	1a4 <q242+0x1a4>
 140:	lw	ra,44(sp)
 144:	slti	at,s0,28
 148:	bnez	at,16c <q242+0x16c>
 14c:	addiu	t4,s0,-1
 150:	sw	t4,0(s1)
 154:	jal	0 <q242>
 158:	li	a0,27
 15c:	lw	s0,0(s1)
 160:	slti	at,s0,28
 164:	beqzl	at,150 <q242+0x150>
 168:	addiu	t4,s0,-1
 16c:	lw	t5,0(s2)
 170:	addiu	t6,t5,2
 174:	b	38 <q242+0x38>
 178:	sw	t6,0(s2)
 17c:	lw	t7,0(s2)
 180:	li	t8,9
 184:	bnel	s5,t7,1a0 <q242+0x1a0>
 188:	sw	t8,0(s2)
 18c:	jal	0 <q242>
 190:	li	a0,7
 194:	b	1a4 <q242+0x1a4>
 198:	lw	ra,44(sp)
 19c:	sw	t8,0(s2)
 1a0:	lw	ra,44(sp)
 1a4:	lw	s0,20(sp)
 1a8:	lw	s1,24(sp)
 1ac:	lw	s2,28(sp)
 1b0:	lw	s3,32(sp)
 1b4:	lw	s4,36(sp)
 1b8:	lw	s5,40(sp)
 1bc:	jr	ra
 1c0:	addiu	sp,sp,48
	...
