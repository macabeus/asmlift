// Shard fan-out + stitch — the whole parent/child contract. Fans each tier across N worker
// PROCESSES (each a `cli.ts run --serial --tier X --shard i/N` child writing a part file), then
// stitches the parts into the canonical per-tier file. Process-level sharding: the hot path per
// case is a synchronous cross-compile + m2c/asmlift that spawnSync-blocks the event loop, so
// intra-process async gives no speedup; independent processes each get their own blocking
// pipeline, and the Docker container pool is shared by name across processes.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
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
 *  `filtered` says a filter could have selected rows here, which makes an empty result a typo. */
function stitch(tier: Tier, n: number, filtered: boolean): number {
  const results: FunctionResult[] = [];
  let parts = 0;
  for (let i = 0; i < n; i++) {
    const part = join(RESULTS_DIR, `${tier}.part${i}.json`);
    if (!existsSync(part)) {
      continue;
    }
    parts++;
    results.push(...(JSON.parse(readFileSync(part, 'utf8')) as BenchOutput).results);
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
  const out: BenchOutput = { meta: benchMeta(results), results };
  writeFileSync(join(RESULTS_DIR, `${tier}.json`), JSON.stringify(out, null, 2));
  return results.length;
}

export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  let failedShards = 0;
  // Rows selected across every tier a filter could have selected in. Stays null on an unfiltered
  // run, which is the only kind that reaches a branch — so this verdict cannot move a number.
  let selected: number | null = null;
  const untouched: Tier[] = [];
  for (const tier of opts.tiers) {
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
    const t0 = Date.now();
    console.log(`\n▶ ${tier}: fanning across ${opts.jobs} shards…`);
    const outcomes = await Promise.all(
      Array.from({ length: opts.jobs }, (_, i) => runShard(tier, `${i}/${opts.jobs}`, extra)),
    );
    const failed = outcomes.filter((o) => o.code !== 0).length;
    failedShards += failed;
    const skips = outcomes.reduce((sum, o) => sum + o.skips, 0);
    const filtered = tierIsFiltered(tier, opts);
    const n = stitch(tier, opts.jobs, filtered);
    if (filtered) {
      selected = (selected ?? 0) + n;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
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
    throw new Error(`${failedShards} shard(s) exited nonzero — see BUILD-FAIL/error lines above`);
  }
  if (selected === 0) {
    throw emptySelectionError(opts, untouched);
  }
  console.log(`\nDone. Next: pnpm bench:merge`);
}
