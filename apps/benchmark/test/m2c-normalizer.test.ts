// Pin tests for the objdump→GNU-as normalizer m2c consumes. The fixtures are real targetAsm
// texts captured from benchmark rows, with the verified-good output frozen byte-exact: a
// dangling branch label here silently fails every affected m2c row. Any output change must be a
// conscious decision (and a cache-key bump — see cache.ts), never an accident.
import { describe, expect, test } from 'vitest';

import { disasmToM2c } from '../src/eval/m2c-normalizer';

// synthetic:breakloop:mwcc_242_81 — mwcc counted loop: the bdnz back-edge MUST get its .LADDR
// label, conditional branches label normally, blr stays bare.
const PPC_LOOP_IN =
  '\n/host-tmp/asmlift-ppc-ref-6IxApi/ref.o:     file format elf32-powerpc\n\n\nDisassembly of section .text:\n\n00000000 <breakloop>:\n   0:\tli      r5,0\n   4:\tmtctr   r4\n   8:\tcmpwi   r4,0\n   c:\tble     28 <breakloop+0x28>\n  10:\tlwz     r0,0(r3)\n  14:\tcmpwi   r0,0\n  18:\tblt     28 <breakloop+0x28>\n  1c:\taddi    r3,r3,4\n  20:\taddi    r5,r5,1\n  24:\tbdnz    10 <breakloop+0x10>\n  28:\tmr      r3,r5\n  2c:\tblr\n';
const PPC_LOOP_OUT =
  'glabel breakloop\n    li      r5,0\n    mtctr   r4\n    cmpwi   r4,0\n    ble      .L28\n.L10:\n    lwz     r0,0(r3)\n    cmpwi   r0,0\n    blt      .L28\n    addi    r3,r3,4\n    addi    r5,r5,1\n    bdnz     .L10\n.L28:\n    mr      r3,r5\n    blr\n';

// synthetic:call2:mwcc_242_81 — a bl whose target arrives as an R_PPC_REL24 reloc: the symbol is
// spliced onto the call, no local label is fabricated, *lr forms stay bare.
const PPC_CALL_IN =
  '\n/host-tmp/asmlift-ppc-ref-ZML1gR/ref.o:     file format elf32-powerpc\n\n\nDisassembly of section .text:\n\n00000000 <call2>:\n   0:\tstwu    r1,-16(r1)\n   4:\tmflr    r0\n   8:\tadd     r5,r3,r4\n   c:\tstw     r0,20(r1)\n  10:\tbl      10 <call2+0x10>\n\t\t\t10: R_PPC_REL24\tadd3\n  14:\tlwz     r0,20(r1)\n  18:\tmtlr    r0\n  1c:\taddi    r1,r1,16\n  20:\tblr\n';
const PPC_CALL_OUT =
  'glabel call2\n    stwu    r1,-16(r1)\n    mflr    r0\n    add     r5,r3,r4\n    stw     r0,20(r1)\n    bl       add3\n    lwz     r0,20(r1)\n    mtlr    r0\n    addi    r1,r1,16\n    blr\n';

// synthetic:arraysum:ido7.1 — MIPS register $-prefixing incl. off(base) memory operands,
// multiple branch targets, jr $ra bare, delay slots preserved in order.
const MIPS_MEM_IN =
  '\n/var/folders/q_/6tsqtbsd2ks6l381b5yc8fvh0000gn/T/asmlift-mips-ref-aETz5J/ref.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <arraysum>:\n   0:\tmove\tv1,zero\n   4:\tblez\ta1,70 <arraysum+0x70>\n   8:\tmove\tv0,zero\n   c:\tandi\tt0,a1,0x3\n  10:\tbeqz\tt0,38 <arraysum+0x38>\n  14:\tmove\ta3,t0\n  18:\tsll\tt6,zero,0x2\n  1c:\taddu\ta2,a0,t6\n  20:\tlw\tt7,0(a2)\n  24:\taddiu\tv0,v0,1\n  28:\taddiu\ta2,a2,4\n  2c:\tbne\ta3,v0,20 <arraysum+0x20>\n  30:\taddu\tv1,v1,t7\n  34:\tbeq\tv0,a1,70 <arraysum+0x70>\n  38:\tsll\tt8,v0,0x2\n  3c:\tsll\tt9,a1,0x2\n  40:\taddu\ta3,t9,a0\n  44:\taddu\ta2,a0,t8\n  48:\tlw\tt1,0(a2)\n  4c:\tlw\tt2,4(a2)\n  50:\tlw\tt3,8(a2)\n  54:\taddu\tv1,v1,t1\n  58:\tlw\tt4,12(a2)\n  5c:\taddu\tv1,v1,t2\n  60:\taddiu\ta2,a2,16\n  64:\taddu\tv1,v1,t3\n  68:\tbne\ta2,a3,48 <arraysum+0x48>\n  6c:\taddu\tv1,v1,t4\n  70:\tjr\tra\n  74:\tmove\tv0,v1\n\t...\n';
const MIPS_MEM_OUT =
  'glabel arraysum\n    move\t$v1, $zero\n    blez\t$a1, .L70\n    move\t$v0, $zero\n    andi\t$t0, $a1, 0x3\n    beqz\t$t0, .L38\n    move\t$a3, $t0\n    sll\t$t6, $zero, 0x2\n    addu\t$a2, $a0, $t6\n.L20:\n    lw\t$t7, 0($a2)\n    addiu\t$v0, $v0, 1\n    addiu\t$a2, $a2, 4\n    bne\t$a3, $v0, .L20\n    addu\t$v1, $v1, $t7\n    beq\t$v0, $a1, .L70\n.L38:\n    sll\t$t8, $v0, 0x2\n    sll\t$t9, $a1, 0x2\n    addu\t$a3, $t9, $a0\n    addu\t$a2, $a0, $t8\n.L48:\n    lw\t$t1, 0($a2)\n    lw\t$t2, 4($a2)\n    lw\t$t3, 8($a2)\n    addu\t$v1, $v1, $t1\n    lw\t$t4, 12($a2)\n    addu\t$v1, $v1, $t2\n    addiu\t$a2, $a2, 16\n    addu\t$v1, $v1, $t3\n    bne\t$a2, $a3, .L48\n    addu\t$v1, $v1, $t4\n.L70:\n    jr\t$ra\n    move\t$v0, $v1\n';

describe('m2c-normalizer (pinned)', () => {
  test('ppc counted loop: bdnz back-edge gets its label', () => {
    expect(disasmToM2c(PPC_LOOP_IN, 'ppc')).toBe(PPC_LOOP_OUT);
  });

  test('ppc call: reloc symbol spliced, no fabricated label', () => {
    expect(disasmToM2c(PPC_CALL_IN, 'ppc')).toBe(PPC_CALL_OUT);
  });

  test('mips: register prefixing, memory operands, branch labels', () => {
    expect(disasmToM2c(MIPS_MEM_IN, 'mips')).toBe(MIPS_MEM_OUT);
  });

  test('unparseable input throws (never silently feeds m2c garbage)', () => {
    expect(() => disasmToM2c('not objdump output', 'mips')).toThrow(/could not parse/);
  });
});

// ── data-section emission (dump-driven) ─────────────────────────────────────────────────────
// With the object's `objdump -s -r -t` dump, the normalizer feeds m2c the DATA the code
// references: jump tables become jtbl_-named .rodata word lists over the same .L labels, mwcc's
// anonymous @N objects get legal names + @ha/@l/@sda21 macro operands, and MIPS jals splice
// their real callees. Verified end-to-end: the pinned m2c decompiles all three fixtures
// (sw_jt → a full switch on both ISAs; i2f → `return (f32) arg0;`).
const PPC_JTBL_IN =
  '\n/host-tmp/asmlift-ppc-ref-Mu670W/ref.o:     file format elf32-powerpc\n\n\nDisassembly of section .text:\n\n00000000 <sw_jt>:\n   0:\tcmplwi  r3,7\n   4:\tbgt     60 <sw_jt+0x60>\n   8:\tlis     r4,0\n\t\t\ta: R_PPC_ADDR16_HA\t@15\n   c:\tslwi    r0,r3,2\n  10:\taddi    r3,r4,0\n\t\t\t12: R_PPC_ADDR16_LO\t@15\n  14:\tlwzx    r0,r3,r0\n  18:\tmtctr   r0\n  1c:\tbctr\n  20:\tli      r3,3\n  24:\tblr\n  28:\tli      r3,5\n  2c:\tblr\n  30:\tli      r3,7\n  34:\tblr\n  38:\tli      r3,9\n  3c:\tblr\n  40:\tli      r3,11\n  44:\tblr\n  48:\tli      r3,13\n  4c:\tblr\n  50:\tli      r3,15\n  54:\tblr\n  58:\tli      r3,17\n  5c:\tblr\n  60:\tli      r3,-1\n  64:\tblr\n';
const PPC_JTBL_DUMP =
  '\n/host-tmp/asmlift-ppc-ref-Mu670W/ref.o:     file format elf32-powerpc\n\nSYMBOL TABLE:\n00000000 l    df *ABS*\t00000000 ref.c\n00000000 l    d  .text\t00000000 .text\n00000000 l    d  .data\t00000000 .data\n00000000 l    d  .mwcats.text\t00000000 .mwcats.text\n00000000 l     O .data\t00000020 @15\n00000000 g     F .text\t00000068 sw_jt\n\n\nRELOCATION RECORDS FOR [.text]:\nOFFSET   TYPE              VALUE\n0000000a R_PPC_ADDR16_HA   @15\n00000012 R_PPC_ADDR16_LO   @15\n\n\nRELOCATION RECORDS FOR [.data]:\nOFFSET   TYPE              VALUE\n00000000 R_PPC_ADDR32      sw_jt+0x00000020\n00000004 R_PPC_ADDR32      sw_jt+0x00000028\n00000008 R_PPC_ADDR32      sw_jt+0x00000030\n0000000c R_PPC_ADDR32      sw_jt+0x00000038\n00000010 R_PPC_ADDR32      sw_jt+0x00000040\n00000014 R_PPC_ADDR32      sw_jt+0x00000048\n00000018 R_PPC_ADDR32      sw_jt+0x00000050\n0000001c R_PPC_ADDR32      sw_jt+0x00000058\n\n\nRELOCATION RECORDS FOR [.mwcats.text]:\nOFFSET   TYPE              VALUE\n00000004 R_PPC_ADDR32      sw_jt\n\n\nContents of section .text:\n 0000 28030007 4181005c 3c800000 5460103a  (...A..\\<...T`.:\n 0010 38640000 7c03002e 7c0903a6 4e800420  8d..|...|...N.. \n 0020 38600003 4e800020 38600005 4e800020  8`..N.. 8`..N.. \n 0030 38600007 4e800020 38600009 4e800020  8`..N.. 8`..N.. \n 0040 3860000b 4e800020 3860000d 4e800020  8`..N.. 8`..N.. \n 0050 3860000f 4e800020 38600011 4e800020  8`..N.. 8`..N.. \n 0060 3860ffff 4e800020                    8`..N..         \nContents of section .data:\n 0000 00000000 00000000 00000000 00000000  ................\n 0010 00000000 00000000 00000000 00000000  ................\nContents of section .mwcats.text:\n 0000 02000068 00000000                    ...h....        \nContents of section .comment:\n 0000 436f6465 57617272 696f720a 02040201  CodeWarrior.....\n 0010 01020016 2c000000 00000000 00000000  ....,...........\n 0020 00000000 00000000 00000000 00000000  ................\n 0030 00000000 00000001 00000000 00000004  ................\n 0040 00000000 00000008 00000000 00000004  ................\n 0050 00000000 00000004 00000000 00000004  ................\n 0060 00000000                             ....            \n';
const PPC_JTBL_OUT =
  'glabel sw_jt\n    cmplwi  r3,7\n    bgt      .L60\n    lis     r4,jtbl_15@ha\n    slwi    r0,r3,2\n    addi    r3,r4,jtbl_15@l\n    lwzx    r0,r3,r0\n    mtctr   r0\n    bctr\n.L20:\n    li      r3,3\n    blr\n.L28:\n    li      r3,5\n    blr\n.L30:\n    li      r3,7\n    blr\n.L38:\n    li      r3,9\n    blr\n.L40:\n    li      r3,11\n    blr\n.L48:\n    li      r3,13\n    blr\n.L50:\n    li      r3,15\n    blr\n.L58:\n    li      r3,17\n    blr\n.L60:\n    li      r3,-1\n    blr\n.rodata\nglabel jtbl_15\n.word .L20\n.word .L28\n.word .L30\n.word .L38\n.word .L40\n.word .L48\n.word .L50\n.word .L58\n';
const PPC_SDA_IN =
  '\n/host-tmp/asmlift-ppc-ref-yV09Yb/ref.o:     file format elf32-powerpc\n\n\nDisassembly of section .text:\n\n00000000 <i2f>:\n   0:\tstwu    r1,-16(r1)\n   4:\txoris   r3,r3,32768\n   8:\tlis     r0,17200\n   c:\tlfd     f1,0(0)\n\t\t\tc: R_PPC_EMB_SDA21\t@6\n  10:\tstw     r3,12(r1)\n  14:\tstw     r0,8(r1)\n  18:\tlfd     f0,8(r1)\n  1c:\tfsubs   f1,f0,f1\n  20:\taddi    r1,r1,16\n  24:\tblr\n';
const PPC_SDA_DUMP =
  '\n/host-tmp/asmlift-ppc-ref-yV09Yb/ref.o:     file format elf32-powerpc\n\nSYMBOL TABLE:\n00000000 l    df *ABS*\t00000000 ref.c\n00000000 l    d  .text\t00000000 .text\n00000000 l    d  .sdata2\t00000000 .sdata2\n00000000 l    d  .mwcats.text\t00000000 .mwcats.text\n00000000 l     O .sdata2\t00000008 @6\n00000000 g     F .text\t00000028 i2f\n\n\nRELOCATION RECORDS FOR [.text]:\nOFFSET   TYPE              VALUE\n0000000c R_PPC_EMB_SDA21   @6\n\n\nRELOCATION RECORDS FOR [.mwcats.text]:\nOFFSET   TYPE              VALUE\n00000004 R_PPC_ADDR32      i2f\n\n\nContents of section .text:\n 0000 9421fff0 6c638000 3c004330 c8200000  .!..lc..<.C0. ..\n 0010 9061000c 90010008 c8010008 ec200828  .a........... .(\n 0020 38210010 4e800020                    8!..N..         \nContents of section .sdata2:\n 0000 43300000 80000000                    C0......        \nContents of section .mwcats.text:\n 0000 02000028 00000000                    ...(....        \nContents of section .comment:\n 0000 436f6465 57617272 696f720a 02040201  CodeWarrior.....\n 0010 01020016 2c000000 00000000 00000000  ....,...........\n 0020 00000000 00000000 00000000 00000000  ................\n 0030 00000000 00000001 00000000 00000004  ................\n 0040 00000000 00000008 00000000 00000004  ................\n 0050 00000000 00000008 00000000 00000004  ................\n 0060 00000000                             ....            \n';
const PPC_SDA_OUT =
  'glabel i2f\n    stwu    r1,-16(r1)\n    xoris   r3,r3,32768\n    lis     r0,17200\n    lfd     f1,data_6@sda21(r2)\n    stw     r3,12(r1)\n    stw     r0,8(r1)\n    lfd     f0,8(r1)\n    fsubs   f1,f0,f1\n    addi    r1,r1,16\n    blr\n.rodata\nglabel data_6\n.word 0x43300000\n.word 0x80000000\n';
const MIPS_JTBL_IN =
  '\n/tmp/asmlift-mgcc-ref-KuL2Ls/ref.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <sw_jt>:\n   0:\tsltiu\tv0,a0,8\n   4:\tbeqz\tv0,60 <sw_jt+0x60>\n   8:\tsll\tv0,a0,0x2\n   c:\tlui\tat,0x0\n  10:\taddu\tat,at,v0\n  14:\tlw\tv0,0(at)\n  18:\tjr\tv0\n  1c:\tnop\n  20:\tj\t64 <sw_jt+0x64>\n  24:\tli\tv0,3\n  28:\tj\t64 <sw_jt+0x64>\n  2c:\tli\tv0,5\n  30:\tj\t64 <sw_jt+0x64>\n  34:\tli\tv0,7\n  38:\tj\t64 <sw_jt+0x64>\n  3c:\tli\tv0,9\n  40:\tj\t64 <sw_jt+0x64>\n  44:\tli\tv0,11\n  48:\tj\t64 <sw_jt+0x64>\n  4c:\tli\tv0,13\n  50:\tj\t64 <sw_jt+0x64>\n  54:\tli\tv0,15\n  58:\tj\t64 <sw_jt+0x64>\n  5c:\tli\tv0,17\n  60:\tli\tv0,-1\n  64:\tjr\tra\n  68:\tnop\n  6c:\tnop\n';
const MIPS_JTBL_DUMP =
  '\n/tmp/asmlift-mgcc-ref-KuL2Ls/ref.o:     file format elf32-tradbigmips\n\nSYMBOL TABLE:\n00000000 l    df *ABS*\t00000000 /host-tmp/asmlift-mgcc-ref-KuL2Ls/ref.c\n00000000 l     O .text\t00000000 gcc2_compiled.\n00000000 l    d  .text\t00000000 .text\n00000000 l    d  .rodata\t00000000 .rodata\n00000000 l    d  .data\t00000000 .data\n00000000 l    d  .bss\t00000000 .bss\n00000000 l    d  .reginfo\t00000000 .reginfo\n00000000 l    d  .note\t00000000 .note\n00000000 l    d  .comment\t00000000 .comment\n00000000 g     F .text\t0000006c sw_jt\n\n\nRELOCATION RECORDS FOR [.text]:\nOFFSET   TYPE              VALUE\n0000000c R_MIPS_HI16       .rodata\n00000014 R_MIPS_LO16       .rodata\n00000020 R_MIPS_26         .text\n00000028 R_MIPS_26         .text\n00000030 R_MIPS_26         .text\n00000038 R_MIPS_26         .text\n00000040 R_MIPS_26         .text\n00000048 R_MIPS_26         .text\n00000050 R_MIPS_26         .text\n00000058 R_MIPS_26         .text\n\n\nRELOCATION RECORDS FOR [.rodata]:\nOFFSET   TYPE              VALUE\n00000000 R_MIPS_32         .text\n00000004 R_MIPS_32         .text\n00000008 R_MIPS_32         .text\n0000000c R_MIPS_32         .text\n00000010 R_MIPS_32         .text\n00000014 R_MIPS_32         .text\n00000018 R_MIPS_32         .text\n0000001c R_MIPS_32         .text\n\n\nContents of section .text:\n 0000 2c820008 10400016 00041080 3c010000  ,....@......<...\n 0010 00220821 8c220000 00400008 00000000  .".!."...@......\n 0020 08000019 24020003 08000019 24020005  ....$.......$...\n 0030 08000019 24020007 08000019 24020009  ....$.......$...\n 0040 08000019 2402000b 08000019 2402000d  ....$.......$...\n 0050 08000019 2402000f 08000019 24020011  ....$.......$...\n 0060 2402ffff 03e00008 00000000 00000000  $...............\nContents of section .reginfo:\n 0000 80000016 00000000 00000000 00000000  ................\n 0010 00000000 00000000                    ........        \nContents of section .note:\n 0000 00000008 00000000 00000001 30312e30  ............01.0\n 0010 31000000                             1...            \nContents of section .rodata:\n 0000 00000020 00000028 00000030 00000038  ... ...(...0...8\n 0010 00000040 00000048 00000050 00000058  ...@...H...P...X\nContents of section .comment:\n 0000 00474343 3a202847 4e552920 322e372e  .GCC: (GNU) 2.7.\n 0010 3200                                 2.              \n';
const MIPS_JTBL_OUT =
  'glabel sw_jt\n    sltiu\t$v0, $a0, 8\n    beqz\t$v0, .L60\n    sll\t$v0, $a0, 0x2\n    lui\t$at, %hi(jtbl_rodata_0)\n    addu\t$at, $at, $v0\n    lw\t$v0, %lo(jtbl_rodata_0)($at)\n    jr\t$v0\n    nop\n.L20:\n    j\t.L64\n    li\t$v0, 3\n.L28:\n    j\t.L64\n    li\t$v0, 5\n.L30:\n    j\t.L64\n    li\t$v0, 7\n.L38:\n    j\t.L64\n    li\t$v0, 9\n.L40:\n    j\t.L64\n    li\t$v0, 11\n.L48:\n    j\t.L64\n    li\t$v0, 13\n.L50:\n    j\t.L64\n    li\t$v0, 15\n.L58:\n    j\t.L64\n    li\t$v0, 17\n.L60:\n    li\t$v0, -1\n.L64:\n    jr\t$ra\n    nop\n    nop\n.rodata\nglabel jtbl_rodata_0\n.word .L20\n.word .L28\n.word .L30\n.word .L38\n.word .L40\n.word .L48\n.word .L50\n.word .L58\n';

describe('disasm-to-m2c data-section emission (pinned)', () => {
  test('ppc jump table: @N named jtbl_, @ha/@l operands, .word .L entries', () => {
    expect(disasmToM2c(PPC_JTBL_IN, 'ppc', PPC_JTBL_DUMP)).toBe(PPC_JTBL_OUT);
    expect(PPC_JTBL_OUT).toContain('jtbl_15@ha');
    expect(PPC_JTBL_OUT).toContain('.word .L20');
  });

  test('ppc sda21 constant: named data block + @sda21(r2) operand', () => {
    expect(disasmToM2c(PPC_SDA_IN, 'ppc', PPC_SDA_DUMP)).toBe(PPC_SDA_OUT);
    expect(PPC_SDA_OUT).toContain('data_6@sda21(r2)');
    expect(PPC_SDA_OUT).toContain('.word 0x43300000');
  });

  test('mips jump table: %hi/%lo operands, REL addends read from section words', () => {
    expect(disasmToM2c(MIPS_JTBL_IN, 'mips', MIPS_JTBL_DUMP)).toBe(MIPS_JTBL_OUT);
    expect(MIPS_JTBL_OUT).toContain('%hi(jtbl_rodata_0)');
    expect(MIPS_JTBL_OUT).toContain('.word .L20');
  });

  test('the dump is optional — text-only behavior is unchanged', () => {
    expect(disasmToM2c(PPC_JTBL_IN, 'ppc')).not.toContain('.rodata');
  });
});
