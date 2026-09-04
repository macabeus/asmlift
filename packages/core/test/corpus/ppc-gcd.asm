corpus.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <gcd>:
   0:	b       18 <gcd+0x18>
   4:	divw    r0,r3,r4
   8:	mr      r5,r4
   c:	mullw   r0,r0,r4
  10:	subf    r4,r0,r3
  14:	mr      r3,r5
  18:	cmpwi   r4,0
  1c:	bne     4 <gcd+0x4>
  20:	blr
