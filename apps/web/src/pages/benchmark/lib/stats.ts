// Pure aggregation helpers over the results array. No React, no charts — just data in, data out.
// New charts should compose these rather than re-deriving counts inside a component.
import type { DecompilerId, FunctionResult, Outcome } from '@asmlift/bench-schema';

export type OutcomeCounts = Record<Outcome, number>;

const zeroOutcomes = (): OutcomeCounts => ({
  match: 0,
  nonmatch: 0,
  noncompile: 0,
  declined: 0,
  failed: 0,
});

/** Total counts of each outcome for one decompiler across the given rows. */
export function outcomeCounts(rows: FunctionResult[], decompiler: DecompilerId): OutcomeCounts {
  const acc = zeroOutcomes();
  for (const r of rows) {
    acc[r[decompiler].outcome]++;
  }
  return acc;
}

/** Match rate (0..1) for one decompiler over the given rows. */
export function matchRate(rows: FunctionResult[], decompiler: DecompilerId): number {
  if (rows.length === 0) {
    return 0;
  }
  const matches = rows.filter((r) => r[decompiler].outcome === 'match').length;
  return matches / rows.length;
}

/** Group rows by an arbitrary key, preserving first-seen order unless `order` is given. */
export function groupBy<K extends string>(
  rows: FunctionResult[],
  keyOf: (r: FunctionResult) => K,
  order?: K[],
): { key: K; rows: FunctionResult[] }[] {
  const map = new Map<K, FunctionResult[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const bucket = map.get(k);
    if (bucket) {
      bucket.push(r);
    } else {
      map.set(k, [r]);
    }
  }
  const keys = order ? order.filter((k) => map.has(k)) : Array.from(map.keys());
  return keys.map((key) => ({ key, rows: map.get(key)! }));
}

export interface MatchRateRow<K extends string> {
  key: K;
  total: number;
  asmlift: number; // match rate 0..1
  m2c: number; // match rate 0..1
}

/** Match rate per group, for both decompilers. */
export function matchRateBy<K extends string>(
  rows: FunctionResult[],
  keyOf: (r: FunctionResult) => K,
  order?: K[],
): MatchRateRow<K>[] {
  return groupBy(rows, keyOf, order).map(({ key, rows: g }) => ({
    key,
    total: g.length,
    asmlift: matchRate(g, 'asmlift'),
    m2c: matchRate(g, 'm2c'),
  }));
}

export interface FeatureStat {
  feature: string;
  count: number;
  asmlift: number; // match rate 0..1
  m2c: number; // match rate 0..1
}

/** Per-feature match rate. A function contributes to every feature tag it carries. */
export function featureStats(rows: FunctionResult[]): FeatureStat[] {
  const byFeature = new Map<string, FunctionResult[]>();
  for (const r of rows) {
    for (const f of r.features) {
      const bucket = byFeature.get(f);
      if (bucket) {
        bucket.push(r);
      } else {
        byFeature.set(f, [r]);
      }
    }
  }
  return Array.from(byFeature.entries())
    .map(([feature, g]) => ({
      feature,
      count: g.length,
      asmlift: matchRate(g, 'asmlift'),
      m2c: matchRate(g, 'm2c'),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Distinct sorted values of a string field, for filter dropdowns. */
export function distinct(rows: FunctionResult[], keyOf: (r: FunctionResult) => string): string[] {
  return Array.from(new Set(rows.map(keyOf))).sort();
}

/** Distinct feature tags across all rows, sorted by frequency (desc). */
export function distinctFeatures(rows: FunctionResult[]): string[] {
  return featureStats(rows).map((f) => f.feature);
}

export interface H2HRow<K extends string> {
  key: K;
  total: number;
  both: number; //        both decompilers byte-exact
  asmliftOnly: number; // asmlift matched, m2c did not
  m2cOnly: number; //     m2c matched, asmlift did not
  neither: number; //     neither matched
}

/** Head-to-head verdict for a set of rows: who matched, exclusively or jointly. This is the
 *  competitive question the per-decompiler match rates don't answer directly. */
export function headToHead(rows: FunctionResult[]): Omit<H2HRow<'all'>, 'key'> {
  const acc = { total: rows.length, both: 0, asmliftOnly: 0, m2cOnly: 0, neither: 0 };
  for (const r of rows) {
    const a = r.asmlift.outcome === 'match';
    const m = r.m2c.outcome === 'match';
    if (a && m) {
      acc.both++;
    } else if (a) {
      acc.asmliftOnly++;
    } else if (m) {
      acc.m2cOnly++;
    } else {
      acc.neither++;
    }
  }
  return acc;
}

/** Head-to-head verdict per group (by ISA, compiler, tier, …). */
export function headToHeadBy<K extends string>(
  rows: FunctionResult[],
  keyOf: (r: FunctionResult) => K,
  order?: K[],
): H2HRow<K>[] {
  return groupBy(rows, keyOf, order).map(({ key, rows: g }) => ({ key, ...headToHead(g) }));
}

export interface Headline {
  total: number;
  toolchains: number;
  projects: number;
  synthetic: number;
  real: number;
}

export function headline(rows: FunctionResult[]): Headline {
  return {
    total: rows.length,
    toolchains: distinct(rows, (r) => r.toolchain).length,
    projects: distinct(rows, (r) => r.project).length,
    synthetic: rows.filter((r) => r.tier === 'synthetic').length,
    real: rows.filter((r) => r.tier === 'real').length,
  };
}

// ── size buckets + readability ──────────────────────────────────────────────────────────────────

export const LOC_BUCKETS = ['1–5 loc', '6–15 loc', '16+ loc'] as const;
export type LocBucket = (typeof LOC_BUCKETS)[number];

/** Reference-source size bucket — separates "wins on trivia" from real capability. */
export function locBucketOf(r: FunctionResult): LocBucket {
  return r.loc <= 5 ? '1–5 loc' : r.loc <= 15 ? '6–15 loc' : '16+ loc';
}

export interface ReadabilityStats {
  n: number; //              compiling outputs (match + nonmatch) this decompiler produced
  meanScore: number; //      mean 0..100 readability score over those outputs
  gotosPer100Lines: number; //  goto density — structured control flow lost
  castsPer100Lines: number; //  cast density — type-recovery noise
  rawMemPer100Lines: number; // `*(T*)(p+N)` density — type recovery failed outright
  addrDerefPer100Lines: number; // `*(T*)0xADDR` density — symbol/global recovery failed
  verbosity: number; //      emitted lines per reference-source line (1.0 = same length)
}

/** Readability of one decompiler's COMPILING outputs (match + nonmatch) — declined/failed rows
 *  carry marker stubs, not code, so they are excluded (same rule the per-function view uses).
 *  Densities are per 100 emitted lines: the two decompilers emit different output volumes, and
 *  share-of-outputs framings ceiling out (glue markers, for instance, force `declined`, so a
 *  "glue-free share" of compiling outputs is definitionally ~100%). */
export function readabilityStats(rows: FunctionResult[], decompiler: DecompilerId): ReadabilityStats {
  const picked = rows.filter((r) => {
    const o = r[decompiler].outcome;
    return o === 'match' || o === 'nonmatch';
  });
  const outputs = picked.map((r) => r[decompiler]);
  const n = outputs.length;
  const lines = outputs.reduce((a, d) => a + d.quality.lines, 0);
  const refLoc = picked.reduce((a, r) => a + r.loc, 0);
  if (n === 0 || lines === 0 || refLoc === 0) {
    return {
      n,
      meanScore: 0,
      gotosPer100Lines: 0,
      castsPer100Lines: 0,
      rawMemPer100Lines: 0,
      addrDerefPer100Lines: 0,
      verbosity: 0,
    };
  }
  const per100 = (total: number) => (100 * total) / lines;
  return {
    n,
    meanScore: outputs.reduce((a, d) => a + d.quality.score, 0) / n,
    gotosPer100Lines: per100(outputs.reduce((a, d) => a + d.quality.gotos, 0)),
    castsPer100Lines: per100(outputs.reduce((a, d) => a + d.quality.casts, 0)),
    rawMemPer100Lines: per100(outputs.reduce((a, d) => a + d.quality.rawMem, 0)),
    addrDerefPer100Lines: per100(outputs.reduce((a, d) => a + d.quality.addrDeref, 0)),
    verbosity: lines / refLoc,
  };
}
