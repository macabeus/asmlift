// UNINITIALISED LOCALS ON MIPS (frontend/mips.ts): the O32 live-in model. A def-less read of a
// register O32 passes no argument in, that is scratch or the prologue saved, is an uninitialised
// local (`registerLiveIns`, MIPS_IDO/MIPS_GCC `nonArgRegs`/`scratchRegs`); so is a def-less read of
// a word of the one frame the function pushed, where nothing but the function could have written
// it (`ownedFrame`). Everything else keeps the parameter or the refusal it had. The compiled
// fixtures are the synthetic tier's rows, built at each toolchain's canonical flags.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { assertScratchRegsPartitioned, registerLiveIns } from '../src/frontend/ssa';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { MIPS_GCC, MIPS_IDO, type TargetDescription } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

/** `.text` R_MIPS_26 records naming `k`, as `objdump -r` hands them over. */
const callsTo = (sym: string, offsets: number[]): AsmData => ({
  sections: new Map(),
  relocs: offsets.map((offset) => ({ section: '.text', offset, type: 'R_MIPS_26', sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

const src = (lines: string[], target: TargetDescription, asmData?: AsmData, prototypes: Prototypes = {}) =>
  decompile('f', obj(lines), target, { ...(asmData ? { asmData } : {}), prototypes }).source;
const lift =
  (...args: Parameters<typeof src>) =>
  () =>
    src(...args);

describe('the O32 register partition', () => {
  test.each([
    ['ido', MIPS_IDO],
    ['gcc', MIPS_GCC],
  ])('is stated, disjoint from the argument registers, and its scratch half is inside it (%s)', (_c, target) => {
    expect(target.nonArgRegs).toBeDefined();
    expect(target.nonArgRegs!.filter((r) => target.argRegs.includes(r))).toEqual([]);
    expect([...assertScratchRegsPartitioned(target)].sort()).toEqual(
      ['at', 'v0', 'v1', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'].sort(),
    );
    // the scratch half is every caller-saved register no argument travels in, and nothing else
    expect(target.callerSaved.filter((r) => r !== 'ra' && !target.argRegs.includes(r)).sort()).toEqual(
      [...(target.scratchRegs ?? [])].sort(),
    );
    // a callee-saved register is a local's home only once the frontend measures its save
    expect(registerLiveIns(target, new Set()).uninitRegs).not.toContain('s0');
    expect(registerLiveIns(target, new Set(['s0'])).uninitRegs).toContain('s0');
  });

  // The function's own declaration moves the edge: an argument register at or past the words it
  // fills is one no caller fills, so it is an uninitialised local's home and no argument — with no
  // save, since every argument register is caller-saved. The two lists stay disjoint.
  test.each([
    ['ido', MIPS_IDO],
    ['gcc', MIPS_GCC],
  ])('argument registers past the own declaration move to the uninitialised side (%s)', (_c, target) => {
    const two = registerLiveIns(target, new Set(), 2);
    expect(two.argRegs).toEqual(['a0', 'a1']);
    expect(two.uninitRegs).toEqual(expect.arrayContaining(['a2', 'a3']));
    expect(two.uninitRegs!.filter((r) => two.argRegs!.includes(r))).toEqual([]);
    expect(registerLiveIns(target, new Set(), 0).argRegs).toEqual([]);
    // no declaration, or one filling every argument register, leaves the ABI's list whole
    for (const words of [undefined, 4, 6]) {
      const m = registerLiveIns(target, new Set(), words);
      expect(m.argRegs).toEqual(target.argRegs);
      expect(m.uninitRegs).toEqual(registerLiveIns(target, new Set()).uninitRegs);
    }
  });
});

// KMC and gcc 2.7.2 home a local in a2/a3 past a two-parameter declaration (`uninit_spill`,
// `uninitfirst`); only the function's own declaration tells that read from an argument
// (`ownArgumentWords`). IDO homes the same locals in frame words, so it never reaches this.
describe('an argument register past the own declaration', () => {
  const READ_A2 = ['0:\taddu\tv0,a0,a2', '4:\tjr\tra', '8:\tnop'];
  const local = 's32 f(s32 a0) {\n    s32 uninit_a2;\n    return a0 + uninit_a2;\n}\n';
  const param = 's32 f(s32 a0, s32 a1, s32 a2) {\n    return a0 + a2;\n}\n';
  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])('is an uninitialised local, and a declared one stays a parameter (%s)', (_c, target) => {
    expect(src(READ_A2, target, undefined, { f: { params: 2, returns: 's32' } })).toBe(local);
    expect(src(READ_A2, target, undefined, { f: { params: ['float', 'float'], returns: 's32' } })).toBe(local);
    expect(src(READ_A2, target)).toBe(param);
    expect(src(READ_A2, target, undefined, { f: { params: 3, returns: 's32' } })).toBe(param);
    // a list whose return is not shown to be a scalar may follow a struct's hidden pointer in a0
    expect(src(READ_A2, target, undefined, { f: { params: ['s32', 's32'] } })).toBe(param);
    expect(src(READ_A2, target, undefined, { f: { params: ['s32', 's32'], returns: 'Pt' } })).toBe(param);
    // a count is the registers the call fills (`FnProto.params`), as the call side reads it
    expect(src(READ_A2, target, undefined, { f: { params: 2 } })).toBe(local);
    // O32 passes `(s32, double)`'s double in a2:a3, skipping a1
    expect(src(READ_A2, target, undefined, { f: { params: ['s32', 'double'], returns: 's32' } })).toBe(param);
    expect(src(READ_A2, target, undefined, { f: { params: ['s32', 'Unsized'], returns: 's32' } })).toBe(param);
  });
});

describe('the register half: scratch and saved registers', () => {
  // `int uninit_join(int a){ int r; if(a>0) r=a*2; return r+1; }`, gcc2.7.2kmc -O2 (and gcc2.7.2
  // -O1, byte-identical): r lives in v0, set only in the branch-likely slot. Without the model it
  // lifts as `uninit_join(s32 a0, s32 a1)` with `return a1 | 1`.
  const UJOIN_KMC = ['0:\tbgtzl\ta0,c <f+0xc>', '4:\tsll\tv0,a0,0x1', '8:\tnop', 'c:\tjr\tra', '10:\tori\tv0,v0,0x1'];

  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])('v0 a path never assigns is a local, not a second parameter (%s)', (_c, target) => {
    expect(src(UJOIN_KMC, target)).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    if (a0 > 0) v0 = a0 << 1;\n    return v0 | 1;\n}\n',
    );
  });

  // `int k(int); int uninit_saved(int s,int a,int b,int c,int d,int e){ int x; if (s) x = k(a);
  // return k(k(k(k(b)+c)+d)+e) + x; }` at gcc2.7.2 -O1: x lives across the calls in s2, which the
  // prologue saved, and the path that skips the call reads what the caller left there. Without the
  // model that read is a SEVENTH parameter.
  const USAVED_GCC272 = [
    '0:\taddiu\tsp,sp,-40',
    '4:\tsw\tra,36(sp)',
    '8:\tsw\ts4,32(sp)',
    'c:\tsw\ts3,28(sp)',
    '10:\tsw\ts2,24(sp)',
    '14:\tsw\ts1,20(sp)',
    '18:\tsw\ts0,16(sp)',
    '1c:\tmove\ts0,a2',
    '20:\tlw\ts3,56(sp)',
    '24:\tlw\ts4,60(sp)',
    '28:\tbeqz\ta0,3c <f+0x3c>',
    '2c:\tmove\ts1,a3',
    '30:\tjal\t0 <f>',
    '34:\tmove\ta0,a1',
    '38:\tmove\ts2,v0',
    '3c:\tjal\t0 <f>',
    '40:\tmove\ta0,s0',
    '44:\tjal\t0 <f>',
    '48:\taddu\ta0,v0,s1',
    '4c:\tjal\t0 <f>',
    '50:\taddu\ta0,v0,s3',
    '54:\tjal\t0 <f>',
    '58:\taddu\ta0,v0,s4',
    '5c:\taddu\tv0,v0,s2',
    '60:\tlw\tra,36(sp)',
    '64:\tlw\ts4,32(sp)',
    '68:\tlw\ts3,28(sp)',
    '6c:\tlw\ts2,24(sp)',
    '70:\tlw\ts1,20(sp)',
    '74:\tlw\ts0,16(sp)',
    '78:\tjr\tra',
    '7c:\taddiu\tsp,sp,40',
  ];

  test('a callee-saved register the prologue saved is a local the skipped path leaves unset', () => {
    expect(src(USAVED_GCC272, MIPS_GCC, callsTo('k', [0x30, 0x3c, 0x44, 0x4c, 0x54]), { k: { params: 1 } })).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n' +
        '    s32 v0;\n' +
        '    if (a0 != 0) v0 = k(a1);\n' +
        '    return k(k(k(k(a2) + a3) + a4) + a5) + v0;\n' +
        '}\n',
    );
  });

  const SAVED_S1 = (first: string[]) => [
    '0:\taddiu\tsp,sp,-8',
    ...first,
    '0c:\tlw\ts1,4(sp)',
    '10:\tjr\tra',
    '14:\taddiu\tsp,sp,8',
  ];

  test('a saved s1 read before anything writes it is uninitialised', () => {
    expect(src(SAVED_S1(['4:\tsw\ts1,4(sp)', '8:\taddu\tv0,s1,a0']), MIPS_GCC)).toBe(
      's32 f(s32 a0) {\n    s32 uninit_s1;\n    return uninit_s1 + a0;\n}\n',
    );
  });

  // The save is the frontend's half of the rule: without it the register may be a value handed
  // over by asm that follows no ABI, so it keeps the parameter it always had.
  test('an s-register nothing saved, or that was read before its store, stays a parameter', () => {
    expect(src(['0:\tjr\tra', '4:\taddu\tv0,s1,a0'], MIPS_GCC)).toMatch(/^s32 f\(s32 a0, s32 a1\) \{/);
    expect(src(SAVED_S1(['4:\taddu\tv0,s1,a0', '8:\tsw\ts1,4(sp)']), MIPS_GCC)).toMatch(/^s32 f\(s32 a0, s32 a1\) \{/);
  });

  test('an argument register read first stays a parameter', () => {
    expect(src(['0:\tjr\tra', '4:\taddu\tv0,a1,a0'], MIPS_GCC)).toMatch(/^s32 f\(s32 a0, s32 a1\) \{/);
  });

  // Hand-written O32 asm hands values over in scratch registers (af's famicom_emu stores the t0 it
  // is handed, `sw t0,6348(s8)`), while a local the compiler homed in one is assigned on some path,
  // so its entry value meets that assignment at a join. An entry value no join takes refuses (and
  // one a join takes with no definition of its own, below).
  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])("a scratch register's entry value no join takes refuses (%s)", (_c, target) => {
    for (const r of ['at', 'v0', 'v1', 't0', 't9']) {
      expect(lift(['0:\tjr\tra', `4:\taddu\tv0,${r},a0`], target)).toThrow(
        new RegExp(`${r} is read before anything writes it, and no join meets it with a definition of its own`),
      );
    }
  });

  // Once a join takes it, a direct use is the same local read before its assignment
  // (`uninitfirst`), and the structurer spells both reads with the join's one name.
  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])("read before the assignment a join meets, it is that join's local (%s)", (_c, target) => {
    expect(
      src(
        [
          '0:\tsw\tt0,0(a1)',
          '4:\tbeqz\ta0,10 <f+0x10>',
          '8:\tnop',
          'c:\tsll\tt0,a0,0x1',
          '10:\taddu\tv0,t0,a0',
          '14:\tjr\tra',
          '18:\tnop',
        ],
        target,
      ),
    ).toBe(
      's32 f(s32 a0, s32 *a1) {\n    s32 v0;\n    *a1 = v0;\n    if (a0 != 0) v0 = a0 << 1;\n    return v0 + a0;\n}\n',
    );
  });
});

describe('what a join must meet before an entry value is a local', () => {
  // A hand-written routine handed a loop count in t0: the entry value enters the loop header's join,
  // but the back edge only carries the count's own next value, so no definition meets it there.
  const COUNT = [
    '0:\tsb\tzero,0(a0)',
    '4:\taddiu\tt0,t0,-1',
    '8:\tbnez\tt0,0 <f>',
    'c:\taddiu\ta0,a0,1',
    '10:\tjr\tra',
    '14:\tnop',
  ];
  // Two scratch entry values joined (`beqz a0; move t0,v1`): neither side is a definition.
  const TWO_INPUTS = ['0:\tbeqz\ta0,c <f+0xc>', '4:\tnop', '8:\tmove\tt0,v1', 'c:\tjr\tra', '10:\taddu\tv0,t0,a1'];
  // `int x, y; if (c) x = y; return x + c;` at gcc2.7.2kmc -O2: x in v0, y in v1, so the one join
  // takes two undefined values and no definition at all.
  const ALL_UNDEF_KMC = ['0:\tbnezl\ta0,8 <f+0x8>', '4:\tmove\tv0,v1', '8:\tjr\tra', 'c:\taddu\tv0,v0,a0'];

  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])('a loop-carried input, two joined inputs and a join no path defines all refuse (%s)', (_c, target) => {
    const REFUSE = /is read before anything writes it, and no join meets it with a definition of its own/;
    expect(lift(COUNT, target)).toThrow(REFUSE);
    expect(lift(TWO_INPUTS, target)).toThrow(REFUSE);
    expect(lift(ALL_UNDEF_KMC, target)).toThrow(REFUSE);
  });

  // `do { if (*p) r = i; i++; p++; } while (i != n); return r;`: r's entry value enters the loop
  // header's join, whose back-edge argument is the inner join — and that one meets `i`, which
  // nothing derives from r. A definition through the inner join is still a definition.
  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])('a local assigned conditionally inside a loop meets its definition through the inner join (%s)', (_c, target) => {
    expect(
      src(
        [
          '0:\tmove\tv1,zero',
          '4:\tlw\tt1,0(a0)',
          '8:\tbeqz\tt1,14 <f+0x14>',
          'c:\tnop',
          '10:\tmove\tt0,v1',
          '14:\taddiu\tv1,v1,1',
          '18:\tbne\tv1,a1,4 <f+0x4>',
          '1c:\taddiu\ta0,a0,4',
          '20:\tjr\tra',
          '24:\tmove\tv0,t0',
        ],
        target,
      ),
    ).not.toMatch(/f\(s32 \*a0, s32 a1, /);
  });

  // A bit reader (`if (bits == 0) { code = *src++; bits = 8; } … code <<= 1;`) at gcc2.7.2kmc -O2,
  // code in t0: the shift on the back edge reaches t0's entry value only through the inner join,
  // and that join also takes the load, which nothing derives from t0. So the shift is a
  // definition of its own, and the header's join meets one.
  test.each([
    ['gcc', MIPS_GCC],
    ['ido', MIPS_IDO],
  ])('a local the loop transforms after a conditional assignment meets its definition (%s)', (_c, target) => {
    expect(
      src(
        [
          '0:	blez	a2,48 <f+0x48>',
          '4:	move	v1,zero',
          '8:	bnez	v1,20 <f+0x20>',
          'c:	andi	v0,t0,0x80',
          '10:	lbu	t0,0(a0)',
          '14:	addiu	a0,a0,1',
          '18:	li	v1,8',
          '1c:	andi	v0,t0,0x80',
          '20:	beqzl	v0,34 <f+0x34>',
          '24:	sb	a3,0(a1)',
          '28:	lbu	v0,0(a0)',
          '2c:	sb	v0,0(a1)',
          '30:	addiu	a0,a0,1',
          '34:	addiu	a1,a1,1',
          '38:	sll	t0,t0,0x1',
          '3c:	addiu	a2,a2,-1',
          '40:	bgtz	a2,8 <f+0x8>',
          '44:	addiu	v1,v1,-1',
          '48:	jr	ra',
          '4c:	nop',
        ],
        target,
      ),
    ).toMatch(/\w+ = \w+ << 1;/);
  });

  // The same source at ido7.1 -O2 keeps x and y in frame words, and copies 0(sp) into 4(sp) on the
  // c path. That copy is an assignment of y to x, spelled; the path that skips it leaves x as it
  // was, which emits nothing. Neither drops the local's only assignment (which the structurer's
  // own postcondition would report as read but never assigned).
  test('a copy of one uninitialised frame word into another is an assignment', () => {
    expect(
      src(
        [
          '0:\tbeqz\ta0,10 <f+0x10>',
          '4:\taddiu\tsp,sp,-8',
          '8:\tlw\tt6,0(sp)',
          'c:\tsw\tt6,4(sp)',
          '10:\tlw\tt7,4(sp)',
          '14:\taddiu\tsp,sp,8',
          '18:\tjr\tra',
          '1c:\taddu\tv0,t7,a0',
        ],
        MIPS_IDO,
      ),
    ).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    s32 uninit_sp0;\n    if (a0 != 0) v0 = uninit_sp0;\n    return v0 + a0;\n}\n',
    );
  });

  // `int x, y; if (c) x = y; else y = x; return x - y;` at ido7.1 -O2: x and y keep their words
  // but live in v1 and a0, each loaded from 0(sp) on one arm and 4(sp) on the other. The joins are
  // register-keyed, over two frame words' undefined values, so each arm is a copy the machine ran,
  // and both arms leave the two equal: what the function returns is 0, not two unrelated values.
  test('a register caching two uninitialised frame words is assigned on each arm', () => {
    const out = src(
      [
        '0:\tbeqz\ta0,14 <f+0x14>',
        '4:\taddiu\tsp,sp,-8',
        '8:\tlw\ta0,0(sp)',
        'c:\tb\t1c <f+0x1c>',
        '10:\tmove\tv1,a0',
        '14:\tlw\tv1,4(sp)',
        '18:\tmove\ta0,v1',
        '1c:\tsubu\tv0,v1,a0',
        '20:\tjr\tra',
        '24:\taddiu\tsp,sp,8',
      ],
      MIPS_IDO,
    );
    expect(out).toMatch(
      /if \(a0 != 0\) \{\n {8}(\w+) = uninit_sp0;\n {8}(\w+) = uninit_sp0;\n {4}\} else \{\n {8}\2 = uninit_sp4;\n {8}\1 = uninit_sp4;/,
    );
    expect(out).not.toMatch(/uninit_v1|uninit_a0/);
  });

  // `return x + y + c;`: y read directly is the word the copy read, so both are one local.
  test('the word a copy reads and a direct read of it are one local', () => {
    expect(
      src(
        [
          '0:\tbeqz\ta0,10 <f+0x10>',
          '4:\taddiu\tsp,sp,-8',
          '8:\tlw\tt6,0(sp)',
          'c:\tsw\tt6,4(sp)',
          '10:\tlw\tt7,4(sp)',
          '14:\tlw\tt8,0(sp)',
          '18:\taddu\tt9,t7,t8',
          '1c:\taddiu\tsp,sp,8',
          '20:\tjr\tra',
          '24:\taddu\tv0,t9,a0',
        ],
        MIPS_IDO,
      ),
    ).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    s32 uninit_sp0;\n    if (a0 != 0) v0 = uninit_sp0;\n    return v0 + uninit_sp0 + a0;\n}\n',
    );
  });
});

// AN UNDEFINED VALUE ANOTHER LOCAL COPIED. A join's edge copy of an undefined value is dropped only
// where nothing else reads that value: there the path leaves the join's local unassigned, which is
// as undefined as the machine's word. Where the value is ALSO read elsewhere (directly, or through
// a second join), the path's local holds that same value on the machine, so the copy is spelled.
// Each of these lifted with a local left unassigned on one arm where the machine holds a value
// another read sees.
describe('an undefined value another local copied is assigned on that arm', () => {
  // `int x, z; if (c) z = x; else z = 7; return z - x;` at ido7.1 -O2: z lives in v1, loaded from
  // x's word 4(sp) on one arm, and x is read from 4(sp) again for the subtraction. c != 0 returns 0.
  test('a register caching one frame word that is also read directly (ido7.1)', () => {
    expect(
      src(
        [
          '0:\tbeqz\ta0,10 <f+0x10>',
          '4:\taddiu\tsp,sp,-8',
          '8:\tb\t14 <f+0x14>',
          'c:\tlw\tv1,4(sp)',
          '10:\tli\tv1,7',
          '14:\tlw\tt6,4(sp)',
          '18:\taddiu\tsp,sp,8',
          '1c:\tjr\tra',
          '20:\tsubu\tv0,v1,t6',
        ],
        MIPS_IDO,
      ),
    ).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    s32 uninit_sp4;\n    if (a0 != 0) {\n        v0 = uninit_sp4;\n    } else {\n' +
        '        v0 = 7;\n    }\n    return v0 - uninit_sp4;\n}\n',
    );
  });

  // The same source at gcc 2.7.2 (KMC) -O2: x lives in v1 and the arm is `move v0,v1`.
  test('a register copying another register that is also read directly (gcc 2.7.2 KMC)', () => {
    expect(
      src(['0:\tbeqz\ta0,c <f+0xc>', '4:\tli\tv0,7', '8:\tmove\tv0,v1', 'c:\tjr\tra', '10:\tsubu\tv0,v0,v1'], MIPS_GCC),
    ).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    s32 uninit_v1;\n    if (a0 != 0) {\n        v0 = uninit_v1;\n    } else {\n' +
        '        v0 = 7;\n    }\n    return v0 - uninit_v1;\n}\n',
    );
  });

  // `int x, y, z; if (c) { x = y; z = x; } else { y = x; z = 7; } if (d) y = z; return x - y;` at
  // ido7.1 -O2: z's register v0 takes x's word on the c arm, which the subtraction also reads; c != 0
  // and d != 0 return 0.
  test('a third register copying one of two cached frame words (ido7.1)', () => {
    expect(
      src(
        [
          '0:\tbeqz\ta0,18 <f+0x18>',
          '4:\taddiu\tsp,sp,-8',
          '8:\tlw\ta0,0(sp)',
          'c:\tmove\tv1,a0',
          '10:\tb\t24 <f+0x24>',
          '14:\tmove\tv0,a0',
          '18:\tlw\tv1,4(sp)',
          '1c:\tli\tv0,7',
          '20:\tmove\ta0,v1',
          '24:\tbeqzl\ta1,34 <f+0x34>',
          '28:\tsubu\tv0,v1,a0',
          '2c:\tmove\ta0,v0',
          '30:\tsubu\tv0,v1,a0',
          '34:\tjr\tra',
          '38:\taddiu\tsp,sp,8',
        ],
        MIPS_IDO,
      ),
    ).toBe(
      's32 f(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 v3;\n    s32 uninit_sp4;\n' +
        '    s32 uninit_sp0;\n    if (a0 != 0) {\n        v1 = uninit_sp0;\n        v0 = uninit_sp0;\n' +
        '        v2 = uninit_sp0;\n    } else {\n        v0 = uninit_sp4;\n        v2 = 7;\n        v1 = uninit_sp4;\n' +
        '    }\n    if (a1 != 0) {\n        v3 = v0 - v2;\n    } else {\n        v3 = v0 - v1;\n    }\n    return v3;\n}\n',
    );
  });

  // `int x, y, r; if (c) r = x; else r = y; if (d) x = 1; else y = 2; return r + x + y;` at ido7.1
  // -O2: r is x on the c arm, and x's register keeps x's word wherever d is 0.
  test('a copy whose source register keeps the word on the other arm of a later branch (ido7.1)', () => {
    expect(
      src(
        [
          '0:\taddiu\tsp,sp,-8',
          '4:\tbeqz\ta0,1c <f+0x1c>',
          '8:\tmove\ta2,a1',
          'c:\tlw\ta0,4(sp)',
          '10:\tlw\ta1,0(sp)',
          '14:\tb\t28 <f+0x28>',
          '18:\tmove\tv1,a0',
          '1c:\tlw\ta1,0(sp)',
          '20:\tlw\ta0,4(sp)',
          '24:\tmove\tv1,a1',
          '28:\tbeqzl\ta2,3c <f+0x3c>',
          '2c:\tli\ta1,2',
          '30:\tb\t3c <f+0x3c>',
          '34:\tli\ta0,1',
          '38:\tli\ta1,2',
          '3c:\taddu\tt6,v1,a0',
          '40:\taddu\tv0,t6,a1',
          '44:\tjr\tra',
          '48:\taddiu\tsp,sp,8',
        ],
        MIPS_IDO,
      ),
    ).toBe(
      's32 f(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 uninit_sp0;\n    s32 uninit_sp4;\n' +
        '    if (a0 != 0) {\n        v0 = uninit_sp4;\n    } else {\n        v0 = uninit_sp0;\n    }\n' +
        '    if (a1 != 0) {\n        v2 = uninit_sp0;\n        v1 = 1;\n    } else {\n        v1 = uninit_sp4;\n' +
        '        v2 = 2;\n    }\n    return v0 + v1 + v2;\n}\n',
    );
  });

  // The same source at gcc 2.7.2 (KMC) -O2: x lives in v1 and r in v0 (`move v0,v1` on the c arm);
  // y stays in a2, which reads as a parameter, as it did before uninitialised locals.
  test("a register's own join keeps the value another register copied (gcc 2.7.2 KMC)", () => {
    expect(
      src(
        [
          '0:\tbeqz\ta0,c <f+0xc>',
          '4:\tmove\tv0,a2',
          '8:\tmove\tv0,v1',
          'c:\tbeqzl\ta1,18 <f+0x18>',
          '10:\tli\ta2,2',
          '14:\tli\tv1,1',
          '18:\taddu\tv0,v0,v1',
          '1c:\tjr\tra',
          '20:\taddu\tv0,v0,a2',
        ],
        MIPS_GCC,
      ),
    ).toBe(
      's32 f(s32 a0, s32 a1, s32 a2) {\n    s32 v0;\n    s32 v1;\n    s32 uninit_v1;\n    if (a0 != 0) {\n' +
        '        v0 = uninit_v1;\n    } else {\n        v0 = a2;\n    }\n    if (a1 != 0) {\n        v1 = 1;\n' +
        '    } else {\n        v1 = uninit_v1;\n        a2 = 2;\n    }\n    return v0 + v1 + a2;\n}\n',
    );
  });

  // `int x, z; z = x; if (c) x = 5; return x * 2 + z;` at gcc 2.7.2 (KMC) -O2: x lives in v0, its
  // entry value is read as z (`move v1,v0`), and the join that keeps it on c == 0 is x's own.
  test("a register's own join, its entry value also read directly (gcc 2.7.2 KMC)", () => {
    expect(
      src(
        [
          '0:\tbeqz\ta0,c <f+0xc>',
          '4:\tmove\tv1,v0',
          '8:\tli\tv0,5',
          'c:\tsll\tv0,v0,0x1',
          '10:\tjr\tra',
          '14:\taddu\tv0,v0,v1',
        ],
        MIPS_GCC,
      ),
    ).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    s32 uninit_v0;\n    if (a0 != 0) {\n        v0 = 5;\n    } else {\n' +
        '        v0 = uninit_v0;\n    }\n    return (v0 << 1) + uninit_v0;\n}\n',
    );
  });
});

describe('the frame half: words of the frame the function pushed', () => {
  // `uninit_join` at ido7.1 -O2: r lives in 4(sp) of an 8-byte leaf frame, pushed in the first
  // branch's delay slot.
  test('a word stored on one path only is the local the other path leaves unset', () => {
    expect(
      src(
        [
          '0:\tblez\ta0,10 <f+0x10>',
          '4:\taddiu\tsp,sp,-8',
          '8:\tsll\tt6,a0,0x1',
          'c:\tsw\tt6,4(sp)',
          '10:\tlw\tv0,4(sp)',
          '14:\taddiu\tsp,sp,8',
          '18:\tjr\tra',
          '1c:\taddiu\tv0,v0,1',
        ],
        MIPS_IDO,
      ),
    ).toBe('s32 f(s32 a0) {\n    s32 v0;\n    if (a0 > 0) v0 = a0 << 1;\n    return v0 + 1;\n}\n');
  });

  // `uninit_spill` at ido7.1 reads 36(sp) and 0(sp), which no instruction stores: a local the
  // source never assigns on that path. In a leaf nothing else can write the frame.
  test('a word of a leaf frame no store reaches is uninitialised', () => {
    expect(src(['0:\taddiu\tsp,sp,-24', '4:\tlw\tv0,8(sp)', '8:\tjr\tra', 'c:\taddiu\tsp,sp,24'], MIPS_IDO)).toBe(
      's32 f(void) {\n    s32 uninit_sp8;\n    return uninit_sp8;\n}\n',
    );
  });

  // `uninit_saved` at ido7.1 -O2: x lives in 28(sp), above the 16-byte outgoing area of calls to a
  // one-argument k, and the path that skips the first call reads it unstored.
  test('past the outgoing area of a function that calls, the same holds', () => {
    expect(
      src(
        [
          '0:\taddiu\tsp,sp,-32',
          '4:\tsw\tra,20(sp)',
          '8:\tsw\ta2,40(sp)',
          'c:\tbeqz\ta0,20 <f+0x20>',
          '10:\tsw\ta3,44(sp)',
          '14:\tjal\t0 <f>',
          '18:\tmove\ta0,a1',
          '1c:\tsw\tv0,28(sp)',
          '20:\tjal\t0 <f>',
          '24:\tlw\ta0,40(sp)',
          '28:\tlw\tt6,44(sp)',
          '2c:\tjal\t0 <f>',
          '30:\taddu\ta0,v0,t6',
          '34:\tlw\tt7,48(sp)',
          '38:\tjal\t0 <f>',
          '3c:\taddu\ta0,v0,t7',
          '40:\tlw\tt8,52(sp)',
          '44:\tjal\t0 <f>',
          '48:\taddu\ta0,v0,t8',
          '4c:\tlw\tra,20(sp)',
          '50:\tlw\tt9,28(sp)',
          '54:\taddiu\tsp,sp,32',
          '58:\tjr\tra',
          '5c:\taddu\tv0,v0,t9',
        ],
        MIPS_IDO,
        callsTo('k', [0x14, 0x20, 0x2c, 0x38, 0x44]),
        { k: { params: 1 } },
      ),
    ).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n' +
        '    s32 v0;\n' +
        '    if (a0 != 0) v0 = k(a1);\n' +
        '    return k(k(k(k(a2) + a3) + a4) + a5) + v0;\n' +
        '}\n',
    );
  });

  const NEVER = /that was never stored/;
  const CALL = ['0:\taddiu\tsp,sp,-32', '4:\tsw\tra,20(sp)', '8:\tjal\t0 <f>', 'c:\tnop'];
  const READ = (off: number) => [
    `10:\tlw\tt6,${off}(sp)`,
    '14:\taddu\tv0,v0,t6',
    '18:\tlw\tra,20(sp)',
    '1c:\tjr\tra',
    '20:\taddiu\tsp,sp,32',
  ];
  const G = callsTo('g', [8]);

  // A callee stores its a0..a3 into the caller's [0,16) and assigns a stack parameter in place, so
  // below the outgoing area's end a word a call reaches may hold what the callee left there.
  test('a word in the outgoing area of a function that calls keeps its refusal', () => {
    expect(lift([...CALL, ...READ(4)], MIPS_IDO, G, { g: { params: 0 } })).toThrow(NEVER);
    expect(src([...CALL, ...READ(28)], MIPS_IDO, G, { g: { params: 0 } })).toBe(
      's32 f(void) {\n    s32 uninit_sp28;\n    return g() + uninit_sp28;\n}\n',
    );
  });

  test('a callee no declaration sizes leaves the outgoing area unknown, so nothing is claimed', () => {
    expect(lift([...CALL, ...READ(28)], MIPS_IDO, G)).toThrow(NEVER);
  });

  test("the caller's home of a0..a3, above the frame, is in no range", () => {
    expect(lift(['0:\taddiu\tsp,sp,-8', '4:\tlw\tv0,12(sp)', '8:\tjr\tra', 'c:\taddiu\tsp,sp,8'], MIPS_IDO)).toThrow(
      NEVER,
    );
    expect(
      lift(
        [
          '0:\taddiu\tsp,sp,-8',
          '4:\tbeqz\ta0,14 <f+0x14>',
          '8:\tnop',
          'c:\tsw\ta0,12(sp)',
          '10:\tnop',
          '14:\tlw\tv0,12(sp)',
          '18:\taddiu\tv0,v0,1',
          '1c:\tjr\tra',
          '20:\taddiu\tsp,sp,8',
        ],
        MIPS_IDO,
      ),
    ).toThrow(/sp@12 is read on a path that never stores it, and lies outside this function's frame partition/);
  });

  // `int g(int); int cv(int a,int c){ int r; if (c) r = g(a); return r + 1; }` at ido7.1 -O2, with g
  // mis-declared void: what the arm stores in 28(sp) is the callee's v0, and it reaches the reload
  // only as the argument of the join's phi. Declared as returning, it lifts.
  const CV = [
    '0:\taddiu\tsp,sp,-32',
    '4:\tbeqz\ta1,18 <f+0x18>',
    '8:\tsw\tra,20(sp)',
    'c:\tjal\t0 <f>',
    '10:\tnop',
    '14:\tsw\tv0,28(sp)',
    '18:\tlw\tra,20(sp)',
    '1c:\tlw\tv0,28(sp)',
    '20:\taddiu\tsp,sp,32',
    '24:\tjr\tra',
    '28:\taddiu\tv0,v0,1',
  ];
  test("a call's destroyed v0 stored to an owned word refuses where the join reads it back", () => {
    expect(lift(CV, MIPS_IDO, callsTo('g', [0xc]), { g: { params: 1, returnsVoid: true } })).toThrow(
      /v0 is read on a path where a call has destroyed it/,
    );
    expect(src(CV, MIPS_IDO, callsTo('g', [0xc]), { g: { params: 1 } })).toBe(
      's32 f(s32 a0, s32 a1) {\n    s32 v0;\n    if (a1 != 0) v0 = g(a0);\n    return v0 + 1;\n}\n',
    );
  });

  // The key is the raw offset, so a word reached at the entry depth names other storage under the
  // same spelling: one such access and the frame claims nothing.
  test('an sp access at another depth than the frame withdraws the claim', () => {
    expect(
      lift(
        [
          '0:\tlw\tv0,4(sp)',
          '4:\taddiu\tsp,sp,-8',
          '8:\tlw\tv1,4(sp)',
          'c:\taddu\tv0,v0,v1',
          '10:\tjr\tra',
          '14:\taddiu\tsp,sp,8',
        ],
        MIPS_IDO,
      ),
    ).toThrow(NEVER);
  });
});
