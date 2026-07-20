// The MATCH-REGRESSION gate: did any function that matched in the committed results.json stop
// matching in the fresh one? `stale-check` answers "may this run replace the dataset" (coverage +
// provenance); THIS answers "did the code get worse" — the question a refactor or feature round
// must ask before committing. `bench run` itself exits 0 either way by design (a nonmatch is a
// valid measurement, not a harness failure), so without this gate "zero matches lost" is a human
// eyeball over a 600-row JSON. Here it is mechanical: any match→non-match flip, or any committed
// row missing from the fresh run (a silently-skipped toolchain reads as "no regression" without
// this), exits non-zero.
import type { BenchOutput, DecompilerId, Outcome } from '@asmlift/bench-schema';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, RESULTS_DIR } from '../config';

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

/** CLI entry: committed HEAD results.json vs the freshly merged one. Returns the process exit
 *  code — 0 iff no match was lost AND no committed row vanished. */
export function regressionGate(): number {
  const committed = JSON.parse(
    execSync('git show HEAD:apps/benchmark/results/results.json', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256e6,
    }),
  ) as BenchOutput;
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
  return report.ok ? 0 : 1;
}
