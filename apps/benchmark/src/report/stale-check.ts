// Is the COMMITTED results.json measurement-stale against the freshly merged one? The comparison
// is measurement-level, not byte-level: `generatedAt`/provenance always differ, and cold
// runs re-mint scratch-dir names inside embedded asm comments — neither is a reason to commit.
//
// Refuses (throws) rather than answers when the fresh run cannot be trusted as a replacement:
//   - coverage shrank (fewer rows, or a toolchain vanished — e.g. Docker was down and its rows
//     were skipped): committing would destroy data, not refresh it
//   - dirty provenance: numbers from uncommitted code must never be published
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, RESULTS_DIR } from '../config';

/** Scratch-dir names and machine temp paths are run-local noise, not measurement. */
const scrub = (s: string): string =>
  s
    .replace(/(?:asmlift|bench)-[A-Za-z0-9-]+-[A-Za-z0-9]{6}/g, '<scratch>')
    .replace(/\/host-tmp\S*|\/var\/folders\S*|\/tmp\/\S*/g, '<tmp>');

const rowKey = (r: FunctionResult): string =>
  JSON.stringify({
    ...r,
    asmlift: { ...r.asmlift, source: scrub(r.asmlift.source) },
    m2c: { ...r.m2c, source: scrub(r.m2c.source) },
    targetAsm: scrub(r.targetAsm),
    refSource: r.refSource,
  });

export function staleCheck(): 'stale' | 'fresh' {
  const committed = JSON.parse(
    execSync('git show HEAD:apps/benchmark/results/results.json', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256e6,
    }),
  ) as BenchOutput;
  const fresh = JSON.parse(readFileSync(join(RESULTS_DIR, 'results.json'), 'utf8')) as BenchOutput;

  if (fresh.meta.asmlift?.dirty !== false) {
    throw new Error('fresh results carry dirty/unknown provenance — refusing to treat as a refresh');
  }
  if (fresh.results.length < committed.results.length) {
    throw new Error(
      `coverage SHRANK (${committed.results.length} → ${fresh.results.length} rows) — a partial run must never replace the dataset`,
    );
  }
  const freshToolchains = new Set(fresh.meta.toolchains);
  for (const tc of committed.meta.toolchains) {
    if (!freshToolchains.has(tc)) {
      throw new Error(`toolchain ${tc} vanished from the fresh run — refusing`);
    }
  }

  const committedRows = new Map(committed.results.map((r) => [r.id, rowKey(r)]));
  for (const r of fresh.results) {
    if (committedRows.get(r.id) !== rowKey(r)) {
      return 'stale';
    }
  }
  return committed.results.length === fresh.results.length ? 'fresh' : 'stale';
}
