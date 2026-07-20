// Pin tests for the match-regression gate: a lost match or a vanished row FAILS; every other
// outcome movement (gains, nonmatch reshuffles, new rows) is reported but never a failure.
import type { BenchOutput, DecompilerResult, FunctionResult, Outcome } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import { compareOutcomes } from '../src/report/regression';

const res = (outcome: Outcome): DecompilerResult => ({
  decompiler: 'asmlift',
  outcome,
  source: '',
  score: outcome === 'match' ? 0 : null,
  maxScore: null,
  compileErrors: null,
  quality: { score: 0, lines: 0, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
});

const row = (id: string, asmlift: Outcome, m2c: Outcome): FunctionResult =>
  ({ id, asmlift: res(asmlift), m2c: { ...res(m2c), decompiler: 'm2c' } }) as FunctionResult;

const out = (...results: FunctionResult[]): BenchOutput => ({ meta: {}, results }) as unknown as BenchOutput;

describe('compareOutcomes (the mechanical zero-lost gate)', () => {
  test('identical runs pass', () => {
    const r = compareOutcomes(out(row('a', 'match', 'nonmatch')), out(row('a', 'match', 'nonmatch')));
    expect(r.ok).toBe(true);
    expect(r.lost).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test('an asmlift match→nonmatch flip FAILS and names the row', () => {
    const r = compareOutcomes(out(row('a', 'match', 'declined')), out(row('a', 'nonmatch', 'declined')));
    expect(r.ok).toBe(false);
    expect(r.lost).toEqual([{ id: 'a', decompiler: 'asmlift', from: 'match', to: 'nonmatch' }]);
  });

  test('EVERY match→non-match destination fails, not just nonmatch', () => {
    for (const to of ['declined', 'noncompile', 'failed'] as const) {
      expect(compareOutcomes(out(row('a', 'match', 'failed')), out(row('a', to, 'failed'))).ok).toBe(false);
    }
  });

  test('an m2c lost match ALSO fails — m2c is pinned, so the flip means the harness regressed', () => {
    const r = compareOutcomes(out(row('a', 'declined', 'match')), out(row('a', 'declined', 'nonmatch')));
    expect(r.ok).toBe(false);
    expect(r.lost[0]).toMatchObject({ decompiler: 'm2c' });
  });

  test('a committed row missing from the fresh run fails — a skipped toolchain must be LOUD', () => {
    const r = compareOutcomes(
      out(row('a', 'match', 'match'), row('b', 'nonmatch', 'failed')),
      out(row('a', 'match', 'match')),
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['b']);
  });

  test('gains and non-match reshuffles are informational, never failures', () => {
    const r = compareOutcomes(
      out(row('gain', 'nonmatch', 'declined'), row('shuffle', 'declined', 'noncompile')),
      out(row('gain', 'match', 'declined'), row('shuffle', 'noncompile', 'noncompile')),
    );
    expect(r.ok).toBe(true);
    expect(r.gained).toEqual([{ id: 'gain', decompiler: 'asmlift', from: 'nonmatch', to: 'match' }]);
    expect(r.changed).toEqual([{ id: 'shuffle', decompiler: 'asmlift', from: 'declined', to: 'noncompile' }]);
  });

  test('rows ADDED in the fresh run are fine (dataset growth is not a regression)', () => {
    const r = compareOutcomes(
      out(row('a', 'match', 'match')),
      out(row('a', 'match', 'match'), row('new', 'failed', 'failed')),
    );
    expect(r.ok).toBe(true);
  });
});
