// WHAT A CALLEE'S OWN BODY READS OF ITS ARGUMENTS (frontend/callee-body.ts): a lift of the callee
// in which every call nothing lays out is taken at every argument register that may still hold the
// callee's incoming value there, read for its entry parameters. Each ISA's listing holds a callee
// that reads none, one that reads the first argument, a thunk forwarding to an undeclared callee,
// and one that clears every argument register before two undeclared calls. The Thumb and MIPS ones
// add a call through a register, and the Thumb one a `.weak` callee, one reading a stack word, and
// two undeclared calls with nothing cleared before them.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { calleeBodyBounds } from '../src/frontend/callee-body';
import { liftStamped } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { TOOLCHAIN_TARGETS, type TargetDescription } from '../src/target';

const boundsOf = (asm: string, target: TargetDescription, asmData?: AsmData, prototypes: Prototypes = {}) =>
  calleeBodyBounds('f', asm, target, prototypes, (callee, table, entryReadCalls) =>
    liftStamped(callee, asm, target, table, asmData, undefined, undefined, {
      calleeBodyBound: () => undefined,
      entryReadCalls,
    }),
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
	.thumb_func
two:
	push	{lr}
	mov	r0, #0
	mov	r1, #0
	mov	r2, #0
	mov	r3, #0
	bl	g
	bl	h
	pop	{r0}
	bx	r0
	.thumb_func
late:
	push	{lr}
	bl	g
	bl	h
	pop	{r0}
	bx	r0
`;

describe('the argument words a callee in the same input reads at most', () => {
  test('agbcc: none, the first, every register through a forwarding thunk, and no proof otherwise', () => {
    expect(
      read(boundsOf(thumb, TOOLCHAIN_TARGETS.agbcc.description), ['rnd', 'rd1', 'thk', 'ind', 'wk', 'st']),
    ).toEqual({ rnd: 0, rd1: 1, thk: 4, ind: 'none', wk: 'none', st: 'none' });
  });
  // A call the first one destroyed every argument register before holds none of the callee's
  // arguments: taken at all four, h would read registers g destroyed, and the lift of `two` refuse
  test('a second undeclared call reads no argument the first destroyed', () => {
    expect(read(boundsOf(thumb, TOOLCHAIN_TARGETS.agbcc.description), ['two', 'late'])).toEqual({ two: 0, late: 4 });
  });
  // The callee's own lift must be one: what lifts wrong bounds wrong in every caller
  test.each([
    // a tail jump to g through lr, every argument register live: `bx lr` after `mov lr, r4`
    ['poplr', '\tpush\t{r4, lr}\n\tldr\tr4, .Lg\n\tmov\tlr, r4\n\tpop\t{r4}\n\tbx\tlr\n.Lg:\n\t.word\tg\n'],
    // returns a1: the pop copies r1's word into r0
    ['cp', '\tpush\t{r1}\n\tpop\t{r0}\n\tbx\tlr\n'],
  ])(
    'agbcc: %s, which lifts as reading r0 alone where its pop or its lr is read by name, proves nothing',
    (n, body) => {
      expect(
        boundsOf(`\t.code\t16\n\t.text\n\t.thumb_func\n${n}:\n${body}`, TOOLCHAIN_TARGETS.agbcc.description)(n),
      ).toBe(undefined);
    },
  );
  // GNU as reads `.weak` with a list of names and a comment after them
  test.each(['\t.weak\tother, cb', '\t.weak\tcb @ the default', '\t.weak cb,other'])(
    'a weak callee (%s) proves nothing',
    (weak) => {
      const asm = `\t.code\t16\n\t.text\n${weak}\n\t.thumb_func\ncb:\n\tmov\tr0, #0\n\tbx\tlr\n`;
      expect(boundsOf(asm, TOOLCHAIN_TARGETS.agbcc.description)('cb')).toBeUndefined();
      expect(boundsOf(asm.replace(weak, '\t.weak\tother'), TOOLCHAIN_TARGETS.agbcc.description)('cb')).toBe(0);
    },
  );
  // `struct Big mk(x)` takes the hidden destination in r0 and x in r1, and its lift reads the
  // destination as no entry parameter: one parameter for two argument words
  test('a callee declared to return a struct proves nothing', () => {
    const mk =
      '\t.code\t16\n\t.text\n\t.thumb_func\nmk:\n\tstr\tr1, [r0]\n\tmov\tr1, #0x0\n\tstr\tr1, [r0, #0x4]\n' +
      '\tstr\tr1, [r0, #0x8]\n\tbx\tlr\n';
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    expect(boundsOf(mk, t)('mk')).toBe(2);
    const members = ['a', 'b', 'c'].map((name) => ({ name, type: 's32' }));
    const big: Prototypes = { mk: { returns: 'struct Big', returnLayout: { kind: 'struct', members } } };
    expect(boundsOf(mk, t, undefined, big)('mk')).toBeUndefined();
  });
  test('a callee absent from the input, and the function being lifted, prove nothing', () => {
    const b = boundsOf(thumb, TOOLCHAIN_TARGETS.agbcc.description);
    expect(b('absent')).toBeUndefined();
    expect(b('f')).toBeUndefined();
  });
  // the thunk's own lift reads `thk(void)` while g is undeclared: its lifted signature is no bound
  // the Thumb frontend lifts a text with no label of the name asked whole, as one function: a callee
  // the input does not define must not be read off that lift
  test('a callee with no label in the input proves nothing, though a lift of its name succeeds', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const one = '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tbl\tg\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(liftStamped('g', one, t, {}, undefined, undefined, undefined).blocks.length).toBeGreaterThan(0);
    expect(boundsOf(one, t)('g')).toBeUndefined();
  });
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
    '  3c:\tlw\tra,16(sp)\n  40:\tjr\tra\n  44:\taddiu\tsp,sp,24\n' +
    '00000048 <two>:\n  48:\taddiu\tsp,sp,-24\n  4c:\tsw\tra,16(sp)\n  50:\tli\ta0,0\n  54:\tli\ta1,0\n' +
    '  58:\tli\ta2,0\n  5c:\tjal\t0 <rnd>\n  60:\tli\ta3,0\n  64:\tjal\t0 <rnd>\n  68:\tnop\n' +
    '  6c:\tlw\tra,16(sp)\n  70:\tjr\tra\n  74:\taddiu\tsp,sp,24\n';
  const jal: AsmData = {
    sections: new Map(),
    relocs: [
      { section: '.text', offset: 0x18, type: 'R_MIPS_26', sym: 'g', addend: 0 },
      { section: '.text', offset: 0x5c, type: 'R_MIPS_26', sym: 'g', addend: 0 },
      { section: '.text', offset: 0x64, type: 'R_MIPS_26', sym: 'h', addend: 0 },
    ],
    symbols: new Map(),
    symbolCount: 0,
    bigEndian: true,
  };
  test.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)('%s: the same five answers on O32', (id) => {
    expect(read(boundsOf(mips, TOOLCHAIN_TARGETS[id].description, jal), ['rnd', 'rd1', 'thk', 'ind', 'two'])).toEqual({
      rnd: 0,
      rd1: 1,
      thk: 4,
      ind: 'none',
      two: 0,
    });
  });

  // `int hdx(double d, int x) { return x + (int)d; }` at gcc2.7.2 -O1: d arrives in $f12, which
  // shadows a0 and a1, and x in a2. Two entry parameters, read from argument index 2: a count of
  // parameters is no count of argument words, so there is no bound
  test.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)('%s: a floating-point parameter proves nothing', (id) => {
    const hdx =
      '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n' +
      '00000000 <hdx>:\n   0:\ttrunc.w.d\t$f0,$f12\n   4:\tmfc1\tv0,$f0\n   8:\tnop\n   c:\tjr\tra\n' +
      '  10:\taddu\tv0,a2,v0\n';
    const t = TOOLCHAIN_TARGETS[id].description;
    expect(liftStamped('hdx', hdx, t, {}, undefined, undefined, undefined).blocks[0].params).toHaveLength(2);
    expect(boundsOf(hdx, t)('hdx')).toBeUndefined();
  });

  const ppc =
    '00000000 <rnd>:\n   0:\tli      r3,7\n   4:\tblr\n' +
    '00000008 <rd1>:\n   8:\taddi    r3,r3,1\n   c:\tblr\n' +
    '00000010 <thk>:\n  10:\tstwu    r1,-16(r1)\n  14:\tmflr    r0\n  18:\tstw     r0,20(r1)\n' +
    '  1c:\tbl      1c <thk+0xc>\n\t\t\t1c: R_PPC_REL24\tg\n  20:\tlwz     r0,20(r1)\n  24:\tmtlr    r0\n' +
    '  28:\taddi    r1,r1,16\n  2c:\tblr\n' +
    '00000030 <two>:\n  30:\tstwu    r1,-16(r1)\n  34:\tmflr    r0\n  38:\tstw     r0,20(r1)\n' +
    [3, 4, 5, 6, 7, 8, 9, 10].map((r, k) => `  ${(0x3c + 4 * k).toString(16)}:\tli      r${r},0\n`).join('') +
    '  5c:\tbl      5c <two+0x2c>\n\t\t\t5c: R_PPC_REL24\tg\n  60:\tbl      60 <two+0x30>\n\t\t\t60: R_PPC_REL24\th\n' +
    '  64:\tlwz     r0,20(r1)\n  68:\tmtlr    r0\n  6c:\taddi    r1,r1,16\n  70:\tblr\n';
  test.each(['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as const)(
    '%s: every one of r3..r10 through the thunk',
    (id) => {
      expect(read(boundsOf(ppc, TOOLCHAIN_TARGETS[id].description), ['rnd', 'rd1', 'thk', 'two'])).toEqual({
        rnd: 0,
        rd1: 1,
        thk: 8,
        two: 0,
      });
    },
  );
});
