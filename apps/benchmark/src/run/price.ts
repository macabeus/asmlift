// What a ranked pass costs per candidate — ONE model, quoted by every command that prices a fan
// before paying for it (`bench fan`'s refusal, `bench sweep --fan`'s newly ranked rows).
import type { FunctionResult } from '@asmlift/bench-schema';

import type { Case } from '../cases/types';
import { readWorktreeArtifact } from '../report/committed';

/** Seconds per candidate on the SCORING path — a compile plus an objdiff alignment — PER TIER,
 *  because the two tiers do not compile the same thing.
 *
 *  Both numbers are cold measurements on this machine with `ASMLIFT_CANDCACHE=0`:
 *
 *  | tier | row | candidates | SCORING wall | per candidate |
 *  |---|---|---|---|---|
 *  | synthetic | `synthetic:sizebound:agbcc` | 800 | 47.9 s | 60 ms |
 *  | real | `kleod:CountCollectedGems:agbcc` | 5,952 | 518 s | 87 ms |
 *  | real | the same row, a second run on a quieter machine | 5,952 | 483 s | 81 ms |
 *
 *  (Both real-tier walls are the total minus a separately measured 50 s of target build plus
 *  enumeration, and both runs reproduced the published `171/387`. The constant is the middle of
 *  the two; the spread is machine load, and the tier gap is 40% either way.)
 *
 *  ONE rate for both under-prices the real tier by ~35%, and that is the tier the refusal quotes
 *  on `CountCollectedGems`. The mechanism is in `compile/real.ts`: a real candidate escalates
 *  through up to three preludes (`makeRealCompile`), where a synthetic one is a single small
 *  prelude — so the real tier pays more compiler invocations per candidate, and the gap is
 *  structural rather than noise.
 *
 *  The point of the constant is that the refusal QUOTES a price instead of asserting one: a reader
 *  steered off `--force` by a wrong number loses the answer the command exists to give. */
export const SCORE_SECONDS_PER_CANDIDATE: Record<Case['tier'], number> = {
  synthetic: 0.06,
  real: 0.085,
};

/** The price of scoring `n` candidates at `perCandidate` seconds each, rounded to a unit a reader
 *  can act on. Never a bare second-count above a minute: the decision this informs is "do I start
 *  this now", and 357 s is a number one has to divide before it means anything. */
export function estimatedScoreTime(n: number, perCandidate: number): string {
  const seconds = n * perCandidate;
  if (seconds < 90) {
    return `about ${Math.max(1, Math.round(seconds))} s`;
  }
  const minutes = seconds / 60;
  return minutes < 90 ? `about ${Math.round(minutes)} min` : `about ${(minutes / 60).toFixed(1)} h`;
}

type PricedRow = Pick<FunctionResult, 'toolchain' | 'tier' | 'asmlift'>;

/** Seconds per COMPILED candidate that an artifact's ranked passes took, keyed `toolchain tier` and
 *  `toolchain`. Per toolchain because the toolchains are not on one scale — an mwcc compile runs in
 *  Docker, an agbcc one natively — and per COMPILED candidate because a stillborn fan's
 *  `rankSeconds` paid for the candidates it compiled, not for the ones it enumerated. */
export function rankRates(recorded: readonly PricedRow[]): Map<string, number> {
  const sums = new Map<string, { n: number; s: number }>();
  const add = (k: string, n: number, s: number): void => {
    const v = sums.get(k) ?? { n: 0, s: 0 };
    sums.set(k, { n: v.n + n, s: v.s + s });
  };
  for (const r of recorded) {
    const { fanSize, fanNotCompiled, rankSeconds } = r.asmlift ?? {};
    const compiled = (fanSize ?? 0) - (fanNotCompiled ?? 0);
    if (typeof rankSeconds === 'number' && compiled > 0) {
      add(`${r.toolchain} ${r.tier}`, compiled, rankSeconds);
      add(r.toolchain, compiled, rankSeconds);
    }
  }
  return new Map([...sums].map(([k, v]) => [k, v.s / v.n]));
}

/** The seconds one candidate of this toolchain and tier is priced at: the slower of the artifact's
 *  rate and the cold floor above. The artifact's rate is measured by a `bench run` whose candidate
 *  cache serves most of its compiles, so on its own it under-prices a fan nobody has compiled yet;
 *  the floor alone under-prices every toolchain slower than agbcc. */
export function secondsPerCandidate(toolchain: string, tier: Case['tier'], rates: ReadonlyMap<string, number>): number {
  return Math.max(rates.get(`${toolchain} ${tier}`) ?? rates.get(toolchain) ?? 0, SCORE_SECONDS_PER_CANDIDATE[tier]);
}

/** `rankRates` over this worktree's committed artifact, and why it has none when it will not parse. */
export function recordedRankRates(): { rates: Map<string, number>; unreadable?: string } {
  const a = readWorktreeArtifact();
  return a.results
    ? { rates: rankRates(a.results) }
    : { rates: new Map(), ...(a.unreadable ? { unreadable: a.unreadable } : {}) };
}
