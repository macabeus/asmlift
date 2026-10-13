
/host-tmp/asmlift-ppc-ref-d9f1fc82ad194de3/ref.o:     file format elf32-powerpc


Disassembly of section .text:

00000000 <tabesc>:
   0:	stwu    r1,-16(r1)
   4:	mflr    r0
   8:	lis     r3,0
			a: R_PPC_ADDR16_HA	tbl$4
   c:	stw     r0,20(r1)
  10:	addi    r3,r3,0
			12: R_PPC_ADDR16_LO	tbl$4
  14:	bl      14 <tabesc+0x14>
			14: R_PPC_REL24	take
  18:	lwz     r0,20(r1)
  1c:	mtlr    r0
  20:	addi    r1,r1,16
  24:	blr
