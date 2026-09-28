// The fanned-out run's ROW QUEUE: which rows a tier measures, in what order, which shard took each,
// and — after an interruption — which are already done. One directory per tier, beside the tier
// file it will be stitched into:
//
//   results/.<tier>.run/plan.json          the rows, dearest first, and the tree they were planned on
//   results/.<tier>.run/claims/<k>         row k taken — created exclusively (O_EXCL), never rewritten
//   results/.<tier>.run/part-<g>-<s>.json  what shard s of generation g finished, flushed per row
//
// WHY A QUEUE AND NOT `idx % jobs`. A static slice decides at spawn time which shard runs which row,
// so a shard whose slice holds the one expensive row runs alone at the end while the others idle.
// Measured on the 2026-09-23 run: `mp4:getCardStatus:mwcc_233_163n` ranked 1,408 candidates in
// 10,276 s — 7.9× the whole real tier's 1,305 s — in one shard, with every other slot free for
// most of three hours. A queue cannot make that row cheaper; it makes every OTHER row finish on the
// idle shards, and, dearest first, starts the dear rows before the cheap ones instead of after.
//
// WHY EXCLUSIVE FILES AND NOT A PARENT DISPATCHING OVER IPC. The shard children are separate
// `tsx` processes that block their event loop in `spawnSync` for every compile, so a message from
// the parent cannot be read while a row runs; `open(…, 'wx')` is atomic on every local filesystem
// and needs no reader. The same files are the journal: a claim with no finished row in any part
// file is a row that was in flight when the run died, and `--resume` re-queues exactly those.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS_DIR } from '../config';
import type { Tier } from './orchestrate';

export const runDir = (tier: Tier, root = RESULTS_DIR): string => join(root, `.${tier}.run`);

/** What a plan was made FROM. A resume against a different tree or a different selection would
 *  stitch rows two trees measured into one tier file, and nothing downstream could tell. */
export interface PlanKey {
  commit: string;
  only?: string;
  project?: string;
  toolchain?: string;
}

export interface Plan extends PlanKey {
  /** row ids in claim order */
  ids: string[];
}

/** The claim order: rows whose price the committed artifact does NOT record first, then the rest by
 *  its `rankSeconds`, dearest first; ties keep dataset order.
 *
 *  Unpriced first, deliberately. It is the new rows and the rows that declined last time — and a
 *  row that declined last time and ranks now is exactly the one no one priced (getCardStatus
 *  above). Most of them still decline in about a second, so putting them first costs a few
 *  seconds per shard; putting a three-hour row last costs three hours of an idle machine. */
export function claimOrder(ids: readonly string[], rankSeconds: ReadonlyMap<string, number>): string[] {
  const at = new Map(ids.map((id, i) => [id, i]));
  const cost = (id: string): number => rankSeconds.get(id) ?? Infinity;
  return [...ids].sort((a, b) => cost(b) - cost(a) || at.get(a)! - at.get(b)!);
}

/** row id → the ranked pass's seconds, off an artifact's rows */
export function recordedRankSeconds(results: readonly Pick<FunctionResult, 'id' | 'asmlift'>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of results) {
    if (typeof r.asmlift?.rankSeconds === 'number') {
      out.set(r.id, r.asmlift.rankSeconds);
    }
  }
  return out;
}

/** The committed artifact's prices, read off this worktree's `results.json`. Empty — every row
 *  unpriced, dataset order — when there is none or it will not parse: this orders, it decides
 *  nothing a number depends on. */
export function committedRankSeconds(root = RESULTS_DIR): Map<string, number> {
  try {
    const { results } = JSON.parse(readFileSync(join(root, 'results.json'), 'utf8')) as BenchOutput;
    return Array.isArray(results) ? recordedRankSeconds(results) : new Map();
  } catch {
    return new Map();
  }
}

export function writePlan(dir: string, plan: Plan): void {
  mkdirSync(join(dir, 'claims'), { recursive: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
}

export function readPlan(dir: string): Plan | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as Plan;
  } catch {
    return undefined;
  }
}

/** Why `plan` cannot be resumed under `key`, or undefined when it can. */
export function resumeRefusal(plan: Plan | undefined, key: PlanKey): string | undefined {
  if (plan === undefined) {
    return 'this tier has no unfinished run — its last run finished, or none was fanned out. Narrow --tier to the tier that has one';
  }
  if (plan.commit !== key.commit) {
    return `the unfinished run measured ${plan.commit.slice(0, 8)} and HEAD is ${key.commit.slice(0, 8)}: its rows and this tree's would be stitched into one tier file`;
  }
  for (const f of ['only', 'project', 'toolchain'] as const) {
    if (plan[f] !== key[f]) {
      return `the unfinished run selected --${f} ${plan[f] ?? '(none)'} and this one --${f} ${key[f] ?? '(none)'}`;
    }
  }
  return undefined;
}

/** Takes the next unclaimed row, across every process claiming from the same directory. */
export interface Claimer {
  /** the claimed row's index into the plan, or undefined when the queue is spent */
  claim(): number | undefined;
  total: number;
}

export function claimer(dir: string, total: number, who: string): Claimer {
  // Claims are only ever CREATED during a run, so every index below the cursor is taken by
  // someone and this process never has to look back.
  let cursor = 0;
  return {
    total,
    claim() {
      for (; cursor < total; cursor++) {
        try {
          const fd = openSync(join(dir, 'claims', String(cursor)), 'wx');
          writeFileSync(fd, who);
          closeSync(fd);
          return cursor++;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw e;
          }
        }
      }
      return undefined;
    },
  };
}

export const partPath = (dir: string, gen: number, shard: number): string => join(dir, `part-${gen}-${shard}.json`);

export interface Journal {
  /** every part file, in generation then shard order */
  parts: { gen: number; shard: number; path: string }[];
  /** the next generation's number */
  nextGen: number;
}

export function readJournal(dir: string): Journal {
  const parts = existsSync(dir)
    ? readdirSync(dir)
        .map((f) => /^part-(\d+)-(\d+)\.json$/.exec(f))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ gen: Number(m[1]), shard: Number(m[2]), path: join(dir, m[0]) }))
        .sort((a, b) => a.gen - b.gen || a.shard - b.shard)
    : [];
  return { parts, nextGen: parts.reduce((g, p) => Math.max(g, p.gen + 1), 0) };
}

/** The rows the journal holds, one per id, and the provenance stamp of every part they came from.
 *  A row twice is a claim that was re-queued while its first shard was still alive (an orphaned
 *  child of a killed parent): the later generation's measurement wins, and it is counted. */
export function journalRows(parts: readonly { path: string }[]): {
  results: FunctionResult[];
  stamps: BenchOutput['meta']['asmlift'][];
  repeated: number;
} {
  const byId = new Map<string, FunctionResult>();
  const stamps: BenchOutput['meta']['asmlift'][] = [];
  let repeated = 0;
  for (const p of parts) {
    const out = JSON.parse(readFileSync(p.path, 'utf8')) as BenchOutput;
    stamps.push(out.meta.asmlift);
    for (const r of out.results) {
      if (byId.has(r.id)) {
        repeated++;
      }
      byId.set(r.id, r);
    }
  }
  return { results: [...byId.values()], stamps, repeated };
}

/** Before a resume: release every claim whose row no part file holds — the rows that were in
 *  flight when the run died, plus rows that were SKIPPED or failed to build, which left no row
 *  either and are re-attempted. Returns how many were released. */
export function releaseUnfinished(dir: string, plan: Plan, done: ReadonlySet<string>): number {
  const claims = join(dir, 'claims');
  let released = 0;
  for (const f of existsSync(claims) ? readdirSync(claims) : []) {
    const id = plan.ids[Number(f)];
    if (id === undefined || !done.has(id)) {
      rmSync(join(claims, f));
      released++;
    }
  }
  return released;
}
