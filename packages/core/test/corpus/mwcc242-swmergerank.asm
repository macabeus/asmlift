
target.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <f>:
   0:	stwu    r1,-48(r1)
   4:	mflr    r0
   8:	stw     r0,52(r1)
   c:	addi    r11,r1,48
  10:	bl      10 <f+0x10>
			10: R_PPC_REL24	_savegpr_22
  14:	mr      r24,r5
  18:	mr      r22,r3
  1c:	addi    r0,r24,3
  20:	lis     r3,0
			22: R_PPC_ADDR16_HA	gA
  24:	mr      r23,r4
  28:	clrlwi  r28,r4,29
  2c:	addi    r29,r3,0
			2e: R_PPC_ADDR16_LO	gA
  30:	clrlwi  r27,r5,31
  34:	rlwinm  r30,r4,2,26,29
  38:	rlwinm  r31,r0,2,26,29
  3c:	xor     r26,r22,r24
  40:	li      r25,0
  44:	b       330 <f+0x330>
  48:	add     r0,r22,r25
  4c:	clrlwi  r0,r0,29
  50:	cmpwi   r0,46
  54:	beq     204 <f+0x204>
  58:	bge     74 <f+0x74>
  5c:	cmpwi   r0,19
  60:	beq     170 <f+0x170>
  64:	bge     314 <f+0x314>
  68:	cmpwi   r0,1
  6c:	beq     80 <f+0x80>
  70:	b       314 <f+0x314>
  74:	cmpwi   r0,64
  78:	beq     308 <f+0x308>
  7c:	b       314 <f+0x314>
  80:	li      r3,1
  84:	bl      84 <f+0x84>
			84: R_PPC_REL24	k
  88:	cmpwi   r28,37
  8c:	beq     118 <f+0x118>
  90:	bge     b8 <f+0xb8>
  94:	cmpwi   r28,19
  98:	beq     f4 <f+0xf4>
  9c:	bge     ac <f+0xac>
  a0:	cmpwi   r28,10
  a4:	beq     dc <f+0xdc>
  a8:	b       158 <f+0x158>
  ac:	cmpwi   r28,28
  b0:	beq     10c <f+0x10c>
  b4:	b       158 <f+0x158>
  b8:	cmpwi   r28,55
  bc:	beq     134 <f+0x134>
  c0:	bge     d0 <f+0xd0>
  c4:	cmpwi   r28,46
  c8:	beq     12c <f+0x12c>
  cc:	b       158 <f+0x158>
  d0:	cmpwi   r28,73
  d4:	beq     14c <f+0x14c>
  d8:	b       158 <f+0x158>
  dc:	li      r3,2
  e0:	bl      e0 <f+0xe0>
			e0: R_PPC_REL24	k
  e4:	lwz     r0,24(r29)
  e8:	cmpwi   r0,1
  ec:	bgt     324 <f+0x324>
  f0:	b       164 <f+0x164>
  f4:	li      r3,3
  f8:	bl      f8 <f+0xf8>
			f8: R_PPC_REL24	k
  fc:	lwz     r0,36(r29)
 100:	cmpwi   r0,1
 104:	bgt     324 <f+0x324>
 108:	b       164 <f+0x164>
 10c:	li      r3,4
 110:	bl      110 <f+0x110>
			110: R_PPC_REL24	k
 114:	b       324 <f+0x324>
 118:	li      r3,5
 11c:	bl      11c <f+0x11c>
			11c: R_PPC_REL24	k
 120:	lwz     r0,40(r29)
 124:	cmpwi   r0,1
 128:	bgt     324 <f+0x324>
 12c:	li      r3,6
 130:	bl      130 <f+0x130>
			130: R_PPC_REL24	k
 134:	li      r3,7
 138:	bl      138 <f+0x138>
			138: R_PPC_REL24	k
 13c:	lwz     r0,24(r29)
 140:	cmpwi   r0,1
 144:	bgt     324 <f+0x324>
 148:	b       32c <f+0x32c>
 14c:	li      r3,8
 150:	bl      150 <f+0x150>
			150: R_PPC_REL24	k
 154:	b       324 <f+0x324>
 158:	li      r3,9
 15c:	bl      15c <f+0x15c>
			15c: R_PPC_REL24	k
 160:	b       324 <f+0x324>
 164:	li      r3,10
 168:	bl      168 <f+0x168>
			168: R_PPC_REL24	k
 16c:	b       32c <f+0x32c>
 170:	li      r3,11
 174:	bl      174 <f+0x174>
			174: R_PPC_REL24	k
 178:	cmpwi   r27,0
 17c:	beq     1f8 <f+0x1f8>
 180:	lwzx    r0,r29,r30
 184:	cmpwi   r0,28
 188:	beq     1d4 <f+0x1d4>
 18c:	bge     1a8 <f+0x1a8>
 190:	cmpwi   r0,19
 194:	beq     1c4 <f+0x1c4>
 198:	bge     1ec <f+0x1ec>
 19c:	cmpwi   r0,10
 1a0:	beq     1b4 <f+0x1b4>
 1a4:	b       1ec <f+0x1ec>
 1a8:	cmpwi   r0,73
 1ac:	beq     1e0 <f+0x1e0>
 1b0:	b       1ec <f+0x1ec>
 1b4:	li      r3,12
 1b8:	bl      1b8 <f+0x1b8>
			1b8: R_PPC_REL24	k
 1bc:	lwz     r3,0(0)
			1bc: R_PPC_EMB_SDA21	gOut
 1c0:	b       340 <f+0x340>
 1c4:	li      r3,13
 1c8:	bl      1c8 <f+0x1c8>
			1c8: R_PPC_REL24	k
 1cc:	lwz     r3,0(0)
			1cc: R_PPC_EMB_SDA21	gOut
 1d0:	b       340 <f+0x340>
 1d4:	li      r3,14
 1d8:	bl      1d8 <f+0x1d8>
			1d8: R_PPC_REL24	k
 1dc:	b       32c <f+0x32c>
 1e0:	li      r3,15
 1e4:	bl      1e4 <f+0x1e4>
			1e4: R_PPC_REL24	k
 1e8:	b       204 <f+0x204>
 1ec:	li      r3,16
 1f0:	bl      1f0 <f+0x1f0>
			1f0: R_PPC_REL24	k
 1f4:	b       324 <f+0x324>
 1f8:	li      r3,18
 1fc:	bl      1fc <f+0x1fc>
			1fc: R_PPC_REL24	k
 200:	b       324 <f+0x324>
 204:	lwzx    r0,r29,r31
 208:	cmpwi   r0,4
 20c:	bgt     324 <f+0x324>
 210:	li      r3,19
 214:	bl      214 <f+0x214>
			214: R_PPC_REL24	k
 218:	cmpwi   r27,0
 21c:	beq     300 <f+0x300>
 220:	cmpwi   r23,64
 224:	beq     2d0 <f+0x2d0>
 228:	bge     244 <f+0x244>
 22c:	cmpwi   r23,37
 230:	beq     2c4 <f+0x2c4>
 234:	bge     2e8 <f+0x2e8>
 238:	cmpwi   r23,19
 23c:	beq     250 <f+0x250>
 240:	b       2e8 <f+0x2e8>
 244:	cmpwi   r23,73
 248:	beq     2dc <f+0x2dc>
 24c:	b       2e8 <f+0x2e8>
 250:	li      r3,20
 254:	bl      254 <f+0x254>
			254: R_PPC_REL24	k
 258:	cmpwi   r26,28
 25c:	beq     2a0 <f+0x2a0>
 260:	bge     27c <f+0x27c>
 264:	cmpwi   r26,10
 268:	beq     294 <f+0x294>
 26c:	bge     2b8 <f+0x2b8>
 270:	cmpwi   r26,1
 274:	beq     288 <f+0x288>
 278:	b       2b8 <f+0x2b8>
 27c:	cmpwi   r26,64
 280:	beq     2ac <f+0x2ac>
 284:	b       2b8 <f+0x2b8>
 288:	li      r3,21
 28c:	bl      28c <f+0x28c>
			28c: R_PPC_REL24	k
 290:	b       324 <f+0x324>
 294:	li      r3,22
 298:	bl      298 <f+0x298>
			298: R_PPC_REL24	k
 29c:	b       324 <f+0x324>
 2a0:	li      r3,23
 2a4:	bl      2a4 <f+0x2a4>
			2a4: R_PPC_REL24	k
 2a8:	b       324 <f+0x324>
 2ac:	li      r3,24
 2b0:	bl      2b0 <f+0x2b0>
			2b0: R_PPC_REL24	k
 2b4:	b       324 <f+0x324>
 2b8:	li      r3,25
 2bc:	bl      2bc <f+0x2bc>
			2bc: R_PPC_REL24	k
 2c0:	b       204 <f+0x204>
 2c4:	li      r3,27
 2c8:	bl      2c8 <f+0x2c8>
			2c8: R_PPC_REL24	k
 2cc:	b       2f8 <f+0x2f8>
 2d0:	li      r3,28
 2d4:	bl      2d4 <f+0x2d4>
			2d4: R_PPC_REL24	k
 2d8:	b       2f8 <f+0x2f8>
 2dc:	li      r3,29
 2e0:	bl      2e0 <f+0x2e0>
			2e0: R_PPC_REL24	k
 2e4:	b       324 <f+0x324>
 2e8:	li      r3,30
 2ec:	bl      2ec <f+0x2ec>
			2ec: R_PPC_REL24	k
 2f0:	lwz     r3,0(0)
			2f0: R_PPC_EMB_SDA21	gOut
 2f4:	b       340 <f+0x340>
 2f8:	li      r3,31
 2fc:	bl      2fc <f+0x2fc>
			2fc: R_PPC_REL24	k
 300:	li      r3,32
 304:	bl      304 <f+0x304>
			304: R_PPC_REL24	k
 308:	li      r3,33
 30c:	bl      30c <f+0x30c>
			30c: R_PPC_REL24	k
 310:	b       31c <f+0x31c>
 314:	li      r3,34
 318:	bl      318 <f+0x318>
			318: R_PPC_REL24	k
 31c:	li      r3,77
 320:	bl      320 <f+0x320>
			320: R_PPC_REL24	k
 324:	li      r3,100
 328:	bl      328 <f+0x328>
			328: R_PPC_REL24	k
 32c:	addi    r25,r25,1
 330:	cmpw    r25,r24
 334:	blt     48 <f+0x48>
 338:	lwz     r0,0(0)
			338: R_PPC_EMB_SDA21	gOut
 33c:	add     r3,r0,r25
 340:	addi    r11,r1,48
 344:	bl      344 <f+0x344>
			344: R_PPC_REL24	_restgpr_22
 348:	lwz     r0,52(r1)
 34c:	mtlr    r0
 350:	addi    r1,r1,48
 354:	blr
