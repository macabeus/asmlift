// asmlift webapp — the ranking hook. Owns the ranking Web Worker and the H1 stale-guard.
//
// H1 (audit CRITICAL): today's decompile is synchronous; ranking is async, so a score can resolve
// AFTER the user has edited the asm. If the resolved (best) source were then shown against the new
// asm, the badge would claim "matched (0)" for the wrong input — a false byte-exact match, the
// cardinal sin. Two layers close it: (1) the view is DERIVED from the input it is about, so a
// render for a changed input shows `loading` and never the previous input's badge; (2) each request
// carries a monotonic reqId, the latest is remembered, and the worker's response is ACCEPTED ONLY
// when its reqId is still the current one — a superseded response is dropped. So the ranked source
// shown is always for the asm on screen, or nothing.
//
// PROGRESS IS UNDER THE SAME GUARD. A progress tick is a message from the worker, so a tick
// stamped with a superseded reqId is dropped exactly like a superseded result — otherwise the bar
// would report another input's run against the asm now on screen. Both rules live in ONE pure
// function, `applyRankMessage`, which returns null for "drop this message"; the hook has no second
// way to settle state, and the rules are testable without a DOM (apps/web has no jsdom).
//
// WHAT THIS GUARD DOES NOT COVER, measured 2026-08-30: the editor's own text leads the WHOLE
// pipeline by Playground's 250 ms input debounce — 269 ms from a keystroke to the first `queued`
// frame on one measured edit. During it the badge, the Source panel and the IR all still describe
// the previous input, so they agree with each other and disagree only with the raw editor buffer.
// That is a property of the debounce, not of this file; narrowing it is a Playground change.
import type { SymbolMap } from '@asmlift/core/symbols';
import type { TargetDescription } from '@asmlift/core/target';
import { useEffect, useRef, useState } from 'react';

import type { RankProgress } from './rank-progress';
import type { BrowserRanking, RankMessage, RankRequest, RankSupersede } from './score-wasm';

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
 *      spinner over a finished verdict. Its live path is `worker.onerror`, NOT "its own result
 *      already landed": postMessage is FIFO per port, so a run's ticks always precede its own
 *      result. `onerror` settles `{status:'error'}` while the still-CURRENT run keeps emitting
 *      under the still-current reqId, and without this rule the bar re-opens over the loud error;
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

/** The stored pair: a ranking, and the input that ranking is ABOUT. */
export interface StoredRanking {
  input: RankingInput;
  ranking: Ranking;
}

/** `applyRankMessage` lifted to the stored pair — the React updater itself, so it must be pure and
 *  it must return the SAME OBJECT for a dropped message. Identity is the point: `Object.is` is what
 *  makes React bail out, and rebuilding `{ ...stored }` for a message that changed nothing commits a
 *  whole Playground render per dropped tick. Every tick of an abandoned run is a dropped tick. */
export function applyToStored(stored: StoredRanking, msg: RankMessage, currentReqId: number): StoredRanking {
  const ranking = applyRankMessage(stored.ranking, msg, currentReqId);
  return ranking === null ? stored : { input: stored.input, ranking };
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

/** Do two renders' inputs describe the SAME ranking question? THE ONE LIST: `viewRanking` and the
 *  request-posting effect both ask HERE, rather than one of them re-enumerating the fields as a
 *  dependency array. Two lists that disagree is a specific silent failure — a field that reaches
 *  the view's guard but not the effect's leaves the badge on `queued` with no request in flight,
 *  the perpetual spinner this file's header swears off. `asm` is compared by reference in the
 *  common case (same string object), never rebuilt into a key, so this costs nothing per render. */
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
 *  about. H1 LAYER 1, AND IT IS DERIVED, NEVER SCHEDULED.
 *
 *  Resetting to `loading` from a `useEffect` lands one commit too late: the effect fires AFTER the
 *  render that already painted the new input, so for that commit the badge belongs to the previous
 *  one — measured at 27 ms on 2026-08-30, switching examples mid-run on an 800-candidate fan (the
 *  FUNCTION field read the new `half` while the badge still counted `scoring 52 / 800`). Derived,
 *  the window is zero, because the state carries the input it is about and anything else renders
 *  as the honest `queued`.
 *
 *  27 ms is not the point; a scheduled invariant is. The same window renders a settled VERDICT for
 *  an asm no longer on screen, which is the cardinal sin H1 exists to prevent, and it closes here
 *  BEFORE a request exists — the reqId guard still does its own job on the message side. */
export function viewRanking(input: RankingInput, stored: StoredRanking): Ranking {
  if (!input.eligible || !input.name) {
    return { status: 'off' };
  }
  return sameRankingInput(stored.input, input) ? stored.ranking : { status: 'loading', phase: 'queued' };
}

export function useRanking(input: RankingInput): Ranking {
  // The state carries the INPUT it is about, so a render for a different input cannot show it.
  const [stored, setStored] = useState<StoredRanking>({ input, ranking: { status: 'off' } });
  const workerRef = useRef<Worker | null>(null);
  const currentReqId = useRef(0); // the id of the latest posted message — the stale-guard anchor
  // The input the CURRENT worker was last told about — what makes `sameRankingInput` the only list.
  const requested = useRef<RankingInput | null>(null);
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
    worker.onmessage = (e: MessageEvent<RankMessage>) => {
      // The id is read HERE, not inside the updater: React may re-invoke an updater, and an
      // updater that reads a ref is not a pure function of its argument.
      const reqId = currentReqId.current;
      // The functional form is what gives `applyRankMessage` the PREVIOUS state (rule 2 needs it)
      // without a second ref; `applyToStored` returns that same state for a dropped message.
      setStored((prev) => applyToStored(prev, e.data, reqId));
    };
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
      requested.current = null; // the next worker has been told nothing (StrictMode remounts one)
    };
  }, []);

  // No dependency array: `sameRankingInput` IS the dependency check, so the fields live in one
  // place. The body runs per render and returns after six identity comparisons.
  useEffect(() => {
    if (requested.current && sameRankingInput(requested.current, input)) {
      return;
    }
    requested.current = input;
    const reqId = ++currentReqId.current; // anything in flight is now superseded
    if (!input.eligible || !input.name) {
      setStored({ input, ranking: { status: 'off' } });
      // Tell the worker, too. Bumping the id alone invalidates the in-flight RESPONSE and leaves
      // the run posting ticks nobody will read for the rest of its life (`RankSupersede`).
      workerRef.current?.postMessage({ kind: 'supersede', reqId } satisfies RankSupersede);
      return;
    }
    // `queued`, not `assembling`: the request has been handed over and nothing has been observed
    // back, which is the only thing the MAIN THREAD can honestly claim here. Naming a phase nobody
    // observed would be wrong for a measured 62.3 s (2026-08-30) whenever the worker is still
    // enumerating a superseded run — its event loop cannot dequeue this message until that
    // returns.
    setStored({ input, ranking: { status: 'loading', phase: 'queued' } });
    workerRef.current?.postMessage({
      kind: 'request',
      reqId,
      name: input.name,
      asm: input.asm,
      target: input.target,
      ...(input.symbols ? { symbols: input.symbols } : {}),
    } satisfies RankRequest);
  }, [input]);

  return viewRanking(input, stored);
}
