
/host-tmp/asmlift-ppc-ref-fa7a3267c5e09f03/ref.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <bssuse>:
   0:	lis     r5,0
			2: R_PPC_ADDR16_HA	a$4
   4:	lis     r4,0
			6: R_PPC_ADDR16_HA	b$5
   8:	addi    r5,r5,0
			a: R_PPC_ADDR16_LO	a$4
   c:	li      r0,1
  10:	stbx    r0,r5,r3
  14:	addi    r4,r4,0
			16: R_PPC_ADDR16_LO	b$5
  18:	li      r0,2
  1c:	stbx    r0,r4,r3
  20:	lbz     r3,0(r5)
  24:	lbz     r0,1(r4)
  28:	add     r3,r3,r0
  2c:	blr
