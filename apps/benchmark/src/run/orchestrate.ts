// Shard fan-out + stitch — the whole parent/child contract. Fans each tier across N worker
// PROCESSES (each a `cli.ts run --tier X --shard i/N --claim <gen>` child taking rows off
// the tier's shared queue and writing a part file — queue.ts), then stitches the parts into the
// canonical per-tier file. Process-level sharding: the hot path per
// case is a synchronous cross-compile + m2c/asmlift that spawnSync-blocks the event loop, so
// intra-process async gives no speedup; independent processes each get their own blocking
// pipeline, and the Docker container pool is shared by name across processes.
import type { BenchOutput } from '@asmlift/bench-schema';
import { CACHE_MISMATCH_EXIT } from '@asmlift/cli/candcache';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
import { asmliftProvenance, combineProvenance } from '../provenance';
import {
  ORCHESTRATOR_PID_ENV,
  type PlanKey,
  claimOrder,
  committedRankSeconds,
  journalRows,
  liveClaimers,
  readJournal,
  readPlan,
  releaseUnfinished,
  resumeRefusal,
  runDir,
  unaccounted,
  writePlan,
} from './queue';
import { benchMeta } from './runner';

const CLI = join(import.meta.dirname, '..', 'cli.ts');

export type Tier = 'synthetic' | 'real';

export interface OrchestrateOptions {
  jobs: number;
  tiers: Tier[];
  only?: string; // symbol substring (both tiers)
  project?: string; // real: project name
  toolchain?: string; // synthetic: single-toolchain filter
  /** the tier's selected row ids, in dataset order — what the queue is planned over */
  caseIds: (tier: Tier) => string[];
  /** continue the tier's unfinished queue instead of discarding it (queue.ts) */
  resume?: boolean;
}

/**
 * The status a fan-out exits with once shards have failed. A CACHE MISMATCH KEEPS ITS OWN CODE
 * THROUGH THE FAN-OUT: the children exit `CACHE_MISMATCH_EXIT` for it, and flattening that back to
 * 1 here would put it back among the statuses a build failure, an empty selection and a crashed
 * shard already share. Only when EVERY failing shard says cache — one shard that failed for its own
 * reason is a run whose headline is that failure, not the store.
 */
export const shardsExitCode = (failedCodes: number[]): number =>
  failedCodes.length > 0 && failedCodes.every((c) => c === CACHE_MISMATCH_EXIT) ? CACHE_MISMATCH_EXIT : 1;

export interface ShardOutcome {
  code: number;
  skips: number; // rows this shard could not measure (toolchain unavailable)
}

/** One shard child (a tsx subprocess), stdout streamed with a shard prefix. Resolves on exit. */
function runShard(tier: Tier, shard: string, extra: string[]): Promise<ShardOutcome> {
  const child = spawn('tsx', [CLI, 'run', '--tier', tier, '--shard', shard, ...extra], {
    cwd: join(import.meta.dirname, '..', '..', '..', '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, [ORCHESTRATOR_PID_ENV]: String(process.pid) },
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
  // `untouched` empty rendered this as "in tier(s)  — … and  left unchanged": two blanks, in the
  // one message whose whole job is to name what was and was not written.
  const where = untouched.length > 0 ? untouched.join('+') : 'the selected tier(s)';
  const files = untouched.length > 0 ? untouched.map((t) => `results/${t}.json`).join(' and ') : 'the tier file(s)';
  return new Error(
    `no row matched ${shown.join(' ')} in tier(s) ${where} — nothing was measured ` +
      `there, and ${files} left unchanged. A row whose toolchain is UNAVAILABLE is SKIPPED, and a ` +
      `skip is nothing measured. Check the symbol with ` +
      `\`grep -rn "sym: '<name>'" apps/benchmark/dataset\`.`,
  );
}

/** What `stitch` did: whether `${tier}.json` was rewritten, how many rows it stitched, and — when
 *  it declined to write — which of the two refusals fired. The caller renders both the tick and
 *  the ` → results/<tier>.json` claim from this, so a claim about a write cannot be re-derived
 *  into disagreeing with the write. */
export interface StitchResult {
  wrote: boolean;
  rows: number;
  /** planned rows no part file measured or skipped */
  lost?: number;
  why?: 'no-parts' | 'no-row-selected';
}

/** One tier's summary line. Pure, and exported for the test: the glyph and the
 *  ` → results/<tier>.json` suffix are the run's only report of whether that file was rewritten,
 *  and a tier whose shards all died once printed `✓ … → results/<tier>.json` for a write that had
 *  not happened. Both now read the write off the same `StitchResult` the write path returned. */
export function tierLine(a: {
  tier: Tier;
  stitched: StitchResult;
  failedShards: number;
  secs: string;
  skips: number;
}): string {
  const glyph = a.failedShards || a.stitched.lost ? '✗' : a.stitched.wrote ? '✓' : '–';
  const wrote = a.stitched.wrote
    ? ` → results/${a.tier}.json`
    : ` — ${a.stitched.why === 'no-row-selected' ? 'no row selected' : 'no shard wrote a part file'}, results/${a.tier}.json left unchanged`;
  // A skip total belongs on the tier line, not only in the scrollback: an absent toolchain
  // costs whole projects and `bench regression` reads them as MISSING.
  const skipNote = a.skips ? ` — ⚠ ${a.skips} row(s) SKIPPED, toolchain unavailable` : '';
  const failNote =
    (a.failedShards ? ` (${a.failedShards} shard(s) exited nonzero)` : '') +
    (a.stitched.lost ? ` (${a.stitched.lost} planned row(s) neither measured nor skipped)` : '');
  return `${glyph} ${a.tier}: ${a.stitched.rows} results in ${a.secs}s${failNote}${wrote}${skipNote}`;
}

/** Stitch every part file in the tier's run directory into the canonical `${tier}.json` — every
 *  GENERATION's, so a resumed run publishes the rows its interrupted predecessor finished.
 *  `filtered` says a filter could have selected rows here, which makes an empty result a typo.
 *
 *  The parts' `meta.asmlift` is CARRIED FORWARD, not re-sampled. Only the shard children sample git
 *  while a fanned-out tier is being measured, so their stamps are the fine-grained record of the
 *  tree the numbers were read from; a tier re-stamped from the parent's own sample alone loses
 *  them — measured, an untracked file in `packages/core` removed 40s into a 129s fanned run left
 *  the tier reading `dirty: false` while the part file it was stitched from said `dirty: true`.
 *  See ../provenance.ts for what combining does with them.
 *
 *  The run directory is removed only by a stitch of a run whose shards all exited 0 (`keep`
 *  false): after a failure it is what `--resume` continues from. */
function stitch(tier: Tier, filtered: boolean, keep: boolean): StitchResult {
  const dir = runDir(tier);
  const { parts } = readJournal(dir);
  if (parts.length === 0) {
    // every shard died before writing anything (e.g. a dataset guard threw at enumeration);
    // keep the last good canonical file instead of clobbering it with an empty set
    return { wrote: false, rows: 0, why: 'no-parts' };
  }
  const plan = readPlan(dir);
  const journal = journalRows(parts);
  // only the plan's rows: a part an earlier run's shard wrote into this directory is not this run's
  const planned = plan ? new Set(plan.ids) : undefined;
  const results = planned ? journal.results.filter((r) => planned.has(r.id)) : journal.results;
  const { stamps, repeated } = journal;
  const lost = plan ? unaccounted(plan, journal).length : 0;
  keep ||= lost > 0;
  if (repeated > 0) {
    console.log(
      `⚠ ${tier}: ${repeated} row(s) were measured twice — by a shard of an earlier, killed run that was still writing; the later measurement is kept`,
    );
  }
  if (filtered && results.length === 0) {
    // Same reason, one step earlier: a filter that selects nothing still has every shard write
    // its own (empty) part file, so this is reached with parts > 0 and the write would replace a
    // good, fully-measured `real.json` with `results: []` — which is what `bench merge` reads
    // next.
    if (!keep) {
      rmSync(dir, { recursive: true, force: true });
    }
    return { wrote: false, rows: 0, why: 'no-row-selected' };
  }
  const out: BenchOutput = {
    meta: { ...benchMeta(results), asmlift: combineProvenance(stamps, asmliftProvenance()) },
    results,
  };
  writeFileSync(join(RESULTS_DIR, `${tier}.json`), JSON.stringify(out, null, 2));
  if (!keep) {
    rmSync(dir, { recursive: true, force: true });
  }
  return { wrote: true, rows: results.length, ...(lost > 0 ? { lost } : {}) };
}

/** Why this tier's queue cannot be started or resumed, or undefined when it can. Reads, never
 *  writes: every tier is checked before any tier's queue is touched. */
function queueRefusal(tier: Tier, opts: OrchestrateOptions, key: PlanKey): string | undefined {
  const dir = runDir(tier);
  const live = liveClaimers(dir);
  if (live.length > 0) {
    return (
      `${tier}: a shard of an earlier run is still measuring — ${live.join(', ')}. It would claim from ` +
      `this run's queue and write into its journal: stop it first (\`kill -9 <pid>\`)`
    );
  }
  if (!opts.resume) {
    return undefined;
  }
  const plan = readPlan(dir);
  if (plan === undefined) {
    return undefined;
  }
  const refusal = resumeRefusal(plan, key);
  if (refusal !== undefined) {
    return `--resume ${tier}: ${refusal}. Drop --resume to measure the tier from the start`;
  }
  if (journalRows(readJournal(dir).parts).stamps.some((st) => st?.dirty)) {
    return (
      `--resume ${tier}: the unfinished run's tree went dirty while it measured, so \`bench merge\` would ` +
      `refuse any tier stitched from it. Drop --resume to measure the tier from the start`
    );
  }
  return undefined;
}

/** Plan the tier's queue, or pick up the unfinished one (`queueRefusal` has passed). Returns the
 *  generation the children claim under. */
function prepareQueue(tier: Tier, opts: OrchestrateOptions, key: PlanKey): number {
  const dir = runDir(tier);
  if (opts.resume) {
    const journal = readJournal(dir);
    const rows = journalRows(journal.parts);
    for (const path of rows.unreadable) {
      console.log(`⚠ ${tier}: ${path} will not parse — its rows are measured again`);
      rmSync(path);
    }
    const plan = readPlan(dir)!;
    const done = new Set(rows.results.map((r) => r.id));
    const released = releaseUnfinished(dir, plan, done);
    console.log(
      `\n▶ ${tier}: resuming — ${done.size} of ${plan.ids.length} row(s) already measured, ${released} unfinished claim(s) re-queued`,
    );
    return journal.nextGen;
  }
  if (existsSync(dir)) {
    const kept = journalRows(readJournal(dir).parts).results.length;
    console.log(`\n▶ ${tier}: discarding an unfinished run's ${kept} measured row(s) — \`--resume\` keeps them`);
    rmSync(dir, { recursive: true, force: true });
  }
  const prices = committedRankSeconds();
  if (prices.unreadable !== undefined) {
    console.log(
      `\n⚠ ${tier}: the committed artifact will not parse (${prices.unreadable}) — rows are queued in dataset order`,
    );
  }
  writePlan(dir, { ...key, ids: claimOrder(opts.caseIds(tier), prices.seconds) });
  return 0;
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
  // exits — belt to the shard stamps' braces, and the only cover a tier whose parts carry no stamp
  // has at all.
  const stamp = asmliftProvenance();
  const key: PlanKey = {
    commit: stamp?.commit ?? 'unknown',
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.toolchain ? { toolchain: opts.toolchain } : {}),
  };
  // Every tier is checked before any tier's queue is touched, and before any child: a refusal
  // refuses the whole run. A `--resume` measures only the tiers that have an unfinished queue — a
  // tier whose last run finished keeps its tier file.
  const refusals = opts.tiers.flatMap((t) => queueRefusal(t, opts, key) ?? []);
  if (refusals.length > 0) {
    throw new Error(refusals.join('\n'));
  }
  const tiers = opts.resume ? opts.tiers.filter((t) => readPlan(runDir(t)) !== undefined) : opts.tiers;
  if (tiers.length === 0) {
    throw new Error(`--resume: ${resumeRefusal(undefined, key)}, or drop --resume`);
  }
  for (const t of opts.tiers.filter((t) => !tiers.includes(t))) {
    console.log(`\n▶ ${t}: nothing to resume — results/${t}.json is left as it is`);
  }
  opts = { ...opts, tiers };
  const gens = new Map(tiers.map((t) => [t, prepareQueue(t, opts, key)]));

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
  // the load they always saw. Within a tier the children take rows off one shared queue
  // (queue.ts), so a slot is freed only when the tier has no row left to hand out — the last
  // expensive row runs while the other slots have already moved on to the next tier. The
  // canonical artifact cannot notice: merge.ts already sorts rows by id precisely because the
  // shard count, and so the per-tier row order, differs by machine.
  const extraFor = (tier: Tier): string[] => {
    const extra: string[] = ['--claim', String(gens.get(tier))];
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
  let lostRows = 0;
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
    const stitched = stitch(tier, filtered, failed > 0);
    const n = stitched.rows;
    lostRows += stitched.lost ?? 0;
    if (filtered) {
      selected = (selected ?? 0) + n;
    }
    const s = span.get(tier);
    const secs = (((s?.t1 ?? 0) - (s?.t0 ?? 0)) / 1000).toFixed(1);
    // Only a FILTER that selected nothing makes a tier `untouched`: a tier whose shards wrote no
    // part file was not left alone because `--only` matched nothing, and `emptySelectionError`
    // must not name it as evidence that it did.
    if (stitched.why === 'no-row-selected') {
      untouched.push(tier);
    }
    console.log(tierLine({ tier, stitched, failedShards: failed, secs, skips }));
  }
  if (failedShards > 0) {
    // all tiers stitched (partial results persist for debugging), but the run itself failed
    const failedCodes = [...outcomes.values()].flat().flatMap((o) => (o.code === 0 ? [] : [o.code]));
    if (shardsExitCode(failedCodes) === CACHE_MISMATCH_EXIT) {
      console.error(
        `\n${failedShards} shard(s) exited ${CACHE_MISMATCH_EXIT}: a stored answer disagreed with a fresh ` +
          `compile. The store is serving objects this toolchain no longer produces — see the [candcache] ` +
          `lines above, then drop the store (ASMLIFT_CANDCACHE_DIR).`,
      );
      process.exitCode = CACHE_MISMATCH_EXIT;
      return;
    }
    throw new Error(
      `${failedShards} shard(s) exited nonzero — see BUILD-FAIL/error lines above. The finished rows are kept: ` +
        `\`pnpm bench run --resume\` with the same filters measures only the rest.`,
    );
  }
  if (lostRows > 0) {
    throw new Error(
      `${lostRows} planned row(s) were neither measured nor skipped, though every shard exited 0 — a shard ` +
        `claimed them and never wrote them. The queue is kept: \`pnpm bench run --resume\` measures them.`,
    );
  }
  if (selected === 0) {
    throw emptySelectionError(opts, untouched);
  }
  console.log(`\nDone in ${((Date.now() - runStart) / 1000).toFixed(1)}s. Next: pnpm bench:merge`);
}
