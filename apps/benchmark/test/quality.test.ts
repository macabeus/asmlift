// Pin tests for the readability heuristic — a transparent proxy whose exact numbers are
// published per row, so a refactor must not silently move scores. Pins cover each penalty class
// and the clean baseline.
import { describe, expect, test } from 'vitest';

import { assessQuality } from '../src/eval/quality';

const NO_HABITS = {
  ptrDeref0: 0,
  decimalMasks: 0,
  incrStmts: 0,
  compoundStmts: 0,
  voidTail: 0,
  elseAfterReturn: 0,
  callNeZero: 0,
  localGaps: 0,
  unusedLocals: 0,
  placeholderParams: 0,
  genericCounters: 0,
};

describe('assessQuality (pinned)', () => {
  test('clean structured output scores 100', () => {
    const q = assessQuality('int add(int a, int b) {\n    return a + b;\n}\n');
    expect(q).toEqual({
      score: 100,
      lines: 3,
      gotos: 0,
      casts: 0,
      unkGlue: 0,
      rawMem: 0,
      addrDeref: 0,
      habits: NO_HABITS,
    });
  });

  test('gotos and labels are penalized', () => {
    const q = assessQuality(
      'int f(int a) {\nL1:\n    if (a > 0) goto L2;\n    a += 1;\n    goto L1;\nL2:\n    return a;\n}\n',
    );
    expect(q).toEqual({
      score: 76,
      lines: 8,
      gotos: 2,
      casts: 0,
      unkGlue: 0,
      rawMem: 0,
      addrDeref: 0,
      habits: NO_HABITS,
    });
  });

  test('m2c glue markers are the strongest penalty', () => {
    const q = assessQuality('s32 f(s32 arg0) {\n    return M2C_ERROR(/* unknown instruction */) + M2C_UNK;\n}\n');
    expect(q.unkGlue).toBe(3); // M2C_ERROR + M2C_UNK + "unknown instruction" inside the comment
    expect(q.score).toBe(64);
  });

  test('ASMLIFT_ERROR counts as glue for asmlift output', () => {
    const q = assessQuality("void f(void) {\n    ASMLIFT_ERROR('could not decompile');\n}\n");
    expect(q.unkGlue).toBe(1);
    expect(q.score).toBe(88);
  });

  test('raw memory casts and excess casts are penalized', () => {
    const q = assessQuality('int f(void *p) {\n    return *(int *)(p) + (u8)1 + (s16)2 + (u32)3 + (int)4;\n}\n');
    expect(q).toEqual({
      score: 90,
      lines: 3,
      gotos: 0,
      casts: 5,
      unkGlue: 0,
      rawMem: 1,
      addrDeref: 0,
      habits: NO_HABITS,
    });
  });

  test('project-idiom address casts are exempt: (u32)&Sym, (s32)&Sym, (u32)Func', () => {
    const q = assessQuality(
      'void f(u32 a0) {\n' + // (the parameter-list `(void)` artifact would count — irrelevant here)
        '    if ((u32)&gBgInfo == (u32)&GwCommon + 4) {\n' +
        '        DoThing((s32)&gDefaultFontPalette < 0, (u32)thunk_sub_080002A0);\n' +
        '    }\n' +
        '}\n',
    );
    expect(q.casts).toBe(0); // all four are the correct address spelling, not cast noise
    expect(q.score).toBe(100);
  });

  test('u32 casts of generic locals and of call RESULTS stay counted', () => {
    // (u32)a0 / (u32)var_x truncate a LOCAL value; (u32)DoThing(1) casts a call result —
    // none of them is an address spelling, so all three still count (plus (s16)2 = 4 > 2).
    const q = assessQuality('u32 f(s32 a0) {\n    return (u32)a0 + (u32)var_x + (u32)DoThing(1) + (s16)2;\n}\n');
    expect(q.casts).toBe(4);
    expect(q.score).toBe(96);
  });

  test('u32 casts of DECLARED names stay counted, whatever the name', () => {
    // a parameter and a local named by a context or a renaming pass are values, not addresses;
    // an undeclared bare name is still read as a code address
    const q = assessQuality(
      'u32 f(s32 count) {\n    s32 i;\n    i = count;\n    return (u32)count + (u32)i + (u32)Func;\n}\n',
    );
    expect(q.casts).toBe(2);
  });

  test('absolute-address derefs are counted but not score-penalized', () => {
    const q = assessQuality('void f(void) {\n    *(vu16 *)0x04000052 = 0x100;\n}\n');
    expect(q.addrDeref).toBe(1);
    expect(q.rawMem).toBe(0); // disjoint from *(T*)(expr) raw memory casts
    expect(q.score).toBe(100); // counted only — the score formula is pinned and unaffected
  });
});

describe('assessQuality habit counters (counted, never score-penalized)', () => {
  const habits = (src: string) => assessQuality(src).habits!;

  test('*p beside a constant subscript of the same p', () => {
    const src = 'u8 f(u8 *a0) {\n    u8 *v0;\n    v0 = a0;\n    return *v0 + v0[2] + a0[1] * *a0 + 2 * v0[1];\n}\n';
    // `*v0` and `*a0` both count; the declaration `u8 *v0;` and the multiplication do not
    expect(habits(src).ptrDeref0).toBe(2);
    expect(habits(src.replace('*v0 +', 'v0[0] +').replace('* *a0', '* a0[0]')).ptrDeref0).toBe(0);
  });

  test('decimal literals of 10 or more as bitwise operands, shifted values and addresses', () => {
    const src =
      'void f(u32 a0) {\n    *(u16 *)67109384 = (a0 & 64) | 3;\n    g(~255, 255 << 8, a0 << 24, a0 && 64, a0 + 64);\n}\n';
    // & 64, ~255, 255 <<, (u16 *)67109384 — not `| 3` (under 10), not the shift count 24, not `&& 64`, not `+ 64`
    expect(habits(src).decimalMasks).toBe(4);
    expect(
      habits(src.replace('64)', '0x40)').replace('~255, 255', '~0xFF, 0xFF').replace('67109384', '0x4000208'))
        .decimalMasks,
    ).toBe(0);
  });

  test('statement-level increments and compound assignments', () => {
    const src =
      'void f(s32 a0, u8 *a1) {\n    s32 v0;\n    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n        a1[v0] = a1[v0] + 3;\n    }\n' +
      '    a0 = a0 - 1;\n    a0 = a0 + a0 << 2;\n    a0 = a0 - (a0 >> 1);\n}\n';
    const h = habits(src);
    expect(h.incrStmts).toBe(2); // the for update and `a0 = a0 - 1`
    expect(h.compoundStmts).toBe(2); // `a1[v0] = a1[v0] + 3` and `a0 = a0 - (a0 >> 1)`, never `a0 + a0 << 2`
  });

  test('a void function: trailing return and an empty default closing its final switch', () => {
    const src =
      'void f(s32 a0) {\n    switch (a0) {\n    case 1:\n        g();\n        break;\n    default:\n        break;\n    }\n}\n';
    expect(habits(src).voidTail).toBe(1);
    expect(habits('void f(void) {\n    g();\n    return;\n}\n').voidTail).toBe(1);
    expect(habits('s32 f(void) {\n    g();\n    return 0;\n}\n').voidTail).toBe(0);
  });

  test('else after a branch that returns', () => {
    const src =
      's32 f(s32 a0) {\n    if (a0 == 0) {\n        return 1;\n    } else {\n        g();\n    }\n    return 0;\n}\n';
    expect(habits(src).elseAfterReturn).toBe(1);
  });

  test('!= 0 on the truth test of a call', () => {
    const src =
      's32 f(s32 a0) {\n    if (g(a0, h(1)) != 0) {\n        return 1;\n    }\n    while (a0 != 0 && g(a0) != 0) {\n    }\n    return (g(a0) != 0) + 1;\n}\n';
    expect(habits(src).callNeZero).toBe(2); // the `if` and the `&&` operand, not `a0 != 0` nor a value
  });

  test('local numbering gaps and unused locals', () => {
    const src =
      's32 f(s32 a0) {\n    s32 v0;\n    s32 v2;\n    u8 *v5;\n    v0 = a0;\n    v2 = v0 + 1;\n    return v2;\n}\n';
    const h = habits(src);
    expect(h.localGaps).toBe(3); // v1, v3, v4
    expect(h.unusedLocals).toBe(1); // v5
  });

  test('placeholder parameters and loop tests reading a generic local', () => {
    const src =
      's32 f(s32 a0, u8 *a1, s32 n) {\n    s32 v0;\n    s32 i;\n    for (i = 0; i < n; i++) {\n    }\n    while (v0 < a0) {\n        v0++;\n    }\n    do {\n    } while (v0 != 0);\n    return v0;\n}\n';
    const h = habits(src);
    expect(h.placeholderParams).toBe(2); // a0, a1; not n
    expect(h.genericCounters).toBe(2); // the `while` and the `do`'s test; not the `for` over i
    expect(habits('void f(void) {\n}\n').placeholderParams).toBe(0);
    // a function pointer's own list is not split, and its name and an array's are both read
    expect(habits('s32 f(s32 a0, void (*a1)(s32, s32)) {\n    a1(a0, 1);\n    return a0;\n}\n').placeholderParams).toBe(
      2,
    );
    expect(habits('s32 f(u8 a0[4], s32 a1) {\n    return a0[a1];\n}\n').placeholderParams).toBe(2);
    expect(habits('s32 f(s32 (*cb)(s32 a0), s32 a1) {\n    return cb(a1);\n}\n').placeholderParams).toBe(1);
  });
});
