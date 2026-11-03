
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <brk2sw_one>:
   0:	addiu	sp,sp,-24
   4:	sw	ra,20(sp)
   8:	sw	s0,16(sp)
   c:	move	s0,a0
  10:	sll	v0,s0,0x3
  14:	lui	at,0x0
  18:	addu	at,at,v0
  1c:	lbu	v0,4(at)
  20:	addiu	v1,v0,-1
  24:	sltiu	v0,v1,6
  28:	beqz	v0,e0 <brk2sw_one+0xe0>
  2c:	sll	v0,v1,0x2
  30:	lui	at,0x0
  34:	addu	at,at,v0
  38:	lw	v0,0(at)
  3c:	jr	v0
  40:	nop
  44:	sll	v1,s0,0x2
  48:	li	v0,1
  4c:	lui	at,0x0
  50:	addu	at,at,v1
  54:	sw	v0,0(at)
  58:	bltz	a1,9c <brk2sw_one+0x9c>
  5c:	move	a0,zero
  60:	sll	v1,a0,0x3
  64:	lui	v0,0x0
  68:	addu	v0,v0,v1
  6c:	lbu	v0,5(v0)
  70:	sltiu	v0,v0,25
  74:	beqz	v0,90 <brk2sw_one+0x90>
  78:	addiu	a0,a0,1
  7c:	lui	v0,0x0
  80:	addu	v0,v0,v1
  84:	lw	v0,0(v0)
  88:	beq	v0,s0,e0 <brk2sw_one+0xe0>
  8c:	nop
  90:	slt	v0,a1,a0
  94:	beqz	v0,64 <brk2sw_one+0x64>
  98:	sll	v1,a0,0x3
  9c:	jal	0 <brk2sw_one>
  a0:	move	a0,s0
  a4:	j	e0 <brk2sw_one+0xe0>
  a8:	nop
  ac:	jal	0 <brk2sw_one>
  b0:	li	a0,3
  b4:	j	e0 <brk2sw_one+0xe0>
  b8:	nop
  bc:	j	d8 <brk2sw_one+0xd8>
  c0:	li	v0,4
  c4:	jal	0 <brk2sw_one>
  c8:	li	a0,5
  cc:	j	e0 <brk2sw_one+0xe0>
  d0:	nop
  d4:	li	v0,6
  d8:	lui	at,0x0
  dc:	sw	v0,0(at)
  e0:	lui	at,0x0
  e4:	sw	s0,0(at)
  e8:	lw	ra,20(sp)
  ec:	lw	s0,16(sp)
  f0:	jr	ra
  f4:	addiu	sp,sp,24
	...
