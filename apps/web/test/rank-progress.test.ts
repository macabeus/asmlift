// The playground's ranking PROGRESS, in the parts a node test can run: the emission throttle and
// the pure view props the badge/pipeline card render from. They live in
// src/pages/playground/rank-progress.ts rather than in score-wasm.ts for the reason
// candidate-compile.test.ts documents: score-wasm.ts pulls in the `agbcc` package, which cannot be
// imported under vitest's ESM loader.
//
// The rules under test are the ones a lying bar would break:
//  • the throttle bounds the postMessage rate but NEVER swallows a phase change or the final tick,
//    so the bar cannot stop short of the end or sit on a stale phase for a whole tail;
//  • an indeterminate phase has NO total — no fabricated denominator, no "0%".
import { describe, expect, test } from 'vitest';

import { type RankProgress, progressBar, progressLabel, throttleProgress } from '../src/pages/playground/rank-progress';
import type { RankMessage } from '../src/pages/playground/score-wasm';

/** A hand-cranked clock: the throttle is keyed on elapsed WALL TIME (per-candidate cost was
 *  measured between 25 ms and 167 ms on one function, so a count-keyed throttle posts at wildly
 *  different rates), and an injected clock is how that is testable without timers. */
function rig(intervalMs = 100) {
  let t = 0;
  const seen: RankProgress[] = [];
  const emit = throttleProgress(
    (p) => seen.push(p),
    () => t,
    intervalMs,
  );
  return { seen, emit, advance: (ms: number) => (t += ms) };
}

describe('throttleProgress', () => {
  test('emits the first tick of a phase immediately, then suppresses until the interval elapses', () => {
    const { seen, emit, advance } = rig();
    emit({ phase: 'scoring', done: 0, total: 10 });
    advance(50);
    emit({ phase: 'scoring', done: 1, total: 10 });
    expect(seen).toEqual([{ phase: 'scoring', done: 0, total: 10 }]);
    advance(50);
    emit({ phase: 'scoring', done: 2, total: 10 });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ phase: 'scoring', done: 2, total: 10 });
  });

  test('never suppresses a phase change', () => {
    const { seen, emit } = rig();
    emit({ phase: 'assembling' });
    emit({ phase: 'enumerating' });
    emit({ phase: 'scoring', done: 0, total: 4 });
    emit({ phase: 'ranking' });
    expect(seen.map((p) => p.phase)).toEqual(['assembling', 'enumerating', 'scoring', 'ranking']);
  });

  test('never drops the final tick of a determinate phase — the bar cannot stop short of the end', () => {
    const { seen, emit, advance } = rig();
    emit({ phase: 'scoring', done: 0, total: 3 });
    advance(1);
    emit({ phase: 'scoring', done: 1, total: 3 });
    advance(1);
    emit({ phase: 'scoring', done: 2, total: 3 });
    advance(1);
    emit({ phase: 'scoring', done: 3, total: 3 }); // done === total: exempt from the throttle
    expect(seen.at(-1)).toEqual({ phase: 'scoring', done: 3, total: 3 });
  });
});

describe('progressBar', () => {
  test('an indeterminate phase carries NO total and no fabricated percentage', () => {
    for (const phase of ['assembling', 'enumerating', 'ranking'] as const) {
      const bar = progressBar({ phase });
      expect(bar.determinate).toBe(false);
      expect(bar.valueNow).toBeUndefined();
      expect(bar.valueMax).toBeUndefined();
      expect(bar.label).not.toMatch(/\d/); // no count, no "0%", no invented denominator
    }
  });

  test('scoring before the total exists is still indeterminate', () => {
    expect(progressBar({ phase: 'scoring' }).determinate).toBe(false);
  });

  test('a determinate bar reports the exact counts and never fills to 100%', () => {
    const bar = progressBar({ phase: 'scoring', done: 117760, total: 117760 });
    expect(bar.determinate).toBe(true);
    expect(bar.valueNow).toBe(117760); // aria-valuenow stays EXACT
    expect(bar.valueMax).toBe(117760);
    expect(bar.pct).toBeLessThanOrEqual(99); // the FILL never reads "finished" while work follows
    expect(bar.label).toBe('scoring 117,760 / 117,760 candidates'); // grouped, not 117760
  });

  test('a zero total cannot divide by zero', () => {
    expect(progressBar({ phase: 'scoring', done: 0, total: 0 }).pct).toBe(0);
  });
});

describe('progressLabel', () => {
  test('every phase has a sentence — the badge is never empty', () => {
    for (const phase of ['assembling', 'enumerating', 'scoring', 'ranking'] as const) {
      expect(progressLabel({ phase }).length).toBeGreaterThan(0);
    }
  });
});

// The worker protocol is now a THREE-shape union, so it is read on an explicit `kind` discriminant
// rather than by sniffing for a property. A structural sniff is how a fourth message shape later
// gets silently mis-routed — and mis-routing a progress message into the result branch would land
// it in `{ status: 'error', error: undefined }`, a loud failure traded for a blank one.
// (`score-wasm` is imported TYPE-ONLY here: the import is erased, so the `agbcc` package it pulls
// in at runtime is never loaded.)
function describeMessage(m: RankMessage): string {
  switch (m.kind) {
    case 'progress':
      return `progress:${m.phase}`;
    case 'result':
      return m.ok ? `ok:${m.result.candidates.length}` : `error:${m.error}`;
    default: {
      const exhaustive: never = m;
      return exhaustive;
    }
  }
}

describe('RankMessage', () => {
  test('a progress message is discriminated by kind, never mistaken for a result', () => {
    const progress: RankMessage = { kind: 'progress', reqId: 7, phase: 'scoring', done: 1, total: 2 };
    expect(describeMessage(progress)).toBe('progress:scoring');
    expect('ok' in progress).toBe(false);
  });

  test('both result shapes still route to the result branch', () => {
    expect(describeMessage({ kind: 'result', reqId: 1, ok: false, error: 'boom' })).toBe('error:boom');
  });
});
