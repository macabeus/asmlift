// Publish the merged results into the web app: the cross-app write is a NAMED step, not a side
// effect of the merge data-transform. `bench merge` runs merge + publish; `bench publish`
// re-stages the existing merged artifact alone. The web copy is split by project like the
// committed one (bench-schema ./artifact), compact rather than pretty.
import { artifactLayoutIn, readArtifactDir, writeArtifactDir } from '@asmlift/bench-schema/artifact-fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, RESULTS_DIR } from '../config';

/** The web app's copy of the artifact (apps/web/src/pages/benchmark/lib/data.ts reads it). */
export const WEB_ARTIFACT_DIR = join(REPO_ROOT, 'apps', 'web', 'src', 'pages', 'benchmark', 'data');

export function publish(): void {
  if (artifactLayoutIn(RESULTS_DIR) === 'none') {
    throw new Error('no merged artifact in results/ — run `bench merge` first');
  }
  const out = readArtifactDir(RESULTS_DIR);
  const { results } = out;

  // The full data into the web app's Benchmark view, so it imports a committed, up-to-date
  // snapshot (no fetch, no server)...
  writeArtifactDir(WEB_ARTIFACT_DIR, out);
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
  console.log(`Published → web/src/pages/benchmark/data/{index.json,projects/} + web/src/data/summary.json`);
}
