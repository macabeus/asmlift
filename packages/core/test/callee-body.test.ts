// WHAT A CALLEE'S OWN BODY READS OF ITS ARGUMENTS (frontend/callee-body.ts): a lift of the callee
// in which every call nothing lays out is taken at the full argument-register count, read for its
// entry parameters. Each ISA's listing holds a callee that reads none, one that reads the first
// argument, a thunk forwarding to an undeclared callee, and one calling through a register.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { calleeBodyBounds } from '../src/frontend/callee-body';
import { liftStamped } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { TOOLCHAIN_TARGETS, type TargetDescription } from '../src/target';

const boundsOf = (asm: string, target: TargetDescription, asmData?: AsmData, prototypes: Prototypes = {}) =>
  calleeBodyBounds('f', asm, target, prototypes, (callee, table) =>
    liftStamped(callee, asm, target, table, asmData, undefined, undefined, { calleeBodyBound: () => undefined }),
  );
const read = (bound: (c: string) => number | undefined, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, bound(n) ?? 'none']));

const thumb = `
	.code	16
	.text
	.thumb_func
rnd:
	ldr	r0, .L3
	ldrb	r0, [r0]
	bx	lr
.L3:
	.word	gR
	.thumb_func
rd1:
	add	r0, r0, #1
	bx	lr
	.thumb_func
thk:
	push	{lr}
	bl	g
	pop	{r1}
	bx	r1
	.thumb_func
ind:
	push	{lr}
	bl	_call_via_r1
	pop	{r1}
	bx	r1
	.weak	wk
	.thumb_func
wk:
	bx	lr
	.thumb_func
st:
	ldr	r3, [sp]
	add	r0, r3, #0
	bx	lr
`;

describe('the argument words a callee in the same input reads at most', () => {
  test('agbcc: none, the first, every register through a forwarding thunk, and no proof otherwise', () => {
    expect(
      read(boundsOf(thumb, TOOLCHAIN_TARGETS.agbcc.description), ['rnd', 'rd1', 'thk', 'ind', 'wk', 'st']),
    ).toEqual({ rnd: 0, rd1: 1, thk: 4, ind: 'none', wk: 'none', st: 'none' });
  });
  test('a callee absent from the input, and the function being lifted, prove nothing', () => {
    const b = boundsOf(thumb, TOOLCHAIN_TARGETS.agbcc.description);
    expect(b('absent')).toBeUndefined();
    expect(b('f')).toBeUndefined();
  });
  // the thunk's own lift reads `thk(void)` while g is undeclared: its lifted signature is no bound
  test("a forwarding thunk's own lifted signature is no bound, and a declared inner callee is read as declared", () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    expect(liftStamped('thk', thumb, t, {}, undefined, undefined, undefined).blocks[0].params).toHaveLength(0);
    expect(boundsOf(thumb, t, undefined, { g: { params: 1 } })('thk')).toBe(1);
    expect(boundsOf(thumb, t, undefined, { g: { params: ['s32', 's32'] } })('thk')).toBe(2);
  });

  const mips =
    '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n' +
    '00000000 <rnd>:\n   0:\tjr\tra\n   4:\tli\tv0,7\n' +
    '00000008 <rd1>:\n   8:\tjr\tra\n   c:\taddiu\tv0,a0,1\n' +
    '00000010 <thk>:\n  10:\taddiu\tsp,sp,-24\n  14:\tsw\tra,16(sp)\n  18:\tjal\t0 <rnd>\n  1c:\tnop\n' +
    '  20:\tlw\tra,16(sp)\n  24:\tjr\tra\n  28:\taddiu\tsp,sp,24\n' +
    '0000002c <ind>:\n  2c:\taddiu\tsp,sp,-24\n  30:\tsw\tra,16(sp)\n  34:\tjalr\ta1\n  38:\tnop\n' +
    '  3c:\tlw\tra,16(sp)\n  40:\tjr\tra\n  44:\taddiu\tsp,sp,24\n';
  const jal: AsmData = {
    sections: new Map(),
    relocs: [{ section: '.text', offset: 0x18, type: 'R_MIPS_26', sym: 'g', addend: 0 }],
    symbols: new Map(),
    symbolCount: 0,
    bigEndian: true,
  };
  test.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)('%s: the same four answers on O32', (id) => {
    expect(read(boundsOf(mips, TOOLCHAIN_TARGETS[id].description, jal), ['rnd', 'rd1', 'thk', 'ind'])).toEqual({
      rnd: 0,
      rd1: 1,
      thk: 4,
      ind: 'none',
    });
  });

  const ppc =
    '00000000 <rnd>:\n   0:\tli      r3,7\n   4:\tblr\n' +
    '00000008 <rd1>:\n   8:\taddi    r3,r3,1\n   c:\tblr\n' +
    '00000010 <thk>:\n  10:\tstwu    r1,-16(r1)\n  14:\tmflr    r0\n  18:\tstw     r0,20(r1)\n' +
    '  1c:\tbl      1c <thk+0xc>\n\t\t\t1c: R_PPC_REL24\tg\n  20:\tlwz     r0,20(r1)\n  24:\tmtlr    r0\n' +
    '  28:\taddi    r1,r1,16\n  2c:\tblr\n';
  test.each(['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as const)(
    '%s: every one of r3..r10 through the thunk',
    (id) => {
      expect(read(boundsOf(ppc, TOOLCHAIN_TARGETS[id].description), ['rnd', 'rd1', 'thk'])).toEqual({
        rnd: 0,
        rd1: 1,
        thk: 8,
      });
    },
  );
});
