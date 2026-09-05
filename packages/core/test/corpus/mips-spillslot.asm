
corpus.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <spillslot>:
   0:	sw	a0,0(sp)
   4:	sw	a1,4(sp)
   8:	lw	v0,0(sp)
   c:	lw	v1,4(sp)
  10:	jr	ra
  14:	subu	v0,v0,v1
