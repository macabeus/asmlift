// Pin tests for the measurement-neutrality gate: which fields it watches, and the two kinds of
// difference it must NOT report (provenance, and run-local scratch names inside a source).
import type { BenchOutput, DecompilerResult, FunctionResult, Outcome } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import {
  FAN_ROWS_SHOWN,
  type FanReport,
  compareCost,
  compareFans,
  compareMeasurements,
  costLines,
  fanLines,
  notRegenerated,
} from '../src/report/diff';

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

const drop = (label: string) => ({ label, error: 'did not build' });

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

  // THE DENOMINATOR MOVES: `maxScore` is the objdiff row count of the winning candidate's
  // alignment, so a different candidate scores against a different scale (`290 → 171` is 119
  // points on a scale that also lost 17).
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

  // `show` renders one SIDE at a time, so a denominator that went null on one side only would
  // print `290/404 → 171` and be read as `171/404`. It prints `?` instead.
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

  // `errorMarkers` is the field this repo has already paid for leaving unwatched: `cache.ts`'s
  // `v17:` note records a warm-store entry replaying a compiler error naming a cause the run does
  // not have, with no artifact comparison to catch it.
  test('a declined row that changes WHICH gap it names is a published claim moving', () => {
    const r = compareMeasurements(
      out(row('a', {}, { outcome: 'declined' as Outcome, errorMarkers: ['no frontend for `bl @far`'] })),
      out(row('a', {}, { outcome: 'declined' as Outcome, errorMarkers: ['unhandled switch fall-through'] })),
    );
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([
      {
        id: 'a',
        field: 'm2c.errorMarkers',
        from: '["no frontend for `bl @far`"]',
        to: '["unhandled switch fall-through"]',
      },
    ]);
  });

  // …but a marker differing ONLY in the scratch dir a cold run re-mints is not a moved measurement,
  // the same equality `source` already gets.
  test('a marker quoting a run-local scratch path is not a difference', () => {
    const r = compareMeasurements(
      out(row('a', { errorMarkers: ['/var/folders/x9/bench-run-a1b2c3/t.c:3: parse error'] })),
      out(row('a', { errorMarkers: ['/var/folders/q1/bench-run-z9y8x7/t.c:3: parse error'] })),
    );
    expect(r.ok).toBe(true);
  });

  test('the gap SHAPE moving at an unchanged score is caught', () => {
    const bd = { insert: 1, delete: 1, replace: 2, opMismatch: 4, argMismatch: 4 };
    const r = compareMeasurements(
      out(row('a', { breakdown: bd })),
      out(row('a', { breakdown: { ...bd, opMismatch: 5, argMismatch: 3 } })),
    );
    expect(r.ok).toBe(false);
    expect(r.changed.map((c) => c.field)).toEqual(['asmlift.breakdown']);
  });

  // THE FAN MOVED AND NOTHING ELSE DID. Over `eb6dec7d`→`2fed1e42` this is 2 real rows
  // (`kleod:ProcessInputAndUpdateEntities:agbcc`, `kleod:UpdateHUDCounterDisplay:agbcc`): identical
  // source, identical score, identical label, a different number of spellings that failed to build.
  // The COUNT is watched and the LIST is not — the list runs to 51,840 entries on one row of the
  // current artifact.
  test('a fan that grew is caught, by its count and not by pasting it', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `cand${i}`, error: 'did not build' }));
    const r = compareMeasurements(
      out(row('a', { droppedCandidates: many(41472) })),
      out(row('a', { droppedCandidates: many(51840) })),
    );
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([{ id: 'a', field: 'asmlift.droppedCandidates.length', from: '41472', to: '51840' }]);
  });

  // The count, not the order: a scheduling change that reorders one row's fan moved no measurement.
  //
  // NOTE this is the one watched field whose ORDER is deliberately free — every other one is
  // compared by value, order included.
  test('a fan that only REORDERED is not a difference', () => {
    const r = compareMeasurements(
      out(row('a', { droppedCandidates: [drop('x'), drop('y')] })),
      out(row('a', { droppedCandidates: [drop('y'), drop('x')] })),
    );
    expect(r.ok).toBe(true);
  });

  // An ABSENT list and an empty one are the same published claim (`[ranked] 0 dropped`), so a row
  // that grows the key without growing the fan must not read as a move.
  test('an absent fan counts as 0, not as a difference from an empty one', () => {
    const r = compareMeasurements(out(row('a')), out(row('a', { droppedCandidates: [] })));
    expect(r.ok).toBe(true);
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

// THE FAN, which is a COST and not a claim. It is reported beside the verdict and never inside it:
// a round can multiply the confirming gate's own price by four and move no published number —
// which is exactly what happened while the real tier went 274 s → 1,654 s on an unchanged corpus.
describe('compareFans', () => {
  test('names the rows whose fan moved, biggest absolute move first', () => {
    const r = compareFans(
      out(row('a', { candidateCount: 96 }), row('b', { candidateCount: 59904 })),
      out(row('a', { candidateCount: 192 }), row('b', { candidateCount: 225792 })),
    );
    expect(r.changed).toEqual([
      { id: 'b', from: 59904, to: 225792 },
      { id: 'a', from: 96, to: 192 },
    ]);
    expect([r.baseTotal, r.freshTotal, r.compared]).toEqual([60000, 225984, 2]);
  });

  // The cost question is not the neutrality question: a fan that held is silence here, and a
  // published field that moved is not this section's business.
  test('an unchanged fan moves nothing, whatever the row`s score did', () => {
    const r = compareFans(
      out(row('a', { candidateCount: 96, score: 3 })),
      out(row('a', { candidateCount: 96, score: 9 })),
    );
    expect(r.changed).toEqual([]);
    expect(r.compared).toBe(1);
  });

  // The transition: `origin/main`'s artifact predates the field, and reading `undefined → 96` as a
  // move would report the whole corpus on the first comparison after this lands.
  test('a base row with no recorded count is not a move — it is an unanswerable comparison', () => {
    const r = compareFans(out(row('a')), out(row('a', { candidateCount: 96 })));
    expect(r.changed).toEqual([]);
    expect(r).toMatchObject({ compared: 0, unrecorded: 1, baseTotal: 0, freshTotal: 0 });
  });

  // …and a row this run DECLINED never ranked, so it has no fan to COMPARE. Counting it as a move
  // to 0 would publish a fan collapse for a row nobody enumerated — but it is not silence either:
  // the count the base recorded left the corpus, and `vanished` is where it is said.
  test('a row the fresh run never ranked is not compared — it is recorded as vanished', () => {
    const r = compareFans(out(row('a', { candidateCount: 96 })), out(row('a', { outcome: 'declined' })));
    expect(r).toMatchObject({ compared: 0, unrecorded: 0, changed: [] });
    expect(r.vanished).toEqual([{ id: 'a', from: 96, to: 0 }]);
  });

  // THE FAN THAT LEFT. With no counter for this direction the surviving rows are summed alone, so
  // the biggest fan in the corpus can walk out under a clean `1.00×` over a silently smaller row
  // set — the section's own subject, invisible in the section.
  test('a vanished fan does not read as a perfect 1.00×', () => {
    const r = compareFans(
      out(row('big', { candidateCount: 50000 }), row('a', { candidateCount: 100 })),
      out(row('big', { outcome: 'declined' }), row('a', { candidateCount: 100 })),
    );
    expect(r).toMatchObject({ compared: 1, baseTotal: 100, freshTotal: 100, changed: [] });
    expect(r.vanished).toEqual([{ id: 'big', from: 50000, to: 0 }]);
    const lines = fanLines(r, 'origin/main', 1);
    expect(lines.some((l) => l.includes('big: 50000 → none'))).toBe(true);
    expect(lines.at(-1)).toContain('1 counted at origin/main did not rank here');
  });
});

describe('the fan section', () => {
  const rep = (over: Partial<FanReport> = {}): FanReport =>
    ({
      changed: [],
      compared: 2,
      unrecorded: 0,
      vanished: [],
      baseTotal: 60000,
      freshTotal: 225984,
      ...over,
    }) as FanReport;

  test('prints the multiplier, which is the number a round reports before merge', () => {
    const lines = fanLines(rep({ changed: [{ id: 'b', from: 59904, to: 225792 }] }), 'origin/main', 900);
    expect(lines[0]).toBe('FAN     b: 59904 → 225792 (3.77×)');
    expect(lines.at(-1)).toContain('total 60000 → 225984 (3.77×) over 2 comparable row(s)');
  });

  // A base that records nothing must say so. A silent `0 row(s) moved` over 0 comparable rows is
  // the shape of a green line that measured nothing — the vacuity this file already guards twice.
  test('says NOT COMPARABLE against an artifact that predates the field', () => {
    const out = fanLines(rep({ compared: 0, unrecorded: 900, baseTotal: 0, freshTotal: 0 }), 'origin/main', 900);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('NOT COMPARABLE');
    expect(out[0]).toContain('900 row(s)');
  });

  // THE OPPOSITE CAUSE OF THE SAME `compared === 0`: the base counted, and this run ranked none of
  // those rows — a phase-1 gate declining the corpus. Blaming the base for "predating the field"
  // there is a false cause printed on exactly the run whose fan line a reader would trust.
  test('a fresh run that ranked nothing says the series is ending, not starting', () => {
    const r = compareFans(
      out(row('a', { candidateCount: 100 }), row('b', { candidateCount: 200 })),
      out(row('a', { outcome: 'declined' }), row('b', { outcome: 'declined' })),
    );
    const lines = fanLines(r, 'origin/main', 0);
    expect(lines.at(-1)).toContain('NOT COMPARABLE');
    expect(lines.at(-1)).toContain('2 stopped ranking, 300 candidate(s) gone');
    expect(lines.at(-1)).toContain('ENDS here');
    expect(lines.some((l) => l.includes('predates the field'))).toBe(false);
  });

  // A COST SECTION, because a recorded number nothing reads is bookkeeping — and because the
  // question `rankSeconds` was recorded for ("the real tier rose 6.0× in 21 days") is asked of two
  // artifacts, not of two transcripts.
  test('names a row whose ranking cost moved, over both floors, and totals the tier', () => {
    const r = compareCost(
      out(row('a', { rankSeconds: 100 }), row('quiet', { rankSeconds: 20 })),
      out(row('a', { rankSeconds: 400 }), row('quiet', { rankSeconds: 21 })),
    );
    expect(r.moved).toEqual([{ id: 'a', from: 100, to: 400 }]);
    const lines = costLines(r, 'origin/main');
    expect(lines[0]).toBe('COST    a: 100.0s → 400.0s (4.00×)');
    expect(lines.at(-1)).toContain('ranked pass 120.0s → 421.0s (3.51×) over 2 row(s)');
    expect(lines.at(-1)).toContain('WALL CLOCK');
  });

  // Wall clock under eight parallel shards on a machine that may be running another round: a
  // section that names ten rows on every run is a section a reader learns to skip.
  test('a run that only moved by the machine names no row', () => {
    const r = compareCost(out(row('a', { rankSeconds: 100 })), out(row('a', { rankSeconds: 108 })));
    expect(r.moved).toEqual([]);
    expect(costLines(r, 'origin/main')).toHaveLength(1);
  });

  // A big RATIO on a tiny row is the machine too (0.2s → 0.6s is three times nothing), and a big
  // ABSOLUTE move on a huge row can be noise — both floors, or neither means anything.
  test('a 3× on a row that ranks in under a second is under the seconds floor', () => {
    expect(compareCost(out(row('a', { rankSeconds: 0.2 })), out(row('a', { rankSeconds: 0.6 }))).moved).toEqual([]);
  });

  // An artifact that predates the field: silence, not a vacuous `0.0s → 0.0s (1.00×)` that reads
  // as a measured neutrality.
  test('says nothing at all when the base recorded no seconds', () => {
    expect(costLines(compareCost(out(row('a')), out(row('a', { rankSeconds: 9 }))), 'origin/main')).toEqual([]);
  });

  // An axis that touches 600 rows must not bury the totals line under 600 lines.
  test('caps the named rows and says how many more moved', () => {
    const changed = Array.from({ length: FAN_ROWS_SHOWN + 3 }, (_, i) => ({ id: `r${i}`, from: 10, to: 20 + i }));
    const lines = fanLines(rep({ changed }), 'origin/main', 900);
    expect(lines.filter((l) => l.startsWith('FAN     r'))).toHaveLength(FAN_ROWS_SHOWN);
    expect(lines.some((l) => l.includes('and 3 more row(s) moved'))).toBe(true);
  });
});
