// Merge synthetic.json + real.json → results.json (the single committed artifact; the tier
// files are gitignored intermediates), annotating each function with its measured gap size. Run
// AFTER `bench run`. PURE data transform — pushing the
// snapshot into the web app is report/publish.ts, a named step.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { M2C_PINNED_COMMIT, REPO_ROOT, RESULTS_DIR } from '../config';
import { assessQuality } from '../eval/quality';
import { benchMeta } from '../run/runner';
import { gapSize } from './gap-size';
import { asmliftScript, m2cScript } from './repro-scripts';

const load = (f: string): FunctionResult[] =>
  existsSync(join(RESULTS_DIR, f))
    ? (JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')) as BenchOutput).results
    : [];

// Provenance: which asmlift commit produced these numbers (dirty flag included). "Dirty" means
// the CODE differs from the commit — the benchmark's own regenerated artifacts (results,
// report data, playground summary) are excluded, otherwise every run marks itself dirty.
const ARTIFACT_PATH = /^(apps\/benchmark\/results\/|apps\/web\/src\/pages\/benchmark\/data\/|apps\/web\/src\/data\/)/;
function asmliftProvenance(): { commit: string; dirty: boolean } | undefined {
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) {
    return undefined;
  }
  const status = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  const codeDirty = status.stdout
    .split('\n')
    .some((l) => l.trim() !== '' && !ARTIFACT_PATH.test(l.slice(3).replace(/^"|"$/g, '')));
  return { commit: head.stdout.trim(), dirty: status.status !== 0 || codeDirty };
}

export function merge(): void {
  // id-sorted: the tier files' row order depends on the shard count, which differs by machine
  // (CPU count) — sorting makes the canonical artifact byte-stable across hosts
  const results = [...load('synthetic.json'), ...load('real.json')].sort((a, b) => a.id.localeCompare(b.id));
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
    meta: { ...benchMeta(results), asmlift: asmliftProvenance(), m2c: { commit: M2C_PINNED_COMMIT } },
    results,
  };
  writeFileSync(join(RESULTS_DIR, 'results.json'), JSON.stringify(out, null, 2));
  console.log(
    `Merged ${results.length} results (${out.meta.counts.synthetic} synthetic + ${out.meta.counts.real} real) → results/results.json`,
  );
}
