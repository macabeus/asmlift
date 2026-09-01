// The MEASUREMENT-NEUTRALITY gate: did anything a reader would quote move, per row, per field?
//
// `regression` answers "did a match get lost" and `stale-check` answers "may this run replace the
// dataset". Neither answers the question a refactor, a harness change or a tooling change has to
// answer — "did this change ANY number at all" — because `regression` compares `outcome` only (a
// row that slid from diff:12 to diff:14 passes it) and `stale-check` collapses the whole artifact
// to one 'stale'/'fresh' word with no row and no field named.
//
// So every branch that had to prove neutrality wrote its own comparator, against its own idea of
// which fields count. This is that comparison, once: for every row in the base artifact, every
// field a published claim is made of, named individually when it moves.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
import { RESULTS_PATH, byId, headContains, readCommitted, scrub, shortSha } from './committed';

/** The fields a published claim is made of — every one the report shows, or the count this gate
 *  prints is the truth about the LIST and not about the row. `source` is here because a change
 *  that moves no score can still rewrite what the report shows, `candidateLabel` because the
 *  ranked WINNER can change identity at an unchanged score (a tie-break moving is a real change),
 *  and `quality` because the report publishes it — a row can move `quality.casts` 0 → 1 with
 *  score, outcome and label all unchanged. */
const FIELDS = {
  asmlift: ['outcome', 'score', 'candidateLabel', 'source', 'quality'],
  m2c: ['outcome', 'score', 'source', 'quality'],
} as const;

/** Compared by VALUE with a stable key order — `quality` is an object, and comparing two of those
 *  with `!==` reports every row as changed. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

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
        const [x, y] =
          f === 'source'
            ? [scrub(String(a ?? '')), scrub(String(b ?? ''))]
            : f === 'quality'
              ? [stable(a), stable(b)]
              : [a, b];
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

/** Is the artifact on disk still the base's own committed file, with no run behind it?
 *
 *  This gate reads whatever bytes happen to sit at `apps/benchmark/results/results.json` — and
 *  that file is COMMITTED, so on a source-only branch with a clean tree it already IS the base's.
 *  Running the gate then compares the base against ITSELF and prints `0 field change(s)` in about
 *  a second, which is indistinguishable from the ~200s run it is supposed to summarise. That green
 *  line is what a PR body publishes as its neutrality proof, so the cheapest way to produce it
 *  must not be the one that measures nothing. (`committed.ts` guards the same vacuity on the BASE
 *  side — `HEAD` comparing a branch against itself; this is the FRESH side of it.)
 *
 *  `meta.generatedAt` decides, because `bench merge` re-mints it from `new Date()` on every run
 *  (`run/runner.ts` benchMeta). Equal stamps therefore mean no merge has run since the base's
 *  artifact was committed — there are no false positives, and it also catches an artifact edited
 *  by hand rather than measured. */
export const notRegenerated = (base: BenchOutput, fresh: BenchOutput): boolean =>
  base.meta.generatedAt === fresh.meta.generatedAt;

/** CLI entry: the artifact at `base` vs the freshly merged one. Returns the process exit code —
 *  0 iff not one compared field moved and the row set is identical, 2 if nothing was compared. */
export function diffGate(base = 'HEAD'): number {
  const committed = readCommitted(base);
  const fresh = JSON.parse(readFileSync(join(RESULTS_DIR, 'results.json'), 'utf8')) as BenchOutput;

  // What was compared, before the verdict — a reader of a PR body can otherwise only take the
  // tick on trust. The base by SHA (a branch name is a different commit on every machine), and
  // the fresh artifact by the run that produced it.
  const sha = shortSha(base);
  const stamp = fresh.meta.asmlift;
  console.log(
    `diff: base ${base}${sha ? ` = ${sha}` : ''} (artifact generated ${committed.meta.generatedAt}) · ` +
      `fresh ${RESULTS_PATH} generated ${fresh.meta.generatedAt}` +
      (stamp ? ` at ${stamp.commit.slice(0, 7)}${stamp.dirty ? ' (dirty tree)' : ''}` : ''),
  );

  if (notRegenerated(committed, fresh)) {
    console.log(
      `NOT REGENERATED — ${RESULTS_PATH} carries the same meta.generatedAt as ${base}'s, so it is still\n` +
        `that committed file and no run stands behind this comparison. Run the benchmark first:\n` +
        `  pnpm bench run && pnpm bench merge && pnpm bench diff --base ${base}\n` +
        `Nothing was compared; this proves nothing.`,
    );
    return 2;
  }

  if (headContains(base) === false) {
    console.log(
      `WARNING: HEAD does not contain ${base} — everything ${base} gained meanwhile is being read as\n` +
        `a change this branch made (or hidden by one). Rebase, re-run, then diff again.`,
    );
  }

  const report = compareMeasurements(committed, fresh);

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

  // THE ROWS THIS BRANCH ADDED, compared against the branch's OWN last artifact.
  //
  // The report above walks the BASE's rows, so a row the branch added is `ADDED` — every time,
  // for as long as the branch lives, however many times it republishes. Its score can then move in
  // either direction with nothing naming a field: `regression` sees only OUTCOME (and, since the
  // added-row comparison there, only a lost match), and this gate never looked. A round that adds
  // six rows and then changes the harness can take one from `asmlift 0` to `asmlift 5` and read
  // `0 field change(s), 6 added` — which is exactly the line it would publish as its neutrality
  // proof.
  //
  // Informational, deliberately: additions already make `report.ok` false, so this section moves no
  // exit code. It is the missing NAMES, not a new verdict.
  if (base !== 'HEAD') {
    let self: BenchOutput | undefined;
    try {
      self = readCommitted('HEAD');
    } catch {
      console.log(`diff: this branch's own artifact is unreadable — added rows compared against nothing`);
    }
    if (self !== undefined) {
      const baseIds = new Set(committed.results.map((r) => r.id));
      const added = { ...self, results: self.results.filter((r) => !baseIds.has(r.id)) };
      const selfReport = compareMeasurements(added, fresh);
      for (const c of selfReport.changed) {
        console.log(`CHANGED ${c.id} ${c.field}: ${c.from} → ${c.to}   (row this branch added)`);
      }
      for (const id of selfReport.removed) {
        console.log(`REMOVED ${id} — row this branch added, absent from the fresh run`);
      }
      console.log(
        `diff over rows added since ${base}: ${selfReport.changed.length} field change(s), ` +
          `${selfReport.removed.length} removed (${added.results.length} such rows)`,
      );
    }
  }
  return report.ok ? 0 : 1;
}
