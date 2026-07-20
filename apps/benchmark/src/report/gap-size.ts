// The MEASURED size of the remaining gap: the best compiling candidate's absolute objdiff diff,
// its row-normalized ratio, and where the diff sits. It measures distance — it never predicts
// closability. null when either decompiler matched or neither produced a scored candidate.
import type { FunctionResult } from '@asmlift/bench-schema';

export function gapSize(r: FunctionResult): FunctionResult['gapSize'] {
  if (r.asmlift.outcome === 'match' || r.m2c.outcome === 'match') {
    return null; // already solved
  }
  const scored = (['asmlift', 'm2c'] as const)
    .map((d) => ({ d, res: r[d] }))
    .filter(({ res }) => res.outcome === 'nonmatch' && res.score !== null && res.maxScore !== null);
  if (scored.length === 0) {
    return null; // nothing measured — no compiling candidate from either decompiler
  }
  const best = scored.reduce((a, b) => (a.res.score! <= b.res.score! ? a : b));
  const score = best.res.score!;
  const maxScore = best.res.maxScore!;
  return {
    decompiler: best.d,
    score,
    maxScore,
    ratio: score / Math.max(1, maxScore),
    kinds: best.res.breakdown,
  };
}
