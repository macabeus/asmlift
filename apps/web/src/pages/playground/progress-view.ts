// asmlift webapp — the ranking progress VIEW: the one sentence the UI shows for a phase, and the
// bar geometry it renders. Split out of rank-progress.ts (the phase model + the transport throttle)
// so the compute driver's import graph does not reach user-facing copy: score-wasm.ts and
// rank.worker.ts import the MODEL, RankPanel.tsx imports this. Same testability — both halves are
// plain functions outside the `agbcc` import — with the altitudes no longer fused.
//
// The rules here are honesty rules, not styling ones:
//  • a determinate bar exists ONLY while scoring with a real, non-zero total;
//  • the fill is clamped below 100 so the pixels never read "finished" while the sort, the
//    structured clone and the render still run, while `aria-valuenow` keeps the TRUE count.
import type { RankPhase, RankProgress } from './rank-progress';

// `scoring` has no entry: it is the one phase that cannot be spelled without its counts, so
// `progressLabel` returns before reaching this table and a sentence here would be unreachable.
const PHASE_TEXT: Record<Exclude<RankPhase, 'scoring'>, string> = {
  queued: 'waiting for the ranking worker…',
  assembling: 'assembling the target asm…',
  enumerating: 'enumerating candidate spellings…',
  ranking: 'ranking scored candidates…',
};

/** The one sentence both the badge and the Pipeline card show, so they cannot disagree about what
 *  the run is doing. Determinate only when a REAL total is in hand. */
export function progressLabel(p: RankProgress): string {
  if (p.phase === 'scoring') {
    return `scoring ${p.done.toLocaleString()} / ${p.total.toLocaleString()} candidates`;
  }
  return PHASE_TEXT[p.phase];
}

/** The bar's props, also discriminated: `pct`/`valueNow`/`valueMax` exist ONLY on the determinate
 *  arm. As optional fields, the indeterminate arm would carry a `pct: 0` — the exact "0 % of an
 *  unknown denominator" this module's header forbids, one careless reader away from being drawn. */
export type RankProgressBar =
  | { determinate: false; label: string }
  | {
      determinate: true;
      /** the EXACT count for `aria-valuenow` (the fill is clamped, this is not). */
      valueNow: number;
      valueMax: number;
      /** the fill WIDTH in percent, clamped to 99 so a full bar never sits over unfinished work. */
      pct: number;
      label: string;
    };

export function progressBar(p: RankProgress): RankProgressBar {
  const label = progressLabel(p);
  // A ZERO total is a real emission — an enumeration that produced nothing, which then throws
  // `no scorable candidate` — and it is NOT determinate: ARIA requires `aria-valuemax` to exceed
  // `aria-valuemin`, so equal bounds leave the AT-computed percentage undefined. 0/0 has no
  // percentage on either channel; the label still carries the true counts.
  if (p.phase !== 'scoring' || p.total === 0) {
    return { determinate: false, label };
  }
  const pct = Math.min(99, Math.round((100 * p.done) / p.total));
  return { determinate: true, valueNow: p.done, valueMax: p.total, pct, label };
}
