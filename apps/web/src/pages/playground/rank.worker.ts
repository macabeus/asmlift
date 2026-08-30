// asmlift webapp — the ranking Web Worker. Enumerating candidates is cheap, but compiling each
// with agbcc-wasm and diffing with objdiff-wasm is heavy enough to jank the editor if run on the
// main thread, so it lives here. The worker owns the wasm engines; the main thread only posts a
// RankRequest and receives a RankResponse. The H1 stale-guard (discarding a superseded response)
// is enforced by the MAIN thread against the echoed `reqId` — the worker just processes each
// request and echoes its id back.
import { throttleProgress, whileCurrent } from './rank-progress';
import {
  type RankInbound,
  type RankMessage,
  type RankResponse,
  preloadScorers,
  rankCandidatesInBrowser,
} from './score-wasm';

// Warm the wasm modules as soon as the worker spawns (the UI spawns it on an agbcc target).
preloadScorers();

// The newest id this worker has been TOLD ABOUT — a RATE policy and nothing else, whose argument
// and measurement live with `whileCurrent` in rank-progress.ts. It may only ever DROP a message;
// the H1 stale-guard stays on the main thread as the sole authority over what is displayed, which
// is why a superseded run's RESULT is still posted.
//
// It does NOT stop the abandoned run. Its agbcc + objdiff compiles keep going, and they are the
// larger cost by far: measured 2026-08-30, a live run scores 52.8 candidates/s alone and 40.6
// while one abandoned run is still working. Stopping that needs an abort seam the scoring loop
// does not have, and silencing is not a substitute for it — cancelling is a follow-up.
let latestReqId = 0;

self.onmessage = async (e: MessageEvent<RankInbound>) => {
  const msg = e.data;
  // BOTH kinds advance the id: the main thread also abandons a run without starting another one,
  // and a `supersede` is the only way it can say so.
  latestReqId = msg.reqId;
  if (msg.kind === 'supersede') {
    return;
  }
  const { reqId, name, asm, target, symbols } = msg;
  try {
    // THE THROTTLE LIVES HERE, at the transport boundary it is a policy about: the driver observes
    // every candidate, and this is what bounds how many of those observations become postMessages
    // (~10/s, whatever the fan shape — 117,760 candidates would otherwise be 117,760 wake-ups of
    // the main thread the worker exists to protect). One per request, so one run's clock cannot
    // suppress another's first tick.
    //
    // Progress carries the SAME echoed `reqId` as the result, because it answers to the same H1
    // guard. The worker never decides what is SHOWN — it stamps, and it declines to spend a
    // postMessage on a run it already knows the main thread will discard.
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
