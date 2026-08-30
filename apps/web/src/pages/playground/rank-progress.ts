// asmlift webapp — the ranking PROGRESS model: the phases a browser ranking passes through, and
// the emission throttle that bounds how often they cross a postMessage boundary. The SENTENCES and
// the bar geometry are one altitude up, in progress-view.ts — the driver that emits progress must
// not have to reach through the UI's copy to do it.
//
// WHY IT IS ITS OWN MODULE rather than living in score-wasm.ts: score-wasm.ts imports the `agbcc`
// package, which cannot be imported under vitest (candidate-compile.test.ts's header documents
// why), and apps/web has no jsdom — so anything that needs a test has to be a plain function
// outside both.
//
// THE HONESTY RULE THIS FILE ENCODES: the total does not exist until `enumerateCandidates` has
// returned, so four of the five phases are INDETERMINATE and carry no number at all — no estimate,
// no "0 %" of an unknown denominator. A fabricated total is a lie the user cannot check, and the
// type below makes one unspellable rather than merely discouraged.

/** The phases a ranking passes through, in the order they run. Only `scoring` is determinate.
 *
 *  `queued` is the one phase the WORKER NEVER EMITS — it is what the main thread knows between
 *  `postMessage` and the worker's first tick, and it is a real state rather than a formality: the
 *  worker is single-threaded and `enumerateCandidates` is synchronous, so a request posted while a
 *  superseded run is still enumerating cannot even be DEQUEUED for the length of that enumeration
 *  (62.3 s on one measured run, 2026-08-30). Calling that `assembling` would assert work that has
 *  not started — the badge asserting a phase nobody observed is the same class of lie as a
 *  fabricated total, so it gets its own name.
 *
 *  `assembling` then runs FIRST inside the worker (it is milliseconds, and it is the phase that
 *  fails on a pret-dialect `.s`); `enumerating` is synchronous inside core and cannot be
 *  subdivided, so it gets a name and no number. */
export type RankPhase = 'queued' | 'assembling' | 'enumerating' | 'scoring' | 'ranking';

/** One progress observation, DISCRIMINATED on the phase: `done`/`total` exist if and only if the
 *  phase is `scoring`, because the candidate array is what mints them. As two optional fields on
 *  one shape the type admitted four states no emitter can produce (`enumerating` with a count,
 *  `scoring` with only a `done`, …), each of which then needed a defensive branch in the view and
 *  a test asserting an unreachable state; as a union there is nothing to defend against. */
export type RankProgress =
  | { phase: Exclude<RankPhase, 'scoring'>; done?: undefined; total?: undefined }
  | { phase: 'scoring'; done: number; total: number };

/** Wrap an emitter so it posts at most once per `intervalMs` of WALL TIME.
 *
 *  WHY A THROTTLE AT ALL: one real function enumerates 117,760 candidates in the browser (measured;
 *  the CLI's number for the same function, WITH a symbol map, is 66,816). A postMessage per
 *  candidate would flood the main thread the worker exists to protect.
 *
 *  WHY THE CLOCK AND NOT A COUNT: per-candidate cost on that same fan was measured between 25 ms
 *  and 167 ms, so "every 64th candidate" posts at wildly different rates per function, while a
 *  100 ms clock bounds the rate whatever the shape.
 *
 *  TWO EXEMPTIONS, both about not lying:
 *   • a PHASE CHANGE is never suppressed — a swallowed one leaves the bar showing a stale phase
 *     for the whole tail;
 *   • the FINAL tick of a determinate phase (`done === total`) is never suppressed — a bar that
 *     stops at 41,318 / 117,760 and then jumps to another phase reads as work that was skipped.
 *  The first tick of any phase is emitted immediately, so the count appears at once. */
export function throttleProgress(
  emit: (p: RankProgress) => void,
  now: () => number = () => performance.now(),
  intervalMs = 100,
): (p: RankProgress) => void {
  let lastPhase: RankPhase | null = null;
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
 *  `self.onmessage` is async, so a second request is dequeued at the first `await` of the first and
 *  the two runs interleave: a superseded run keeps scoring, and keeps emitting, for the rest of its
 *  natural life. Measured (2026-08-30): bumping the reqId 9.9 s into an 800-candidate run left the
 *  abandoned run posting 286 further ticks over 78 s, every one waking the main thread to be thrown
 *  away. The throttle bounds ONE run to ~10 msg/s; nothing bounded the number of live superseded
 *  runs, so the aggregate rate scaled with edits-during-a-run.
 *
 *  This may only ever DROP. The H1 stale-guard stays on the main thread as the sole authority over
 *  what is DISPLAYED (`applyRankMessage`), and dropping more here cannot route around it: the
 *  worker learns of a new id only from the message the main thread posted after adopting it, so
 *  everything suppressed here would have been dropped there. */
export function whileCurrent(isCurrent: () => boolean, post: (p: RankProgress) => void): (p: RankProgress) => void {
  return (p) => {
    if (!isCurrent()) {
      return;
    }
    post(p);
  };
}
