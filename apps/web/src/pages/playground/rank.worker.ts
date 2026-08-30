// asmlift webapp — the ranking Web Worker. Enumerating candidates is cheap, but compiling each
// with agbcc-wasm and diffing with objdiff-wasm is heavy enough to jank the editor if run on the
// main thread, so it lives here. The worker owns the wasm engines; the main thread only posts a
// RankRequest and receives a RankResponse. The H1 stale-guard (discarding a superseded response)
// is enforced by the MAIN thread against the echoed `reqId` — the worker just processes each
// request and echoes its id back.
import { throttleProgress, whileCurrent } from './rank-progress';
import {
  type RankMessage,
  type RankRequest,
  type RankResponse,
  preloadScorers,
  rankCandidatesInBrowser,
} from './score-wasm';

// Warm the wasm modules as soon as the worker spawns (the UI spawns it on an agbcc target).
preloadScorers();

// The newest request this worker has RECEIVED. `self.onmessage` is async, so a second request is
// dequeued at the first `await` of the first and the two runs interleave — a superseded run keeps
// scoring for the rest of its natural life. Measured: bumping the reqId 9.9 s into an 800-candidate
// run left the abandoned run posting 286 further ticks over 78 s, every one waking the main thread
// to be thrown away. The per-run throttle bounds ONE run to ~10 msg/s; nothing bounded the number
// of live superseded runs, so the aggregate rate scaled with edits-during-a-run — the precise load
// the worker exists to prevent.
//
// This id is a RATE policy and NOTHING ELSE. It may only ever DROP a message: the H1 stale-guard
// stays on the main thread, sole authority over what is displayed, and this cannot route around it
// — the worker learns of id N only from the message the main thread posted after setting its own
// current id to N, so `latestReqId <= currentReqId` always, and everything suppressed here would
// have been dropped there. The superseded run's RESULT is still posted for exactly that reason:
// deciding a verdict is the main thread's job, not this file's.
let latestReqId = 0;

self.onmessage = async (e: MessageEvent<RankRequest>) => {
  const { reqId, name, asm, target, symbols } = e.data;
  latestReqId = reqId;
  try {
    // THE THROTTLE LIVES HERE, at the transport boundary it is a policy about: the driver observes
    // every candidate, and this is what bounds how many of those observations become postMessages
    // (~10/s, whatever the fan shape — 117,760 candidates would otherwise be 117,760 wake-ups of
    // the main thread the worker exists to protect). A fresh throttle per request, so one run's
    // clock cannot suppress another's first tick.
    //
    // Progress carries the SAME echoed `reqId` as the result, for the same reason: the main
    // thread's H1 guard drops anything stamped with a superseded id. The worker never decides what
    // is SHOWN — it stamps, and it declines to spend a postMessage on a run it already knows the
    // main thread will discard.
    const post = throttleProgress(
      whileCurrent(
        () => reqId === latestReqId,
        (p) => postMessage({ kind: 'progress', reqId, ...p } satisfies RankMessage),
      ),
    );
    const result = await rankCandidatesInBrowser(name, asm, target, symbols, post);
    postMessage({ kind: 'result', reqId, ok: true, result } satisfies RankResponse);
  } catch (err) {
    postMessage({
      kind: 'result',
      reqId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies RankResponse);
  }
};
