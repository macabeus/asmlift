// The MEASUREMENT-NEUTRALITY gate: did anything a reader would quote move, per row, per field?
//
// `regression` answers "did a match get lost" and `stale-check` answers "may this run replace the
// dataset". Neither answers the question a refactor, a harness change or a tooling change has to
// answer — "did this change ANY number at all" — because `regression` compares `outcome` only (a
// row that slid from diff:12 to diff:14 passes it) and `stale-check` collapses the whole artifact
// to one 'stale'/'fresh' word with no row and no field named.
//
// So every branch that had to prove neutrality wrote its own comparator, against its own idea of
// which fields count. This is that comparison, once: for every row in the base artifact, the six
// fields a published claim is made of, named individually when they move.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
import { byId, readCommitted, scrub } from './committed';

/** The fields a published claim is made of. `source` is in the list because a change that moves
 *  no score can still rewrite what the report shows, and `candidateLabel` because the ranked
 *  WINNER can change identity at an unchanged score (a tie-break moving is a real change). */
const FIELDS = {
  asmlift: ['outcome', 'score', 'candidateLabel', 'source'],
  m2c: ['outcome', 'score', 'source'],
} as const;

export interface FieldChange {
  id: string;
  field: string; // e.g. "asmlift.score"
  from: string;
  to: string;
}
export interface DiffReport {
  changed: FieldChange[];
  added: string[];
  removed: string[];
  baseRows: number;
  freshRows: number;
  ok: boolean;
}

// Long text is reported by its shape, not pasted: a 40-line C body in a gate's output buries the
// one line that says which row moved.
const show = (field: string, v: unknown): string => {
  if (v === undefined || v === null) {
    return String(v);
  }
  if (field.endsWith('source')) {
    return `${String(v).length} bytes`;
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
};

export function compareMeasurements(base: BenchOutput, fresh: BenchOutput): DiffReport {
  const freshById = byId(fresh);
  const baseIds = new Set(base.results.map((r) => r.id));
  const changed: FieldChange[] = [];
  const removed: string[] = [];

  for (const was of base.results) {
    const now = freshById.get(was.id);
    if (!now) {
      removed.push(was.id);
      continue;
    }
    for (const side of ['asmlift', 'm2c'] as const) {
      for (const f of FIELDS[side]) {
        const a = (was[side] as unknown as Record<string, unknown>)[f];
        const b = (now[side] as unknown as Record<string, unknown>)[f];
        // sources are compared SCRUBBED, the same measurement-level equality stale-check uses:
        // a cold run re-mints scratch-dir names inside embedded asm comments
        const [x, y] = f === 'source' ? [scrub(String(a ?? '')), scrub(String(b ?? ''))] : [a, b];
        if (x !== y) {
          changed.push({ id: was.id, field: `${side}.${f}`, from: show(f, a), to: show(f, b) });
        }
      }
    }
  }
  const added = fresh.results.filter((r: FunctionResult) => !baseIds.has(r.id)).map((r) => r.id);
  return {
    changed,
    added,
    removed,
    baseRows: base.results.length,
    freshRows: fresh.results.length,
    ok: changed.length === 0 && added.length === 0 && removed.length === 0,
  };
}

/** CLI entry: the artifact at `base` vs the freshly merged one. Returns the process exit code —
 *  0 iff not one compared field moved and the row set is identical. */
export function diffGate(base = 'HEAD'): number {
  const report = compareMeasurements(
    readCommitted(base),
    JSON.parse(readFileSync(join(RESULTS_DIR, 'results.json'), 'utf8')) as BenchOutput,
  );

  for (const c of report.changed) {
    console.log(`CHANGED ${c.id} ${c.field}: ${c.from} → ${c.to}`);
  }
  for (const id of report.removed) {
    console.log(`REMOVED ${id} — present at ${base}, absent from the fresh run (toolchain skipped?)`);
  }
  for (const id of report.added) {
    console.log(`ADDED   ${id}`);
  }
  console.log(
    `diff vs ${base}: ${report.changed.length} field change(s), ${report.added.length} added, ` +
      `${report.removed.length} removed (${report.baseRows} base rows, ${report.freshRows} fresh rows)`,
  );
  return report.ok ? 0 : 1;
}
