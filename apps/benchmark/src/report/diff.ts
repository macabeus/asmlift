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
import { RESULTS_PATH, byId, headContains, readCommitted, sameRun, scrub, shortSha } from './committed';
import { rowsAddedSince } from './regression';

/** The fields a published claim is made of, named individually when they move.
 *
 *  THIS LIST IS NOT "every field the report shows" — it was written as that rule and the rule was
 *  false in its own file: `droppedCandidates` is published (`[ranked] N dropped, M withheld`) and
 *  is 51,840 entries long on one row of the current artifact, so watching it raw emits a
 *  multi-megabyte diff line. The honest rule is: every published claim SMALL ENOUGH TO PRINT, and
 *  for the big ones the published COUNT rather than the list. A rule stated as universal and
 *  applied selectively is worse than a narrow rule stated plainly — `errorMarkers` was missed
 *  twice under the universal wording.
 *
 *  `source` is here because a change that moves no score can still rewrite what the report shows,
 *  `candidateLabel` because the ranked WINNER can change identity at an unchanged score (a
 *  tie-break moving is a real change), `quality` because the report publishes it — a row can move
 *  `quality.casts` 0 → 1 with score, outcome and label all unchanged — and `breakdown` for the
 *  same reason (the web FunctionDetail renders its five numbers; 17 sides moved it over
 *  `eb6dec7d`→`2fed1e42`, none of them a row no other field already named).
 *
 *  `maxScore` is here because it is NOT a constant of the row, and the whole project read it as
 *  one. It is the objdiff row count of the winning candidate's alignment, so a different
 *  candidate gives a different denominator: twelve rows moved theirs between `eb6dec7d` and
 *  `2fed1e42`, `kleod:CountCollectedGems:agbcc` by 17 (404 → 387). Its `290 → 171` was therefore
 *  never a subtraction on a fixed scale, and reading it as one is what produced a six-way
 *  "partition of the 290", a 297-predicted / 119-delivered shortfall, and a whole extra
 *  attribution round to explain the difference. The report publishes `score/maxScore` (the
 *  Explorer and the gap badge both render it), so by this list's own rule a denominator-only move
 *  is a published claim moving and must be named. It has never moved ALONE — all 12 printed a
 *  `score` line on the same row and side, and that line now renders both denominators — so the
 *  entry buys 0 unique rows today and is kept for the constructible case it alone catches: an
 *  alignment whose length moves while the diff count holds. Do not re-litigate it as a duplicate.
 *
 *  `compileErrors` is here for the same reason and no other: the report publishes it (the run line
 *  prints `noncompile(k)`, the web FunctionDetail prints `compile errors {n}`), so a row sliding
 *  `noncompile(3) → noncompile(7)` is a published claim moving. It was previously this gate's
 *  own stand-in for an UNCOMPARED field, which asserted the opposite of this list's rule. Cost,
 *  measured over `eb6dec7d`→`2fed1e42`: 0 extra lines — no row in that pair moved it.
 *
 *  `errorMarkers` is here because this repo has already PAID for its absence, in writing: the
 *  `v17:` note in `cache.ts` records a warm-store entry replaying ``gPacked' undeclared`` for a row
 *  whose deciding rung declares the symbol — "invisible to every artifact comparison,
 *  `errorMarkers` being outside `FIELDS.m2c`". The run line prints `declined(k gap(s))` from it and
 *  the web report derives its whole declined/failed taxonomy column from it. Cost over the same
 *  pair: 2 lines, 0 rows no other field named. Max 6 entries / 491 chars, so it prints as itself.
 *
 *  The two `.length` entries are the exception the first paragraph describes: `droppedCandidates`
 *  and `withheldCandidates` are published as COUNTS by the `[ranked]` line, and the count is what
 *  is watched. This is not a cosmetic saving — over `eb6dec7d`→`2fed1e42` the dropped count moved
 *  on 2 rows (`kleod:ProcessInputAndUpdateEntities:agbcc`, `kleod:UpdateHUDCounterDisplay:agbcc`)
 *  that NO other watched field moves on: identical source, identical score, identical label, a fan
 *  that demonstrably changed, and a gate that answered "nothing moved". `symbolsUsed` is left out
 *  for size and for nothing else. */
const FIELDS = {
  asmlift: [
    'outcome',
    'score',
    'maxScore',
    'compileErrors',
    'errorMarkers',
    'breakdown',
    'candidateLabel',
    'source',
    'quality',
    'droppedCandidates.length',
    'withheldCandidates.length',
  ],
  m2c: ['outcome', 'score', 'maxScore', 'compileErrors', 'errorMarkers', 'breakdown', 'source', 'quality'],
} as const;

/** One side's value for a watched field. A `<key>.length` entry reads the COUNT of a published
 *  list — absent list = 0, because "no fan recorded" and "an empty fan" are the same published
 *  claim (`[ranked] 0 dropped`). */
const read = (res: Record<string, unknown>, field: string): unknown => {
  if (field.endsWith('.length')) {
    const list = res[field.slice(0, -'.length'.length)];
    return Array.isArray(list) ? list.length : 0;
  }
  return res[field];
};

/** Compared by VALUE with a stable key order — `quality`, `breakdown` and `errorMarkers` are
 *  objects and arrays, and comparing two of those with `!==` reports every row as changed. */
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
//
// `res` is the whole side-result the value came from, because a score alone is not readable: it
// is a numerator over a denominator that moves with the winning candidate. `290 → 171` invites a
// subtraction; `290/404 → 171/387` shows that 17 of those 119 points are the scale, not the row.
const show = (field: string, v: unknown, res: Record<string, unknown>): string => {
  if (v === undefined || v === null) {
    return String(v);
  }
  if (field.endsWith('source')) {
    return `${String(v).length} bytes`;
  }
  // Rendered the way it is COMPARED: a compiler error carries the scratch path a cold run
  // re-mints, and a rendering that shows a difference the comparison ignored is a false line.
  if (field === 'errorMarkers') {
    return scrub(stable(v));
  }
  // A scored side ALWAYS renders a denominator, `?` included: `show` is called once per side, so
  // a fresh side that lost its `maxScore` would otherwise print `290/404 → 171` and be read as
  // `171/404` — the fixed-scale misreading this whole rendering exists to stop. `res` is REQUIRED
  // rather than optional so this cannot be re-opened by a call site that forgets it: the bare
  // numerator would come back silently, on a path no test can reach.
  if (field === 'score' && 'maxScore' in res) {
    return `${String(v)}/${typeof res.maxScore === 'number' ? res.maxScore : '?'}`;
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
      const wasSide = was[side] as unknown as Record<string, unknown>;
      const nowSide = now[side] as unknown as Record<string, unknown>;
      for (const f of FIELDS[side] as readonly string[]) {
        const a = read(wasSide, f);
        const b = read(nowSide, f);
        // sources and compiler errors are compared SCRUBBED, the same measurement-level equality
        // stale-check uses: a cold run re-mints scratch-dir names inside embedded asm comments and
        // inside the paths a compiler quotes back. Objects and arrays are compared by VALUE.
        const norm = (v: unknown): unknown =>
          f === 'source'
            ? scrub(String(v ?? ''))
            : f === 'errorMarkers'
              ? // `stable(undefined)` is `undefined`, not a string — most sides carry no markers
                scrub(stable(v) ?? 'absent')
              : v !== null && typeof v === 'object'
                ? stable(v)
                : v;
        const [x, y] = [norm(a), norm(b)];
        if (x !== y) {
          changed.push({ id: was.id, field: `${side}.${f}`, from: show(f, a, wasSide), to: show(f, b, nowSide) });
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
export const notRegenerated = (base: BenchOutput, fresh: BenchOutput): boolean => sameRun(base, fresh);

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
  //
  // AND THE SAME WINDOW THE REGRESSION GATE'S HALF HAS: this is a comparison only between
  // `bench merge` and the commit of the regenerated artifact. After that commit `readCommitted`
  // hands back the file this gate already read off disk, and the section prints
  // `0 field change(s)` from a file compared with itself — the vacuity `notRegenerated` guards on
  // the BASE side, asked here of the SELF side by the same predicate. It says NOT
  // CHECKED rather than nothing, and rather than a zero.
  if (base !== 'HEAD') {
    let self: BenchOutput | undefined;
    try {
      self = readCommitted('HEAD');
    } catch {
      console.log(`diff: this branch's own artifact is unreadable — added rows compared against nothing`);
    }
    if (self !== undefined && sameRun(self, fresh)) {
      console.log(
        `diff over rows added since ${base}: NOT CHECKED — this branch's committed artifact carries ` +
          `the same meta.generatedAt as the fresh one, so it IS this run. Run it after the merge and ` +
          `BEFORE committing the regenerated artifact.`,
      );
      self = undefined;
    }
    if (self !== undefined) {
      // the narrowing the regression gate exports and its tests pin — one implementation, so the
      // tested one is the one that runs
      const added = rowsAddedSince(committed, self);
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
