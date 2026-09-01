// Shard fan-out + stitch — the whole parent/child contract. Fans each tier across N worker
// PROCESSES (each a `cli.ts run --serial --tier X --shard i/N` child writing a part file), then
// stitches the parts into the canonical per-tier file. Process-level sharding: the hot path per
// case is a synchronous cross-compile + m2c/asmlift that spawnSync-blocks the event loop, so
// intra-process async gives no speedup; independent processes each get their own blocking
// pipeline, and the Docker container pool is shared by name across processes.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { CACHE_MISMATCH_EXIT } from '@asmlift/cli/candcache';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
import { asmliftProvenance, combineProvenance } from '../provenance';
import { benchMeta } from './runner';

const CLI = join(import.meta.dirname, '..', 'cli.ts');

export type Tier = 'synthetic' | 'real';

export interface OrchestrateOptions {
  jobs: number;
  tiers: Tier[];
  only?: string; // symbol substring (both tiers)
  project?: string; // real: project name
  toolchain?: string; // synthetic: single-toolchain filter
}

/**
 * The status a fan-out exits with once shards have failed. A CACHE MISMATCH KEEPS ITS OWN CODE
 * THROUGH THE FAN-OUT: the children exit `CACHE_MISMATCH_EXIT` for it, and flattening that back to
 * 1 here would put it back among the statuses a build failure, an empty selection and a crashed
 * shard already share. Only when EVERY failing shard says cache — one shard that failed for its own
 * reason is a run whose headline is that failure, not the store.
 */
export const fanExitCode = (failedCodes: number[]): number =>
  failedCodes.length > 0 && failedCodes.every((c) => c === CACHE_MISMATCH_EXIT) ? CACHE_MISMATCH_EXIT : 1;

export interface ShardOutcome {
  code: number;
  skips: number; // rows this shard could not measure (toolchain unavailable)
}

/** One shard child (a tsx subprocess), stdout streamed with a shard prefix. Resolves on exit. */
function runShard(tier: Tier, shard: string, extra: string[]): Promise<ShardOutcome> {
  const child = spawn('tsx', [CLI, 'run', '--serial', '--tier', tier, '--shard', shard, ...extra], {
    cwd: join(import.meta.dirname, '..', '..', '..', '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tag = `[${tier} ${shard}]`;
  let buf = '';
  let skips = 0;
  const line = (l: string): void => {
    // the child's own end-of-shard tally (runner.ts) — the parent needs it to total a tier, and
    // stdout is the only channel it has: the part files carry results, and a skipped row is
    // precisely a row that produced none
    const m = /^SKIPPED (\d+)\//.exec(l);
    if (m) {
      skips += Number(m[1]);
    }
    console.log(`${tag} ${l}`);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (l.trim()) {
        line(l);
      }
    }
  });
  return new Promise<ShardOutcome>((res) => {
    child.on('close', (code, signal) => {
      if (buf.trim()) {
        line(buf);
      }
      // a signal-killed child (OOM, segfault) reports code=null — that is a failure, not a 0
      res({ code: code ?? (signal ? 1 : 0), skips });
    });
  });
}

/** Which of the three filters can select a row in `tier`. `--only` is the one both tiers read, so
 *  an `--only` naming a synthetic row selects nothing in `real` and that is an answer, not a typo
 *  — which is why the empty-selection verdict is taken over the whole run, never per tier.
 *  Exported for the test: this predicate is the whole rule. */
export function tierIsFiltered(tier: Tier, opts: Pick<OrchestrateOptions, 'only' | 'project' | 'toolchain'>): boolean {
  return Boolean(opts.only) || Boolean(tier === 'synthetic' ? opts.toolchain : opts.project);
}

/** The verdict itself, shared by both run paths — the fanned-out one below and the `--serial` one
 *  in cli.ts, which writes `<tier>.json` directly and so empties it exactly the same way.
 *  `untouched` names the tier files that were left alone, because the OTHER tier in the same run
 *  may legitimately have been rewritten (`--toolchain` filters only synthetic, `--project` only
 *  real, so the unfiltered tier runs whole) — and a fail-loud message must not claim a write did
 *  not happen when it did. */
export function emptySelectionError(
  opts: Pick<OrchestrateOptions, 'only' | 'project' | 'toolchain'>,
  untouched: Tier[],
): Error {
  // `--only` is a SUBSTRING of the symbol, not the row id. A green tick on a row that does not
  // exist is how an attribution once rested on a control row nobody had written.
  const shown = [
    opts.only && `--only ${opts.only}`,
    opts.project && `--project ${opts.project}`,
    opts.toolchain && `--toolchain ${opts.toolchain}`,
  ].filter(Boolean);
  const files = untouched.map((t) => `results/${t}.json`).join(' and ');
  return new Error(
    `no row matched ${shown.join(' ')} in tier(s) ${untouched.join('+')} — nothing was measured ` +
      `there, and ${files} left unchanged. Check the symbol with ` +
      `\`grep -rn "sym: '<name>'" apps/benchmark/dataset\`.`,
  );
}

/** Stitch `${tier}.part{0..n-1}.json` back into the canonical `${tier}.json`, delete the parts.
 *  `filtered` says a filter could have selected rows here, which makes an empty result a typo.
 *
 *  The parts' `meta.asmlift` is CARRIED FORWARD, not re-sampled. Only the shard children sample git
 *  while a fanned-out tier is being measured, so their stamps are the fine-grained record of the
 *  tree the numbers were read from; re-stamping the tier with `benchMeta`'s own sample — which,
 *  before `orchestrate` was made to sample at spawn time, was taken only after the last child had
 *  exited — made the run-time check compare two measurements from the same instant. Measured on
 *  the code as it stood then: a tier run with an untracked file in `packages/core` that was removed
 *  40s into a 129s run stamped `dirty: false`, while the part file it was stitched from said
 *  `dirty: true`. */
function stitch(tier: Tier, n: number, filtered: boolean): number {
  const results: FunctionResult[] = [];
  const stamps: ({ commit: string; dirty: boolean } | undefined)[] = [];
  let parts = 0;
  for (let i = 0; i < n; i++) {
    const part = join(RESULTS_DIR, `${tier}.part${i}.json`);
    if (!existsSync(part)) {
      continue;
    }
    parts++;
    const out = JSON.parse(readFileSync(part, 'utf8')) as BenchOutput;
    results.push(...out.results);
    stamps.push(out.meta.asmlift);
    rmSync(part);
  }
  if (parts === 0) {
    // every shard died before writing anything (e.g. a dataset guard threw at enumeration);
    // keep the last good canonical file instead of clobbering it with an empty set
    return 0;
  }
  if (filtered && results.length === 0) {
    // Same reason, one step earlier: a filter that selects nothing still has every shard write
    // its own (empty) part file, so this is reached with parts > 0 and the write would replace a
    // good 240-row `real.json` with `results: []` — which is what `bench merge` reads next.
    return 0;
  }
  const out: BenchOutput = {
    meta: { ...benchMeta(results), asmlift: combineProvenance(stamps, asmliftProvenance()) },
    results,
  };
  writeFileSync(join(RESULTS_DIR, `${tier}.json`), JSON.stringify(out, null, 2));
  return results.length;
}

/** Tiers are enqueued in this order (any tier not named keeps its `--tier` order, after these).
 *  Measured over five full runs: the real tier's heaviest shard is 2-3x the synthetic tier's
 *  (147/165/215/161/194s against 46/98/113/96/64s). With `tiers × jobs` tasks over `jobs` slots a
 *  task queued late starts late, so the expensive tier is queued first — starting the longest
 *  task last is exactly the tail the shared queue exists to remove. */
const COST_ORDER: readonly Tier[] = ['real', 'synthetic'];

/** Every tier's shard tasks, in the order the slots take them. Exported for the test: this
 *  ordering is the whole scheduling decision, and it must stay a permutation of `tiers × jobs`. */
export function shardQueue(opts: Pick<OrchestrateOptions, 'jobs' | 'tiers'>): { tier: Tier; shard: number }[] {
  const rank = (t: Tier): number => (COST_ORDER.includes(t) ? COST_ORDER.indexOf(t) : COST_ORDER.length);
  return opts.tiers
    .map((tier, i) => ({ tier, i }))
    .sort((a, b) => rank(a.tier) - rank(b.tier) || a.i - b.i)
    .flatMap(({ tier }) => Array.from({ length: opts.jobs }, (_, shard) => ({ tier, shard })));
}

export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  // Sample BEFORE the first child spawns. `asmliftProvenance` is sticky over the process, so this
  // parent's stamp then covers the whole run rather than only the instant after the last shard
  // exits — belt to the shard stamps' braces, and the only cover a tier whose parts predate the
  // stamp has at all.
  asmliftProvenance();

  // ONE queue across ALL tiers, drained by exactly `opts.jobs` slots. Fanning the tiers one after
  // the other (a `Promise.all` per tier) made every run pay both tiers' TAILS: the real fan could
  // not start until the last synthetic shard had exited, and the real fan then ended with one
  // shard running alone for 46-59s (measured across five full runs) while seven slots idled — the
  // synthetic work that could have filled them having already drained. Overlapping them is 15-27%
  // off the run phase on those same five runs, and cannot be WORSE than the split fan: with
  // `jobs` tasks per tier over `jobs` slots each slot runs one shard per tier, so the makespan is
  // max_i(that slot's shards summed) ≤ the per-tier maxima summed, which is exactly what the
  // split fan always paid.
  //
  // Concurrency is still capped at `opts.jobs`, so the Docker container pool and the machine see
  // the load they always saw, and the same shard children run the same `idx % jobs` slices over
  // the same rows in the same order — only scheduled to overlap. The canonical artifact cannot
  // notice: merge.ts already sorts rows by id precisely because the shard count, and so the
  // per-tier row order, differs by machine.
  const extraFor = (tier: Tier): string[] => {
    const extra: string[] = [];
    if (opts.only) {
      extra.push('--only', opts.only);
    }
    if (tier === 'synthetic' && opts.toolchain) {
      extra.push('--toolchain', opts.toolchain);
    }
    if (tier === 'real' && opts.project) {
      extra.push('--project', opts.project);
    }
    return extra;
  };
  const queue = shardQueue(opts);
  const outcomes = new Map<Tier, ShardOutcome[]>(opts.tiers.map((t) => [t, []]));
  // First child spawned → last child exited, per tier: with the tiers overlapping, a clock read
  // once at the end of the run is no longer that tier's own elapsed time.
  const span = new Map<Tier, { t0: number; t1: number }>();
  const runStart = Date.now();
  let next = 0;
  // One slot: take the next shard task, run it to completion, repeat. `next++` needs no lock —
  // the read and the increment are one synchronous step on the one event loop.
  const slot = async (): Promise<void> => {
    for (;;) {
      const task = queue[next++];
      if (!task) {
        return;
      }
      if (!span.has(task.tier)) {
        span.set(task.tier, { t0: Date.now(), t1: 0 });
        console.log(`\n▶ ${task.tier}: fanning across ${opts.jobs} shards…`);
      }
      outcomes.get(task.tier)!.push(await runShard(task.tier, `${task.shard}/${opts.jobs}`, extraFor(task.tier)));
      span.get(task.tier)!.t1 = Date.now();
    }
  };
  await Promise.all(Array.from({ length: opts.jobs }, () => slot()));

  let failedShards = 0;
  // Rows selected across every tier a filter could have selected in. Stays null on an unfiltered
  // run, which is the only kind that reaches a branch — so this verdict cannot move a number.
  let selected: number | null = null;
  const untouched: Tier[] = [];
  // Stitched and reported in the CALLER's tier order, so the summary lines read as they always
  // have however the queue interleaved the children.
  for (const tier of opts.tiers) {
    const mine = outcomes.get(tier)!;
    const failed = mine.filter((o) => o.code !== 0).length;
    failedShards += failed;
    const skips = mine.reduce((sum, o) => sum + o.skips, 0);
    const filtered = tierIsFiltered(tier, opts);
    const n = stitch(tier, opts.jobs, filtered);
    if (filtered) {
      selected = (selected ?? 0) + n;
    }
    const s = span.get(tier);
    const secs = (((s?.t1 ?? 0) - (s?.t0 ?? 0)) / 1000).toFixed(1);
    // A skip total belongs on the tier line, not only in the scrollback: an absent toolchain
    // costs whole projects (marioparty3's 40 rows) and `bench regression` reads them as MISSING.
    const skipNote = skips ? ` — ⚠ ${skips} row(s) SKIPPED, toolchain unavailable` : '';
    // `→ results/<tier>.json` is a claim about a write, so it goes only where one happened.
    const empty = filtered && n === 0;
    if (empty) {
      untouched.push(tier);
    }
    const wrote = empty ? ` — no row selected, results/${tier}.json left unchanged` : ` → results/${tier}.json`;
    console.log(
      `${failed ? '✗' : empty ? '–' : '✓'} ${tier}: ${n} results in ${secs}s${failed ? ` (${failed} shard(s) exited nonzero)` : ''}${wrote}${skipNote}`,
    );
  }
  if (failedShards > 0) {
    // all tiers stitched (partial results persist for debugging), but the run itself failed
    const failedCodes = [...outcomes.values()].flat().flatMap((o) => (o.code === 0 ? [] : [o.code]));
    if (fanExitCode(failedCodes) === CACHE_MISMATCH_EXIT) {
      console.error(
        `\n${failedShards} shard(s) exited ${CACHE_MISMATCH_EXIT}: a stored answer disagreed with a fresh ` +
          `compile. The store is serving objects this toolchain no longer produces — see the [candcache] ` +
          `lines above, then drop the store (ASMLIFT_CANDCACHE_DIR).`,
      );
      process.exitCode = CACHE_MISMATCH_EXIT;
      return;
    }
    throw new Error(`${failedShards} shard(s) exited nonzero — see BUILD-FAIL/error lines above`);
  }
  if (selected === 0) {
    throw emptySelectionError(opts, untouched);
  }
  console.log(`\nDone in ${((Date.now() - runStart) / 1000).toFixed(1)}s. Next: pnpm bench:merge`);
}
