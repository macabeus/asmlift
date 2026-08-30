// asmlift webapp — the ranking PROGRESS model: the phases a browser ranking passes through, the
// emission throttle, and the pure props the UI renders a bar from.
//
// WHY IT IS ITS OWN MODULE. Two reasons, both load-bearing. (1) score-wasm.ts imports the `agbcc`
// package, which cannot be imported under vitest (candidate-compile.test.ts's header documents
// why), and apps/web has no jsdom — so anything that needs a test has to be a plain function
// outside both. (2) The throttle and the labels are shared by the worker driver and by two views
// (RankBadge, RankCandidates); one copy is how they cannot drift into saying different things
// about the same run.
//
// THE HONESTY RULES THIS FILE ENCODES:
//  • The total does not exist until `enumerateCandidates` has returned, so three of the four
//    phases are INDETERMINATE and carry no number at all. No estimate, no "0 %" of an unknown
//    denominator — a fabricated total is a lie the user cannot check.
//  • A determinate bar is rendered ONLY while scoring, and the scoring phase ends by moving to
//    `ranking`, not by sitting at done === total. The fill is additionally clamped below 100 so
//    the pixels never read "finished" while the sort + structured clone + render still run;
//    `aria-valuenow` keeps the TRUE count, so assistive tech gets the exact number.

/** The four phases of `rankCandidatesInBrowser`, in the order they run. Only `scoring` is
 *  determinate. `assembling` runs FIRST (it is milliseconds, and it is the phase that fails on a
 *  pret-dialect `.s`); `enumerating` is synchronous inside core and cannot be subdivided, so it
 *  gets a name and no number. */
export type RankPhase = 'assembling' | 'enumerating' | 'scoring' | 'ranking';

/** One progress observation. `done`/`total` exist only once the candidate array does. */
export interface RankProgress {
  phase: RankPhase;
  done?: number;
  total?: number;
}

const PHASE_TEXT: Record<RankPhase, string> = {
  assembling: 'assembling the target asm…',
  enumerating: 'enumerating candidate spellings…',
  scoring: 'scoring candidates with agbcc + objdiff…',
  ranking: 'ranking scored candidates…',
};

/** The one sentence both the badge and the Pipeline card show, so they cannot disagree about what
 *  the run is doing. Determinate only when a REAL total is in hand. */
export function progressLabel(p: RankProgress): string {
  if (p.phase === 'scoring' && p.total !== undefined && p.done !== undefined) {
    return `scoring ${p.done.toLocaleString()} / ${p.total.toLocaleString()} candidates`;
  }
  return PHASE_TEXT[p.phase];
}

export interface RankProgressBar {
  /** true ⇔ a real total exists ⇔ the bar may show a fill and an `aria-valuenow`. */
  determinate: boolean;
  /** the EXACT count for `aria-valuenow`; omitted while indeterminate (that omission is the ARIA
   *  spelling of "indeterminate" — an invented 0 would not be). */
  valueNow?: number;
  valueMax?: number;
  /** the fill WIDTH in percent, clamped to 99 so a full bar never sits over unfinished work. */
  pct: number;
  label: string;
}

export function progressBar(p: RankProgress): RankProgressBar {
  const label = progressLabel(p);
  if (p.phase !== 'scoring' || p.total === undefined || p.done === undefined) {
    return { determinate: false, pct: 0, label };
  }
  const pct = p.total > 0 ? Math.min(99, Math.round((100 * p.done) / p.total)) : 0;
  return { determinate: true, valueNow: p.done, valueMax: p.total, pct, label };
}

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
