// asmlift webapp — the ranking hook. Owns the ranking Web Worker and the H1 stale-guard.
//
// H1 (audit CRITICAL): today's decompile is synchronous; ranking is async, so a score can resolve
// AFTER the user has edited the asm. If the resolved (best) source were then shown against the new
// asm, the badge would claim "matched (0)" for the wrong input — a false byte-exact match, the
// cardinal sin. Two layers close it: (1) every input change immediately resets ranking to
// "loading", clearing any prior result from the view; (2) each request carries a monotonic reqId,
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
 *   2. a progress tick arriving after its own request has settled — it would re-open the spinner
 *      over a finished verdict;
 *   3. progress into anything but `loading` — enforced by the type, not by a convention. */
export function applyRankMessage(prev: Ranking, msg: RankMessage, currentReqId: number): Ranking | null {
  if (msg.reqId !== currentReqId) {
    return null; // superseded by a newer input — drop it, progress included
  }
  if (msg.kind === 'progress') {
    if (prev.status !== 'loading') {
      return null; // its own result already landed; a bar must never outlive the verdict
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

export function useRanking(input: RankingInput): Ranking {
  const { eligible, asm, name, targetId, target, symbols } = input;
  const [ranking, setRanking] = useState<Ranking>({ status: 'off' });
  const workerRef = useRef<Worker | null>(null);
  const currentReqId = useRef(0); // the id of the latest posted request — the stale-guard anchor

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
      setRanking({ status: 'error', error: e.message || 'the ranking worker failed to load' });
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
      setRanking({ status: 'off' });
      return;
    }
    const reqId = ++currentReqId.current; // new request supersedes anything in flight
    // clear any prior result from the view immediately (H1 layer 1) — with a NAMED phase from the
    // first frame, never an empty message
    setRanking({ status: 'loading', phase: 'assembling' });
    workerRef.current?.postMessage({ reqId, name, asm, target, ...(symbols ? { symbols } : {}) } satisfies RankRequest);
  }, [eligible, asm, name, targetId, target, symbols]);

  return ranking;
}
