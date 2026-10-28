
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <jl_cont>:
   0:	addiu	sp,sp,-64
   4:	sw	s5,44(sp)
   8:	sw	s3,36(sp)
   c:	sw	s8,56(sp)
  10:	sw	s7,52(sp)
  14:	sw	s6,48(sp)
  18:	sw	s4,40(sp)
  1c:	sw	s2,32(sp)
  20:	sw	s1,28(sp)
  24:	sw	s0,24(sp)
  28:	lui	s3,0x0
  2c:	lui	s5,0x0
  30:	move	s0,a1
  34:	move	s1,a3
  38:	move	s8,a0
  3c:	sw	ra,60(sp)
  40:	sw	a2,72(sp)
  44:	addiu	s5,s5,0
  48:	addiu	s3,s3,0
  4c:	move	s2,zero
  50:	li	s4,3
  54:	li	s6,5
  58:	move	s7,a0
  5c:	lw	t6,72(sp)
  60:	addiu	t8,s7,-1
  64:	addiu	t7,s8,-37
  68:	beqz	t6,78 <jl_cont+0x78>
  6c:	sltiu	at,t8,6
  70:	b	120 <jl_cont+0x120>
  74:	sw	t7,0(s3)
  78:	beqz	at,10c <jl_cont+0x10c>
  7c:	sll	t8,t8,0x2
  80:	lui	at,0x0
  84:	addu	at,at,t8
  88:	lw	t8,0(at)
  8c:	jr	t8
  90:	nop
  94:	jal	0 <jl_cont>
  98:	li	a0,1
  9c:	b	124 <jl_cont+0x124>
  a0:	addiu	t9,s7,-37
  a4:	jal	0 <jl_cont>
  a8:	move	a0,s1
  ac:	sw	s1,0(s3)
  b0:	beq	s1,s4,1c4 <jl_cont+0x1c4>
  b4:	sw	s6,0(s5)
  b8:	jal	0 <jl_cont>
  bc:	move	a0,s2
  c0:	b	124 <jl_cont+0x124>
  c4:	addiu	t9,s7,-37
  c8:	jal	0 <jl_cont>
  cc:	move	a0,s1
  d0:	sw	s1,0(s3)
  d4:	beq	s1,s4,1c4 <jl_cont+0x1c4>
  d8:	sw	s6,0(s5)
  dc:	jal	0 <jl_cont>
  e0:	move	a0,s2
  e4:	b	124 <jl_cont+0x124>
  e8:	addiu	t9,s7,-37
  ec:	jal	0 <jl_cont>
  f0:	move	a0,s1
  f4:	b	124 <jl_cont+0x124>
  f8:	addiu	t9,s7,-37
  fc:	jal	0 <jl_cont>
 100:	li	a0,7
 104:	b	124 <jl_cont+0x124>
 108:	addiu	t9,s7,-37
 10c:	sw	s1,0(s3)
 110:	beq	s1,s4,1c4 <jl_cont+0x1c4>
 114:	sw	s6,0(s5)
 118:	jal	0 <jl_cont>
 11c:	move	a0,s2
 120:	addiu	t9,s7,-37
 124:	sltiu	at,t9,8
 128:	beqz	at,1c0 <jl_cont+0x1c0>
 12c:	sll	t9,t9,0x2
 130:	lui	at,0x0
 134:	addu	at,at,t9
 138:	lw	t9,24(at)
 13c:	jr	t9
 140:	nop
 144:	lw	t0,36(s0)
 148:	addiu	t1,t0,1
 14c:	b	1c0 <jl_cont+0x1c0>
 150:	sw	t1,36(s0)
 154:	lw	t2,40(s0)
 158:	addiu	t3,t2,2
 15c:	b	1c0 <jl_cont+0x1c0>
 160:	sw	t3,40(s0)
 164:	lw	t4,44(s0)
 168:	addiu	t5,t4,3
 16c:	b	1c0 <jl_cont+0x1c0>
 170:	sw	t5,44(s0)
 174:	lw	t6,48(s0)
 178:	addiu	t7,t6,4
 17c:	b	1c0 <jl_cont+0x1c0>
 180:	sw	t7,48(s0)
 184:	lw	t8,52(s0)
 188:	addiu	t9,t8,5
 18c:	b	1c0 <jl_cont+0x1c0>
 190:	sw	t9,52(s0)
 194:	lw	t0,56(s0)
 198:	addiu	t1,t0,6
 19c:	b	1c0 <jl_cont+0x1c0>
 1a0:	sw	t1,56(s0)
 1a4:	lw	t2,60(s0)
 1a8:	addiu	t3,t2,7
 1ac:	b	1c0 <jl_cont+0x1c0>
 1b0:	sw	t3,60(s0)
 1b4:	lw	t4,64(s0)
 1b8:	addiu	t5,t4,8
 1bc:	sw	t5,64(s0)
 1c0:	addiu	s1,s1,1
 1c4:	addiu	s2,s2,1
 1c8:	bnel	s2,s4,60 <jl_cont+0x60>
 1cc:	lw	t6,72(sp)
 1d0:	lw	ra,60(sp)
 1d4:	lw	s0,24(sp)
 1d8:	lw	s1,28(sp)
 1dc:	lw	s2,32(sp)
 1e0:	lw	s3,36(sp)
 1e4:	lw	s4,40(sp)
 1e8:	lw	s5,44(sp)
 1ec:	lw	s6,48(sp)
 1f0:	lw	s7,52(sp)
 1f4:	lw	s8,56(sp)
 1f8:	jr	ra
 1fc:	addiu	sp,sp,64
