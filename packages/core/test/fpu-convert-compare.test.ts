// Hardware floating point, between the files: on MIPS the conversions (`trunc.w`, `cvt.s.w`/`cvt.d.w`,
// with `mfc1`/`mtc1` moving the integer word) and the compares (`c.eq`/`c.lt`/`c.le` and the branch on
// the condition code they set); on PowerPC `fctiwz` through the frame and `fcmpo`/`fcmpu` through a
// condition-register field, a branch, a `cror` or an `mfcr` extract — onto the IR's conversions and
// float compares. Every listing a test accepts is the toolchain's own at its canonical flags, and its
// lift recompiled to it when the listing was taken; the tests pin the spelling. A refusal's listing may
// be hand asm.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '../src/target';

const objdump = (sym: string, body: string) => `00000000 <${sym}>:\n${body}`;
const lift = (sym: string, body: string, target: TargetDescription = MIPS_IDO) =>
  decompile(sym, objdump(sym, body), target).source;

describe('a conversion between the files', () => {
  // int f2i(float x){ return (int)x; } — IDO truncates into $f4, KMC into $f0, the float return home.
  test('trunc.w and the move out of the file are the cast to int', () => {
    const want = 's32 f2i(float a0) {\n    return (s32)a0;\n}\n';
    expect(lift('f2i', '   0:\ttrunc.w.s\t$f4,$f12\n   4:\tmfc1\tv0,$f4\n   8:\tjr\tra\n   c:\tnop\n')).toBe(want);
    expect(lift('f2i', '   0:\ttrunc.w.s\t$f0,$f12\n   4:\tmfc1\tv0,$f0\n   8:\tjr\tra\n   c:\tnop\n', MIPS_GCC)).toBe(
      want,
    );
  });

  // double i2d(int x){ return (double)x; }
  test('the move into the file and cvt.d.w are the cast to double', () => {
    expect(lift('i2d', '   0:\tmtc1\ta0,$f4\n   4:\tjr\tra\n   8:\tcvt.d.w\t$f0,$f4\n   c:\tnop\n')).toBe(
      'double i2d(s32 a0) {\n    return (double)a0;\n}\n',
    );
  });

  // float fround(float x){ return (float)(int)x; } at IDO: the word leaves the file and comes back.
  test('a word out of the file and back in', () => {
    expect(
      lift(
        'fround',
        '   0:\ttrunc.w.s\t$f4,$f12\n   4:\tmfc1\tt7,$f4\n   8:\tnop\n   c:\tmtc1\tt7,$f6\n  10:\tjr\tra\n' +
          '  14:\tcvt.s.w\t$f0,$f6\n',
      ),
    ).toBe('float fround(float a0) {\n    return (float)(s32)a0;\n}\n');
  });
});

describe('a compare and the branch on its condition code', () => {
  // int fcmp(float a, float b){ return a > b; } — `c.lt.s b, a`. IDO branches past the 1 when the code
  // is CLEAR, KMC when it is set (its `li v0,1` is the slot).
  test('bc1f is taken on the NOT of the compare, which is the unordered compare', () => {
    const src = lift(
      'fcmp',
      '   0:\tc.lt.s\t$f14,$f12\n   4:\tmove\tv0,zero\n   8:\tbc1f\t14 <fcmp+0x14>\n   c:\tnop\n  10:\tli\tv0,1\n' +
        '  14:\tjr\tra\n  18:\tnop\n',
    );
    expect(src).toBe(
      's32 fcmp(float a0, float a1) {\n    s32 v0;\n    if (a1 < a0) {\n        v0 = 1;\n    } else {\n' +
        '        v0 = 0;\n    }\n    return v0;\n}\n',
    );
  });

  test('bc1t is taken on the compare', () => {
    const src = lift(
      'fcmp',
      '   0:\tc.lt.s\t$f14,$f12\n   4:\tnop\n   8:\tnop\n   c:\tbc1t\t18 <fcmp+0x18>\n  10:\tli\tv0,1\n' +
        '  14:\tmove\tv0,zero\n  18:\tjr\tra\n  1c:\tnop\n',
      MIPS_GCC,
    );
    expect(src).toContain('if (!(a1 < a0)) {\n        v0 = 0;\n    } else {\n        v0 = 1;\n    }');
  });

  // int fne(float a, float b){ return a != b; } — `c.eq.s` and the branch past the 1 when it is SET.
  test('a != b is c.eq with the branch sense flipped', () => {
    const src = lift(
      'fne',
      '   0:\tc.eq.s\t$f12,$f14\n   4:\tmove\tv0,zero\n   8:\tbc1t\t14 <fne+0x14>\n   c:\tnop\n  10:\tli\tv0,1\n' +
        '  14:\tjr\tra\n  18:\tnop\n',
    );
    expect(src).toContain('if (a0 != a1) {\n        v0 = 1;');
  });

  // A branch reads the code a compare in its own block set; there is none here.
  test('a branch on a code no compare in its block set refuses', () => {
    expect(() =>
      lift(
        'g',
        '   0:\tc.lt.s\t$f14,$f12\n   4:\tbeqz\ta0,c <g+0xc>\n   8:\tnop\n   c:\tbc1t\t14 <g+0x14>\n  10:\tnop\n' +
          '  14:\tjr\tra\n  18:\tnop\n',
      ),
    ).toThrow("'bc1t' at 0xc tests a condition code no compare in its block set");
  });
});

describe('what refuses', () => {
  // int fand(float a, float b, float c){ return a < b && b < c; } at KMC: `c` arrives in a2, an
  // integer register, and `mtc1` moves its bits in; the compare in the next block reads them as a
  // float, which is a bit cast.
  test('an integer word computed on as a float across a block boundary', () => {
    expect(() =>
      lift(
        'fand',
        '   0:\tc.lt.s\t$f12,$f14\n   4:\tmtc1\ta2,$f0\n   8:\tnop\n   c:\tbc1t\t18 <fand+0x18>\n  10:\tli\tv0,1\n' +
          '  14:\tmove\tv0,zero\n  18:\tc.lt.s\t$f14,$f0\n  1c:\tnop\n  20:\tnop\n  24:\tbc1t\t30 <fand+0x30>\n' +
          '  28:\tli\tv1,1\n  2c:\tmove\tv1,zero\n  30:\tjr\tra\n  34:\tand\tv0,v0,v1\n',
        MIPS_GCC,
      ),
    ).toThrow("cannot lift 'fand': 'fcmp_olt' is handed an integer word");
  });

  test('…and within one block', () => {
    expect(() => lift('g', '   0:\tmtc1\ta0,$f4\n   4:\tjr\tra\n   8:\tadd.s\t$f0,$f4,$f12\n')).toThrow(
      "'add.s' at 0x8 reads $f4 as a float, and it holds an integer word",
    );
  });
});

describe('which home a function returns in, once a float reaches the integer file', () => {
  const kmc = (sym: string, body: string, prototypes = {}) =>
    decompile(sym, objdump(sym, body), MIPS_GCC, { prototypes }).source;
  // int vi2(float a, float b){ float c = a + b; if (c < a) return 3; if (c > b) return 7; return 5; }
  // at KMC adds into $f0, the float return home, and the compares read it: the `li`s in v0, which
  // nothing but the return reads, are the result.
  const vi2 =
    '   0:\tadd.s\t$f0,$f12,$f14\n   4:\tc.lt.s\t$f0,$f12\n   8:\tnop\n   c:\tbc1f\t1c <vi2+0x1c>\n  10:\tnop\n' +
    '  14:\tj\t34 <vi2+0x34>\n  18:\tli\tv0,3\n  1c:\tc.lt.s\t$f14,$f0\n\t...\n  28:\tbc1t\t34 <vi2+0x34>\n' +
    '  2c:\tli\tv0,7\n  30:\tli\tv0,5\n  34:\tjr\tra\n  38:\tnop\n';
  test('a float temporary in the float home feeds a compare, and the integer home returns', () => {
    const src = kmc('vi2', vi2);
    expect(src).toMatch(/^s32 vi2\(float a0, float a1\)/);
    expect(src).toContain('v0 = 3;');
  });

  // void vb1(float a, float b, int *p){ float c = a * b; if (c < a) *p = 1; if (c > b) *p = 2; } is
  // one object with `float vb1(…){ …; return c; }`: c in $f0 feeds the compares, and v0 only the
  // stores. The declaration decides it.
  const vb1 =
    '   0:\tnop\n   4:\tmul.s\t$f0,$f12,$f14\n   8:\tc.lt.s\t$f0,$f12\n\t...\n  14:\tbc1f\t20 <vb1+0x20>\n' +
    '  18:\tli\tv0,1\n  1c:\tsw\tv0,0(a2)\n  20:\tc.lt.s\t$f14,$f0\n\t...\n  2c:\tbc1f\t38 <vb1+0x38>\n' +
    '  30:\tli\tv0,2\n  34:\tsw\tv0,0(a2)\n  38:\tjr\tra\n  3c:\tnop\n';
  test('where neither home holds a value computed only to be returned, the declaration decides', () => {
    expect(() => kmc('vb1', vb1)).toThrow('whether it returns $f0, v0 or nothing is not decided by the bytes');
    expect(kmc('vb1', vb1, { vb1: { returnsVoid: true } })).toMatch(/^void vb1\(float a0, float a1, s32 \*a2\)/);
    expect(kmc('vb1', vb1, { vb1: { params: ['float', 'float', 'int *'], returns: 'float' } })).toContain(
      'return a0 * a1;',
    );
  });

  // float fround(float x){ return (float)(int)x; } at KMC moves the truncated word out through v0 and
  // back in: v0 is read by the `mtc1`, and the `cvt.s.w` in $f0 only by the return.
  test('the float home returns where its value is computed only to be returned', () => {
    expect(
      kmc(
        'fround',
        '   0:\ttrunc.w.s\t$f0,$f12\n   4:\tmfc1\tv0,$f0\n   8:\tnop\n   c:\tmtc1\tv0,$f0\n  10:\tnop\n' +
          '  14:\tjr\tra\n  18:\tcvt.s.w\t$f0,$f0\n  1c:\tnop\n',
      ),
    ).toBe('float fround(float a0) {\n    return (float)(s32)a0;\n}\n');
  });

  // `mtc1 zero,$f0` is how the MIPS compilers return 0.0f: the word's bits as a float.
  test('an integer word in the float home at a return refuses', () => {
    expect(() => kmc('fz', '   0:\tmtc1\tzero,$f0\n   4:\tjr\tra\n   8:\tnop\n')).toThrow(
      "$f0, the float return register, holds an integer word at a return that an 'mtc1' moved in",
    );
    // float fz2(float a, float b){ if (a < b) return 0.0f; return a; } at IDO, where one path returns
    // the word and the other the float argument.
    const fz2 =
      '   0:\tc.lt.s\t$f12,$f14\n   4:\tnop\n   8:\tbc1fl\t20 <fz2+0x20>\n   c:\tmov.s\t$f0,$f12\n' +
      '  10:\tmtc1\tzero,$f0\n  14:\tjr\tra\n  18:\tnop\n  1c:\tmov.s\t$f0,$f12\n  20:\tjr\tra\n  24:\tnop\n';
    expect(() => lift('fz2', fz2)).toThrow('holds an integer word at a return');
    expect(() =>
      decompile('fz2', objdump('fz2', fz2), MIPS_IDO, {
        prototypes: { fz2: { params: ['float', 'float'], returns: 'float' } },
      }),
    ).toThrow('a return reads an integer word from $f0, the float return register');
  });

  // typedef union { int i; float f; } U; float u3(float a, float b){ U u; u.i = a < b ? 0x3f800000 :
  // 0x40000000; return u.f; } and float u4(float a){ U u; u.i = (int)a << 1; return u.f; } at KMC
  // compute the word in v0 and move it into $f0. v0's only reader in the IR is the return, as in
  // KMC's f2i, which moves its word the other way.
  test('a word moved into the float home refuses, though the integer home seems to prove itself', () => {
    const u3 =
      '   0:\tc.lt.s\t$f12,$f14\n   4:\tnop\n   8:\tnop\n   c:\tbc1t\t18 <u3+0x18>\n  10:\tlui\tv0,0x4000\n' +
      '  14:\tlui\tv0,0x3f80\n  18:\tmtc1\tv0,$f0\n  1c:\tjr\tra\n  20:\tnop\n';
    const u4 =
      '   0:\ttrunc.w.s\t$f0,$f12\n   4:\tmfc1\tv0,$f0\n   8:\tnop\n   c:\tsll\tv0,v0,0x1\n' +
      '  10:\tmtc1\tv0,$f0\n  14:\tjr\tra\n  18:\tnop\n';
    const moved = "holds an integer word at a return that an 'mtc1' moved in from the integer file";
    expect(() => kmc('u3', u3)).toThrow(moved);
    expect(() => kmc('u4', u4)).toThrow(moved);
    // the own declaration of an integer return says the caller reads v0
    expect(kmc('u4', u4, { u4: { params: ['float'], returns: 'int' } })).toContain('return (s32)a0 << 1;');
  });

  // float mx(float a, float b, int *p){ if (a < b) *p = 1; return a; } at mwcc leaves f1, the first
  // float argument, untouched — one object with the same function returning `p` in r3.
  const mx = '   0:\tfcmpo   cr0,f1,f2\n   4:\tbgelr-\n   8:\tli      r0,1\n   c:\tstw     r0,0(r3)\n  10:\tblr\n';
  test('PowerPC: the float argument in f1 and the pointer in r3, and only the declaration decides', () => {
    expect(() => decompile('mx', objdump('mx', mx), PPC_MWCC)).toThrow(
      'whether it returns f1, r3 or nothing is not decided by the bytes',
    );
    const src = decompile('mx', objdump('mx', mx), PPC_MWCC, {
      prototypes: { mx: { params: ['float', 'float', 'int *'], returns: 'float' } },
    }).source;
    expect(src).toMatch(/^float mx\(/);
    expect(src).toMatch(/return a1;/);
  });
});

describe('PowerPC: a float compare in a condition-register field', () => {
  const ppc = (sym: string, body: string) => decompile(sym, objdump(sym, body), PPC_MWCC).source;
  // An FPR holds a double whichever the source declared, and mwcc compiles the float and double
  // spellings of each of these to one object: the precision is unstated, and spells `float`.
  test.each([
    // int fcmp(float a, float b){ return a > b; } — the GT bit, rotated to the bottom
    ['fcmp', '   0:\tfcmpo   cr0,f1,f2\n   4:\tmfcr    r0\n   8:\trlwinm  r3,r0,2,31,31\n   c:\tblr\n', 'a0 > a1'],
    // int flt(float a, float b){ return a < b; } — the LT bit, shifted down
    ['flt', '   0:\tfcmpo   cr0,f1,f2\n   4:\tmfcr    r0\n   8:\tsrwi    r3,r0,31\n   c:\tblr\n', 'a0 < a1'],
    // int fle(float a, float b){ return a <= b; } — `cror eq,lt,eq` makes EQ the OR
    [
      'fle',
      '   0:\tfcmpo   cr0,f1,f2\n   4:\tcror    eq,lt,eq\n   8:\tmfcr    r0\n   c:\trlwinm  r3,r0,3,31,31\n  10:\tblr\n',
      'a0 <= a1',
    ],
    // int feq(float a, float b){ return a == b; } — the quiet compare
    ['feq', '   0:\tfcmpu   cr0,f1,f2\n   4:\tmfcr    r0\n   8:\trlwinm  r3,r0,3,31,31\n   c:\tblr\n', 'a0 == a1'],
  ])('%s, a bit of an mfcr copy', (sym, body, value) => {
    expect(ppc(sym, body)).toBe(`s32 ${sym}(float a0, float a1) {\n    return ${value};\n}\n`);
  });

  // int fcmpngt(float a, float b){ return !(a > b); } — the GT bit, then `cntlzw >> 5`, its zero
  // test: the negation of the compare, which is the unordered one, never `a <= b`.
  test('a zero test of an extracted bit is the negated compare', () => {
    expect(
      ppc(
        'fcmpngt',
        '   0:\tfcmpo   cr0,f1,f2\n   4:\tmfcr    r0\n   8:\trlwinm  r0,r0,2,31,31\n   c:\tcntlzw  r0,r0\n' +
          '  10:\tsrwi    r3,r0,5\n  14:\tblr\n',
      ),
    ).toBe('s32 fcmpngt(float a0, float a1) {\n    return !(a0 > a1);\n}\n');
  });

  // void fbr(float a, float b, int *p){ if (a > b) *p = 1; } — `blelr-` returns when GT is CLEAR,
  // which is `!(a > b)`, true on a NaN; the store is guarded by `a > b`. Declared void, because the
  // bytes are also those of a float function returning `a`.
  test('a conditional return on a cleared bit is the unordered compare', () => {
    const src = decompile(
      'fbr',
      objdump(
        'fbr',
        '   0:\tfcmpo   cr0,f1,f2\n   4:\tblelr-\n   8:\tli      r0,1\n   c:\tstw     r0,0(r3)\n  10:\tblr\n',
      ),
      PPC_MWCC,
      { prototypes: { fbr: { returnsVoid: true } } },
    ).source;
    expect(src).toContain('if (a1 > a2) {');
  });

  // int f2i(float x){ return (int)x; } — the integer word reaches r3 through the frame, low word.
  test('fctiwz through the frame is the cast to int', () => {
    expect(
      ppc(
        'f2i',
        '   0:\tfctiwz  f0,f1\n   4:\tstwu    r1,-16(r1)\n   8:\tstfd    f0,8(r1)\n   c:\tlwz     r3,12(r1)\n' +
          '  10:\taddi    r1,r1,16\n  14:\tblr\n',
      ),
    ).toBe('s32 f2i(float a0) {\n    return (s32)a0;\n}\n');
  });

  // int d2i(double x){ return (int)x; } is the same object: neither fctiwz nor fcmpo states a
  // precision, so the own declaration does, and one stating both refuses.
  test('the own declaration states the precision the instructions do not', () => {
    const f2i =
      '   0:\tfctiwz  f0,f1\n   4:\tstwu    r1,-16(r1)\n   8:\tstfd    f0,8(r1)\n   c:\tlwz     r3,12(r1)\n' +
      '  10:\taddi    r1,r1,16\n  14:\tblr\n';
    const lifted = (params: string[]) =>
      decompile('d2i', objdump('d2i', f2i), PPC_MWCC, { prototypes: { d2i: { params, returns: 'int' } } }).source;
    expect(lifted(['double'])).toBe('s32 d2i(double a0) {\n    return (s32)a0;\n}\n');
    expect(lifted(['float'])).toBe('s32 d2i(float a0) {\n    return (s32)a0;\n}\n');
    const fcmp = '   0:\tfcmpo   cr0,f1,f2\n   4:\tmfcr    r0\n   8:\tsrwi    r3,r0,31\n   c:\tblr\n';
    expect(() =>
      decompile('mixd', objdump('mixd', fcmp), PPC_MWCC, {
        prototypes: { mixd: { params: ['float', 'double'], returns: 'int' } },
      }),
    ).toThrow("'fcmpo' is in a function that computes in both single and double precision");
  });

  test('…and its high word is no value', () => {
    expect(() =>
      ppc(
        'f2i',
        '   0:\tfctiwz  f0,f1\n   4:\tstwu    r1,-16(r1)\n   8:\tstfd    f0,8(r1)\n   c:\tlwz     r3,8(r1)\n' +
          '  10:\taddi    r1,r1,16\n  14:\tblr\n',
      ),
    ).toThrow('reload of a stack local');
    // Hand asm: a word stored there before the `stfd` is no longer what a reload reads.
    const declared = { prototypes: { ff: { params: ['int', 'float'], returns: 'int' } } };
    const over =
      '   0:\tfctiwz  f0,f1\n   4:\tstwu    r1,-16(r1)\n   8:\taddi    r4,r3,5\n   c:\tstw     r4,8(r1)\n' +
      '  10:\tstfd    f0,8(r1)\n  14:\tlwz     r3,8(r1)\n  18:\taddi    r1,r1,16\n  1c:\tblr\n';
    const high = "the high word the 'stfd' at 0x10 stores is reloaded and used";
    expect(() => decompile('ff', objdump('ff', over), PPC_MWCC, declared)).toThrow(high);
    // …nor on the path that stored it, where a join meets the other path's word
    const joined =
      '   0:\tfctiwz  f0,f1\n   4:\tstwu    r1,-16(r1)\n   8:\tcmpwi   r3,0\n   c:\tbeq     18 <ff+0x18>\n' +
      '  10:\tstfd    f0,8(r1)\n  14:\tb       1c <ff+0x1c>\n  18:\tstw     r3,8(r1)\n  1c:\tlwz     r3,8(r1)\n' +
      '  20:\taddi    r1,r1,16\n  24:\tblr\n';
    expect(() => decompile('ff', objdump('ff', joined), PPC_MWCC, declared)).toThrow(high);
  });

  test('an ordering bit of the quiet compare refuses', () => {
    expect(() =>
      ppc('g', '   0:\tfcmpu   cr0,f1,f2\n   4:\tmfcr    r0\n   8:\trlwinm  r3,r0,2,31,31\n   c:\tblr\n'),
    ).toThrow('extracts from a copy of the condition register something other than one bit a float compare set');
    expect(() => ppc('g', '   0:\tfcmpu   cr0,f1,f2\n   4:\tblelr-\n   8:\tli      r3,1\n   c:\tblr\n')).toThrow(
      "conditional branch 'ble' orders the operands of an 'fcmpu'",
    );
  });

  test('a copy of the condition register read as an integer refuses', () => {
    expect(() => ppc('g', '   0:\tfcmpo   cr0,f1,f2\n   4:\tmfcr    r3\n   8:\tblr\n')).toThrow(
      "a copy of the condition register ('mfcr') is read as an integer",
    );
  });

  test('a cror across two fields refuses', () => {
    expect(() =>
      ppc(
        'g',
        '   0:\tfcmpo   cr0,f1,f2\n   4:\tcror    eq,4*cr1+lt,eq\n   8:\tbeqlr-\n   c:\tli      r3,1\n  10:\tblr\n',
      ),
    ).toThrow("'cror' at 0x4 — only an OR of two bits of the field a float compare set");
  });
});
