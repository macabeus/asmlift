// The ranking progress VIEW — the sentence and the bar geometry (src/pages/playground/progress-view.ts).
// Split from rank-progress.test.ts along the same seam the modules split on: this half is what the
// user reads, and every rule below is an honesty rule rather than a styling one.
//
//  • an indeterminate phase has NO total and NO percentage — no fabricated denominator, no "0 %";
//  • a determinate bar's `aria-valuenow` is the EXACT count while its fill never reads 100 %,
//    because the sort and a six-figure structured clone still follow the last scoring tick.
import { describe, expect, test } from 'vitest';

import { progressBar, progressLabel } from '../src/pages/playground/progress-view';

describe('progressBar', () => {
  test('an indeterminate phase carries NO total and no fabricated percentage', () => {
    for (const phase of ['queued', 'assembling', 'enumerating', 'ranking'] as const) {
      const bar = progressBar({ phase });
      expect(bar.determinate).toBe(false);
      expect('valueNow' in bar).toBe(false); // the ARIA spelling of indeterminate is OMISSION
      expect('valueMax' in bar).toBe(false);
      expect(bar.label).not.toMatch(/\d/); // no count, no "0%", no invented denominator
    }
  });

  test('a determinate bar reports the exact counts and never fills to 100%', () => {
    const bar = progressBar({ phase: 'scoring', done: 117760, total: 117760 });
    if (!bar.determinate) {
      throw new Error('a scoring tick with a real total must be determinate');
    }
    expect(bar.valueNow).toBe(117760); // aria-valuenow stays EXACT
    expect(bar.valueMax).toBe(117760);
    expect(bar.pct).toBeLessThanOrEqual(99); // the FILL never reads "finished" while work follows
    expect(bar.label).toBe('scoring 117,760 / 117,760 candidates'); // grouped, not 117760
  });

  test('a zero total is indeterminate — no division by zero, and no equal ARIA bounds', () => {
    // ARIA requires aria-valuemax > aria-valuemin; `0 / 0` on both would leave the AT-computed
    // percentage undefined. The enumeration that produces it goes on to throw `no scorable
    // candidate`, so this is a transient state — but it is a REACHABLE one.
    const bar = progressBar({ phase: 'scoring', done: 0, total: 0 });
    expect(bar.determinate).toBe(false);
    expect('pct' in bar).toBe(false); // no "0 % of an unknown denominator" on the indeterminate arm
  });

  test('the indeterminate arm carries no pct at all — a number nobody may read', () => {
    expect('pct' in progressBar({ phase: 'enumerating' })).toBe(false);
  });
});

describe('progressLabel', () => {
  test('`queued` is a phase the WORKER never emits — the main thread sets it, and it claims nothing', () => {
    // The hook cannot observe `assembling`: it only knows it posted. On a busy worker (a superseded
    // run enumerating for a measured 62.3 s) `assembling` would be false for the whole wait.
    expect(progressLabel({ phase: 'queued' })).toBe('waiting for the ranking worker…');
    expect(progressBar({ phase: 'queued' }).determinate).toBe(false);
  });

  test('every phase has a sentence — the badge is never empty', () => {
    for (const phase of ['queued', 'assembling', 'enumerating', 'ranking'] as const) {
      expect(progressLabel({ phase }).length).toBeGreaterThan(0);
    }
    // `scoring` is the one phase that CANNOT be spelled without counts — the union says so, and a
    // count-less scoring tick is now a compile error rather than a defensive branch.
    expect(progressLabel({ phase: 'scoring', done: 1, total: 2 })).toBe('scoring 1 / 2 candidates');
  });
});
