// asmlift webapp — the ranking Web Worker. Enumerating candidates is cheap, but compiling each
// with agbcc-wasm and diffing with objdiff-wasm is heavy enough to jank the editor if run on the
// main thread, so it lives here. The worker owns the wasm engines; the main thread only posts a
// RankRequest and receives a RankResponse. The H1 stale-guard (discarding a superseded response)
// is enforced by the MAIN thread against the echoed `reqId` — the worker just processes each
// request and echoes its id back.
import { type RankRequest, type RankResponse, preloadScorers, rankCandidatesInBrowser } from './score-wasm';

// Warm the wasm modules as soon as the worker spawns (the UI spawns it on an agbcc target).
preloadScorers();

self.onmessage = async (e: MessageEvent<RankRequest>) => {
  const { reqId, name, asm, target } = e.data;
  try {
    const result = await rankCandidatesInBrowser(name, asm, target);
    postMessage({ reqId, ok: true, result } satisfies RankResponse);
  } catch (err) {
    postMessage({ reqId, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies RankResponse);
  }
};
