// The Benchmark view's data module bundles the split artifact (`../data/index.json` + every
// `../data/projects/*.json`, through `import.meta.glob`) and merges it back. Pinned against the
// same files read off disk, so a glob that misses a file — or a rename that leaves one out —
// cannot render a benchmark with a project silently gone.
import { readArtifactDir } from '@asmlift/bench-schema/artifact-fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { bench } from '../src/pages/benchmark/lib/data';

test('the bundled benchmark is the whole published artifact, in its order', () => {
  const onDisk = readArtifactDir(join(import.meta.dirname, '../src/pages/benchmark/data'));
  expect(bench.meta).toEqual(onDisk.meta);
  expect(bench.results.map((r) => r.id)).toEqual(onDisk.results.map((r) => r.id));
  expect(bench.results.length).toBe(bench.meta.counts.total);
  expect(new Set(bench.results.map((r) => r.project)).size).toBeGreaterThan(1);
});
