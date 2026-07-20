// The web app only DISPLAYS the reproduction scripts — they are generated at merge time
// (apps/benchmark/src/report/repro-scripts.ts) and shipped in the published rows. This pin
// keeps the published copy carrying them for every function.
import type { BenchOutput } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('every published function carries both reproduction scripts', () => {
  const rows = (
    JSON.parse(
      readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8'),
    ) as BenchOutput
  ).results;
  for (const r of rows) {
    expect(r.scripts?.m2c, r.id).toBeTruthy();
    expect(r.scripts?.asmlift, r.id).toBeTruthy();
  }
});

test('every real function carries a commit-pinned, line-anchored GitHub permalink', () => {
  const rows = (
    JSON.parse(
      readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8'),
    ) as BenchOutput
  ).results;
  for (const r of rows.filter((x) => x.tier === 'real')) {
    expect(r.sourceUrl, r.id).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\/.+#L\d+-L\d+$/);
  }
  for (const r of rows.filter((x) => x.tier === 'synthetic')) {
    expect(r.sourceUrl, r.id).toBeUndefined();
  }
});
