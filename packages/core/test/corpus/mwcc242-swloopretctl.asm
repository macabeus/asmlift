
target.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <sw_loopret_ctl>:
   0:	stwu    r1,-32(r1)
   4:	mflr    r0
   8:	lis     r5,0
			a: R_PPC_ADDR16_HA	gE
   c:	stw     r0,36(r1)
  10:	stw     r31,28(r1)
  14:	mr      r31,r4
  18:	stw     r30,24(r1)
  1c:	mr      r30,r3
  20:	stw     r29,20(r1)
  24:	addi    r29,r5,0
			26: R_PPC_ADDR16_LO	gE
  28:	stw     r28,16(r1)
  2c:	li      r28,0
  30:	b       e4 <sw_loopret_ctl+0xe4>
  34:	lbz     r3,4(r29)
  38:	addi    r0,r3,-5
  3c:	cmplwi  r0,7
  40:	bgt-    dc <sw_loopret_ctl+0xdc>
  44:	lis     r3,0
			46: R_PPC_ADDR16_HA	@26
  48:	slwi    r0,r0,2
  4c:	addi    r3,r3,0
			4e: R_PPC_ADDR16_LO	@26
  50:	lwzx    r0,r3,r0
  54:	mtctr   r0
  58:	bctr
  5c:	lwz     r0,0(r29)
  60:	cmpw    r30,r0
  64:	bne-    74 <sw_loopret_ctl+0x74>
  68:	mr      r3,r30
  6c:	bl      6c <sw_loopret_ctl+0x6c>
			6c: R_PPC_REL24	k
  70:	b       f4 <sw_loopret_ctl+0xf4>
  74:	li      r0,1
  78:	stw     r0,0(0)
			78: R_PPC_EMB_SDA21	gOut
  7c:	b       dc <sw_loopret_ctl+0xdc>
  80:	lwz     r0,0(r29)
  84:	cmpw    r0,r30
  88:	ble-    dc <sw_loopret_ctl+0xdc>
  8c:	li      r0,2
  90:	stw     r0,0(0)
			90: R_PPC_EMB_SDA21	gOut
  94:	b       dc <sw_loopret_ctl+0xdc>
  98:	lwz     r0,0(r29)
  9c:	cmpw    r0,r30
  a0:	bge-    dc <sw_loopret_ctl+0xdc>
  a4:	li      r0,3
  a8:	stw     r0,0(0)
			a8: R_PPC_EMB_SDA21	gOut
  ac:	b       dc <sw_loopret_ctl+0xdc>
  b0:	li      r0,4
  b4:	stw     r0,0(0)
			b4: R_PPC_EMB_SDA21	gOut
  b8:	b       dc <sw_loopret_ctl+0xdc>
  bc:	lwz     r0,0(r29)
  c0:	cmpw    r30,r0
  c4:	beq-    dc <sw_loopret_ctl+0xdc>
  c8:	li      r0,5
  cc:	stw     r0,0(0)
			cc: R_PPC_EMB_SDA21	gOut
  d0:	b       dc <sw_loopret_ctl+0xdc>
  d4:	mr      r3,r28
  d8:	bl      d8 <sw_loopret_ctl+0xd8>
			d8: R_PPC_REL24	k
  dc:	addi    r29,r29,8
  e0:	addi    r28,r28,1
  e4:	cmpw    r28,r31
  e8:	ble+    34 <sw_loopret_ctl+0x34>
  ec:	li      r0,9
  f0:	stw     r0,0(0)
			f0: R_PPC_EMB_SDA21	gOut
  f4:	lwz     r0,36(r1)
  f8:	lwz     r31,28(r1)
  fc:	lwz     r30,24(r1)
 100:	lwz     r29,20(r1)
 104:	lwz     r28,16(r1)
 108:	mtlr    r0
 10c:	addi    r1,r1,32
 110:	blr
