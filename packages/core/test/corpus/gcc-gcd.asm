corpus.o:     file format elf32-tradbigmips


Disassembly of section .text:

00000000 <gcd>:
   0:	beqz	a1,48 <gcd+0x48>
   4:	nop
   8:	move	v0,a1
   c:	div	zero,a0,a1
  10:	bnez	a1,1c <gcd+0x1c>
  14:	nop
  18:	break	0x7
  1c:	li	at,-1
  20:	bne	a1,at,34 <gcd+0x34>
  24:	lui	at,0x8000
  28:	bne	a0,at,34 <gcd+0x34>
  2c:	nop
  30:	break	0x6
  34:	mfhi	a1
	...
  40:	bnez	a1,8 <gcd+0x8>
  44:	move	a0,v0
  48:	jr	ra
  4c:	move	v0,a0
