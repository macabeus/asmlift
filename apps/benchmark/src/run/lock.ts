// Which `bench run`s are measuring something on this MACHINE right now? An advisory register of
// records, and the two questions `preflight.ts` structurally cannot answer from a git status.
//
// QUESTION 1 — "may I edit this tree?" The start-time refusal in `preflight.ts` asks "is the tree
// dirty at second 0". `provenance.ts` asks "was it dirty at any sample DURING the run", stickily,
// and `merge` refuses the tier. Between them sits a run that starts clean and is dirtied while it
// is in flight — a comment audit, a `pnpm format`, an editor save. That run is 39 minutes of
// measurement no commit holds, and it is the shape that cost the most: one round lost 2,420 s to a
// comment audit run beside its own gate bench.
//
// QUESTION 2 — "may I start a run?" Two full benches on one machine halve each other (2,704 s
// against a neighbour versus 1,800 s solo) and, worse, a shard killed by a neighbour writes a
// partial tier with NO error line. That is the standing house rule "two full benches must never
// overlap on this machine", and it is the hazard with two recorded incidents.
//
// So the register is MACHINE-WIDE and each record names the tree it measures: a run writes
// `<register>/<pid>.json` on the way in and removes it on the way out, and every reader filters by
// what it actually cares about. Question 1 reads only the records whose `root` is this worktree —
// a neighbour's bench cannot be dirtied by an edit here. Question 2 reads them all: a whole-tier
// run is refused against a whole-tier run at ANY root, and same-root runs are refused when they
// write the same `results/<tier>.json`.
//
// WHERE, and why not `os.tmpdir()`. A machine-wide rendezvous is worth nothing if two processes
// disagree about where it is, and `tmpdir()` disagrees: measured on this machine, an interactive
// shell gives `/var/folders/…/T` from `$TMPDIR` while the same node with `TMPDIR` unset gives
// `/tmp`. Two agents would then hold two registers and each would read the other as absent — the
// guard firing green while the hazard is live, which is worse than no guard. `/tmp` is resolved
// from no environment variable, so every process on this machine agrees. The uid suffix is for
// permissions, not privacy: `/tmp` is sticky, and a second user's records would be unremovable.
//
// ADVISORY: nothing here waits, queues or retries, and `--no-lock` walks past it (see
// `concurrentRunRefusal`). The register is a name for a fact, not a mutex.
//
// ONE RECORD PER RUN, not one slot. A single slot makes the guard LIE: a second run that took the
// slot would delete the first run's protection when IT finished, and a tree-editing phase would
// then be cleared to edit under a bench still in flight — louder than no guard, and wrong. A run
// only ever writes and unlinks its own record.
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
// `results/synthetic.json`, and only then exited 143. `kill -9` is the stop that works.
//
// So a run that dies without reaching its exit path leaves its record behind, exactly like a
// SIGKILL: it names a pid that is gone, so it reads `stale`, and stale blocks nothing.
//
// OUTSIDE EVERY WORKTREE, which is what makes it free. A marker inside the tree is an untracked
// path — exactly what `preflight.ts` refuses to start on and what the mid-run sampler stamps
// dirty — so it would have to be gitignored, and the guard would be one `.gitignore` edit away
// from causing the loss it exists to prevent. In `/tmp` it cannot be seen by git at all.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT } from '../config';

/** The register's directory: machine-wide, per-uid, and — where the incidents happen — derived
 *  from NO environment variable; see the header for the `tmpdir()` measurement that rules that
 *  function out. Windows has no `/tmp` to agree on and no bench, so it falls back. Quoted in every
 *  refusal, so a reader can `ls` it. */
export const BENCH_LOCK_DIR =
  process.platform === 'win32'
    ? join(tmpdir(), 'asmlift-bench-running')
    : `/tmp/asmlift-bench-running-${typeof process.getuid === 'function' ? process.getuid() : 0}`;

/** What one run records. Enough for a reader to decide whether to wait or to clear it, enough for
 *  the NEXT run to tell whether the two collide on a `results/<tier>.json`, and enough to tell a
 *  run measuring THIS worktree from one measuring a neighbour. */
export interface BenchLockRecord {
  pid: number;
  startedAt: string;
  command: string;
  /** The tiers this run writes. */
  tiers: string[];
  /** The worktree it measures. Absent in a record that did not say which — an older build, or a
   *  hand-written one. Absent means UNKNOWN, and unknown is never a clearance: it matches every
   *  root. */
  root?: string;
  /** Does it rewrite at least one tier file WHOLE (`preflight.ts`'s `runIsWholeTier`)? That, not
   *  "is it slow", is what makes two runs a house-rule violation rather than a dev loop. */
  whole: boolean;
}

export type BenchLockState =
  /** No live record anywhere on this machine. */
  | { state: 'free'; path: string }
  /** At least one record naming a live process, oldest first. Records at ANY root: it is each
   *  reader's job to filter, because the two questions filter differently. */
  | { state: 'held'; path: string; records: BenchLockRecord[] }
  /** The directory is there but every record in it is dead or unreadable — a SIGKILLed or
   *  signalled run, or a lost machine. Treated as free by every reader, because the alternative is
   *  a round blocked on a file nobody can explain. */
  | { state: 'stale'; path: string; why: string };

function recordPath(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
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
      root: typeof r.root === 'string' ? r.root : undefined,
      // Unknown is not a clearance, on this axis too: a record that does not say gets treated as
      // the run that collides.
      whole: r.whole !== false,
    };
  } catch {
    // A half-written or hand-edited record names no process, so no reader can ever clear it by
    // waiting. Unreadable is dead.
    return undefined;
  }
}

/** Every record on disk, live and dead, so acquire can sweep the dead ones and read can explain
 *  itself. Anything that is not a readable `<pid>.json` counts as one dead record. */
function scan(dir: string): { live: BenchLockRecord[]; dead: string[] } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    // Either it is not there at all, or something that is not a readable directory is. A PLAIN
    // file (a stray `touch`) names no live run and is safe to clear; an unreadable DIRECTORY is
    // not — sweeping that would delete live records — so it is reported as neither, and the
    // acquire below fails loudly on its own write instead.
    if (!existsSync(dir)) {
      return { live: [], dead: [] };
    }
    let isDir = false;
    try {
      isDir = lstatSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    return { live: [], dead: isDir ? [] : [dir] };
  }
  const live: BenchLockRecord[] = [];
  const dead: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let record: BenchLockRecord | undefined;
    try {
      record = parseRecord(readFileSync(path, 'utf8'));
    } catch {
      // Including EISDIR: a DIRECTORY named `<pid>.json` is junk, and it is swept like any other
      // unreadable record. The sweep's `rmSync` is recursive for exactly this case — without it,
      // one such directory makes every later `bench run` in this register die on a Node stack.
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

export function readBenchLock(dir: string = BENCH_LOCK_DIR): BenchLockState {
  const { live, dead } = scan(dir);
  if (live.length > 0) {
    return { state: 'held', path: dir, records: live };
  }
  if (dead.length > 0) {
    return { state: 'stale', path: dir, why: `${dead.length} record(s), none naming a live process` };
  }
  return { state: 'free', path: dir };
}

/** Does this record measure that worktree? A record that does not say which tree it measures
 *  matches every one: unknown is not a clearance. */
function measures(r: BenchLockRecord, root: string): boolean {
  return r.root === undefined || r.root === root;
}

function elapsed(startedAt: string): string {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) {
    return 'unknown';
  }
  return `${Math.round((Date.now() - t) / 1000)} s`;
}

/** One record as a line a reader can act on. The directory comes from the STATE that was read,
 *  never from `BENCH_LOCK_DIR`: every refusal here quotes a path to `rm`, and a message naming a
 *  path the reader did not read is a message that sends them to delete the wrong file. */
function describe(r: BenchLockRecord, dir: string): string {
  return (
    `\`${dir}/${r.pid}.json\` (pid ${r.pid}, started ${r.startedAt}, ` + `${elapsed(r.startedAt)} ago): ${r.command}`
  );
}

/** What a tree-editing phase is told when a run is measuring THIS worktree, or undefined when it
 *  may proceed. Filtered by root on purpose: a neighbour worktree's bench cannot be stamped dirty
 *  by an edit here, and refusing on it would block every round on this machine whenever any round
 *  is measuring. */
export function benchInFlightRefusal(state: BenchLockState, root: string = REPO_ROOT): string | undefined {
  if (state.state !== 'held') {
    return undefined;
  }
  const mine = state.records.filter((r) => measures(r, root));
  if (mine.length === 0) {
    return undefined;
  }
  return [
    `REFUSED: a bench run is measuring this worktree — ${describe(mine[0], state.path)}`,
    ...mine.slice(1).map((r) => `  and ${describe(r, state.path)}`),
    '',
    'Editing the tree now does not just risk the edit: `provenance.ts` samples git DURING the run',
    'and the sample is STICKY, so one save stamps the whole run dirty and `bench:merge` throws the',
    'numbers away — 39 minutes, after the fact, for a change that was reverted.',
    'Wait for the run (its log ends in an `EXIT=` line), then edit. If the run is dead, the record',
    `names its pid: check, then \`rm ${state.path}/<pid>.json\`.`,
  ].join('\n');
}

/** What this run is: the three facts every verdict below is decided on. */
export interface BenchRunIdentity {
  tiers: readonly string[];
  /** Does it rewrite a tier file whole? `preflight.ts`'s `runIsWholeTier`. */
  whole: boolean;
  root?: string;
}

/** What `bench run` is told when another run makes starting this one a mistake, on either of the
 *  two counts that have actually cost time.
 *
 *  SAME WORKTREE, SAME TIER FILE. A run already in flight here writes `results/<tier>.json`, and so
 *  does this one — including a one-row `--only` run, which rewrites the canonical file with its
 *  handful of rows (`orchestrate.ts`'s `stitch`). The tiers decide it and not "a run is in flight":
 *  a scoped `--tier synthetic --only <sym>` beside a background `--tier real` touches different
 *  files and is the dev loop the house rules and both briefs prescribe.
 *
 *  TWO FULL BENCHES, ANY WORKTREE. The house rule, mechanised: 2,704 s against a neighbour versus
 *  1,800 s solo, and a shard killed by a neighbour writes a partial tier with no error line. Only
 *  whole-tier against whole-tier — a 15 s scoped probe is not what fans 8 shards, and refusing it
 *  because a neighbour is busy would be this guard inventing a rule nobody has an incident for.
 *
 *  AND THERE IS A SANCTIONED DOOR, `--no-lock`. Not because the refusal is doubted: it is right,
 *  and the wait is the correct move. It is here because the alternative door is `rm`ing someone
 *  else's record, which is the one move that can silently unprotect a run still in flight — the
 *  same "one sanctioned name beats an escape hatch" trade `preflight.ts` makes for `.envrc.local`.
 *  A refusal an agent cannot legitimately pass is a refusal it passes illegitimately. */
export function concurrentRunRefusal(state: BenchLockState, run: BenchRunIdentity): string | undefined {
  if (state.state !== 'held') {
    return undefined;
  }
  const root = run.root ?? REPO_ROOT;
  const sameFile = state.records.find(
    (r) => measures(r, root) && (r.tiers.length === 0 || r.tiers.some((t) => run.tiers.includes(t))),
  );
  if (sameFile !== undefined) {
    const shared = sameFile.tiers.filter((t) => run.tiers.includes(t));
    const files = (shared.length > 0 ? shared : run.tiers).map((t) => `apps/benchmark/results/${t}.json`).join(', ');
    return [
      `bench run REFUSED: pid ${sameFile.pid} is already measuring this worktree — ${describe(sameFile, state.path)}`,
      '',
      `Both runs write ${files}, so the second publishes a tier stitched from two`,
      'measurements — a one-row `--only` run rewrites that file too, with its one row.',
      'Wait for it (its log ends in an `EXIT=` line), or run a SCOPED probe (`--only`) on a tier it',
      'is not writing — scoped, because a second WHOLE tier beside this one halves both runs and',
      'can kill a shard with no error line. A separate worktree is the other way.',
      `If that pid is dead: \`rm ${state.path}/${sameFile.pid}.json\`. If you have a reason to`,
      'measure anyway, `--no-lock` says so out loud and leaves every other record alone — never',
      "`rm` a record you did not write, which is the one move that unprotects someone else's run.",
    ].join('\n');
  }
  if (!run.whole) {
    return undefined;
  }
  const otherWhole = state.records.find((r) => r.whole);
  if (otherWhole === undefined) {
    return undefined;
  }
  return [
    `bench run REFUSED: a full bench is already running on this machine — ${describe(otherWhole, state.path)}`,
    `  in ${otherWhole.root ?? 'an unrecorded worktree'}`,
    '',
    'Two full benches must never overlap here: 10 cores, 8 shards each, and one measured 2,704 s',
    'against a neighbour versus 1,800 s solo. Worse than slow — a shard killed by a neighbour',
    'writes a partial tier with NO error line, and `grep -c SKIP` reads 0 either way.',
    'Wait for it, or scope this one (`--only <sym>`, or `--tier` the one it is not writing): a',
    'scoped probe is not refused against a neighbour, only against a run writing the same file.',
    `If that pid is dead: \`rm ${state.path}/${otherWhole.pid}.json\`. If you have a reason to`,
    'measure anyway, `--no-lock` says so out loud and leaves every other record alone.',
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
 *  Never touches another run's record, on either side, and never removes the DIRECTORY: an empty
 *  register costs nothing outside the tree, while removing it would race a neighbour that has just
 *  created it and not yet written into it, throwing ENOENT out of a 35-minute command before it
 *  did any work.
 *
 *  Two runs launched in the same millisecond can both read `free` and both proceed — a read/write
 *  window no reader can close from here. Left open knowingly: with one record per pid the racing
 *  pair only DUPLICATES work, where the single-slot shape had the second run EVICT the first's
 *  protection, and real launches are seconds apart. */
export function acquireBenchLock(command: string, run: BenchRunIdentity, dir: string = BENCH_LOCK_DIR): string {
  const { dead } = scan(dir);
  if (dead.length === 1 && dead[0] === dir) {
    // Something that is not a directory where the register belongs. It names no live run.
    console.error(`[bench lock] cleared a stray \`${dir}\` that is not a directory`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  for (const path of dead) {
    if (path === dir) {
      continue;
    }
    console.error(`[bench lock] cleared a stale record: ${path}`);
    // Recursive because a DIRECTORY named `<pid>.json` reaches this list too, and a plain `rmSync`
    // throws EISDIR on it — which would brick every later run in this register.
    rmSync(path, { recursive: true, force: true });
  }
  const record: BenchLockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command,
    tiers: [...run.tiers],
    root: run.root ?? REPO_ROOT,
    whole: run.whole,
  };
  const path = recordPath(dir, process.pid);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  process.on('exit', () => releaseBenchLock(dir, record.pid));
  return path;
}

/** Remove OUR record. Another run's record is never touched: deleting one would silently unlock a
 *  live run, which is the failure that makes an advisory guard worse than none. */
export function releaseBenchLock(dir: string = BENCH_LOCK_DIR, pid: number = process.pid): void {
  rmSync(recordPath(dir, pid), { recursive: true, force: true });
}

/** `bench in-flight`: the read the tree-editing phases run. Exit 0 = go ahead, 1 = a run is
 *  measuring THIS worktree. A neighbour's run is reported and does not change the verdict — it
 *  cannot be dirtied from here, but a reader deciding whether to start a bench wants to know. */
export function benchLockStatus(dir: string = BENCH_LOCK_DIR, root: string = REPO_ROOT): number {
  const state = readBenchLock(dir);
  const elsewhere = state.state === 'held' ? state.records.filter((r) => !measures(r, root)) : [];
  const note = (): void => {
    for (const r of elsewhere) {
      console.log(
        `(a bench is also running in ${r.root} — ${describe(r, state.path)}; it does not block an edit here,`,
      );
      console.log(' but starting a second FULL bench beside it is refused, and for good reason)');
    }
  };
  const refusal = benchInFlightRefusal(state, root);
  if (refusal !== undefined) {
    console.error(refusal);
    note();
    return 1;
  }
  if (state.state === 'stale') {
    console.log(
      `no bench run in flight — \`${dir}\` holds only records of dead runs (${state.why}). ` +
        `The next \`bench run\` sweeps them; \`rm -r ${dir}\` to be rid of them now.`,
    );
    note();
    return 0;
  }
  console.log(`no bench run is measuring this worktree (no live record in \`${dir}\`) — it is yours to edit.`);
  note();
  return 0;
}
