// asmlift webapp — the ranking PROGRESS model: the phases a browser ranking passes through, and
// the emission throttle that bounds how often they cross a postMessage boundary. The SENTENCES and
// the bar geometry are one altitude up, in progress-view.ts — the driver that emits progress must
// not have to reach through the UI's copy to do it. It is its own module rather than part of
// score-wasm.ts because score-wasm.ts imports the `agbcc` package, which cannot be imported under
// vitest (candidate-compile.test.ts's header documents why), and apps/web has no jsdom.
//
// THE HONESTY RULE THESE TYPES ENCODE: the total does not exist until `enumerateCandidates` has
// returned, so four of the five phases are INDETERMINATE and carry no number at all — no estimate,
// no "0 %" of an unknown denominator. A fabricated total is a lie the user cannot check, and the
// union below makes one unspellable rather than merely discouraged.

/** The phases a ranking passes through, in the order they run. Only `scoring` is determinate.
 *
 *  `queued` is the one phase the WORKER NEVER EMITS: it is what the main thread knows between
 *  `postMessage` and the first tick, and it is a real wait, not a formality — the worker is
 *  single-threaded and `enumerateCandidates` is synchronous, so a request posted while a superseded
 *  run is still enumerating cannot even be DEQUEUED for the length of it (62.3 s on one measured
 *  run, 2026-08-30). Naming that `assembling` would assert work nobody has observed, the same class
 *  of lie as a fabricated total.
 *
 *  `assembling` runs first inside the worker (milliseconds, and the phase that fails on a
 *  pret-dialect `.s`); `enumerating` is synchronous inside core and cannot be subdivided, so it
 *  gets a name and no number. */
export type RankPhase = 'queued' | 'assembling' | 'enumerating' | 'scoring' | 'ranking';

/** One progress observation, DISCRIMINATED on the phase: `done`/`total` exist if and only if the
 *  phase is `scoring`, because the candidate array is what mints them. Two optional fields on one
 *  shape would admit four states no emitter can produce (`enumerating` with a count, `scoring` with
 *  only a `done`, …), each needing a defensive branch in the view; a union has nothing to defend.
 *
 *  `EmittedProgress` is the same model minus `queued`, and the whole emitter chain — the driver's
 *  `onProgress`, the throttle, the poster, the wire type — is typed on IT, so the phase the worker
 *  cannot observe cannot be posted. The VIEW takes `RankProgress`, because the main thread's own
 *  `queued` is a real thing to render. */
export type EmittedProgress =
  | { phase: Exclude<RankPhase, 'scoring' | 'queued'>; done?: undefined; total?: undefined }
  | { phase: 'scoring'; done: number; total: number };
export type RankProgress = EmittedProgress | { phase: 'queued'; done?: undefined; total?: undefined };

/** Wrap an emitter so it posts at most once per `intervalMs` of WALL TIME. (Every number here is
 *  one machine on 2026-08-30, not a property of the code: the argument is durable, the numbers rot.)
 *
 *  WHY A THROTTLE AT ALL: one real function enumerates 117,760 candidates in the browser (the CLI's
 *  number for the same function, WITH a symbol map, is 66,816), and a postMessage per candidate
 *  would flood the main thread the worker exists to protect.
 *
 *  WHY THE CLOCK AND NOT A COUNT: per-candidate cost on that same fan was measured between 25 ms
 *  and 167 ms, so "every 64th candidate" posts at wildly different rates per function, while a
 *  100 ms clock bounds the rate whatever the shape.
 *
 *  TWO EXEMPTIONS, both about not lying: a PHASE CHANGE is never suppressed (a swallowed one leaves
 *  the bar on a stale phase for the whole tail), and neither is the FINAL tick of a determinate
 *  phase (`done === total`) — a bar that stops at 41,318 / 117,760 and then jumps to another phase
 *  reads as work that was skipped. The first tick of a phase is emitted at once, so the count
 *  appears immediately. */
export function throttleProgress(
  emit: (p: EmittedProgress) => void,
  now: () => number = () => performance.now(),
  intervalMs = 100,
): (p: EmittedProgress) => void {
  let lastPhase: EmittedProgress['phase'] | null = null;
  let lastAt = 0;
  return (p) => {
    const final = p.total !== undefined && p.done === p.total;
    if (p.phase === lastPhase && !final && now() - lastAt < intervalMs) {
      return;
    }
    lastPhase = p.phase;
    lastAt = now();
    emit(p);
  };
}

/** Wrap a poster so it goes silent once `isCurrent()` stops holding — the RATE half of the
 *  stale-guard, and only the rate half.
 *
 *  `self.onmessage` is async, so a second message is dequeued at the first `await` of the first and
 *  two runs interleave: a superseded run keeps scoring, and keeps emitting, for the rest of its
 *  natural life. Measured 2026-08-30, bumping the reqId 9.9 s into an 800-candidate run: 286
 *  further ticks over 78 s, every one waking the main thread to be thrown away. The throttle bounds
 *  ONE run to ~10 msg/s; nothing bounded the number of live superseded runs, so the aggregate rate
 *  scaled with edits-during-a-run.
 *
 *  This may only ever DROP. The H1 stale-guard stays on the main thread as the sole authority over
 *  what is DISPLAYED (`applyRankMessage`), and dropping more here cannot route around it: the
 *  worker learns of a new id only from a message the main thread posted after adopting it — a
 *  request, or the `supersede` it posts when it abandons ranking without asking for anything — so
 *  everything suppressed here would have been dropped there. */
export function whileCurrent(
  isCurrent: () => boolean,
  post: (p: EmittedProgress) => void,
): (p: EmittedProgress) => void {
  return (p) => {
    if (!isCurrent()) {
      return;
    }
    post(p);
  };
}
