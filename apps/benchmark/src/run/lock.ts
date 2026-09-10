// Is a `bench run` measuring THIS worktree right now? An advisory marker, and the one question
// `preflight.ts` structurally cannot answer.
//
// The start-time refusal there asks "is the tree dirty at second 0". `provenance.ts` asks "was it
// dirty at any sample DURING the run", stickily, and `merge` refuses the tier. Between them sits a
// run that starts clean and is dirtied while it is in flight — a comment audit, a `pnpm format`, an
// editor save. That run is 39 minutes of measurement no commit holds, and it is the shape that cost
// the most: one round lost 2,420 s to a comment audit run beside its own gate bench.
//
// The fix is not a machine-wide queue. It is a name for the fact: `bench run` writes a record under
// `bench-running/` at the repo root and removes it on the way out, and the phases that EDIT the
// tree read it and refuse (`pnpm bench lock`, wired into the function briefs' audit phase).
//
// ONE RECORD PER RUN, not one slot. `bench-running/<pid>.json`, because a single slot makes the
// guard LIE: a second run that took the slot would delete the first run's protection when IT
// finished, and `bench lock` would then clear an audit to edit the tree under a bench still in
// flight — louder than no guard, and wrong. A worktree is held while ANY record names a live
// process, and a run only ever writes and unlinks its own.
//
// ADVISORY, on purpose. It coordinates one worktree's agents, not the machine: two worktrees have
// two directories, and nothing here waits, queues, or retries.
//
// NO SIGNAL HANDLERS, and this is the one place tidiness had to lose. `orchestrate.ts` blocks the
// event loop in `spawnSync` for every case, so a JS listener for SIGTERM turns an OS-level kill
// into a callback that cannot run until the loop unblocks. Measured in isolation (node blocked in
// `spawnSync('sleep', ['10'])`, SIGTERM at 600 ms): with no listener it died at 608 ms; with one it
// ran the full 10 s, exited **0**, and the listener never ran — the signal was swallowed outright.
//
// What this does NOT buy is a killable `bench run`. Importing `run/orchestrate.ts` makes tsx bind
// its own hidden SIGINT/SIGTERM handler (hidden: it patches `process.listenerCount`, which reports
// 0), so the CLI is signal-deferred on `origin/main` too — measured, with no handler of ours: a
// `bench run --tier synthetic --serial` sent SIGTERM 6 s in ran all 291 cases, REWROTE
// `results/synthetic.json`, and only then exited 143. `kill -9` is the stop that works. Adding a
// second listener on top of that could only make things worse, and did.
//
// So a run that dies without reaching its exit path leaves its record behind, exactly like a
// SIGKILL: it names a pid that is gone, so it reads `stale`, and stale blocks nothing.
//
// GITIGNORED (`/bench-running`, anchored) — and that is load-bearing rather than tidy. An untracked
// path at the repo root is exactly what `preflight.ts` refuses to start on and what the mid-run
// sampler stamps dirty, so a marker git can see would cause the loss it exists to prevent.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../config';

/** The marker's name at the repo root: a directory of `<pid>.json` records. Quoted in every
 *  refusal, and in `.gitignore` as `/bench-running` — unanchored, the pattern would also hide
 *  anything of that name anywhere in the tree, which is how a real committed artifact once went
 *  missing here. */
export const BENCH_LOCK_FILE = 'bench-running';

/** What one run records: enough for a reader to decide whether to wait or to clear it, and enough
 *  for the NEXT run to tell whether the two of them collide on a `results/<tier>.json`. */
export interface BenchLockRecord {
  pid: number;
  startedAt: string;
  command: string;
  /** The tiers this run writes. Empty only for a record written by an older build. */
  tiers: string[];
}

export type BenchLockState =
  /** No live record: nothing is measuring this worktree. */
  | { state: 'free'; path: string }
  /** At least one record naming a live process, oldest first. */
  | { state: 'held'; path: string; records: BenchLockRecord[] }
  /** The directory is there but every record in it is dead or unreadable — a SIGKILLed or
   *  signalled run, or a lost machine. Treated as free by every reader, because the alternative is
   *  a round blocked on a file nobody can explain. */
  | { state: 'stale'; path: string; why: string };

export function benchLockPath(root: string = REPO_ROOT): string {
  return join(root, BENCH_LOCK_FILE);
}

function recordPath(root: string, pid: number): string {
  return join(benchLockPath(root), `${pid}.json`);
}

/** Is that pid a process this machine still has? EPERM means yes and owned by someone else; only
 *  ESRCH means gone.
 *
 *  A recycled pid therefore reads as HELD when the bench that wrote it is long dead. That is the
 *  direction to be wrong in: a false `held` costs one `rm` of a record named on screen, while a
 *  false `stale` costs the 2,420 s this file exists to keep. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRecord(text: string): BenchLockRecord | undefined {
  try {
    const r = JSON.parse(text) as Partial<BenchLockRecord>;
    if (typeof r?.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) {
      return undefined;
    }
    return {
      pid: r.pid,
      startedAt: String(r.startedAt ?? 'unknown'),
      command: String(r.command ?? 'unknown'),
      tiers: Array.isArray(r.tiers) ? r.tiers.map(String) : [],
    };
  } catch {
    // A half-written or hand-edited record names no process, so no reader can ever clear it by
    // waiting. Unreadable is dead.
    return undefined;
  }
}

/** Every record on disk, live and dead, so acquire can sweep the dead ones and read can explain
 *  itself. Anything that is not a readable `<pid>.json` counts as one dead record. */
function scan(root: string): { live: BenchLockRecord[]; dead: string[] } {
  const dir = benchLockPath(root);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    // Missing, or a plain FILE where the directory should be (an older build's marker, a stray
    // `touch`). Either way there is no live record in it.
    return { live: [], dead: existsSync(dir) ? [dir] : [] };
  }
  const live: BenchLockRecord[] = [];
  const dead: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let record: BenchLockRecord | undefined;
    try {
      record = parseRecord(readFileSync(path, 'utf8'));
    } catch {
      record = undefined;
    }
    if (record && pidAlive(record.pid)) {
      live.push(record);
    } else {
      dead.push(path);
    }
  }
  live.sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
  return { live, dead };
}

export function readBenchLock(root: string = REPO_ROOT): BenchLockState {
  const path = benchLockPath(root);
  const { live, dead } = scan(root);
  if (live.length > 0) {
    return { state: 'held', path, records: live };
  }
  if (dead.length > 0) {
    return { state: 'stale', path, why: `${dead.length} record(s), none naming a live process` };
  }
  return { state: 'free', path };
}

function elapsed(startedAt: string): string {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) {
    return 'unknown';
  }
  return `${Math.round((Date.now() - t) / 1000)} s`;
}

function describe(r: BenchLockRecord): string {
  return (
    `\`${BENCH_LOCK_FILE}/${r.pid}.json\` (pid ${r.pid}, started ${r.startedAt}, ` +
    `${elapsed(r.startedAt)} ago): ${r.command}`
  );
}

/** What a tree-editing phase is told when a run is in flight, or undefined when it may proceed. */
export function benchInFlightRefusal(state: BenchLockState): string | undefined {
  if (state.state !== 'held') {
    return undefined;
  }
  return [
    `REFUSED: a bench run is measuring this worktree — ${describe(state.records[0])}`,
    ...state.records.slice(1).map((r) => `  and ${describe(r)}`),
    '',
    'Editing the tree now does not just risk the edit: `provenance.ts` samples git DURING the run',
    'and the sample is STICKY, so one save stamps the whole run dirty and `bench:merge` throws the',
    'numbers away — 39 minutes, after the fact, for a change that was reverted.',
    'Wait for the run (its log ends in an `EXIT=` line), then edit. If the run is dead, the record',
    `names its pid: check, then \`rm ${BENCH_LOCK_FILE}/<pid>.json\`.`,
  ].join('\n');
}

/** What `bench run` is told when a run already in flight writes a tier file it is about to write.
 *
 *  Gated on the TIERS, not on "a run is in flight". A background `--tier real` and a scoped
 *  `--tier synthetic --only <sym>` touch different files and are the dev loop HARD RULE 2 and both
 *  briefs prescribe; refusing that would be the trade `preflight.ts` warns about in advance — "one
 *  sanctioned name beats an escape hatch", and the invented way past a wrong refusal here is `rm`,
 *  which is the one move that can silently unprotect the run still in flight. A scoped run on the
 *  SAME tier is still refused: it rewrites `results/<tier>.json` with its handful of rows. */
export function concurrentRunRefusal(state: BenchLockState, tiers: readonly string[]): string | undefined {
  if (state.state !== 'held') {
    return undefined;
  }
  const clashes = state.records
    .map((r) => ({ record: r, shared: r.tiers.filter((t) => tiers.includes(t)) }))
    // An older build's record carries no tiers; assume it collides rather than assume it does not.
    .filter((c) => c.shared.length > 0 || c.record.tiers.length === 0);
  if (clashes.length === 0) {
    return undefined;
  }
  const shared = clashes[0].shared;
  const files = (shared.length > 0 ? shared : tiers).map((t) => `apps/benchmark/results/${t}.json`).join(', ');
  return [
    `bench run REFUSED: pid ${clashes[0].record.pid} is already running one here — ${describe(clashes[0].record)}`,
    '',
    `Both runs write ${files}, so the second publishes a tier stitched from two`,
    'measurements — and on a 10-core machine they halve each other besides.',
    'Wait for it, run a tier it is not writing, or use a separate worktree. If that pid is dead,',
    `\`rm ${BENCH_LOCK_FILE}/${clashes[0].record.pid}.json\`.`,
  ].join('\n');
}

/** Take a record for this process and arrange for it to go away again.
 *
 *  Removal is hung off `process.on('exit')` rather than a `try`/`finally` because `cli.ts` leaves
 *  through `process.exit()` on a dozen paths, and each one would need its own release. Signals get
 *  NO handler of ours — see the module header. A run that dies without reaching `exit` leaves a
 *  record naming a dead pid, which is what `stale` is for, and the same is true of SIGKILL or a
 *  lost machine.
 *
 *  Never touches another run's record, on either side. Two runs launched in the same millisecond
 *  can both read `free` and both proceed — a read/write window `concurrentRunRefusal` cannot close
 *  from here. Left open knowingly: with one record per pid the racing pair only DUPLICATES work,
 *  where the single-slot shape had the second run EVICT the first's protection, and real launches
 *  are seconds apart. */
export function acquireBenchLock(command: string, tiers: readonly string[], root: string = REPO_ROOT): string {
  const dir = benchLockPath(root);
  const { dead } = scan(root);
  if (dead.length === 1 && dead[0] === dir) {
    // A plain file where the directory belongs. It names no live run, so it is safe to clear.
    console.error(`[bench lock] cleared a stale \`${BENCH_LOCK_FILE}\` left by an older build`);
    rmSync(dir, { force: true });
  }
  mkdirSync(dir, { recursive: true });
  for (const path of dead) {
    if (path === dir) {
      continue;
    }
    console.error(`[bench lock] cleared a stale record: ${path.slice(root.length + 1)}`);
    rmSync(path, { force: true });
  }
  const record: BenchLockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command,
    tiers: [...tiers],
  };
  const path = recordPath(root, process.pid);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  process.on('exit', () => releaseBenchLock(root, record.pid));
  return path;
}

/** Remove OUR record, and the directory once it holds nothing. Another run's record is never
 *  touched: deleting one would silently unlock a live run, which is the failure that makes an
 *  advisory guard worse than none. */
export function releaseBenchLock(root: string = REPO_ROOT, pid: number = process.pid): void {
  rmSync(recordPath(root, pid), { force: true });
  try {
    rmdirSync(benchLockPath(root));
  } catch {
    // Not empty (another run holds a record), or already gone. Both are fine.
  }
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
      `no bench run in flight — \`${BENCH_LOCK_FILE}\` holds only records of dead runs (${state.why}). ` +
        `The next \`bench run\` sweeps them; \`rm -r ${BENCH_LOCK_FILE}\` to be rid of them now.`,
    );
    return 0;
  }
  console.log(`no bench run in flight (no \`${BENCH_LOCK_FILE}\`) — the tree is yours to edit.`);
  return 0;
}
