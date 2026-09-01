// Merge synthetic.json + real.json → results.json (the single committed artifact; the tier
// files are gitignored intermediates), annotating each function with its measured gap size. Run
// AFTER `bench run`. A near-pure data transform — pushing the
// snapshot into the web app is report/publish.ts, a named step — with one REFUSAL: a tier whose
// run-time provenance disagrees with merge time is not merged (see ../provenance.ts).
import type { BenchOutput } from '@asmlift/bench-schema';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { M2C_PINNED_COMMIT, RESULTS_DIR } from '../config';
import { assessQuality } from '../eval/quality';
import { asmliftProvenance } from '../provenance';
import { benchMeta } from '../run/runner';
import { gapSize } from './gap-size';
import { asmliftScript, m2cScript } from './repro-scripts';

const read = (f: string): BenchOutput | undefined =>
  existsSync(join(RESULTS_DIR, f))
    ? (JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')) as BenchOutput)
    : undefined;

/** Refuse to merge a tier whose RUN-time provenance disagrees with merge time. A tier written
 *  before this stamp existed carries no `meta.asmlift` and is passed through — the loud failure is
 *  for a disagreement, not for an absence, because a missing stamp is an old artifact rather than
 *  a mutated tree. */
export function checkTierProvenance(
  f: string,
  out: BenchOutput | undefined,
  now: { commit: string; dirty: boolean } | undefined,
): void {
  const ran = out?.meta.asmlift;
  if (ran === undefined) {
    return;
  }
  if (ran.dirty) {
    throw new Error(
      `${f} was RUN against a dirty working tree (commit ${ran.commit}) — those numbers come from code no ` +
        `commit holds. Re-run on a clean tree; see apps/benchmark/src/provenance.ts.`,
    );
  }
  if (now !== undefined && now.commit !== ran.commit) {
    throw new Error(
      `${f} was RUN at ${ran.commit} but merge is at ${now.commit} — the code moved between run and merge, ` +
        `so the artifact would publish this commit's provenance over another commit's numbers. Re-run.`,
    );
  }
}

export function merge(): void {
  const tiers = { 'synthetic.json': read('synthetic.json'), 'real.json': read('real.json') };
  const now = asmliftProvenance();
  for (const [f, out] of Object.entries(tiers)) {
    checkTierProvenance(f, out, now);
  }
  // id-sorted: the tier files' row order depends on the shard count, which differs by machine
  // (CPU count) — sorting makes the canonical artifact byte-stable across hosts
  const results = [...(tiers['synthetic.json']?.results ?? []), ...(tiers['real.json']?.results ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  for (const r of results) {
    r.gapSize = gapSize(r);
    r.scripts = { m2c: m2cScript(r), asmlift: asmliftScript(r) };
    // Quality is RECOMPUTED from the stored source at merge time: cached decompiler results
    // carry the quality shape of whatever harness version produced them (retired fields like
    // the old prose `notes`, or missing newer counters) — recomputing keeps the published
    // object exactly current-schema without a cache bump. The score formula is pinned
    // (quality.test.ts), so recompute never moves published scores.
    for (const side of [r.asmlift, r.m2c]) {
      side.quality = assessQuality(side.source);
    }
  }

  const out: BenchOutput = {
    meta: { ...benchMeta(results), asmlift: now, m2c: { commit: M2C_PINNED_COMMIT } },
    results,
  };
  writeFileSync(join(RESULTS_DIR, 'results.json'), JSON.stringify(out, null, 2));
  console.log(
    `Merged ${results.length} results (${out.meta.counts.synthetic} synthetic + ${out.meta.counts.real} real) → results/results.json`,
  );
}
