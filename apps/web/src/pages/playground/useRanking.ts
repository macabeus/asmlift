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
import type { RankedResult } from '@asmlift/core/rank';
import type { TargetDescription } from '@asmlift/core/target';
import { useEffect, useRef, useState } from 'react';

import type { MatchScore, RankRequest, RankResponse } from './score-wasm';

export type Ranking =
  | { status: 'off' } // not an agbcc/C run, or no valid input
  | { status: 'loading' }
  | { status: 'ok'; result: RankedResult<MatchScore> }
  | { status: 'error'; error: string };

export interface RankingInput {
  /** true only for an agbcc target + C backend with a valid function name and non-empty asm. */
  eligible: boolean;
  asm: string;
  name: string | undefined;
  targetId: string;
  target: TargetDescription;
}

export function useRanking(input: RankingInput): Ranking {
  const { eligible, asm, name, targetId, target } = input;
  const [ranking, setRanking] = useState<Ranking>({ status: 'off' });
  const workerRef = useRef<Worker | null>(null);
  const currentReqId = useRef(0); // the id of the latest posted request — the stale-guard anchor

  // One worker per mounted app. Its onmessage applies the H1 guard: a response is accepted only
  // while its reqId is still the current one.
  useEffect(() => {
    const worker = new Worker(new URL('./rank.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<RankResponse>) => {
      const res = e.data;
      if (res.reqId !== currentReqId.current) {
        return;
      } // superseded by a newer input — drop it
      setRanking(res.ok ? { status: 'ok', result: res.result } : { status: 'error', error: res.error });
    };
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
    setRanking({ status: 'loading' }); // clear any prior result from the view immediately (H1 layer 1)
    workerRef.current?.postMessage({ reqId, name, asm, target } satisfies RankRequest);
  }, [eligible, asm, name, targetId, target]);

  return ranking;
}
