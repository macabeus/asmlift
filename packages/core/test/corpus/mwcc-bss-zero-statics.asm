
/host-tmp/asmlift-ppc-ref-d563b5178c8f90b1/ref.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <bsszero>:
   0:	lis     r4,0
			2: R_PPC_ADDR16_HA	a$5
   4:	cmpwi   r3,0
   8:	addi    r3,r4,0
			a: R_PPC_ADDR16_LO	a$5
   c:	lwz     r3,0(r3)
  10:	beqlr-
  14:	lis     r3,0
			16: R_PPC_ADDR16_HA	c$4
  18:	addi    r3,r3,0
			1a: R_PPC_ADDR16_LO	c$4
  1c:	lwz     r3,0(r3)
  20:	blr
