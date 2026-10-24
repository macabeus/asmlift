// A GAP IN A GUESSED CALL ARITY, DECIDED (frontend/call-plan.ts `decideGap`). An argument register
// left at its incoming value below one the call's own block set up is the function's own argument
// passed on — where the set one is surely an argument, and the ABI cannot leave the gap empty below
// it. Each fixture is the toolchain's own output (canonical flags, 2026-10-18); the Thumb shapes are
// in thumb-frontend.test.ts beside the refusals that still hold there.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { type Prototypes, ownLeadingWordParams, ownLeadingWordRegisters } from '../src/proto';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, TOOLCHAIN_TARGETS, argRegisterHoles } from '../src/target';

describe('where an ABI can leave an argument register empty below a filled one', () => {
  test('an 8-byte argument skips an odd word on O32 and PowerPC, and a leading float shadows O32 words', () => {
    expect(argRegisterHoles(ARMV4T_AGBCC)).toEqual({ skippable: new Set(), leadingFloatShadow: false });
    for (const t of [MIPS_IDO, MIPS_GCC]) {
      expect(argRegisterHoles(t)).toEqual({ skippable: new Set(['a1', 'a3']), leadingFloatShadow: true });
    }
    expect(argRegisterHoles(PPC_MWCC)).toEqual({
      skippable: new Set(['r4', 'r6', 'r8', 'r10']),
      leadingFloatShadow: false,
    });
  });

  test('every toolchain states it through the facts that place its arguments', () => {
    const holes = Object.fromEntries(
      Object.entries(TOOLCHAIN_TARGETS).map(([id, r]) => {
        const h = argRegisterHoles(r.description);
        return [id, [[...h.skippable].join(','), h.leadingFloatShadow]];
      }),
    );
    expect(holes).toMatchObject({
      agbcc: ['', false],
      'ido7.1': ['a1,a3', true],
      'gcc2.7.2kmc': ['a1,a3', true],
      'gcc2.7.2': ['a1,a3', true],
      mwcc_242_81: ['r4,r6,r8,r10', false],
      mwcc_233_163n: ['r4,r6,r8,r10', false],
      mwcc_247_107: ['r4,r6,r8,r10', false],
    });
  });
});

describe('the first argument registers that surely hold an own word parameter', () => {
  const n = (p: Parameters<typeof ownLeadingWordParams>[1], target = MIPS_IDO) => ownLeadingWordParams('f', p, target);
  test('counts leading integer words, and stops at anything else', () => {
    expect(n({ params: ['const char *', 's32'], returns: 's32' })).toBe(2);
    expect(n({ params: ['s32', 'float', 's32'], returns: 's32' })).toBe(1);
    expect(n({ params: ['float', 's32'], returns: 's32' })).toBe(0);
    expect(n({ params: ['s32', 'long long'], returns: 'void' })).toBe(1);
  });
  test('is none where a hidden word may come first, or nothing is laid out', () => {
    expect(n(undefined)).toBe(0);
    expect(n({ params: 2 })).toBe(0);
    // an unsized parameter anywhere lays nothing out
    expect(n({ params: ['s32', 'Foo'], returns: 's32' })).toBe(0);
    // a return the declaration does not show is a scalar may be a struct handed back through a0
    expect(n({ params: ['s32'] })).toBe(0);
    expect(n({ params: ['s32'], returns: 'struct Big' })).toBe(0);
  });
  // Asked whether a register holds a word whoever's, a hidden word ahead is one too, and a later
  // parameter nothing places does not move the ones before it.
  test("asked for words whoever's, a hidden word is one and a later unsized parameter is no bar", () => {
    const w = (p: Parameters<typeof ownLeadingWordRegisters>[1]) => ownLeadingWordRegisters('f', p);
    expect(w({ params: ['u32'], returns: 'u32' })).toBe(1);
    expect(w({ params: ['u32', 'u8 *'], returns: 'u32' })).toBe(2);
    expect(w({ params: ['float', 'u32'], returns: 'u32' })).toBe(0);
    expect(w({ params: ['u32', 'Foo'], returns: 'u32' })).toBe(1);
    expect(w({ params: ['u32'], returns: 'struct S' })).toBe(1);
    expect(w({ params: ['u32'] })).toBe(1);
    expect(w({ params: 1 })).toBe(0);
    expect(w(undefined)).toBe(0);
  });
});

/** Wrap objdump-shaped MIPS body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const mips = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');
const jalTo = (offset: number, sym: string): AsmData => ({
  sections: new Map(),
  relocs: [{ section: '.text', offset, type: 'R_MIPS_26', sym, addend: 0 }],
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});
const own = (params: string[]): Prototypes => ({ f: { params, returns: 's32' } });

describe('on O32 (gcc2.7.2kmc), a gap is decided where the own declaration rules out the holes', () => {
  // `int logv(); int f(const char *s){ return logv(s, 1) + 1; }`
  const passgap = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tjal\t0 <f>',
    'c:\tli\ta1,1',
    '10:\tlw\tra,16(sp)',
    '14:\taddiu\tv0,v0,1',
    '18:\tjr\tra',
    '1c:\taddiu\tsp,sp,24',
  ];
  const lift = (lines: string[], sym: string, prototypes: Prototypes = {}) =>
    decompile('f', mips(lines), MIPS_GCC, { asmData: jalTo(lines === passgap ? 8 : 0xc, sym), prototypes }).source;

  test('a0 below a set a1 is passed on where the own declaration puts an integer word there', () => {
    expect(lift(passgap, 'logv', own(['const char *']))).toContain('return logv(a0, 1) + 1;');
  });
  // `int gp(float, int); int f(float x){ return gp(x, 5) + 1; }` is the same object: the float
  // crosses in $f12 and leaves a0 holding nothing
  test('…and refuses where a leading float may have left a0 empty', () => {
    expect(() => lift(passgap, 'logv')).toThrow(/a1 holds a value and a0 holds none/);
    expect(() => lift(passgap, 'logv', own(['float']))).toThrow(/a1 holds a value and a0 holds none/);
  });

  // `int g3(); int f(int a, int b){ return g3(1, b, 3) + 1; }`
  const passmid = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tli\ta0,1',
    'c:\tjal\t0 <f>',
    '10:\tli\ta2,3',
    '14:\tlw\tra,16(sp)',
    '18:\taddiu\tv0,v0,1',
    '1c:\tjr\tra',
    '20:\taddiu\tsp,sp,24',
  ];
  test('a1 below a set a2 is passed on where a3 holds nothing an 8-byte argument could own', () => {
    expect(lift(passmid, 'g3', own(['s32', 's32']))).toContain('return g3(1, a1, 3) + 1;');
  });
  // `g3(1, ((long long)3 << 32) | d)` of a fourth parameter `d` sets a0 and a2 alone as well, so a3
  // left at an incoming value may be the low word of a pair that skipped a1
  test('…and refuses where a3 may be an own parameter, or nothing says', () => {
    expect(() => lift(passmid, 'g3')).toThrow(/a2 holds a value and a1 holds none/);
    expect(() => lift(passmid, 'g3', own(['s32', 's32', 's32', 's32']))).toThrow(/a2 holds a value and a1 holds none/);
  });

  // `int g(); int f(int a, int b){ return g(1, 3LL) + 1; }`, the object `g(1, b, 0, 3)` compiles to
  test('a1 below a set a2:a3 pair is the hole an 8-byte argument skips, and refuses', () => {
    const fb = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tli\ta2,0',
      'c:\tli\ta3,3',
      '10:\tjal\t0 <f>',
      '14:\tli\ta0,1',
      '18:\tlw\tra,16(sp)',
      '1c:\taddiu\tv0,v0,1',
      '20:\tjr\tra',
      '24:\taddiu\tsp,sp,24',
    ];
    expect(() =>
      decompile('f', mips(fb), MIPS_GCC, { asmData: jalTo(0x10, 'g'), prototypes: own(['s32', 's32']) }),
    ).toThrow(/a2 holds a value and a1 holds none/);
  });
});

describe('on O32 (gcc2.7.2kmc), a decided gap refuses where the call may take more than it counts', () => {
  // `int g(); int f(int a, int b, int c, int d){ return g(a, 2, c, d, 5) + 1; }`: c and d stay in
  // a2/a3, and the fifth argument goes to 16(sp)
  const ll6 = [
    '0:\taddiu\tsp,sp,-32',
    '4:\tli\tv0,5',
    '8:\tli\ta1,2',
    'c:\tsw\tra,24(sp)',
    '10:\tjal\t0 <f>',
    '14:\tsw\tv0,16(sp)',
    '18:\tlw\tra,24(sp)',
    '1c:\taddiu\tv0,v0,1',
    '20:\tjr\tra',
    '24:\taddiu\tsp,sp,32',
  ];
  const lift = (prototypes: Prototypes) =>
    decompile('f', mips(ll6), MIPS_GCC, { asmData: jalTo(0x10, 'g'), prototypes }).source;
  test('an own parameter that may sit past the count refuses', () => {
    expect(() => lift(own(['s32', 's32', 's32', 's32']))).toThrow(/a1 holds a value and a0 holds none/);
  });
  test('an outgoing stack word that reaches the call refuses', () => {
    expect(() => lift(own(['s32', 's32']))).toThrow(/a1 holds a value and a0 holds none/);
  });
});

describe('on PowerPC (mwcc_242_81), a gap is decided where no 8-byte argument can own it', () => {
  const ppc = (body: string) => `0 <f>:\n${body}`;
  const call = (at: number, sym: string) =>
    `${at.toString(16)}:\tbl      ${at.toString(16)} <f+0x${at.toString(16)}>\n\t\t\t${at.toString(16)}: R_PPC_REL24\t${sym}\n`;
  const frame = (setup: string, at: number, sym: string) =>
    ppc(
      '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n' +
        setup +
        call(at, sym) +
        `${(at + 4).toString(16)}:\tlwz     r0,20(r1)\n${(at + 8).toString(16)}:\taddi    r3,r3,1\n` +
        `${(at + 12).toString(16)}:\tmtlr    r0\n${(at + 16).toString(16)}:\taddi    r1,r1,16\n${(at + 20).toString(16)}:\tblr\n`,
    );

  // `int logv(); int f(const char *s){ return logv(s, 1) + 1; }`: r3 is even, and PowerPC's floats
  // take no general word, so no 8-byte argument can leave it empty. But a float passed on in f1
  // is invisible: `int g(); int f(int b, float x){ return g(b, x, 3) + 1; }` is this very object
  // (`li r4,3; bl g`), so only an own declaration with no floating parameter decides it.
  test('r3 below a set r4 is passed on where the own declaration rules out a float in f1', () => {
    const passgap = frame('8:\tli      r4,1\nc:\tstw     r0,20(r1)\n', 0x10, 'logv');
    expect(decompile('f', passgap, PPC_MWCC, { prototypes: own(['const char *']) }).source).toContain(
      'return logv(a0, 1) + 1;',
    );
    expect(() => decompile('f', passgap, PPC_MWCC)).toThrow(/r4 holds a value and r3 holds none/);
    expect(() => decompile('f', passgap, PPC_MWCC, { prototypes: own(['s32', 'float']) })).toThrow(
      /r4 holds a value and r3 holds none/,
    );
    // …nor where the own declaration gives r3 no parameter
    expect(() => decompile('f', passgap, PPC_MWCC, { prototypes: own([]) })).toThrow(
      /r4 holds a value and r3 holds none/,
    );
    // …nor at flags that keep a computation nothing uses (mwcc -O0 keeps a dead `li r31,5`)
    const keeping = { ...PPC_MWCC, compilerBehaviors: { ...PPC_MWCC.compilerBehaviors, keepsUnusedReads: true } };
    expect(() => decompile('f', passgap, keeping, { prototypes: own(['const char *']) })).toThrow(
      /r4 holds a value and r3 holds none/,
    );
  });

  // `int g3(); int f(int a, int b){ return g3(1, b, 3) + 1; }`
  test('r4 below a set r5 is passed on where r6 holds nothing an 8-byte argument could own', () => {
    const passmid = frame('8:\tli      r3,1\nc:\tli      r5,3\n10:\tstw     r0,20(r1)\n', 0x14, 'g3');
    expect(decompile('f', passmid, PPC_MWCC, { prototypes: own(['s32', 's32']) }).source).toContain(
      'return g3(1, a1, 3) + 1;',
    );
    expect(() => decompile('f', passmid, PPC_MWCC)).toThrow(/r5 holds a value and r4 holds none/);
  });

  // `int g(); int f(int a, int b){ return g(1, 3LL) + 1; }`, the object `g(1, b, 0, 3)` compiles to
  test('r4 below a set r5:r6 pair is the hole an 8-byte argument skips, and refuses', () => {
    const fb = frame('8:\tli      r3,1\nc:\tli      r6,3\n10:\tstw     r0,20(r1)\n14:\tli      r5,0\n', 0x18, 'g');
    expect(() => decompile('f', fb, PPC_MWCC, { prototypes: own(['s32', 's32']) })).toThrow(
      /r5 holds a value and r4 holds none/,
    );
  });
});

describe('the compiler facts a decided gap reads, stated for every toolchain', () => {
  test('where a discarded read may land, and who forwards a struct destination', () => {
    const facts = Object.fromEntries(
      Object.entries(TOOLCHAIN_TARGETS).map(([id, r]) => {
        const b = r.description.compilerBehaviors;
        return [id, [b.discardedReadMayFillArgRegister, b.forwardsStructReturnDestination]];
      }),
    );
    expect(facts).toMatchObject({
      agbcc: [true, false],
      'ido7.1': [false, true],
      'gcc2.7.2kmc': [true, false],
      'gcc2.7.2': [true, false],
      mwcc_242_81: [true, false],
      mwcc_233_163n: [true, false],
      mwcc_247_107: [true, false],
    });
  });
});

// A LOAD ONLY THE CALL READS IS AN ARGUMENT only where no discarded read lands in an argument
// register (`compilerBehaviors.discardedReadMayFillArgRegister`): ido7.1 discards into $zero every
// time, so `int logv(); int f(const char *s, int *q){ return logv(s, *q) + 1; }` decides its gap
// there. KMC and GCC 2.7.2 discard into a1 and mwcc into r4 once v0/v1 or r0 are busy, the bytes of
// the twin that passes the read, so there it refuses, as agbcc's r1 does (thumb-frontend.test.ts,
// `fvol`).
describe('a value a load left above the gap', () => {
  const pld2 = [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,16(sp)',
    '8:\tjal\t0 <f>',
    'c:\tlw\ta1,0(a1)',
    '10:\tlw\tra,16(sp)',
    '14:\taddiu\tv0,v0,1',
    '18:\tjr\tra',
    '1c:\taddiu\tsp,sp,24',
  ];
  const lift = (target: typeof MIPS_GCC) =>
    decompile('f', mips(pld2), target, {
      asmData: jalTo(8, 'logv'),
      prototypes: own(['const char *', 's32 *']),
    }).source;
  test('decides it on O32 (ido7.1), where a discarded read goes to $zero', () => {
    expect(lift(MIPS_IDO)).toContain('return logv(a0, *a1) + 1;');
    // where the fact is unmeasured, a load decides nothing
    const unmeasured = {
      ...MIPS_IDO,
      compilerBehaviors: { ...MIPS_IDO.compilerBehaviors, discardedReadMayFillArgRegister: undefined },
    };
    expect(() => lift(unmeasured)).toThrow(/a1 holds a value and a0 holds none/);
  });
  test('refuses on O32 (gcc2.7.2kmc), where a discarded read may go to a1', () => {
    expect(() => lift(MIPS_GCC)).toThrow(/a1 holds a value and a0 holds none/);
  });
  test('refuses on PowerPC (mwcc_242_81), where a discarded read may go to r4', () => {
    const ppc =
      '0 <f>:\n0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\nc:\tlwz     r4,0(r4)\n' +
      '10:\tbl      10 <f+0x10>\n\t\t\t10: R_PPC_REL24\tlogv\n14:\tlwz     r0,20(r1)\n18:\taddi    r3,r3,1\n' +
      '1c:\tmtlr    r0\n20:\taddi    r1,r1,16\n24:\tblr\n';
    expect(() => decompile('f', ppc, PPC_MWCC, { prototypes: own(['const char *', 's32 *']) })).toThrow(
      /r4 holds a value and r3 holds none/,
    );
  });
});

// IDO HANDS ITS OWN DESTINATION ON AS A CALLEE'S HIDDEN POINTER
// (`compilerBehaviors.forwardsStructReturnDestination`): `struct S sg(); int f(struct S *p){ *p =
// sg(1); return 0; }` is `jal sg; li a1,1` with a0 never touched, so a gap at a0 is decided only
// where something other than a `ret` reads the call's result. ido7.1's own output for each source.
describe("on O32 (ido7.1), a gap at a0 needs the call's result read", () => {
  const body = (tail: string[]) => [
    '0:\taddiu\tsp,sp,-24',
    '4:\tsw\tra,20(sp)',
    '8:\tjal\t0 <f>',
    'c:\tli\ta1,1',
    '10:\tlw\tra,20(sp)',
    '14:\taddiu\tsp,sp,24',
    ...tail,
  ];
  const lift = (lines: string[], sym: string, prototypes: Prototypes) =>
    decompile('f', mips(lines), MIPS_IDO, { asmData: jalTo(8, sym), prototypes }).source;
  // `int logv(); int f(const char *s){ return logv(s, 1) + 1; }`
  test('a result the function computes with is a word, and the gap is passed on', () => {
    const passgap = body(['18:\taddiu\tv0,v0,1', '1c:\tjr\tra', '20:\tnop']);
    expect(lift(passgap, 'logv', own(['const char *']))).toContain('return logv(a0, 1) + 1;');
  });
  test('a forwarded struct return refuses, with the own declaration or without a result', () => {
    // `int f(struct S *p){ *p = sg(1); return 0; }`
    const b3 = body(['18:\tmove\tv0,zero', '1c:\tjr\tra', '20:\tnop']);
    expect(() => lift(b3, 'sg', own(['struct S *']))).toThrow(/a1 holds a value and a0 holds none/);
    // `void f(struct S *p){ *p = sg(1); }`: the `ret` reads v0, which is no reader
    const b7 = body(['18:\tjr\tra', '1c:\tnop']);
    expect(() =>
      decompile('f', mips(b7), MIPS_IDO, {
        asmData: jalTo(8, 'sg'),
        prototypes: { f: { params: ['struct S *'], returnsVoid: true } },
      }),
    ).toThrow(/a1 holds a value and a0 holds none/);
    // `int f(const char *s){ return logv(s, 1); }` is the same object, and declines with it
    expect(() => lift(b7, 'logv', own(['const char *']))).toThrow(/a1 holds a value and a0 holds none/);
  });
  // gcc2.7.2kmc copies a struct return through a frame temporary (`addiu a0,sp,16`), so there a
  // returned value only a `ret` reads still decides the gap
  test('…where the compiler copies through a temporary instead, a returned result decides it', () => {
    const pt = [
      '0:\taddiu\tsp,sp,-24',
      '4:\tsw\tra,16(sp)',
      '8:\tjal\t0 <f>',
      'c:\tli\ta1,1',
      '10:\tlw\tra,16(sp)',
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,24',
    ];
    expect(
      decompile('f', mips(pt), MIPS_GCC, { asmData: jalTo(8, 'logv'), prototypes: own(['const char *']) }).source,
    ).toContain('return logv(a0, 1);');
  });
});

describe('on Thumb (agbcc), a decided gap proves only the register above it', () => {
  const thumb = (name: string, body: string) =>
    `${name}:\n\tpush\t{lr}\n${body}\tadd\tr0, r0, #0x1\n\tpop\t{r1}\n\tbx\tr1\n`;
  // `int g(); int f(int a, int b, int c){ return g(a, 1, 2) + 1; }`
  test('every register counted past it that is proven the same way is an argument', () => {
    const ok3 = thumb('f', '\tmov\tr1, #0x1\n\tmov\tr2, #0x2\n\tbl\tg\n');
    expect(decompile('f', ok3, ARMV4T_AGBCC).source).toContain('return g(a0, 1, 2) + 1;');
  });
  // `int g(); int gp[4]; int gy; int f(int a, int b, int c){ gp[1] = 3; return g(a, -gy) + 1; }`:
  // r2 holds the store's address, which would lift `g(a0, -gy, &gp)`
  test('a store address above it refuses', () => {
    const fa =
      'f:\n\tpush\t{lr}\n\tldr\tr2, .L3\n\tmov\tr1, #0x3\n\tstr\tr1, [r2, #0x4]\n\tldr\tr1, .L3+0x4\n' +
      '\tldr\tr1, [r1]\n\tneg\tr1, r1\n\tbl\tg\n\tadd\tr0, r0, #0x1\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L4:\n.L3:\n\t.word\tgp\n\t.word\tgy\n';
    expect(() => decompile('f', fa, ARMV4T_AGBCC)).toThrow(/r1 holds a value and r0 holds none/);
  });
  // `int g(); int f(int a, int b, int c){ return g(a, c + 1) + 1; }`: r2 still holds c, read for
  // `c + 1`, which would lift `g(a0, a2 + 1, a2)`
  test('an incoming value read elsewhere above it refuses', () => {
    const fd = thumb('f', '\tadd\tr1, r2, #0x1\n\tbl\tg\n');
    expect(() => decompile('f', fd, ARMV4T_AGBCC)).toThrow(/r1 holds a value and r0 holds none/);
  });
  // `int logv(); int f(const char *s){ return logv(s, 1) + 1; }` with `int f(void);` in the context.
  // The entry refuses the gap, and the relift without the bound refuses on it too.
  test('a context entry that gives the gap no parameter refuses through the unbounded relift', () => {
    const pr = thumb('f', '\tmov\tr1, #0x1\n\tbl\tlogv\n');
    expect(decompile('f', pr, ARMV4T_AGBCC).source).toContain('return logv(a0, 1) + 1;');
    expect(() => decompile('f', pr, ARMV4T_AGBCC, { ownContextProto: { params: [], returns: 's32' } })).toThrow(
      /r1 holds a value and r0 holds none/,
    );
  });
});

// A CALLEE WHOSE BODY IS IN THE SAME INPUT BOUNDS WHAT IT READS (frontend/callee-body.ts), and so
// answers a question about a register at or past that bound, never one below it.
describe('on Thumb (agbcc), a callee body in the same input bounds the arity guess', () => {
  // `u8 rnd(); void jt_rndsame(s32 i){ switch (i) { case 0: gH = 5; gA = rnd(); break; … } }`, the
  // agbcc output of synthetic:jt_rndsame:agbcc: case 0 leaves its store's 5 in r0 at `bl rnd`
  const rnd = '\t.thumb_func\nrnd:\n\tldr\tr0, .L3\n\tldrb\tr0, [r0]\n\tbx\tlr\n\t.align\t2, 0\n.L3:\n\t.word\tgR\n';
  const caller =
    '\t.thumb_func\njt_rndsame:\n\tpush\t{r4, lr}\n\tcmp\tr0, #0x6\n\tbhi\t.L6\n\tlsl\tr0, r0, #0x2\n' +
    '\tldr\tr1, .L17\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n\t.align\t2, 0\n.L17:\n\t.word\t.L14\n' +
    '\t.align\t2, 0\n.L14:\n\t.word\t.L7\n\t.word\t.L8\n\t.word\t.L9\n\t.word\t.L10\n\t.word\t.L11\n\t.word\t.L12\n' +
    '\t.word\t.L13\n.L7:\n\tldr\tr1, .L19\n\tmov\tr0, #0x5\n\tstrh\tr0, [r1]\n\tbl\trnd\n\tldr\tr1, .L19+0x4\n' +
    '\tb\t.L16\n\t.align\t2, 0\n.L19:\n\t.word\tgH\n\t.word\tgA\n.L8:\n\tldr\tr1, .L21\n\tmov\tr0, #0x1\n\tb\t.L16\n' +
    '\t.align\t2, 0\n.L21:\n\t.word\tgB\n.L9:\n\tldr\tr4, .L23\n\tbl\trnd\n\tmov\tr1, #0x3\n\tand\tr1, r1, r0\n' +
    '\tstrb\tr1, [r4]\n\tb\t.L6\n\t.align\t2, 0\n.L23:\n\t.word\tgA\n.L10:\n\tldr\tr1, .L25\n\tmov\tr0, #0x7\n' +
    '\tb\t.L16\n\t.align\t2, 0\n.L25:\n\t.word\tgC\n.L11:\n\tbl\trnd\n\tldr\tr1, .L27\n\tb\t.L16\n\t.align\t2, 0\n' +
    '.L27:\n\t.word\tgB\n.L12:\n\tldr\tr1, .L29\n\tmov\tr0, #0x9\n\tstrh\tr0, [r1]\n\tb\t.L6\n\t.align\t2, 0\n' +
    '.L29:\n\t.word\tgH\n.L13:\n\tbl\trnd\n\tldr\tr1, .L31\n.L16:\n\tstrb\tr0, [r1]\n.L6:\n\tpop\t{r4}\n\tpop\t{r0}\n' +
    '\tbx\tr0\n\t.align\t2, 0\n.L31:\n\t.word\tgC\n';
  const prototypes: Prototypes = { jt_rndsame: { returnsVoid: true }, rnd: { returns: 'u8' } };
  test('a callee that reads no argument is called with none, in a dispatch the guess would refuse', () => {
    const src = decompile('jt_rndsame', `\t.code\t16\n\t.text\n${rnd}${caller}`, ARMV4T_AGBCC, { prototypes }).source;
    expect(src).toContain('rnd()');
    expect(src).not.toMatch(/rnd\([^)]/);
  });
  test('…and the same caller with no body for it still refuses (synthetic:jt_rndst:agbcc)', () => {
    expect(() => decompile('jt_rndsame', `\t.code\t16\n\t.text\n${caller}`, ARMV4T_AGBCC, { prototypes })).toThrow(
      /has no prototype, and r0, which the count takes, holds a value an effect of its block uses/,
    );
  });
  // a callee reading only r0 (`rd1`), one reading none (`rd0`), and one reading r0 and r1 (`rd2`)
  const rd1 = '\t.thumb_func\nrd1:\n\tadd\tr0, r0, #0x1\n\tbx\tlr\n';
  const rd0 = '\t.thumb_func\nrd0:\n\tmov\tr0, #0x1\n\tbx\tlr\n';
  const rd2 = '\t.thumb_func\nrd2:\n\tadd\tr0, r0, r1\n\tbx\tlr\n';
  const f = (body: string) => `\t.thumb_func\nf:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tr1\n`;
  // `reg` holds a 3 that a store to gp, through `addr`, read first
  const stored = (reg: string, callee: string, addr = 'r2') =>
    f(`\tldr\t${addr}, .L3\n\tmov\t${reg}, #0x3\n\tstr\t${reg}, [${addr}]\n\tbl\t${callee}\n`) + '.L3:\n\t.word\tgp\n';
  // The bound is what the callee READS, never what the caller passes: an unused parameter and a
  // K&R call's extra arguments are set up all the same, and decide the gap below them
  test('a register the caller set up for the call alone stays an argument, past the bound too', () => {
    const three = f('\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tbl\trd1\n');
    expect(decompile('f', `${rd1}${three}`, ARMV4T_AGBCC).source).toContain('rd1(1, 2, 3)');
    // `tick(5)` to a body that reads none
    expect(decompile('f', `${rd0}${f('\tmov\tr0, #0x5\n\tbl\trd0\n')}`, ARMV4T_AGBCC).source).toContain('rd0(5)');
    // r1's constant decides the gap below it, with the body as without
    const gap = f('\tmov\tr1, #0x2\n\tbl\trd0\n');
    expect(decompile('f', gap, ARMV4T_AGBCC).source).toContain('rd0(a0, 2)');
    expect(decompile('f', `${rd0}${gap}`, ARMV4T_AGBCC).source).toContain('rd0(a0, 2)');
    // `caller(a, b) { rd1(a, b, 7); }`: the 7 proves r0 and r1 the caller's own, and rd1 reads r0
    expect(decompile('f', `${rd1}${f('\tmov\tr2, #0x7\n\tbl\trd1\n')}`, ARMV4T_AGBCC).source).toContain(
      'rd1(a0, a1, 7)',
    );
  });
  test('past the bound, a value something else read first is no argument', () => {
    // `gp = 3; rd0();` leaves the store's 3 in r0
    expect(decompile('f', stored('r0', 'rd0', 'r1'), ARMV4T_AGBCC).source).toContain('rd0(3, &gp)');
    expect(decompile('f', `${rd0}${stored('r0', 'rd0', 'r1')}`, ARMV4T_AGBCC).source).toContain('rd0()');
    // …and a gap past the bound under one stops the count below the gap, where it refuses unbounded
    expect(() => decompile('f', stored('r1', 'rd0'), ARMV4T_AGBCC)).toThrow(/r1 holds a value and r0 holds none/);
    expect(decompile('f', `${rd0}${stored('r1', 'rd0')}`, ARMV4T_AGBCC).source).toContain('rd0()');
  });
  // `gp = 3; gq = rd1(a);` leaves the store's 3 in r1 above r0's a, which rd1 reads: dropping r0
  // would drop the a, so the gap refuses as it does with no body
  test('a gap below the bound refuses whatever lies above it', () => {
    for (const asm of [stored('r1', 'rd1'), `${rd1}${stored('r1', 'rd1')}`]) {
      expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(/r1 holds a value and r0 holds none/);
    }
    expect(() => decompile('f', `${rd2}${stored('r3', 'rd2')}`, ARMV4T_AGBCC)).toThrow(
      /holds a value and r0 holds none/,
    );
  });
});
