
target.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <inrange>:
   0:	slt	v0,a0,a1
   4:	xori	v0,v0,0x1
   8:	beqz	v0,18 <inrange+0x18>
   c:	nop
  10:	slt	v0,a2,a0
  14:	xori	v0,v0,0x1
  18:	jr	ra
  1c:	nop
