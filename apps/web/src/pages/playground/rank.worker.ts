// asmlift webapp — the ranking Web Worker. Enumerating candidates is cheap, but compiling each
// with agbcc-wasm and diffing with objdiff-wasm is heavy enough to jank the editor if run on the
// main thread, so it lives here. The worker owns the wasm engines; the main thread only posts a
// RankRequest and receives a RankResponse. The H1 stale-guard (discarding a superseded response)
// is enforced by the MAIN thread against the echoed `reqId` — the worker just processes each
// request and echoes its id back.
import { throttleProgress } from './rank-progress';
import {
  type RankMessage,
  type RankRequest,
  type RankResponse,
  preloadScorers,
  rankCandidatesInBrowser,
} from './score-wasm';

// Warm the wasm modules as soon as the worker spawns (the UI spawns it on an agbcc target).
preloadScorers();

self.onmessage = async (e: MessageEvent<RankRequest>) => {
  const { reqId, name, asm, target, symbols } = e.data;
  try {
    // THE THROTTLE LIVES HERE, at the transport boundary it is a policy about: the driver observes
    // every candidate, and this is what bounds how many of those observations become postMessages
    // (~10/s, whatever the fan shape — 117,760 candidates would otherwise be 117,760 wake-ups of
    // the main thread the worker exists to protect). A fresh throttle per request, so one run's
    // clock cannot suppress another's first tick.
    //
    // Progress carries the SAME echoed `reqId` as the result, for the same reason: the main
    // thread's H1 guard drops anything stamped with a superseded id. The worker still does not
    // learn about staleness — it only stamps and posts.
    const post = throttleProgress((p) => postMessage({ kind: 'progress', reqId, ...p } satisfies RankMessage));
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
