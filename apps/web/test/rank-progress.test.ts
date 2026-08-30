// The playground's ranking PROGRESS MODEL: the emission throttle (rank-progress.ts), the worker
// message union, and the H1 stale-guard the ticks answer to. The SENTENCES and the bar geometry are
// one altitude up and tested in progress-view.test.ts.
//
// These live outside score-wasm.ts for the reason candidate-compile.test.ts documents: score-wasm.ts
// pulls in the `agbcc` package, which cannot be imported under vitest's ESM loader.
//
// The rule under test here is the one a lying bar would break: the throttle bounds the postMessage
// rate but NEVER swallows a phase change or the final tick, so the bar cannot stop short of the end
// or sit on a stale phase for a whole tail.
import { describe, expect, test } from 'vitest';

import { type RankProgress, throttleProgress, whileCurrent } from '../src/pages/playground/rank-progress';
import type { BrowserRanking, RankMessage } from '../src/pages/playground/score-wasm';
import {
  type Ranking,
  type RankingInput,
  applyRankMessage,
  sameRankingInput,
  viewRanking,
} from '../src/pages/playground/useRanking';

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

describe('whileCurrent', () => {
  test('a superseded run stops posting entirely — it does not merely get its ticks dropped later', () => {
    // The worker's onmessage is async, so two runs interleave: before this, an abandoned 800-
    // candidate run posted 286 ticks over 78 s after being superseded, every one a main-thread
    // wake-up for a message `applyRankMessage` would discard.
    let current = true;
    const seen: RankProgress[] = [];
    const post = whileCurrent(
      () => current,
      (p) => seen.push(p),
    );
    post({ phase: 'assembling' });
    current = false;
    for (let i = 0; i < 100; i++) {
      post({ phase: 'scoring', done: i, total: 100 });
    }
    post({ phase: 'ranking' }); // not even a phase change survives supersession
    expect(seen).toEqual([{ phase: 'assembling' }]);
  });

  test('composed under the throttle it changes nothing while the run IS current', () => {
    let t = 0;
    const seen: RankProgress[] = [];
    const emit = throttleProgress(
      whileCurrent(
        () => true,
        (p) => seen.push(p),
      ),
      () => t,
      100,
    );
    emit({ phase: 'scoring', done: 0, total: 3 });
    t += 1;
    emit({ phase: 'scoring', done: 1, total: 3 }); // throttled, as before
    emit({ phase: 'ranking' }); // a phase change is still exempt
    expect(seen).toEqual([{ phase: 'scoring', done: 0, total: 3 }, { phase: 'ranking' }]);
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

// ── H1, the stale-guard, now with progress under it ──────────────────────────────────────────
// useRanking.ts's whole file comment is about H1 (an audit CRITICAL): ranking is async, so a score
// can resolve AFTER the user has edited the asm, and showing it would claim a byte-exact match for
// the wrong input. A PROGRESS message is a message from the worker and is subject to exactly the
// same guard. `applyRankMessage` is the one pure place both rules live, and it returns null for
// "drop this message" so the hook has no second way to settle state.
//
// The existing H1 reasoning had no test at all before this file; case (d) pins it.
const RESULT = {
  best: { label: 'unsigned', source: '', symbolRefs: [], score: { score: 0 } },
  candidates: [],
  dropped: [],
  withheld: [],
  refused: [],
} as unknown as BrowserRanking;

describe('applyRankMessage (H1)', () => {
  test('(a) a PROGRESS message from a superseded request is dropped', () => {
    const prev: Ranking = { status: 'loading', phase: 'enumerating' };
    expect(applyRankMessage(prev, { kind: 'progress', reqId: 1, phase: 'scoring', done: 5, total: 9 }, 2)).toBeNull();
  });

  test('(b) a progress tick that arrives after its own result cannot resurrect the spinner', () => {
    const settled: Ranking = { status: 'ok', result: RESULT };
    expect(
      applyRankMessage(settled, { kind: 'progress', reqId: 3, phase: 'scoring', done: 5, total: 9 }, 3),
    ).toBeNull();
    const failed: Ranking = { status: 'error', error: 'boom' };
    expect(applyRankMessage(failed, { kind: 'progress', reqId: 3, phase: 'ranking' }, 3)).toBeNull();
  });

  test("(b') rule 2's LIVE case: onerror settles the CURRENT run, whose ticks keep arriving", () => {
    // postMessage is FIFO per port, so a run's ticks always precede its own result — "its own
    // result already landed" cannot happen. What CAN: `worker.onerror` sets {status:'error'} for a
    // run that is still current and still emitting. Without rule 2 the spinner re-opens over the
    // loud error, which is constraint 4 (a failure path must stay loud) broken by progress.
    const afterOnError: Ranking = { status: 'error', error: 'the ranking worker failed to load' };
    expect(applyRankMessage(afterOnError, { kind: 'progress', reqId: 9, phase: 'enumerating' }, 9)).toBeNull();
    expect(
      applyRankMessage(afterOnError, { kind: 'progress', reqId: 9, phase: 'scoring', done: 400, total: 800 }, 9),
    ).toBeNull();
  });

  test('(c) a current-reqId progress message yields loading with the phase and counts', () => {
    const prev: Ranking = { status: 'loading', phase: 'assembling' };
    expect(applyRankMessage(prev, { kind: 'progress', reqId: 4, phase: 'scoring', done: 5, total: 9 }, 4)).toEqual({
      status: 'loading',
      phase: 'scoring',
      done: 5,
      total: 9,
    });
  });

  test('(d) a superseded RESULT is still dropped — ok and error alike', () => {
    const prev: Ranking = { status: 'loading', phase: 'scoring', done: 1, total: 2 };
    expect(applyRankMessage(prev, { kind: 'result', reqId: 1, ok: true, result: RESULT }, 2)).toBeNull();
    expect(applyRankMessage(prev, { kind: 'result', reqId: 1, ok: false, error: 'stale' }, 2)).toBeNull();
  });

  test('(e) progress does not leak into ok or error', () => {
    const prev: Ranking = { status: 'loading', phase: 'scoring', done: 8, total: 9 };
    const ok = applyRankMessage(prev, { kind: 'result', reqId: 5, ok: true, result: RESULT }, 5);
    expect(ok).toEqual({ status: 'ok', result: RESULT });
    const err = applyRankMessage(prev, { kind: 'result', reqId: 5, ok: false, error: 'no scorable candidate' }, 5);
    expect(err).toEqual({ status: 'error', error: 'no scorable candidate' });
    for (const next of [ok, err]) {
      expect(next && 'phase' in next).toBe(false);
      expect(next && 'done' in next).toBe(false);
    }
  });
});

// ── H1 LAYER 1, the window the counts made visible ────────────────────────────────────────────
// Resetting to `loading` inside the posting effect lands one commit AFTER the render that painted
// the new input. Measured in the app on 2026-08-30, switching examples mid-run on an 800-candidate
// fan: the FUNCTION field read the new `half` at t=935 ms while the badge still counted
// `scoring 52 / 800`; the reset landed at t=962 ms. One commit, 27 ms — and the same window renders
// a settled VERDICT for an asm no longer on screen. `viewRanking` derives the answer instead, so it
// cannot lag: re-measured after the change, the first frame naming `half` already reads `queued`.
const INPUT: RankingInput = {
  eligible: true,
  asm: 'push {r4}',
  name: 'f',
  targetId: 'agbcc',
  target: {} as RankingInput['target'],
};

describe('viewRanking (H1 layer 1)', () => {
  test('state belonging to ANOTHER input renders as queued, never as that input`s badge', () => {
    const settled: Ranking = { status: 'ok', result: RESULT };
    const scoring: Ranking = { status: 'loading', phase: 'scoring', done: 38, total: 800 };
    const edited = { ...INPUT, asm: 'push {r4,r5}' };
    for (const ranking of [settled, scoring, { status: 'error', error: 'boom' } as Ranking]) {
      expect(viewRanking(edited, { input: INPUT, ranking })).toEqual({ status: 'loading', phase: 'queued' });
    }
  });

  test('state for the SAME input is shown unchanged — the guard costs nothing when it should not fire', () => {
    const scoring: Ranking = { status: 'loading', phase: 'scoring', done: 38, total: 800 };
    expect(viewRanking(INPUT, { input: { ...INPUT }, ranking: scoring })).toBe(scoring);
  });

  test('an ineligible input is `off`, whatever is stored — no spinner over a non-agbcc target', () => {
    expect(
      viewRanking({ ...INPUT, eligible: false }, { input: INPUT, ranking: { status: 'ok', result: RESULT } }),
    ).toEqual({
      status: 'off',
    });
    expect(
      viewRanking({ ...INPUT, name: undefined }, { input: INPUT, ranking: { status: 'ok', result: RESULT } }),
    ).toEqual({
      status: 'off',
    });
  });

  test('every field the posting effect depends on is compared — none may be forgotten', () => {
    const map = new Map() as NonNullable<RankingInput['symbols']>;
    expect(sameRankingInput(INPUT, { ...INPUT })).toBe(true);
    for (const changed of [
      { eligible: false },
      { asm: 'other' },
      { name: 'g' },
      { targetId: 'ido7.1' },
      { target: {} as RankingInput['target'] },
      { symbols: map },
    ]) {
      expect(sameRankingInput(INPUT, { ...INPUT, ...changed })).toBe(false);
    }
  });
});
