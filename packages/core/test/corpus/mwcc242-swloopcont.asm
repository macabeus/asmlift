
target.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <d1>:
   0:	stwu    r1,-32(r1)
   4:	mflr    r0
   8:	stw     r0,36(r1)
   c:	addi    r11,r1,32
  10:	bl      10 <d1+0x10>
			10: R_PPC_REL24	_savegpr_27
  14:	lis     r6,0
			16: R_PPC_ADDR16_HA	gId
  18:	lis     r5,0
			1a: R_PPC_ADDR16_HA	gV
  1c:	addi    r30,r6,0
			1e: R_PPC_ADDR16_LO	gId
  20:	mr      r31,r3
  24:	addi    r29,r5,0
			26: R_PPC_ADDR16_LO	gV
  28:	mr      r27,r4
  2c:	li      r28,0
  30:	b       d0 <d1+0xd0>
  34:	lbz     r0,0(r30)
  38:	cmplwi  r0,6
  3c:	bgt-    b8 <d1+0xb8>
  40:	lis     r3,0
			42: R_PPC_ADDR16_HA	@23
  44:	slwi    r0,r0,2
  48:	addi    r3,r3,0
			4a: R_PPC_ADDR16_LO	@23
  4c:	lwzx    r0,r3,r0
  50:	mtctr   r0
  54:	bctr
  58:	lwz     r0,0(r29)
  5c:	cmpw    r31,r0
  60:	bne-    70 <d1+0x70>
  64:	mr      r3,r31
  68:	bl      68 <d1+0x68>
			68: R_PPC_REL24	k
  6c:	b       f8 <d1+0xf8>
  70:	li      r0,1
  74:	stw     r0,0(0)
			74: R_PPC_EMB_SDA21	gOut
  78:	b       b8 <d1+0xb8>
  7c:	li      r0,2
  80:	stw     r0,0(0)
			80: R_PPC_EMB_SDA21	gOut
  84:	b       b8 <d1+0xb8>
  88:	mr      r3,r28
  8c:	bl      8c <d1+0x8c>
			8c: R_PPC_REL24	k
  90:	b       b8 <d1+0xb8>
  94:	li      r0,4
  98:	stw     r0,0(0)
			98: R_PPC_EMB_SDA21	gOut
  9c:	b       b8 <d1+0xb8>
  a0:	li      r3,5
  a4:	bl      a4 <d1+0xa4>
			a4: R_PPC_REL24	k
  a8:	b       b8 <d1+0xb8>
  ac:	li      r3,6
  b0:	bl      b0 <d1+0xb0>
			b0: R_PPC_REL24	k
  b4:	b       c4 <d1+0xc4>
  b8:	lwz     r3,0(r29)
  bc:	addi    r0,r3,1
  c0:	stw     r0,0(r29)
  c4:	addi    r30,r30,1
  c8:	addi    r29,r29,4
  cc:	addi    r28,r28,1
  d0:	cmpw    r28,r27
  d4:	ble+    34 <d1+0x34>
  d8:	lwz     r0,0(0)
			d8: R_PPC_EMB_SDA21	gOut
  dc:	cmpw    r0,r31
  e0:	bne-    f0 <d1+0xf0>
  e4:	li      r3,7
  e8:	bl      e8 <d1+0xe8>
			e8: R_PPC_REL24	k
  ec:	b       f8 <d1+0xf8>
  f0:	li      r0,9
  f4:	stw     r0,0(0)
			f4: R_PPC_EMB_SDA21	gOut
  f8:	addi    r11,r1,32
  fc:	bl      fc <d1+0xfc>
			fc: R_PPC_REL24	_restgpr_27
 100:	lwz     r0,36(r1)
 104:	mtlr    r0
 108:	addi    r1,r1,32
 10c:	blr
