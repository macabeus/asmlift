
corpus.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <swpick>:
   0:	li	v0,6
   4:	bne	a0,v0,18 <swpick+0x18>
   8:	li	v0,7
   c:	li	v0,1
  10:	j	24 <swpick+0x24>
  14:	sw	v0,0(a1)
  18:	bne	a0,v0,24 <swpick+0x24>
  1c:	li	v0,2
  20:	sw	v0,4(a1)
  24:	jr	ra
  28:	nop
  2c:	nop
