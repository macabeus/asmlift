
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <sw_loopret>:
   0:	addiu	sp,sp,-56
   4:	sw	ra,52(sp)
   8:	sw	s8,48(sp)
   c:	sw	s7,44(sp)
  10:	sw	s6,40(sp)
  14:	sw	s5,36(sp)
  18:	sw	s4,32(sp)
  1c:	sw	s3,28(sp)
  20:	sw	s2,24(sp)
  24:	sw	s1,20(sp)
  28:	sw	s0,16(sp)
  2c:	move	s1,a0
  30:	move	s2,a1
  34:	bltz	s2,154 <sw_loopret+0x154>
  38:	move	s0,zero
  3c:	lui	s8,0x0
  40:	addiu	s8,s8,0
  44:	li	s7,1
  48:	li	s6,2
  4c:	li	s5,3
  50:	li	s4,4
  54:	li	s3,5
  58:	sll	v0,s0,0x3
  5c:	lui	at,0x0
  60:	addu	at,at,v0
  64:	lbu	v0,4(at)
  68:	addiu	v1,v0,-5
  6c:	sltiu	v0,v1,8
  70:	beqz	v0,144 <sw_loopret+0x144>
  74:	sll	v0,v1,0x2
  78:	addu	v0,v0,s8
  7c:	lw	v0,0(v0)
  80:	jr	v0
  84:	nop
  88:	sll	v0,s0,0x3
  8c:	lui	at,0x0
  90:	addu	at,at,v0
  94:	lw	v0,0(at)
  98:	beq	v0,s1,174 <sw_loopret+0x174>
  9c:	addiu	s0,s0,1
  a0:	lui	at,0x0
  a4:	j	148 <sw_loopret+0x148>
  a8:	sw	s7,0(at)
  ac:	sll	v0,s0,0x3
  b0:	lui	at,0x0
  b4:	addu	at,at,v0
  b8:	lw	v0,0(at)
  bc:	slt	v0,s1,v0
  c0:	beqz	v0,148 <sw_loopret+0x148>
  c4:	addiu	s0,s0,1
  c8:	lui	at,0x0
  cc:	sw	s6,0(at)
  d0:	j	14c <sw_loopret+0x14c>
  d4:	slt	v0,s2,s0
  d8:	sll	v0,s0,0x3
  dc:	lui	at,0x0
  e0:	addu	at,at,v0
  e4:	lw	v0,0(at)
  e8:	slt	v0,v0,s1
  ec:	beqz	v0,148 <sw_loopret+0x148>
  f0:	addiu	s0,s0,1
  f4:	lui	at,0x0
  f8:	sw	s5,0(at)
  fc:	j	14c <sw_loopret+0x14c>
 100:	slt	v0,s2,s0
 104:	lui	at,0x0
 108:	sw	s4,0(at)
 10c:	j	148 <sw_loopret+0x148>
 110:	addiu	s0,s0,1
 114:	sll	v0,s0,0x3
 118:	lui	at,0x0
 11c:	addu	at,at,v0
 120:	lw	v0,0(at)
 124:	beq	v0,s1,148 <sw_loopret+0x148>
 128:	addiu	s0,s0,1
 12c:	lui	at,0x0
 130:	sw	s3,0(at)
 134:	j	14c <sw_loopret+0x14c>
 138:	slt	v0,s2,s0
 13c:	jal	0 <sw_loopret>
 140:	move	a0,s0
 144:	addiu	s0,s0,1
 148:	slt	v0,s2,s0
 14c:	beqz	v0,5c <sw_loopret+0x5c>
 150:	sll	v0,s0,0x3
 154:	lui	v0,0x0
 158:	lw	v0,0(v0)
 15c:	bne	v0,s1,184 <sw_loopret+0x184>
 160:	li	v0,9
 164:	jal	0 <sw_loopret>
 168:	li	a0,7
 16c:	j	18c <sw_loopret+0x18c>
 170:	nop
 174:	jal	0 <sw_loopret>
 178:	move	a0,s1
 17c:	j	18c <sw_loopret+0x18c>
 180:	nop
 184:	lui	at,0x0
 188:	sw	v0,0(at)
 18c:	lw	ra,52(sp)
 190:	lw	s8,48(sp)
 194:	lw	s7,44(sp)
 198:	lw	s6,40(sp)
 19c:	lw	s5,36(sp)
 1a0:	lw	s4,32(sp)
 1a4:	lw	s3,28(sp)
 1a8:	lw	s2,24(sp)
 1ac:	lw	s1,20(sp)
 1b0:	lw	s0,16(sp)
 1b4:	jr	ra
 1b8:	addiu	sp,sp,56
 1bc:	nop
