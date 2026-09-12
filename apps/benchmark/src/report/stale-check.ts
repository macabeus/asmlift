// Is the COMMITTED results.json measurement-stale against the freshly merged one? The comparison
// is measurement-level, not byte-level: `generatedAt`/provenance always differ, and cold
// runs re-mint scratch-dir names inside embedded asm comments — neither is a reason to commit.
//
// Refuses (throws) rather than answers when the fresh run cannot be trusted as a replacement:
//   - coverage shrank (fewer rows, or a toolchain vanished — e.g. Docker was down and its rows
//     were skipped): committing would destroy data, not refresh it
//   - dirty provenance: numbers from uncommitted code must never be published
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
import { readCommitted, scrub } from './committed';

/** One decompiler's side of a row as this file COMPARES it: whole, minus what a re-run re-mints
 *  for reasons that are not the measurement.
 *
 *  `rankSeconds` is dropped for the same reason the scratch paths are scrubbed, and it is the
 *  sharper case: it is wall clock, so it differs on EVERY row of EVERY run — machine load, docker,
 *  and ~5× between a cold and a warm candidate cache. Left in, this file would answer `stale`
 *  unconditionally and stop being a question at all. `candidateCount` STAYS: enumeration is a
 *  deterministic cross over axes, so a fan that moved is a real change and exactly the one this
 *  artifact started recording in order to stop losing.
 *
 *  DELETED rather than blanked, so an artifact that predates the field still compares equal to a
 *  fresh run that carries it. */
const comparable = (d: FunctionResult['asmlift']): Record<string, unknown> => {
  const { rankSeconds: _rankSeconds, ...rest } = d;
  return { ...rest, source: scrub(d.source) };
};

/** Exported for the test: which fields this file compares is the whole of its verdict, and a
 *  nondeterministic one added to a row would turn `fresh` into an answer it can never give. */
export const rowKey = (r: FunctionResult): string =>
  JSON.stringify({
    ...r,
    asmlift: comparable(r.asmlift),
    m2c: comparable(r.m2c),
    targetAsm: scrub(r.targetAsm),
    refSource: r.refSource,
  });

export function staleCheck(base = 'HEAD'): 'stale' | 'fresh' {
  const committed = readCommitted(base);
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
