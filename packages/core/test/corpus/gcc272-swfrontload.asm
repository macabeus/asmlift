
corpus.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <swpick>:
   0:	li	v0,6
   4:	beq	a0,v0,1c <swpick+0x1c>
   8:	li	v0,7
   c:	beq	a0,v0,28 <swpick+0x28>
  10:	li	v0,2
  14:	j	2c <swpick+0x2c>
  18:	nop
  1c:	li	v0,1
  20:	j	2c <swpick+0x2c>
  24:	sw	v0,0(a1)
  28:	sw	v0,4(a1)
  2c:	jr	ra
  30:	nop
	...
