// THE COMMITTED BASELINE FOR ONE SYMBOL — the number a round starts from, read out of the
// artifact instead of inherited from a brief.
//
// Every other gate here (`stale-check`, `regression`, `diff`) compares the committed artifact
// against a FRESH run, so none of them can answer "what does the published benchmark say about
// this row" without spending a run first. A round opens with exactly that question, and the
// answer it inherits instead is a hand-written number in a brief — a hint with a timestamp: one
// said 196 where the artifact said 171.
//
// A subcommand rather than the `git show … | jq` one-liner it would otherwise take, because in a
// pipeline the exit status is jq's: an unfetched ref, a renamed artifact path or a remote that is
// not `origin` all print NOTHING and succeed, and "empty" is the output that reads as "this symbol
// has no benchmark row, so it is measured outside the harness". So every way of finding no row
// here is a message instead: a missing ref throws out of `readCommitted`, and a symbol with no row
// exits 1 naming both causes.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from '../config';
import { MEASURED_PATHS, SCORING_PATHS } from '../provenance';
import { RESULTS_PATH, readCommitted } from './committed';

/** The rows one typed argument selects.
 *
 *  A substring of the SYMBOL, because that is the matcher `bench run --only` uses
 *  (`x.sym.includes(filter.only)` in `cases/real.ts` and `cases/synthetic.ts`) and the two must
 *  agree about what one typed name selects. An argument containing `:` is matched against the
 *  ROW ID instead — ids are `project:sym:toolchain`, both briefs teach them, and this command
 *  prints them, so pasting back what it printed has to work rather than silently select nothing. */
export function selectRows(results: readonly FunctionResult[], needle: string): FunctionResult[] {
  return needle.includes(':')
    ? results.filter((r) => r.id.includes(needle))
    : results.filter((r) => r.sym.includes(needle));
}

const score = (s: number | null | undefined, m: number | null | undefined): string =>
  // `-` and not `null`: a declined or noncompile row has no score, which is normal. Rendering it
  // as `null` invites the reader to quote a null as a number.
  `${s ?? '-'}/${m ?? '-'}`;

export function formatRow(r: FunctionResult): string {
  return `${r.id}  asmlift=${r.asmlift.outcome} ${score(r.asmlift.score, r.asmlift.maxScore)}  m2c=${r.m2c.outcome} ${score(r.m2c.score, r.m2c.maxScore)}`;
}

/** `git …` in the repo, or `undefined` when git declines to answer — the freshness verdict is a
 *  note about the rows, so a question git cannot answer must degrade to "not shown" and never
 *  swallow the row itself. */
function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64e6,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

const lines = (out: string | undefined): string[] => (out ? out.split('\n').filter(Boolean) : []);

/** Commits on `base` that landed AFTER the artifact was committed, split into the ones that
 *  decide a measurement and the ones around it.
 *
 *  The handle is the artifact FILE's own commit, not `meta.asmlift.commit`: main squash-merges,
 *  so the stamp names a branch commit main does not contain, it is unresolvable once the merged
 *  branch is pruned, and a range against it is a fork-point range rather than "since the
 *  artifact". */
export function commitsSinceArtifact(base: string): { at?: string; scoring: string[]; harness: string[] } {
  const at = git('log', '-1', '--format=%H', base, '--', RESULTS_PATH);
  if (!at) {
    return { scoring: [], harness: [] };
  }
  const range = `${at}..${base}`;
  const scoring = lines(git('log', '--no-merges', '--oneline', range, '--', ...SCORING_PATHS));
  const all = lines(git('log', '--no-merges', '--oneline', range, '--', ...MEASURED_PATHS));
  const decided = new Set(scoring);
  return { at, scoring, harness: all.filter((c) => !decided.has(c)) };
}

/** Prints the committed baseline for `needle` and whether it is still the current answer.
 *  Returns the process exit code: 1 when nothing matched, 0 otherwise. */
export function baseline(needle: string, base: string, log = console.log, err = console.error): number {
  const committed: BenchOutput = readCommitted(base);
  const rows = selectRows(committed.results, needle);

  if (rows.length === 0) {
    const near = committed.results.filter((r) =>
      r.sym.toLowerCase().includes(needle.toLowerCase().replace(/^.*:/, '')),
    );
    err(
      `baseline: no row for ${JSON.stringify(needle)} in the artifact at ${base} (${committed.results.length} rows).`,
    );
    err('Either you mistyped it, or this target is measured outside the harness (the ranked repro) —');
    err('decide which before quoting any number for it.');
    if (near.length > 0) {
      err(
        `Case-insensitively, ${near.length} row(s) match: ${near
          .slice(0, 5)
          .map((r) => r.id)
          .join(', ')}`,
      );
    }
    return 1;
  }

  for (const r of rows) {
    log(formatRow(r));
  }
  log(
    `baseline: ${rows.length} row(s) from the artifact generated ${committed.meta.generatedAt}, as committed on ${base}`,
  );

  const { at, scoring, harness } = commitsSinceArtifact(base);
  if (at === undefined) {
    err(`baseline: cannot date the artifact on ${base} (git declined) — treat the numbers above as unverified`);
    return 0;
  }
  if (scoring.length === 0) {
    log(
      `baseline: CURRENT — nothing since ${at.slice(0, 8)} changes what it measures, so these numbers beat any you were handed.`,
    );
  } else {
    log(`baseline: NOT CURRENT — ${scoring.length} commit(s) since ${at.slice(0, 8)} change what it measures, so`);
    log('neither these numbers nor the ones you were handed are the fact. Re-measure the row with');
    log('`pnpm bench run` and name the commits you re-measured across:');
    for (const c of scoring) {
      log(`  ${c}`);
    }
  }
  if (harness.length > 0) {
    log(`baseline: note — ${harness.length} commit(s) touch the harness around the decompiler, not the decompiler`);
    log('itself. Not disqualifying; listed because they could still move a row:');
    for (const c of harness) {
      log(`  ${c}`);
    }
  }
  return 0;
}
