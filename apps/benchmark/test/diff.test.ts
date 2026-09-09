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
    expect(r.changed).toEqual([{ id: 'a', field: 'asmlift.score', from: '12/40', to: '14/40' }]);
  });

  // THE DENOMINATOR MOVES. `maxScore` is the objdiff row count of the winning candidate's
  // alignment, so a different candidate scores against a different scale: twelve rows moved theirs
  // between `eb6dec7d` and `2fed1e42`, `kleod:CountCollectedGems:agbcc` by 17. Read as a
  // subtraction on a fixed scale, its `290 → 171` bought a six-way "partition of the 290", a
  // 297-predicted / 119-delivered shortfall, and an extra attribution round.
  test('a moving score is shown over its own denominator, not as a bare numerator', () => {
    const r = compareMeasurements(
      out(row('a', { score: 290, maxScore: 404 })),
      out(row('a', { score: 171, maxScore: 387 })),
    );
    expect(r.changed).toContainEqual({ id: 'a', field: 'asmlift.score', from: '290/404', to: '171/387' });
  });

  test('a denominator that moves ALONE is a change, and is named', () => {
    const r = compareMeasurements(out(row('a', { maxScore: 404 })), out(row('a', { maxScore: 387 })));
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([{ id: 'a', field: 'asmlift.maxScore', from: '404', to: '387' }]);
  });

  // `show` renders one SIDE at a time, so a denominator missing on one side only would print
  // `290/404 → 171` and be read as `171/404` — the fixed-scale misreading this rendering exists to
  // stop. A scored side with no `maxScore` therefore prints `?`, never a bare numerator.
  test('a score whose denominator is missing renders `?`, on either side', () => {
    const r = compareMeasurements(
      out(row('a', { score: 12, maxScore: null })),
      out(row('a', { score: 14, maxScore: null })),
    );
    expect(r.changed).toEqual([{ id: 'a', field: 'asmlift.score', from: '12/?', to: '14/?' }]);

    const oneSided = compareMeasurements(
      out(row('b', { score: 290, maxScore: 404 })),
      out(row('b', { score: 171, maxScore: null })),
    );
    expect(oneSided.changed).toContainEqual({ id: 'b', field: 'asmlift.score', from: '290/404', to: '171/?' });
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

  // `compileErrors` used to be this test's stand-in for an uncompared field, which asserted the
  // opposite of the FIELDS rule: the run line prints `noncompile(k)` and the web detail prints
  // `compile errors {n}`, so it IS a published claim. It is now watched, and the sentinel here is
  // provenance alone — the thing the title actually names.
  test('provenance is not compared — only the listed fields', () => {
    const base = out(row('a'));
    const fresh = out(row('a'));
    (fresh.meta as unknown as Record<string, unknown>).generatedAt = 'much later';
    (fresh.results[0] as unknown as Record<string, unknown>).note = 'a re-run on another machine';
    expect(compareMeasurements(base, fresh).ok).toBe(true);
  });

  test('a compiler-error count that moves is a published claim moving', () => {
    const r = compareMeasurements(
      out(row('a', { outcome: 'noncompile' as Outcome, compileErrors: 3 })),
      out(row('a', { outcome: 'noncompile' as Outcome, compileErrors: 7 })),
    );
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([{ id: 'a', field: 'asmlift.compileErrors', from: '3', to: '7' }]);
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
// OUTCOME, so nothing else names a score move on an added row. The gate narrows the branch's own
// artifact to those rows and compares them by the same fields; it changes no exit code (an
// addition already makes the base report not-ok), it supplies the missing names.
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
