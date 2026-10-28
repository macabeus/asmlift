
/tmp/asmlift-mips-ref-cba913f14559a926/ref.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <ib>:
   0:	addiu	sp,sp,-56
   4:	sw	s7,48(sp)
   8:	sw	s6,44(sp)
   c:	sw	s0,20(sp)
  10:	move	s6,a1
  14:	move	s7,a0
  18:	sw	ra,52(sp)
  1c:	sw	s5,40(sp)
  20:	sw	s4,36(sp)
  24:	sw	s3,32(sp)
  28:	sw	s2,28(sp)
  2c:	sw	s1,24(sp)
  30:	bltz	a1,e0 <ib+0xe0>
  34:	move	s0,zero
  38:	lui	s1,0x0
  3c:	lui	s3,0x0
  40:	lui	s2,0x0
  44:	addiu	s2,s2,0
  48:	addiu	s3,s3,0
  4c:	addiu	s1,s1,0
  50:	li	s5,4
  54:	li	s4,1
  58:	lbu	t6,0(s1)
  5c:	sltiu	at,t6,6
  60:	beqz	at,cc <ib+0xcc>
  64:	sll	t6,t6,0x2
  68:	lui	at,0x0
  6c:	addu	at,at,t6
  70:	lw	t6,0(at)
  74:	jr	t6
  78:	nop
  7c:	sll	t7,s0,0x2
  80:	addu	t8,s3,t7
  84:	lw	t9,0(t8)
  88:	beql	s7,t9,ec <ib+0xec>
  8c:	slti	at,s7,3
  90:	sw	s4,0(s2)
  94:	lw	t0,0(s2)
  98:	addiu	t1,t0,2
  9c:	b	cc <ib+0xcc>
  a0:	sw	t1,0(s2)
  a4:	jal	0 <ib>
  a8:	li	a0,2
  ac:	jal	0 <ib>
  b0:	move	a0,s0
  b4:	b	d0 <ib+0xd0>
  b8:	addiu	s0,s0,1
  bc:	b	cc <ib+0xcc>
  c0:	sw	s5,0(s2)
  c4:	jal	0 <ib>
  c8:	li	a0,5
  cc:	addiu	s0,s0,1
  d0:	addiu	t2,s6,1
  d4:	bne	t2,s0,58 <ib+0x58>
  d8:	addiu	s1,s1,1
  dc:	move	s0,zero
  e0:	lui	s2,0x0
  e4:	addiu	s2,s2,0
  e8:	slti	at,s7,3
  ec:	beqz	at,104 <ib+0x104>
  f0:	slti	at,s0,7
  f4:	beqzl	at,120 <ib+0x120>
  f8:	lw	ra,52(sp)
  fc:	jal	0 <ib>
 100:	move	a0,s0
 104:	lw	t3,0(s2)
 108:	addiu	s0,s0,1
 10c:	slti	at,s0,7
 110:	addu	t4,t3,s0
 114:	bnez	at,fc <ib+0xfc>
 118:	sw	t4,0(s2)
 11c:	lw	ra,52(sp)
 120:	lw	s0,20(sp)
 124:	lw	s1,24(sp)
 128:	lw	s2,28(sp)
 12c:	lw	s3,32(sp)
 130:	lw	s4,36(sp)
 134:	lw	s5,40(sp)
 138:	lw	s6,44(sp)
 13c:	lw	s7,48(sp)
 140:	jr	ra
 144:	addiu	sp,sp,56
	...
