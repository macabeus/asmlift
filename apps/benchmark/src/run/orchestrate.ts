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

/** One shard child (a tsx subprocess), stdout streamed with a shard prefix. Resolves on exit. */
function runShard(tier: Tier, shard: string, extra: string[]): Promise<number> {
  const child = spawn('tsx', [CLI, 'run', '--serial', '--tier', tier, '--shard', shard, ...extra], {
    cwd: join(import.meta.dirname, '..', '..', '..', '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tag = `[${tier} ${shard}]`;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        console.log(`${tag} ${line}`);
      }
    }
  });
  return new Promise<number>((res) => {
    child.on('close', (code, signal) => {
      if (buf.trim()) {
        console.log(`${tag} ${buf}`);
      }
      // a signal-killed child (OOM, segfault) reports code=null — that is a failure, not a 0
      res(code ?? (signal ? 1 : 0));
    });
  });
}

/** Stitch `${tier}.part{0..n-1}.json` back into the canonical `${tier}.json`, delete the parts. */
function stitch(tier: Tier, n: number): number {
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
  const out: BenchOutput = { meta: benchMeta(results), results };
  writeFileSync(join(RESULTS_DIR, `${tier}.json`), JSON.stringify(out, null, 2));
  return results.length;
}

export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  let failedShards = 0;
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
    const codes = await Promise.all(
      Array.from({ length: opts.jobs }, (_, i) => runShard(tier, `${i}/${opts.jobs}`, extra)),
    );
    const failed = codes.filter((c) => c !== 0).length;
    failedShards += failed;
    const n = stitch(tier, opts.jobs);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${failed ? '✗' : '✓'} ${tier}: ${n} results in ${secs}s${failed ? ` (${failed} shard(s) exited nonzero)` : ''} → results/${tier}.json`,
    );
  }
  if (failedShards > 0) {
    // all tiers stitched (partial results persist for debugging), but the run itself failed
    throw new Error(`${failedShards} shard(s) exited nonzero — see BUILD-FAIL/error lines above`);
  }
  console.log(`\nDone. Next: pnpm bench:merge`);
}
