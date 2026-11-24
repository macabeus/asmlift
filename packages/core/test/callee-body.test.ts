// WHAT A CALLEE'S OWN BODY READS OF ITS ARGUMENTS (frontend/callee-body.ts): a lift of the callee
// in which every call nothing lays out is taken at every argument register that may still hold the
// callee's incoming value there, read for its entry parameters. Each ISA's listing holds a callee
// that reads none, one that reads the first argument, a thunk forwarding to an undeclared callee,
// and one that clears every argument register before two undeclared calls. The Thumb and MIPS ones
// add a call through a register, and the Thumb one a `.weak` callee, one reading a stack word, and
// two undeclared calls with nothing cleared before them.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { type CalleeBodies, calleeBodyBounds, calleeBodyReads } from '../src/frontend/callee-body';
import { frontendFor } from '../src/frontend/registry';
import { decompile, liftStamped } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { TOOLCHAIN_TARGETS, type TargetDescription } from '../src/target';

const boundsOf = (
  asm: string,
  target: TargetDescription,
  asmData?: AsmData,
  prototypes: Prototypes = {},
  external?: CalleeBodies,
) =>
  calleeBodyBounds(
    'f',
    asm,
    target,
    prototypes,
    (callee, table, entryReadCalls, text) =>
      liftStamped(callee, text, target, table, text === asm ? asmData : undefined, undefined, undefined, {
        calleeBody: { bound: () => undefined },
        entryReadCalls,
      }),
    external,
    frontendFor(target),
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

describe('the argument words a callee in the same input reads at most', () => {
  test('agbcc: none, the first, every register through a forwarding thunk, and no proof otherwise', () => {
    expect(
      read(boundsOf(thumb, TOOLCHAIN_TARGETS.agbcc.description), ['rnd', 'rd1', 'thk', 'ind', 'wk', 'st']),
    ).toEqual({ rnd: 0, rd1: 1, thk: 4, ind: 2, wk: 'none', st: 'none' });
  });
  // agbcc's `bl _call_via_rK` with K below r4 passes at most r0..r(K-1) and no stack word (its
  // `*call_indirect` takes the address in a register no argument is live in, and it fills r0 up), so
  // the call reads every argument it can take and the body around it still bounds; through r4 or
  // past it, the call may take every argument register and stack words, and nothing bounds it
  test.each([
    // reads r0 as the call's argument and r1 as its address
    ['in2', '\tpush\t{lr}\n\tbl\t_call_via_r1\n\tpop\t{r0}\n\tbx\tr0\n', 2],
    // the address loaded, r0 set: the call reads r0 and r1 of its own, and the body none
    [
      'own',
      '\tpush\t{lr}\n\tldr\tr1, .Lp\n\tmov\tr0, #0x1f\n\tbl\t_call_via_r1\n\tpop\t{r0}\n\tbx\tr0\n.Lp:\n\t.word\tgP\n',
      0,
    ],
    // r2 passed on, r0 and r1 its own: the third argument word is the body's
    [
      'r2',
      '\tpush\t{lr}\n\tldr\tr3, .Lp\n\tmov\tr0, #0\n\tmov\tr1, #0\n\tbl\t_call_via_r3\n\tpop\t{r0}\n\tbx\tr0\n.Lp:\n\t.word\tgP\n',
      3,
    ],
    [
      'r4',
      '\tpush\t{r4, lr}\n\tldr\tr4, .Lp\n\tmov\tr0, #0\n\tbl\t_call_via_r4\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.Lp:\n\t.word\tgP\n',
      undefined,
    ],
  ])('agbcc: a body holding a call through a thunk register (%s)', (n, body, bound) => {
    expect(
      boundsOf(`\t.code\t16\n\t.text\n\t.thumb_func\n${n}:\n${body}`, TOOLCHAIN_TARGETS.agbcc.description)(n),
    ).toBe(bound);
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

// A RETURN READS THE RETURN REGISTER: where it is the first argument register (r3, r0), a return
// that no call-free path wrote it for hands back the caller's first argument, though no instruction
// reads it (mp4's `void *hwTransAddr(void *p) { return p; }` is a lone `blr`). On MIPS the return is
// v0, which no argument is in.
describe('a return the body left the return register untouched for', () => {
  const ppcRet =
    '00000000 <idf>:\n   0:\tblr\n' +
    '00000004 <vd>:\n   4:\tli      r4,7\n   8:\tblr\n' +
    '0000000c <cnd>:\n   c:\tcmpwi   r4,0\n  10:\tbnelr\n  14:\tli      r3,5\n  18:\tblr\n';
  test.each(['mwcc_242_81', 'mwcc_247_107'] as const)('%s: counts the first argument word as read', (id) => {
    const t = TOOLCHAIN_TARGETS[id].description;
    expect(read(boundsOf(ppcRet, t), ['idf', 'vd', 'cnd', 'two'])).toEqual({ idf: 1, vd: 1, cnd: 2, two: 'none' });
    // a call destroys r3 on every path to the return: that return hands back none of the arguments
    expect(read(boundsOf(ppc, t), ['two'])).toEqual({ two: 0 });
    // declared void, it returns nothing
    const declared = { idf: { returnsVoid: true }, vd: { returnsVoid: true } };
    expect(read(boundsOf(ppcRet, t, undefined, declared), ['idf', 'vd'])).toEqual({ idf: 0, vd: 0 });
  });
  test('agbcc: the same, inline and handed in', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const id =
      '\t.code\t16\n\t.text\n\t.thumb_func\nid:\n\tldr\tr1, .L3\n\tldr\tr2, [r1]\n\tadd\tr2, r2, #1\n' +
      '\tstr\tr2, [r1]\n\tbx\tlr\n.L3:\n\t.word\tgN\n';
    const caller = '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tbx\tlr\n';
    expect(boundsOf(id, t)('id')).toBe(1);
    expect(boundsOf(caller, t, undefined, {}, { id: { kind: 'listing', text: id } })('id')).toBe(1);
  });
  // agbcc's interworking return `pop {r0}; bx r0` branches through r0: it hands back the return
  // address, not the caller's first argument (kl2dct sub_08047848 loads r0 first)
  test('agbcc: a return through r0 hands back no argument', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const via =
      '\t.code\t16\n\t.text\n\t.thumb_func\nvia:\n\tpush\t{lr}\n\tldr\tr0, .L3\n\tmov\tr1, #0x1\n' +
      '\tstr\tr1, [r0]\n\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\tgN\n';
    expect(boundsOf(via, t)('via')).toBe(0);
    // …and one that reads r0 first still counts it
    expect(boundsOf(via.replace('\tldr\tr0, .L3\n', '\tadd\tr1, r0, #0\n\tldr\tr0, .L3\n'), t)('via')).toBe(1);
  });
});

// AN UNMODELLED INSTRUCTION PROVES NOTHING: its `opaque` op names registers, and which of them it reads
// is the decode's guess. PowerPC `mtmsr r3` and MIPS `mtc0 a0, …` read the argument; the decode took
// it for written, and the lift counted no parameter (mp4 PPCMtmsr, mp3 __osSetSR). A linked image's
// objdump names the CP0 register (`c0_sr`) where an object's prints `$12`: neither answers.
describe('a callee whose lift holds an opaque op', () => {
  test.each(['mwcc_242_81', 'mwcc_247_107'] as const)('%s: mtmsr gives no bound', (id) => {
    const t = TOOLCHAIN_TARGETS[id].description;
    const text = '00000000 <mtm>:\n   0:\tmtmsr   r3\n   4:\tblr\n';
    expect(boundsOf(text, t)('mtm')).toBeUndefined();
    expect(boundsOf('00000000 <f>:\n   0:\tblr\n', t, undefined, {}, { mtm: { kind: 'listing', text } })('mtm')).toBe(
      undefined,
    );
  });
  test.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)('%s: mtc0 gives no bound, in either spelling', (id) => {
    const t = TOOLCHAIN_TARGETS[id].description;
    const head = '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n';
    for (const cp0 of ['$12', 'c0_sr']) {
      const text = `${head}00000000 <setsr>:\n   0:\tmtc0\ta0,${cp0}\n   4:\tnop\n   8:\tjr\tra\n   c:\tnop\n`;
      expect(boundsOf(text, t)('setsr')).toBeUndefined();
    }
  });
});

// A BODY THE INPUT DOES NOT HOLD (`CalleeBodies`), handed in by a driver that found it elsewhere: read
// exactly as the same text placed in the input, and only where the input defines no label of the name
describe('the argument words a callee body handed in from outside the input reads at most', () => {
  const caller = '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tbx\tlr\n';
  test('agbcc: a body handed in bounds as the same body inline', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const names = ['rnd', 'rd1', 'thk', 'ind', 'wk', 'st', 'two', 'late'];
    const external = Object.fromEntries(names.map((n) => [n, { kind: 'listing' as const, text: thumb }]));
    expect(read(boundsOf(caller, t, undefined, {}, external), names)).toEqual(read(boundsOf(thumb, t), names));
    expect(read(boundsOf(caller, t), names)).toEqual(Object.fromEntries(names.map((n) => [n, 'none'])));
  });
  test('a label in the input answers before a body handed in, and a body without its label answers nothing', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const rd0 = '\t.thumb_func\nrd1:\n\tmov\tr0, #0x1\n\tbx\tlr\n';
    // the input's own rd1 reads r0; the one handed in reads none
    expect(boundsOf(thumb, t, undefined, {}, { rd1: { kind: 'listing', text: rd0 } })('rd1')).toBe(1);
    expect(boundsOf(caller, t, undefined, {}, { rd1: { kind: 'listing', text: rd0 } })('rd1')).toBe(0);
    // the Thumb frontend lifts a text with no label of the name whole: that is no body of it
    expect(boundsOf(caller, t, undefined, {}, { g: { kind: 'listing', text: rd0 } })('g')).toBeUndefined();
    // nor is a weak one, nor the function's own
    expect(boundsOf(caller, t, undefined, {}, { wk: { kind: 'listing', text: thumb } })('wk')).toBeUndefined();
    expect(boundsOf(caller, t, undefined, {}, { f: { kind: 'listing', text: rd0.replace('rd1', 'f') } })('f')).toBe(
      undefined,
    );
  });
  test.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)(
    '%s: a listing handed in is lifted with none of the input object side table',
    (id) => {
      const t = TOOLCHAIN_TARGETS[id].description;
      const names = ['rnd', 'rd1', 'thk', 'ind', 'two'];
      const head = '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n';
      const own = `${head}00000000 <f>:\n   0:\tjr\tra\n   4:\tnop\n`;
      const external = Object.fromEntries(names.map((n) => [n, { kind: 'listing' as const, text: mips }]));
      // the input's relocations name g and h in thk and two, by offsets in the input's own .text;
      // handed in, the listing's jal is named by nothing, so a callee that calls proves nothing
      expect(read(boundsOf(own, t, jal, {}, external), names)).toEqual({
        rnd: 0,
        rd1: 1,
        thk: 'none',
        ind: 'none',
        two: 'none',
      });
    },
  );
  // `extern int gp; f() { gp = 3; two(); }`: the store leaves its 3 in a0 at the `jal`, and the guess
  // passes it. `two` reads none, but makes two calls: the relocations handed in with it name them
  // (cli elf-bodies.ts reads them off a linked image's symbols), and without them it does not lift
  test.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)(
    '%s: decompile: a listing handed in with the relocations of its calls lifts under them alone',
    (id) => {
      const t = TOOLCHAIN_TARGETS[id].description;
      const head = '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n';
      const f =
        `${head}00000000 <f>:\n   0:\taddiu\tsp,sp,-24\n   4:\tsw\tra,16(sp)\n   8:\tlui\tv0,0x0\n` +
        '   c:\tli\ta0,3\n  10:\tsw\ta0,0(v0)\n  14:\tjal\t0 <f>\n  18:\tnop\n  1c:\tlw\tra,16(sp)\n' +
        '  20:\tjr\tra\n  24:\taddiu\tsp,sp,24\n';
      // the input's own relocations, whose offsets the body's listing shares and must not read
      const asmData: AsmData = {
        ...jal,
        relocs: [
          { section: '.text', offset: 8, type: 'R_MIPS_HI16', sym: 'gp', addend: 0 },
          { section: '.text', offset: 0x10, type: 'R_MIPS_LO16', sym: 'gp', addend: 0 },
          { section: '.text', offset: 0x14, type: 'R_MIPS_26', sym: 'two', addend: 0 },
          { section: '.text', offset: 0x5c, type: 'R_MIPS_26', sym: 'h', addend: 0 },
        ],
      };
      const relocs = jal.relocs.filter((r) => r.offset >= 0x48);
      const lifted = (bodies?: CalleeBodies) => decompile('f', f, t, { asmData, calleeBodies: bodies }).source;
      expect(lifted()).toContain('two(3)');
      expect(lifted({ two: { kind: 'listing', text: mips } })).toContain('two(3)');
      expect(lifted({ two: { kind: 'listing', text: mips, relocs } })).toContain('two()');
    },
  );
  test.each(['mwcc_242_81', 'mwcc_247_107'] as const)('%s: a body handed in bounds as the same body inline', (id) => {
    const t = TOOLCHAIN_TARGETS[id].description;
    const names = ['rnd', 'rd1', 'thk', 'two'];
    const own = '00000000 <f>:\n   0:\tblr\n';
    const external = Object.fromEntries(names.map((n) => [n, { kind: 'listing' as const, text: ppc }]));
    expect(read(boundsOf(own, t, undefined, {}, external), names)).toEqual(read(boundsOf(ppc, t), names));
  });
  // `gp = 3; rd0();` leaves the store's 3 in r0, which the guess passes; rd0's body, inline or handed
  // in, says it reads none
  test('decompile: a body handed in decides the call as the same body inline, and none leaves the guess', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const rd0 = '\t.thumb_func\nrd0:\n\tmov\tr0, #0x1\n\tbx\tlr\n';
    const f =
      '\t.thumb_func\nf:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n\tbl\trd0\n' +
      '\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgp\n';
    expect(decompile('f', f, t).source).toContain('rd0(3, &gp)');
    expect(decompile('f', `${rd0}${f}`, t).source).toContain('rd0()');
    expect(decompile('f', f, t, { calleeBodies: { rd0: { kind: 'listing', text: rd0 } } }).source).toBe(
      decompile('f', `${rd0}${f}`, t).source,
    );
  });
  // agbcc -O2's own output for `static void fill(u8 *p) { int i; for (i = 0; i < 4; i++) p[i] = gk + i; }
  // int f(int a) { u8 *o = AllocZeroed(16); fill(o); return o[a]; }`: AllocZeroed's result is still
  // in r0 at `bl fill`, which the trim drops as no argument (`f(); g();` and `g(f())` are the same
  // bytes). fill's body reads r0 as a parameter, so the call takes it: dropping it lifted `fill()`
  // and a buffer nothing fills
  test('decompile: an earlier call`s result the callee`s body reads is passed, one it reads none of is dropped', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const fill =
      '\t.thumb_func\nfill:\n\tpush\t{lr}\n\tadd\tr2, r0, #0\n\tldr\tr0, .L8\n\tldr\tr0, [r0]\n' +
      '\tadd\tr0, r0, #0x3\n\tadd\tr1, r2, #0x3\n.L6:\n\tstrb\tr0, [r1]\n\tsub\tr0, r0, #0x1\n' +
      '\tsub\tr1, r1, #0x1\n\tcmp\tr1, r2\n\tbge\t.L6\n\tpop\t{r0}\n\tbx\tr0\n.L8:\n\t.word\tgk\n';
    const f =
      '\t.thumb_func\nf:\n\tpush\t{r4, r5, lr}\n\tadd\tr4, r0, #0\n\tmov\tr0, #0x10\n\tbl\tAllocZeroed\n' +
      '\tadd\tr5, r0, #0\n\tbl\tfill\n\tadd\tr5, r5, r4\n\tldrb\tr0, [r5]\n\tpop\t{r4, r5}\n' +
      '\tpop\t{r1}\n\tbx\tr1\n';
    const head = '\t.code\t16\n\t.text\n';
    expect(decompile('f', head + fill + f, t).source).toContain('    fill(v0);\n');
    // …unless that result is declared void, which names nothing a call is passed
    expect(
      decompile('f', head + fill + f, t, { prototypes: { AllocZeroed: { params: 1, returnsVoid: true } } }).source,
    ).toContain('    fill();\n');
    // with no body, or one that reads no argument register, the result stays the trim's to drop
    expect(decompile('f', head + f, t).source).toContain('    fill();\n');
    const rd0 = '\t.thumb_func\nfill:\n\tmov\tr0, #0x1\n\tbx\tlr\n';
    expect(decompile('f', head + rd0 + f, t).source).toContain('    fill();\n');
    // …or one whose bound covers r0 only through an undeclared call it makes, or a return of r0
    // untouched: the bound is an upper one, and neither is a read of a parameter
    const fwd = '\t.thumb_func\nfill:\n\tpush\t{lr}\n\tbl\th\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(decompile('f', head + fwd + f, t).source).toContain('    fill();\n');
    const id = '\t.thumb_func\nfill:\n\tbx\tlr\n';
    expect(decompile('f', head + id + f, t).source).toContain('    fill();\n');
    // A CALL THROUGH A THUNK REGISTER ON AN ADDRESS THE BODY LOADS passes what is below it: agbcc
    // -O2's `static void fill(u8 *p) { gfn1(p); }` is `ldr r1, =gfn1; ldr r1, [r1]; bl _call_via_r1`,
    // where a call passing nothing loads the address into r0 (`gS.fn()` is `bl _call_via_r0`)
    const thunk =
      '\t.thumb_func\nfill:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tldr\tr1, [r1]\n\tbl\t_call_via_r1\n' +
      '\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\tgfn1\n';
    expect(decompile('f', head + thunk + f, t).source).toContain('    fill(v0);\n');
    // …while one called where it arrived may pass nothing below it: `void fill(int u, void (*fn)(void))
    // { fn(); }` is `bl _call_via_r1` on the entry r1
    const inPlace = '\t.thumb_func\nfill:\n\tpush\t{lr}\n\tbl\t_call_via_r1\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(decompile('f', head + inPlace + f, t).source).toContain('    fill();\n');
    // A READ THROUGH A JOIN THAT ALSO MERGES A VALUE THE BODY WROTE is none: agbcc -O2's
    // `void fill(void) { int x; while (gk) { gk--; x = gk; } gy = x + 1; }` keeps x in r0 and adds
    // to the entry r0 where the loop never ran, the same bytes as a reassigned parameter
    const uninit =
      '\t.thumb_func\nfill:\n\tldr\tr2, .L8\n\tldr\tr1, [r2]\n\tldr\tr3, .L8+0x4\n\tcmp\tr1, #0\n' +
      '\tbeq\t.L4\n.L5:\n\tsub\tr1, r1, #0x1\n\tadd\tr0, r1, #0\n\tcmp\tr0, #0\n\tbne\t.L5\n' +
      '\tstr\tr0, [r2]\n.L4:\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [r3]\n\tbx\tlr\n' +
      '.L8:\n\t.word\tgk\n\t.word\tgy\n';
    expect(decompile('f', head + uninit + f, t).source).toContain('    fill();\n');
  });
});

// A CALLEE'S BODY PROVES IT TAKES NO HIDDEN STRUCT-RETURN POINTER where its compiler hands the pointer
// back at every return of a struct return (`structReturnHandsBackPointer`): a return that hands back
// nothing, or a constant, is no return of one. agbcc's `pop {r0}; bx r0` holds the return address;
// compiled, `struct R mk(int *)` returns through `pop {r1}; bx r1` with r0 the pointer at -O0..-Os.
describe('a callee body that proves it is no struct return through a hidden pointer', () => {
  const noPointer = (asm: string, target: TargetDescription, asmData?: AsmData, prototypes: Prototypes = {}) =>
    calleeBodyReads(
      'f',
      asm,
      target,
      prototypes,
      (callee, table, entryReadCalls, text) =>
        liftStamped(callee, text, target, table, text === asm ? asmData : undefined, undefined, undefined, {
          calleeBody: { bound: () => undefined, stackWords: () => undefined, returnsNoHiddenPointer: () => false },
          entryReadCalls,
        }),
      undefined,
      frontendFor(target),
    ).returnsNoHiddenPointer;
  const bodies = (fns: Array<[string, string]>) =>
    `\t.code\t16\n\t.text\n${fns.map(([n, b]) => `\t.thumb_func\n${n}:\n${b}`).join('')}`;
  const thumbBodies = bodies([
    ['vd', '\tpush\t{lr}\n\tbl\th\n\tpop\t{r0}\n\tbx\tr0\n'],
    ['cst', '\tstr\tr1, [r0]\n\tmov\tr0, #0x0\n\tbx\tlr\n'],
    // a leaf hands r0 back untouched, and a value-returning epilogue keeps r0: either may be the pointer
    ['leaf', '\tstr\tr1, [r0]\n\tbx\tlr\n'],
    ['kp', '\tpush\t{lr}\n\tbl\th\n\tpop\t{r1}\n\tbx\tr1\n'],
    // a body the lift refuses (an instruction it does not model) still returns through r0
    ['unmodelled', '\tpush\t{lr}\n\tswi\t#0x5\n\tpop\t{r0}\n\tbx\tr0\n'],
    // `bx r0` after `pop {r1}` jumps to no lr: no return, so nothing is proved
    ['jump', '\tpush\t{lr}\n\tbl\th\n\tpop\t{r1}\n\tbx\tr0\n'],
  ]);
  test('agbcc: a return through r0 or of a constant proves it, a return of r0 does not', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const answer = noPointer(thumbBodies, t);
    expect(
      Object.fromEntries(['vd', 'cst', 'leaf', 'kp', 'unmodelled', 'jump', 'absent'].map((n) => [n, answer(n)])),
    ).toEqual({ vd: true, cst: true, leaf: false, kp: false, unmodelled: true, jump: false, absent: false });
  });
  // where the return register is the first argument register, a bare `ret` that did not branch
  // through it hands that register back untouched, which in a struct return is the hidden pointer
  test('a bare return proves it only where it branched through the return register', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const answer = calleeBodyReads(
      'f',
      thumbBodies,
      t,
      {},
      (callee, table, entryReadCalls, text) => {
        const fn = liftStamped(callee, text, t, table, undefined, undefined, undefined, {
          calleeBody: { bound: () => undefined, stackWords: () => undefined, returnsNoHiddenPointer: () => false },
          entryReadCalls,
        });
        fn.blocks.forEach((b) => b.ops.forEach((o) => delete o.attrs.viaReturnReg));
        return fn;
      },
      undefined,
      frontendFor(t),
    ).returnsNoHiddenPointer;
    expect([answer('vd'), answer('cst')]).toEqual([false, true]);
  });
  test('a callee declared to return a struct is not asked', () => {
    const members = ['a', 'b', 'c'].map((name) => ({ name, type: 's32' }));
    const big: Prototypes = { vd: { returns: 'struct Big', returnLayout: { kind: 'struct', members } } };
    expect(noPointer(thumbBodies, TOOLCHAIN_TARGETS.agbcc.description, undefined, big)('vd')).toBe(false);
  });
  // O32's struct return is `move v0, a0`: a return no path wrote v0 for is none
  test.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)(
    '%s: a return of nothing or of a constant proves it',
    (id) => {
      const t = TOOLCHAIN_TARGETS[id].description;
      const head = '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n';
      const text =
        `${head}00000000 <st>:\n   0:\tjr\tra\n   4:\tsw\ta1,0(a0)\n` +
        '00000008 <cst>:\n   8:\tsw\ta1,0(a0)\n   c:\tjr\tra\n  10:\tmove\tv0,zero\n' +
        '00000014 <cp>:\n  14:\tsw\ta1,0(a0)\n  18:\tjr\tra\n  1c:\tmove\tv0,a0\n';
      const answer = noPointer(text, t);
      expect([answer('st'), answer('cst'), answer('cp')]).toEqual([true, true, false]);
    },
  );
  // mwcc reloads r3 from a frame word before the `blr` of a struct return: nothing it returns proves it
  test.each(['mwcc_242_81', 'mwcc_247_107'] as const)('%s: a constant return proves nothing', (id) => {
    const t = TOOLCHAIN_TARGETS[id].description;
    expect(noPointer('00000000 <cst>:\n   0:\tstw     r4,0(r3)\n   4:\tli      r3,0\n   8:\tblr\n', t)('cst')).toBe(
      false,
    );
  });
  // agbcc's own output for `void g(u8 *d, u8 *s, int n) { while (n-- > 0) *d++ = *s++; h(); } void
  // f(u8 *src) { u8 b[16]; g(b, src, 16); }`: `b` is handed to `g` at argument 0 and never read here
  test('decompile: the frame a body proves no struct return is handed is that body`s out-parameter', () => {
    const t = TOOLCHAIN_TARGETS.agbcc.description;
    const g =
      '\t.thumb_func\ng:\n\tpush\t{lr}\n\tadd\tr3, r0, #0\n\tb\t.L7\n.L5:\n\tldrb\tr0, [r1]\n\tstrb\tr0, [r3]\n' +
      '\tadd\tr1, r1, #0x1\n\tadd\tr3, r3, #0x1\n.L7:\n\tadd\tr0, r2, #0\n\tsub\tr2, r2, #0x1\n\tcmp\tr0, #0\n' +
      '\tbgt\t.L5\n\tbl\th\n\tpop\t{r0}\n\tbx\tr0\n';
    const f =
      '\t.thumb_func\nf:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tmov\tr2, #0x10\n' +
      '\tbl\tg\n\tadd\tsp, sp, #0x10\n\tpop\t{r0}\n\tbx\tr0\n';
    const head = '\t.code\t16\n\t.text\n';
    expect(() => decompile('f', head + f, t)).toThrow(
      /`g` takes it at argument 0 and nothing says what that callee returns/,
    );
    expect(decompile('f', head + g + f, t).source).toContain('    u8 sp0[16];\n    g(sp0, a0, 16);\n');
    expect(decompile('f', head + f, t, { calleeBodies: { g: { kind: 'listing', text: head + g } } }).source).toBe(
      decompile('f', head + g + f, t).source,
    );
  });
});
