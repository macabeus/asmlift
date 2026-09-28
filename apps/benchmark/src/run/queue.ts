// The fanned-out run's ROW QUEUE: which rows a tier measures, in what order, which shard took each,
// and — after an interruption — which are already done. One directory per tier, beside the tier
// file it will be stitched into:
//
//   results/.<tier>.run/plan.json          the rows, in claim order, and the tree they were planned on
//   results/.<tier>.run/claims/<k>         row k taken — created exclusively (O_EXCL), never rewritten
//   results/.<tier>.run/part-<g>-<s>.json  what shard s of generation g finished or skipped, flushed per row
//
// WHY A QUEUE. A tier ends when its dearest row ends, whatever the scheduling; what the scheduling
// decides is whether the other shards finish the rest of the tier meanwhile. With a fixed slice per
// shard they cannot: the rows are handed out at spawn time. With a queue each shard takes the next
// unclaimed row, so a shard is idle only once the queue is empty.
//
// WHY EXCLUSIVE FILES. The shard children are separate `tsx` processes that block their event loop
// in `spawnSync` for every compile, so a message from the parent could not be read while a row
// runs; `open(…, 'wx')` is atomic on a local filesystem and needs no reader. The same files are the
// journal: a claim no part file finished is a row that was in flight when the run died, and
// `--resume` re-queues exactly those.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { realRowIdentities } from '../cases/manifests';
import { RESULTS_DIR } from '../config';
import { readWorktreeArtifact, rekeyToCurrent } from '../report/committed';
import type { Tier } from './orchestrate';

export const runDir = (tier: Tier, root = RESULTS_DIR): string => join(root, `.${tier}.run`);

/** The environment variable a shard child reads its orchestrator's pid from (see `claimer`). */
export const ORCHESTRATOR_PID_ENV = 'ASMLIFT_BENCH_ORCHESTRATOR_PID';

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

/** A shard's part file: the tier file's shape, plus the rows it SKIPPED (toolchain unavailable),
 *  so the stitch can tell a skipped row from a lost one. */
export interface PartFile extends BenchOutput {
  skipped?: string[];
}

/** The claim order: rows whose price the committed artifact does NOT record first, then the rest by
 *  its `rankSeconds`, dearest first; ties keep dataset order.
 *
 *  Unpriced first, because an unpriced row is new or declined last time — and a row that declined
 *  last time and ranks now is the one row nobody has priced, possibly the tier's dearest. Starting
 *  it last would put its whole ranked pass after the rest of the tier. */
export function claimOrder(ids: readonly string[], rankSeconds: ReadonlyMap<string, number>): string[] {
  const at = new Map(ids.map((id, i) => [id, i]));
  const cost = (id: string): number => rankSeconds.get(id) ?? Infinity;
  return [...ids].sort((a, b) => cost(b) - cost(a) || at.get(a)! - at.get(b)!);
}

/** Current row id → the ranked pass's seconds, off an artifact's rows, re-keyed to the current
 *  dataset so a renamed row keeps its price. */
export function recordedRankSeconds(results: readonly FunctionResult[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, r] of rekeyToCurrent(results, realRowIdentities())) {
    if (typeof r.asmlift?.rankSeconds === 'number') {
      out.set(id, r.asmlift.rankSeconds);
    }
  }
  return out;
}

/** The committed artifact's prices, and why there are none when it will not parse — the caller
 *  says so and plans in dataset order. */
export function committedRankSeconds(): { seconds: Map<string, number>; unreadable?: string } {
  const a = readWorktreeArtifact();
  return a.results
    ? { seconds: recordedRankSeconds(a.results) }
    : { seconds: new Map(), ...(a.unreadable ? { unreadable: a.unreadable } : {}) };
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

/** The plan's rows as this tree's cases, in plan order. Throws on a plan row this tree does not
 *  select: that plan was made on another tree or selection. */
export function planCases<C extends { id: string }>(dir: string, cases: readonly C[]): C[] {
  const plan = readPlan(dir);
  if (plan === undefined) {
    throw new Error(`no plan in ${dir} — the orchestrator writes it before spawning a shard`);
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  return plan.ids.map((id) => {
    const c = byId.get(id);
    if (c === undefined) {
      throw new Error(`the plan in ${dir} names ${id}, which this tree does not select`);
    }
    return c;
  });
}

/** Why `plan` cannot be resumed under `key`, or undefined when it can. */
export function resumeRefusal(plan: Plan | undefined, key: PlanKey): string | undefined {
  if (plan === undefined) {
    return 'this tier has no unfinished run — its last run finished, or none was fanned out. Narrow --tier to the tier that has one';
  }
  if (key.commit === 'unknown' || plan.commit === 'unknown') {
    return 'git cannot say which commit this tree is, so a resume cannot be checked against the one the unfinished run measured';
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
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A claimer over the plan in `dir`. It stops claiming once the orchestrator named by
 *  `ORCHESTRATOR_PID_ENV` is gone: a `kill -9` of the orchestrator orphans its shards, and an
 *  orphan still claiming would race the next `--resume` for the same rows, writing into a
 *  generation that has already been stitched. */
export function claimer(dir: string, who: string, orchestrator = Number(process.env[ORCHESTRATOR_PID_ENV])): Claimer {
  const total = readPlan(dir)?.ids.length ?? 0;
  // Claims are only ever CREATED during a run, so every index below the cursor is taken by
  // someone and this process never has to look back.
  let cursor = 0;
  return {
    claim() {
      if (Number.isInteger(orchestrator) && orchestrator > 0 && !alive(orchestrator)) {
        return undefined;
      }
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

/** The rows the journal holds, one per id, the rows it skipped, the provenance stamp of every
 *  part, and the parts that will not parse. A row twice is a claim re-queued while its first shard
 *  was still writing: the later generation's measurement wins, and it is counted. An unparsable part
 *  contributes nothing, so its rows read as unfinished and a resume re-queues them. */
export function journalRows(parts: readonly { path: string }[]): {
  results: FunctionResult[];
  skipped: Set<string>;
  stamps: BenchOutput['meta']['asmlift'][];
  repeated: number;
  unreadable: string[];
} {
  const byId = new Map<string, FunctionResult>();
  const skipped = new Set<string>();
  const stamps: BenchOutput['meta']['asmlift'][] = [];
  const unreadable: string[] = [];
  let repeated = 0;
  for (const p of parts) {
    let out: PartFile;
    try {
      out = JSON.parse(readFileSync(p.path, 'utf8')) as PartFile;
    } catch {
      unreadable.push(p.path);
      continue;
    }
    stamps.push(out.meta.asmlift);
    for (const r of out.results) {
      if (byId.has(r.id)) {
        repeated++;
      }
      byId.set(r.id, r);
    }
    for (const id of out.skipped ?? []) {
      skipped.add(id);
    }
  }
  return { results: [...byId.values()], skipped, stamps, repeated, unreadable };
}

/** Is `pid` a live bench shard child? Its command line carries `--claim`; any other process that
 *  holds a recycled pid of a long-dead shard does not. */
const isShardChild = (pid: number): boolean => {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && /\bcli\.ts run\b.*--claim\b/.test(ps.stdout);
};

/** Every UNFINISHED claim in `dir` whose claimer is still a live shard child, as `<pid> (<who>)`.
 *  At the start of a run none of this run's own shards exist yet, so a live one is an orphan of a
 *  killed run, still measuring: a run beside it would have it claim from the new queue and write
 *  into the new journal. A claim whose row a part file measured names a shard that finished it. */
export function liveClaimers(dir: string): string[] {
  const claims = join(dir, 'claims');
  const plan = readPlan(dir);
  const done = new Set(journalRows(readJournal(dir).parts).results.map((r) => r.id));
  const out = new Set<string>();
  for (const f of existsSync(claims) ? readdirSync(claims) : []) {
    const id = plan?.ids[Number(f)];
    if (id !== undefined && done.has(id)) {
      continue;
    }
    const who = readFileSync(join(claims, f), 'utf8');
    const pid = Number(/^pid (\d+)/.exec(who)?.[1]);
    if (pid > 0 && isShardChild(pid)) {
      out.add(`${pid} (${who})`);
    }
  }
  return [...out];
}

/** The plan's rows the journal neither measured nor skipped. Non-empty after every shard exited 0
 *  means rows were lost — claimed by a process that never flushed them. */
export function unaccounted(
  plan: Plan,
  journal: { results: readonly { id: string }[]; skipped: ReadonlySet<string> },
): string[] {
  const done = new Set(journal.results.map((r) => r.id));
  return plan.ids.filter((id) => !done.has(id) && !journal.skipped.has(id));
}

/** Before a resume: release every claim whose row no part file MEASURED — the rows in flight when
 *  the run died, and the rows that were skipped or failed to build, which are re-attempted. Returns
 *  how many were released. */
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
