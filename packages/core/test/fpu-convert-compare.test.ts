// Hardware floating point, between the files: on MIPS the conversions (`trunc.w`, `cvt.s.w`/`cvt.d.w`,
// with `mfc1`/`mtc1` moving the integer word) and the compares (`c.eq`/`c.lt`/`c.le` and the branch on
// the condition code they set); on PowerPC `fctiwz` through the frame and `fcmpo`/`fcmpu` through a
// condition-register field, a branch, a `cror` or an `mfcr` extract — onto the IR's conversions and
// float compares. Every listing is the
// toolchain's own at its canonical flags, and each lift recompiles to it (checked when taken).
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

  // float fround(float x){ return (float)(int)x; } at KMC moves the truncated word out through v0,
  // so both homes are written and a float reaches the integer file: which one returns is undecided.
  test('a function writing both return homes and moving a float into the integer file', () => {
    expect(() =>
      lift(
        'fround',
        '   0:\ttrunc.w.s\t$f0,$f12\n   4:\tmfc1\tv0,$f0\n   8:\tnop\n   c:\tmtc1\tv0,$f0\n  10:\tnop\n' +
          '  14:\tjr\tra\n  18:\tcvt.s.w\t$f0,$f0\n  1c:\tnop\n',
        MIPS_GCC,
      ),
    ).toThrow("it writes both $f0 and v0 (the 'mfc1' at 0x4)");
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

  // void fbr(float a, float b){ if (a > b) gI = 1; } — `blelr-` returns when GT is CLEAR, which is
  // `!(a > b)`, true on a NaN; the store is guarded by `a > b`.
  test('a conditional return on a cleared bit is the unordered compare', () => {
    const src = ppc(
      'fbr',
      '   0:\tfcmpo   cr0,f1,f2\n   4:\tblelr-\n   8:\tli      r0,1\n   c:\tstw     r0,0(r3)\n  10:\tblr\n',
    );
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

  test('…and its high word is no value', () => {
    expect(() =>
      ppc(
        'f2i',
        '   0:\tfctiwz  f0,f1\n   4:\tstwu    r1,-16(r1)\n   8:\tstfd    f0,8(r1)\n   c:\tlwz     r3,8(r1)\n' +
          '  10:\taddi    r1,r1,16\n  14:\tblr\n',
      ),
    ).toThrow('reload of a stack local');
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
