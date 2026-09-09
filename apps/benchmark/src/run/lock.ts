// Is a `bench run` measuring THIS worktree right now? An advisory marker, and the one question
// `preflight.ts` structurally cannot answer.
//
// The start-time refusal there asks "is the tree dirty at second 0". `provenance.ts` asks "was it
// dirty at any sample DURING the run", stickily, and `merge` refuses the tier. Between them sits a
// run that starts clean and is dirtied while it is in flight — a comment audit, a `pnpm format`, an
// editor save. That run is 39 minutes of measurement no commit holds, and it is the shape that cost
// the most: one round lost 2,420 s to a comment audit run beside its own gate bench.
//
// The fix is not a machine-wide queue. It is a name for the fact: `bench run` writes
// `bench-running` at the repo root and removes it on the way out, and the phases that EDIT the tree
// read it and refuse (`pnpm bench lock`, wired into the function briefs' audit phase).
//
// ADVISORY, on purpose. It coordinates one worktree's agents, not the machine: two worktrees have
// two markers, and nothing here waits, queues, or retries.
//
// GITIGNORED (`/bench-running`, anchored) — and that is load-bearing rather than tidy. An untracked
// file at the repo root is exactly what `preflight.ts` refuses to start on and what the mid-run
// sampler stamps dirty, so a marker git can see would cause the loss it exists to prevent.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT } from '../config';

/** The marker's name at the repo root. Quoted in every refusal, and in `.gitignore` as
 *  `/bench-running` — unanchored, the pattern would also hide a file of that name anywhere in the
 *  tree, which is how a real committed artifact once went missing here. */
export const BENCH_LOCK_FILE = 'bench-running';

/** What the marker records: enough for a reader to decide whether to wait or to clear it. */
export interface BenchLockRecord {
  pid: number;
  startedAt: string;
  command: string;
}

export type BenchLockState =
  /** No marker: nothing is measuring this worktree. */
  | { state: 'free'; path: string }
  /** A marker whose process is still alive. */
  | { state: 'held'; path: string; record: BenchLockRecord }
  /** A marker left behind — the run was SIGKILLed, or the machine went down. Treated as free by
   *  every reader, because the alternative is a round blocked on a file nobody can explain. */
  | { state: 'stale'; path: string; record?: BenchLockRecord; why: string };

export function benchLockPath(root: string = REPO_ROOT): string {
  return join(root, BENCH_LOCK_FILE);
}

/** Is that pid a process this machine still has? EPERM means yes and owned by someone else; only
 *  ESRCH means gone.
 *
 *  A recycled pid therefore reads as HELD when the bench that wrote it is long dead. That is the
 *  direction to be wrong in: a false `held` costs one `rm` and says so on screen, while a false
 *  `stale` costs the 2,420 s this file exists to keep. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readBenchLock(root: string = REPO_ROOT): BenchLockState {
  const path = benchLockPath(root);
  if (!existsSync(path)) {
    return { state: 'free', path };
  }
  let record: BenchLockRecord;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const r = parsed as Partial<BenchLockRecord>;
    if (typeof r?.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) {
      throw new Error('no pid');
    }
    record = { pid: r.pid, startedAt: String(r.startedAt ?? 'unknown'), command: String(r.command ?? 'unknown') };
  } catch (e) {
    // A half-written or hand-edited marker names no process, so no reader can ever clear it by
    // waiting. Unreadable is stale.
    return { state: 'stale', path, why: `unreadable (${(e as Error).message})` };
  }
  return pidAlive(record.pid)
    ? { state: 'held', path, record }
    : { state: 'stale', path, record, why: `pid ${record.pid} is gone` };
}

function elapsed(startedAt: string): string {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) {
    return 'unknown';
  }
  return `${Math.round((Date.now() - t) / 1000)} s`;
}

/** What a tree-editing phase is told when a run is in flight, or undefined when it may proceed. */
export function benchInFlightRefusal(state: BenchLockState): string | undefined {
  if (state.state !== 'held') {
    return undefined;
  }
  return [
    `REFUSED: a bench run is measuring this worktree — \`${BENCH_LOCK_FILE}\` (pid ${state.record.pid}, started ` +
      `${state.record.startedAt}, ${elapsed(state.record.startedAt)} ago): ${state.record.command}`,
    '',
    'Editing the tree now does not just risk the edit: `provenance.ts` samples git DURING the run',
    'and the sample is STICKY, so one save stamps the whole run dirty and `bench:merge` throws the',
    'numbers away — 39 minutes, after the fact, for a change that was reverted.',
    'Wait for the run (its log ends in an `EXIT=` line), then edit. If the run is dead, the marker',
    `names its pid: check, then \`rm ${BENCH_LOCK_FILE}\`.`,
  ].join('\n');
}

/** What `bench run` is told when another run already holds this worktree. Separate text: the
 *  reader is not editing anything, they are about to rewrite `results/<tier>.json` under a run that
 *  is still writing it. */
export function concurrentRunRefusal(state: BenchLockState): string | undefined {
  if (state.state !== 'held') {
    return undefined;
  }
  return [
    `bench run REFUSED: pid ${state.record.pid} is already running one here (\`${BENCH_LOCK_FILE}\`, started ` +
      `${state.record.startedAt}, ${elapsed(state.record.startedAt)} ago): ${state.record.command}`,
    '',
    'Both runs write `apps/benchmark/results/<tier>.json`, so the second publishes a tier stitched',
    'from two measurements — and on a 10-core machine they halve each other besides.',
    `Wait for it, or run in a separate worktree. If that pid is dead, \`rm ${BENCH_LOCK_FILE}\`.`,
  ].join('\n');
}

/** Take the marker for this process and arrange for it to go away again.
 *
 *  Removal is hung off `process.on('exit')` rather than a `try`/`finally` because `cli.ts` leaves
 *  through `process.exit()` on a dozen paths, and each one would need its own release. Signals get
 *  explicit handlers that remove and then re-exit — an unhandled SIGINT never runs `exit`
 *  listeners, and Ctrl-C on a 39-minute run is not the rare case.
 *
 *  What no handler can cover is SIGKILL or a lost machine, which is what `stale` is for. */
export function acquireBenchLock(command: string, root: string = REPO_ROOT): string {
  const path = benchLockPath(root);
  const record: BenchLockRecord = { pid: process.pid, startedAt: new Date().toISOString(), command };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  const release = () => releaseBenchLock(root, record.pid);
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      release();
      process.exit(128 + (osConstants.signals[sig] as number));
    });
  }
  return path;
}

/** Remove the marker, but only if it is still OURS: a run that overwrote a stale marker and a
 *  concurrent process that cleared it by hand both end with someone else's record on disk, and
 *  deleting that would silently unlock a live run. */
export function releaseBenchLock(root: string = REPO_ROOT, pid: number = process.pid): void {
  const path = benchLockPath(root);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BenchLockRecord>;
    if (parsed?.pid !== pid) {
      return;
    }
  } catch {
    return;
  }
  rmSync(path, { force: true });
}

/** `bench lock`: the read the audit phases run. Exit 0 = go ahead, 1 = a run is in flight. */
export function benchLockStatus(root: string = REPO_ROOT): number {
  const state = readBenchLock(root);
  const refusal = benchInFlightRefusal(state);
  if (refusal !== undefined) {
    console.error(refusal);
    return 1;
  }
  if (state.state === 'stale') {
    console.log(
      `no bench run in flight — \`${BENCH_LOCK_FILE}\` is stale (${state.why}). ` +
        `The next \`bench run\` overwrites it; \`rm ${BENCH_LOCK_FILE}\` to be rid of it now.`,
    );
    return 0;
  }
  console.log(`no bench run in flight (no ${state.path}) — the tree is yours to edit.`);
  return 0;
}
