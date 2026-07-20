// Pin tests for the readability heuristic — a transparent proxy whose exact numbers are
// published per row, so a refactor must not silently move scores. Pins cover each penalty class
// and the clean baseline.
import { describe, expect, test } from 'vitest';

import { assessQuality } from '../src/eval/quality';

describe('assessQuality (pinned)', () => {
  test('clean structured output scores 100', () => {
    const q = assessQuality('int add(int a, int b) {\n    return a + b;\n}\n');
    expect(q).toEqual({ score: 100, lines: 3, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 });
  });

  test('gotos and labels are penalized', () => {
    const q = assessQuality(
      'int f(int a) {\nL1:\n    if (a > 0) goto L2;\n    a += 1;\n    goto L1;\nL2:\n    return a;\n}\n',
    );
    expect(q).toEqual({ score: 76, lines: 8, gotos: 2, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 });
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
    expect(q).toEqual({ score: 90, lines: 3, gotos: 0, casts: 5, unkGlue: 0, rawMem: 1, addrDeref: 0 });
  });

  test('absolute-address derefs are counted but not score-penalized', () => {
    const q = assessQuality('void f(void) {\n    *(vu16 *)0x04000052 = 0x100;\n}\n');
    expect(q.addrDeref).toBe(1);
    expect(q.rawMem).toBe(0); // disjoint from *(T*)(expr) raw memory casts
    expect(q.score).toBe(100); // counted only — the score formula is pinned and unaffected
  });
});
