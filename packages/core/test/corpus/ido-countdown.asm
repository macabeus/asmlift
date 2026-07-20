
corpus.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <countdown>:
   0:	beqz	a0,14 <countdown+0x14>
   4:	move	v1,zero
   8:	sra	a0,a0,0x1
   c:	bnez	a0,8 <countdown+0x8>
  10:	addiu	v1,v1,1
  14:	jr	ra
  18:	move	v0,v1
  1c:	nop
