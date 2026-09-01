// Pin tests for the measurement-neutrality gate: which fields it watches, and the two kinds of
// difference it must NOT report (provenance, and run-local scratch names inside a source).
import type { BenchOutput, DecompilerResult, FunctionResult, Outcome } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import { compareMeasurements, notRegenerated } from '../src/report/diff';

const res = (over: Partial<DecompilerResult> = {}): DecompilerResult =>
  ({
    decompiler: 'asmlift',
    outcome: 'nonmatch' as Outcome,
    source: 'void f(void) {}',
    score: 12,
    maxScore: 40,
    compileErrors: null,
    quality: { score: 0, lines: 0, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
    ...over,
  }) as DecompilerResult;

const row = (
  id: string,
  asmlift: Partial<DecompilerResult> = {},
  m2c: Partial<DecompilerResult> = {},
): FunctionResult => ({ id, asmlift: res(asmlift), m2c: { ...res(m2c), decompiler: 'm2c' } }) as FunctionResult;

const out = (...results: FunctionResult[]): BenchOutput =>
  ({ meta: { generatedAt: 'whenever' }, results }) as unknown as BenchOutput;

const at = (generatedAt: string): BenchOutput => ({ meta: { generatedAt }, results: [] }) as unknown as BenchOutput;

describe('compareMeasurements', () => {
  test('identical rows: nothing moved', () => {
    const r = compareMeasurements(out(row('a')), out(row('a')));
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual([]);
  });

  test('a score that moves without changing the outcome is caught — the case `regression` misses', () => {
    const r = compareMeasurements(out(row('a', { score: 12 })), out(row('a', { score: 14 })));
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([{ id: 'a', field: 'asmlift.score', from: '12', to: '14' }]);
  });

  test('the ranked WINNER changing identity at an equal score is a change', () => {
    const r = compareMeasurements(
      out(row('a', { candidateLabel: 'signed' })),
      out(row('a', { candidateLabel: 'signed/flip-join' })),
    );
    expect(r.changed.map((c) => c.field)).toEqual(['asmlift.candidateLabel']);
  });

  test('both decompilers are watched, and source is reported by size not pasted', () => {
    const r = compareMeasurements(out(row('a')), out(row('a', {}, { source: 'void f(void) { /* longer */ }' })));
    expect(r.changed).toEqual([{ id: 'a', field: 'm2c.source', from: '15 bytes', to: '29 bytes' }]);
  });

  test('a quality block that moves is reported, and an identical one is not', () => {
    const q = { score: 100, lines: 3, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 };
    expect(compareMeasurements(out(row('a', { quality: q })), out(row('a', { quality: { ...q } }))).changed).toEqual(
      [],
    );
    const moved = compareMeasurements(out(row('a', { quality: q })), out(row('a', { quality: { ...q, casts: 1 } })));
    expect(moved.changed.map((c) => c.field)).toEqual(['asmlift.quality']);
  });

  test('a run-local scratch name inside a source is NOT a measurement change', () => {
    const r = compareMeasurements(
      out(row('a', { source: '/* asmlift-usercc-Ab12Cd/cand.c */ void f(void) {}' })),
      out(row('a', { source: '/* asmlift-usercc-Zz98Yx/cand.c */ void f(void) {}' })),
    );
    expect(r.ok).toBe(true);
  });

  test('a vanished row is REMOVED, a new row is ADDED, and either fails the gate', () => {
    const r = compareMeasurements(out(row('a'), row('b')), out(row('a'), row('c')));
    expect(r.removed).toEqual(['b']);
    expect(r.added).toEqual(['c']);
    expect(r.ok).toBe(false);
  });

  test('provenance and timings are not compared — only the six fields', () => {
    const base = out(row('a'));
    const fresh = out(row('a'));
    (fresh.meta as unknown as Record<string, unknown>).generatedAt = 'much later';
    (fresh.results[0].asmlift as unknown as Record<string, unknown>).maxScore = 999;
    expect(compareMeasurements(base, fresh).ok).toBe(true);
  });
});

// The gate reads a COMMITTED file, so on a clean source-only branch it is already the base's own
// artifact: run it without running the benchmark and it compares the base against itself and
// prints a green line in about a second. That line is what a PR publishes as its proof.
describe('notRegenerated', () => {
  test('the same stamp as the base means no run stands behind the comparison', () => {
    expect(notRegenerated(at('2026-08-22T21:42:27.432Z'), at('2026-08-22T21:42:27.432Z'))).toBe(true);
  });

  test('a real merge re-mints generatedAt, so a genuine regeneration always passes', () => {
    expect(notRegenerated(at('2026-08-22T21:42:27.432Z'), at('2026-08-23T09:01:04.005Z'))).toBe(false);
  });
});

// THE SECOND POPULATION `diffGate` PRINTS. Rows the branch added are `ADDED` against the branch
// POINT every time, for as long as the branch lives — so a score on one of them can move in either
// direction and the published line still reads `0 field change(s), N added`. `regression` sees only
// OUTCOME, so a score move on an added row was named by nothing at all. The gate narrows the
// branch's own artifact to those rows and compares them by the same fields; it changes no exit
// code (an addition already makes the base report not-ok), it supplies the missing names.
describe('the rows a branch added, compared against the branch own artifact', () => {
  const base = out(row('a'));
  const self = out(row('a'), row('b', { score: 0, outcome: 'match' as Outcome }));
  const addedRows = (b: BenchOutput, s: BenchOutput): BenchOutput => {
    const ids = new Set(b.results.map((r) => r.id));
    return { ...s, results: s.results.filter((r) => !ids.has(r.id)) } as BenchOutput;
  };

  test('a score move on an added row is invisible against the base and named against the branch', () => {
    const fresh = out(row('a'), row('b', { score: 5, outcome: 'nonmatch' as Outcome }));
    expect(compareMeasurements(base, fresh).changed).toEqual([]); // the base report: nothing moved
    const seen = compareMeasurements(addedRows(base, self), fresh);
    expect(seen.changed.map((c) => c.field).sort()).toEqual(['asmlift.outcome', 'asmlift.score']);
    expect(seen.changed.every((c) => c.id === 'b')).toBe(true);
  });

  test('a row in BOTH artifacts is not re-reported here — the base report already named it', () => {
    const fresh = out(row('a', { score: 99 }), row('b', { score: 0, outcome: 'match' as Outcome }));
    expect(compareMeasurements(base, fresh).changed.map((c) => c.id)).toEqual(['a']);
    expect(compareMeasurements(addedRows(base, self), fresh).changed).toEqual([]);
  });
});
