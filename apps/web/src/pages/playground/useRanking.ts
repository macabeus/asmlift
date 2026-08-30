// asmlift webapp — the ranking hook. Owns the ranking Web Worker and the H1 stale-guard.
//
// H1 (audit CRITICAL): today's decompile is synchronous; ranking is async, so a score can resolve
// AFTER the user has edited the asm. If the resolved (best) source were then shown against the new
// asm, the badge would claim "matched (0)" for the wrong input — a false byte-exact match, the
// cardinal sin. Two layers close it: (1) the view is DERIVED from the input it is about, so a
// render for a changed input shows `loading` and never the previous input's badge — this used to be
// a reset inside the posting effect, which lands one commit too late (measured: a 27 ms window with
// the new function named beside the old run's counts); (2) each request carries a monotonic reqId,
// the latest is remembered, and the worker's response is ACCEPTED ONLY when its reqId is still the
// current one — a superseded response is dropped. So the ranked source shown is always for the asm
// on screen, or nothing.
//
// PROGRESS IS UNDER THE SAME GUARD. A progress tick is a message from the worker, so a tick
// stamped with a superseded reqId is dropped exactly like a superseded result — otherwise the bar
// would report another input's run against the asm now on screen. Both rules live in ONE pure
// function, `applyRankMessage`, which returns null for "drop this message"; the hook has no second
// way to settle state, and the rules are testable without a DOM (apps/web has no jsdom).
import type { SymbolMap } from '@asmlift/core/symbols';
import type { TargetDescription } from '@asmlift/core/target';
import { useEffect, useRef, useState } from 'react';

import type { RankProgress } from './rank-progress';
import type { BrowserRanking, RankMessage, RankRequest } from './score-wasm';

export type Ranking =
  | { status: 'off' } // not an agbcc/C run, or no valid input
  // progress is carried ONLY here, so it structurally cannot survive into a finished state
  | ({ status: 'loading' } & RankProgress)
  | { status: 'ok'; result: BrowserRanking }
  | { status: 'error'; error: string };

/** Apply one worker message to the current state, or return null to DROP it.
 *
 *  Three refusals, each closing a way the UI could tell a lie:
 *   1. any message (progress or result) whose reqId is not the current one — it belongs to an asm
 *      the user has already edited away from, and rendering it is the cardinal sin H1 names;
 *   2. a progress tick arriving into a request that has ALREADY SETTLED — it would re-open the
 *      spinner over a finished verdict. Its live path is `worker.onerror` below, NOT "its own
 *      result already landed": postMessage is FIFO per port, so a run's ticks always precede its
 *      own result. `onerror` settles `{status:'error'}` while the still-CURRENT run keeps emitting
 *      under the still-current reqId, and without this rule the bar would visibly re-open over the
 *      loud error — constraint 4, a failure path that must stay loud;
 *   3. progress into anything but `loading` — enforced by the type, not by a convention. */
export function applyRankMessage(prev: Ranking, msg: RankMessage, currentReqId: number): Ranking | null {
  if (msg.reqId !== currentReqId) {
    return null; // superseded by a newer input — drop it, progress included
  }
  if (msg.kind === 'progress') {
    if (prev.status !== 'loading') {
      return null; // settled (in practice: by worker.onerror) — a bar must never outlive a verdict
    }
    const { kind: _kind, reqId: _reqId, ...progress } = msg;
    return { status: 'loading', ...progress };
  }
  return msg.ok ? { status: 'ok', result: msg.result } : { status: 'error', error: msg.error };
}

export interface RankingInput {
  /** true only for an agbcc target + C backend with a valid function name and non-empty asm. */
  eligible: boolean;
  asm: string;
  name: string | undefined;
  targetId: string;
  target: TargetDescription;
  /** the Symbols pane's parsed map — the worker enumerates+scores the named spellings with it
   *  (self-declared, via core's declaration synthesis); a new map identity re-ranks (H1). */
  symbols?: SymbolMap;
}

/** Do two renders' inputs describe the SAME ranking question? Compared field by field, on exactly
 *  the fields the request-posting effect depends on — `asm` is compared by reference in the common
 *  case (same string object), never rebuilt into a key, so this costs nothing at 10 Hz. */
export function sameRankingInput(a: RankingInput, b: RankingInput): boolean {
  return (
    a.eligible === b.eligible &&
    a.asm === b.asm &&
    a.name === b.name &&
    a.targetId === b.targetId &&
    a.target === b.target &&
    a.symbols === b.symbols
  );
}

/** What to SHOW for `input`, given the state that was last stored and the input that state is
 *  about. H1 LAYER 1, MOVED OFF THE EFFECT.
 *
 *  Resetting to `loading` inside a `useEffect` runs one commit too late: the effect fires AFTER the
 *  render that already painted the new input, so for that one commit the badge belongs to the
 *  previous one. Measured in the app on 2026-08-30, switching examples mid-run on an 800-candidate
 *  fan: the FUNCTION field read the new `half` at t=935 ms while the badge still counted
 *  `scoring 52 / 800`, and the reset landed at t=962 ms — a 27 ms window, one commit wide. (The
 *  ~1 s that precedes it is the deliberate 250 ms input debounce, stretched by Chrome's background-
 *  tab timer clamp; during it the WHOLE pipeline still shows the previous input, which is coherent.
 *  Only the editor text is ahead.) Derived instead, the window is zero: re-measured after this
 *  change, the first frame carrying the new function already reads `waiting for the ranking
 *  worker…`.
 *
 *  27 ms is not the point — a scheduled invariant is. The counts this round added are what made the
 *  mismatch legible at all, and the same window renders a settled VERDICT for an asm no longer on
 *  screen, which is the cardinal sin H1 exists to prevent. Derived, it cannot lag: state carries
 *  the input it is about, and anything else renders as the honest `queued`. The reqId guard still
 *  does its own job on the message side — this closes the window BEFORE a request even exists. */
export function viewRanking(input: RankingInput, stored: { input: RankingInput; ranking: Ranking }): Ranking {
  if (!input.eligible || !input.name) {
    return { status: 'off' };
  }
  return sameRankingInput(stored.input, input) ? stored.ranking : { status: 'loading', phase: 'queued' };
}

export function useRanking(input: RankingInput): Ranking {
  const { eligible, asm, name, targetId, target, symbols } = input;
  // The state carries the INPUT it is about, so a render for a different input cannot show it.
  const [stored, setStored] = useState<{ input: RankingInput; ranking: Ranking }>({
    input,
    ranking: { status: 'off' },
  });
  const setRanking = (next: Ranking | ((prev: Ranking) => Ranking)) =>
    setStored((prev) => ({
      input: prev.input,
      ranking: typeof next === 'function' ? next(prev.ranking) : next,
    }));
  const workerRef = useRef<Worker | null>(null);
  const currentReqId = useRef(0); // the id of the latest posted request — the stale-guard anchor
  // The last COMMITTED input, for the one writer that is not a reply to a request: `worker.onerror`
  // fires from a closure created once, and an error stored against a stale input would be derived
  // away — a loud failure silently swallowed, which is the trade this repo never makes.
  const latestInput = useRef(input);
  useEffect(() => {
    latestInput.current = input;
  });

  // One worker per mounted app. Its onmessage applies the H1 guard: a response is accepted only
  // while its reqId is still the current one.
  useEffect(() => {
    const worker = new Worker(new URL('./rank.worker.ts', import.meta.url), { type: 'module' });
    // The functional form is what gives `applyRankMessage` the PREVIOUS state (rule 2 needs it)
    // without a second ref; returning `prev` unchanged is a React bail-out.
    worker.onmessage = (e: MessageEvent<RankMessage>) =>
      setRanking((prev) => applyRankMessage(prev, e.data, currentReqId.current) ?? prev);
    // A worker that fails to LOAD (a bad wasm import, a syntax error) would otherwise never reply,
    // leaving ranking stuck on "loading" forever. Surface it as an error instead — never a silent
    // perpetual spinner. Only while a request is actually in flight, so a benign teardown is quiet.
    worker.onerror = (e) => {
      if (currentReqId.current === 0) {
        return;
      }
      setStored({
        input: latestInput.current,
        ranking: { status: 'error', error: e.message || 'the ranking worker failed to load' },
      });
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!eligible || !name) {
      currentReqId.current++; // invalidate any in-flight response
      setStored({ input, ranking: { status: 'off' } });
      return;
    }
    const reqId = ++currentReqId.current; // new request supersedes anything in flight
    // Clear any prior result from the view immediately (H1 layer 1) — with a named phase from the
    // first frame, never an empty message. The phase is `queued`, the one the worker never sends,
    // because it is the only thing the MAIN THREAD can honestly claim here: the request has been
    // handed over and nothing has been observed back. Naming `assembling` would be an assertion,
    // not an observation, and it is wrong for a measured 62.3 s (2026-08-30) whenever the worker is still
    // enumerating a superseded run (its event loop cannot dequeue this message until it returns).
    setStored({ input, ranking: { status: 'loading', phase: 'queued' } });
    workerRef.current?.postMessage({ reqId, name, asm, target, ...(symbols ? { symbols } : {}) } satisfies RankRequest);
  }, [eligible, asm, name, targetId, target, symbols]);

  return viewRanking(input, stored);
}
