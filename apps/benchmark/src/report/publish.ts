// Publish the merged results into the web app: the cross-app write is a NAMED step, not a side
// effect of the merge data-transform. `bench merge` runs merge + publish; `bench publish`
// re-stages an existing results.json alone.
import type { BenchOutput } from '@asmlift/bench-schema';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, RESULTS_DIR } from '../config';

export function publish(): void {
  const path = join(RESULTS_DIR, 'results.json');
  if (!existsSync(path)) {
    throw new Error('results/results.json not found — run `bench merge` first');
  }
  const out = JSON.parse(readFileSync(path, 'utf8')) as BenchOutput;
  const { results } = out;

  // The full data into the web app's Benchmark view, so it imports a committed, up-to-date
  // snapshot (no fetch, no server)...
  const reportData = join(REPO_ROOT, 'apps', 'web', 'src', 'pages', 'benchmark', 'data');
  mkdirSync(reportData, { recursive: true });
  writeFileSync(join(reportData, 'results.json'), JSON.stringify(out));
  // ...and a tiny outcome summary into the playground, so its footer stat is data, not prose.
  const webData = join(REPO_ROOT, 'apps', 'web', 'src', 'data');
  mkdirSync(webData, { recursive: true });
  writeFileSync(
    join(webData, 'summary.json'),
    JSON.stringify(
      {
        total: results.length,
        match: {
          asmlift: results.filter((r) => r.asmlift.outcome === 'match').length,
          m2c: results.filter((r) => r.m2c.outcome === 'match').length,
        },
        commit: out.meta.asmlift?.commit ?? null,
        m2cCommit: out.meta.m2c?.commit ?? null,
        // NEVER dropped: numbers produced by uncommitted code must say so wherever they surface.
        dirty: out.meta.asmlift?.dirty ?? null,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Published → web/src/pages/benchmark/data/results.json + web/src/data/summary.json`);
}
