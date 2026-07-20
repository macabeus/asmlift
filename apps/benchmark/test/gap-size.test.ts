// Pin tests for the gapSize annotation: it MEASURES the best compiling candidate's distance —
// it never predicts closability, and it must never manufacture a number when nothing compiled.
import type { DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import { gapSize } from '../src/report/gap-size';

const res = (over: Partial<DecompilerResult>): DecompilerResult => ({
  decompiler: 'asmlift',
  outcome: 'declined',
  source: '',
  score: null,
  maxScore: null,
  compileErrors: null,
  quality: { score: 0, lines: 0, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
  ...over,
});

const row = (asmlift: DecompilerResult, m2c: DecompilerResult): FunctionResult =>
  ({ id: 't', asmlift, m2c }) as FunctionResult;

describe('gapSize (pinned)', () => {
  test('null when either decompiler matched (already solved)', () => {
    expect(gapSize(row(res({ outcome: 'match', score: 0 }), res({})))).toBeNull();
    expect(gapSize(row(res({}), res({ outcome: 'match', score: 0 })))).toBeNull();
  });

  test('null when neither produced a scored candidate — absence, not a guess', () => {
    expect(gapSize(row(res({ outcome: 'declined' }), res({ outcome: 'noncompile' })))).toBeNull();
  });

  test('picks the smallest-diff nonmatch candidate and reports measured fields only', () => {
    const kinds = { insert: 1, delete: 0, replace: 0, opMismatch: 0, argMismatch: 2 };
    const g = gapSize(
      row(
        res({ outcome: 'nonmatch', score: 7, maxScore: 20 }),
        res({ decompiler: 'm2c', outcome: 'nonmatch', score: 3, maxScore: 24, breakdown: kinds }),
      ),
    )!;
    expect(g).toEqual({ decompiler: 'm2c', score: 3, maxScore: 24, ratio: 3 / 24, kinds });
  });

  test('a lone scored candidate wins even when the other column failed', () => {
    const g = gapSize(row(res({ outcome: 'nonmatch', score: 12, maxScore: 30 }), res({ outcome: 'failed' })))!;
    expect(g.decompiler).toBe('asmlift');
    expect(g.ratio).toBeCloseTo(0.4);
  });
});
