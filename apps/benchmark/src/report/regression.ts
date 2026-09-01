// The MATCH-REGRESSION gate: did any function that matched in the committed results.json stop
// matching in the fresh one? `stale-check` answers "may this run replace the dataset" (coverage +
// provenance); THIS answers "did the code get worse" — the question a refactor or feature round
// must ask before committing. `bench run` itself exits 0 either way by design (a nonmatch is a
// valid measurement, not a harness failure), so without this gate "zero matches lost" is a human
// eyeball over a 600-row JSON. Here it is mechanical: any match→non-match flip, or any committed
// row missing from the fresh run (a silently-skipped toolchain reads as "no regression" without
// this), exits non-zero.
import type { BenchOutput, DecompilerId, Outcome } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
import { readCommitted } from './committed';

export interface OutcomeFlip {
  id: string;
  decompiler: DecompilerId;
  from: Outcome;
  to: Outcome;
}

export interface RegressionReport {
  /** committed row ids absent from the fresh run — coverage silently shrank; NEVER "no regression" */
  missing: string[];
  /** match → anything-else, either decompiler. asmlift losses mean the code regressed; m2c is
   *  pinned, so an m2c loss means the HARNESS regressed. Both fail the gate. */
  lost: OutcomeFlip[];
  /** non-match → match (informational — the good direction) */
  gained: OutcomeFlip[];
  /** every other outcome transition (e.g. nonmatch→declined) — reported for eyes, not a failure:
   *  legitimate feature rounds move these; only a LOST MATCH is unambiguous regression. */
  changed: OutcomeFlip[];
  ok: boolean;
}

export function compareOutcomes(committed: BenchOutput, fresh: BenchOutput): RegressionReport {
  const freshById = new Map(fresh.results.map((r) => [r.id, r]));
  const missing: string[] = [];
  const lost: OutcomeFlip[] = [];
  const gained: OutcomeFlip[] = [];
  const changed: OutcomeFlip[] = [];

  for (const was of committed.results) {
    const now = freshById.get(was.id);
    if (!now) {
      missing.push(was.id);
      continue;
    }
    for (const d of ['asmlift', 'm2c'] as const) {
      const from = was[d].outcome;
      const to = now[d].outcome;
      if (from === to) {
        continue;
      }
      const flip: OutcomeFlip = { id: was.id, decompiler: d, from, to };
      if (from === 'match') {
        lost.push(flip);
      } else if (to === 'match') {
        gained.push(flip);
      } else {
        changed.push(flip);
      }
    }
  }
  return { missing, lost, gained, changed, ok: missing.length === 0 && lost.length === 0 };
}

/** The rows the branch's OWN committed artifact holds that `base` does not.
 *
 *  THE BLIND SPOT THIS EXISTS FOR, and it is not hypothetical — it was found by an audit after the
 *  gate had passed. `compareOutcomes(base, fresh)` walks the BASE's rows, so a row the branch added
 *  is compared against nothing: it is an ADDITION relative to the branch point for as long as the
 *  branch lives, however many times the branch republishes its own artifact. A round that adds six
 *  rows in one commit and then changes the harness in the next can take one of them from a
 *  published MATCH to a noncompile with `regression --base origin/main` reporting `0 lost` and
 *  `diff --base origin/main` reporting it as `added`, not `changed`. Measured on exactly that: with
 *  base `origin/main` the report is ok, `0 lost`; with the branch's own artifact as base it is
 *  `2 lost` — `synthetic:bfwordread:agbcc` and `synthetic:bfwordwrite:agbcc`, m2c match → noncompile.
 *
 *  So the gate asks BOTH questions, and this is the second population: the branch's own artifact
 *  narrowed to the rows the base lacks. Rows present in both are already policed by the base
 *  comparison; asking them twice would only report the same flip twice. */
export function rowsAddedSince(base: BenchOutput, self: BenchOutput): BenchOutput {
  const baseIds = new Set(base.results.map((r) => r.id));
  return { ...self, results: self.results.filter((r) => !baseIds.has(r.id)) };
}

/** CLI entry: the committed results.json at `base` vs the freshly merged one, PLUS the branch's own
 *  committed artifact vs the fresh one over the rows `base` does not have. Returns the process exit
 *  code — 0 iff no match was lost and no committed row vanished, in EITHER comparison. `base`
 *  defaults to HEAD; a branch that has already committed its own artifact must pass its branch
 *  point instead, or the first comparison compares the branch against itself. */
export function regressionGate(base = 'HEAD'): number {
  const committed = readCommitted(base);
  const fresh = JSON.parse(readFileSync(join(RESULTS_DIR, 'results.json'), 'utf8')) as BenchOutput;
  const report = compareOutcomes(committed, fresh);

  for (const f of report.gained) {
    console.log(`GAINED  ${f.id} [${f.decompiler}] ${f.from} → match`);
  }
  for (const f of report.changed) {
    console.log(`changed ${f.id} [${f.decompiler}] ${f.from} → ${f.to}`);
  }
  for (const id of report.missing) {
    console.error(`MISSING ${id} — committed row absent from the fresh run (toolchain skipped?)`);
  }
  for (const f of report.lost) {
    console.error(`LOST    ${f.id} [${f.decompiler}] match → ${f.to}`);
  }
  const { lost, missing, gained, changed } = report;
  console.log(
    `regression: ${lost.length} lost, ${missing.length} missing, ${gained.length} gained, ` +
      `${changed.length} other flips (${committed.results.length} committed rows)`,
  );

  // The branch's OWN rows, which the comparison above cannot see (see rowsAddedSince). Skipped only
  // when `base` IS this artifact — then the two comparisons are the same one. The population is
  // always PRINTED, including when it is empty: a gate whose silence reads the same for "nothing
  // was added" and "this never ran" has reported nothing.
  let selfOk = true;
  if (base !== 'HEAD') {
    let self: BenchOutput | undefined;
    try {
      self = readCommitted('HEAD');
    } catch (e) {
      console.error(`added-row regression: SKIPPED — cannot read this branch's own artifact: ${String(e)}`);
      selfOk = false; // a gate that cannot run is not a gate that passed
    }
    if (self !== undefined) {
      const added = rowsAddedSince(committed, self);
      const selfReport = compareOutcomes(added, fresh);
      for (const f of selfReport.gained) {
        console.log(`GAINED  ${f.id} [${f.decompiler}] ${f.from} → match   (row this branch added)`);
      }
      for (const f of selfReport.changed) {
        console.log(`changed ${f.id} [${f.decompiler}] ${f.from} → ${f.to}   (row this branch added)`);
      }
      for (const id of selfReport.missing) {
        console.error(`MISSING ${id} — row this branch added is absent from the fresh run`);
      }
      for (const f of selfReport.lost) {
        console.error(`LOST    ${f.id} [${f.decompiler}] match → ${f.to}   (row this branch added)`);
      }
      console.log(
        `added-row regression: ${selfReport.lost.length} lost, ${selfReport.missing.length} missing, ` +
          `${selfReport.gained.length} gained, ${selfReport.changed.length} other flips ` +
          `(${added.results.length} rows this branch added since ${base})`,
      );
      selfOk = selfReport.ok;
    }
  }
  return report.ok && selfOk ? 0 : 1;
}
