// May this heavy command START on this machine NOW, given the memory it will need at its peak and the
// memory the machine has to give? One check, called by every heavy entry point: `bench run`,
// `bench fidelity`, `bench fan`, `bench sweep`, and the vitest gate (`scripts/gate-vitest.sh`,
// through this file's `main`).
//
// THE INCIDENT. On 2026-10-20 at 13:18 a 7.5 GiB host with 9.5 GiB of swap ran out of both, and the
// kernel OOM killer took down the user's desktop session along with every job on it. Its table
// counted 22 node processes holding 12.36 GB of rss+swap: a `bench run --jobs 3` (~8.0 GB), a
// whole-corpus `bench sweep --base` (~3.7 GB) and an orphaned `bench fan --show` loop (~0.7 GB).
// Each of the three was a sane command alone; nothing in the harness asked what the others held.
// `run/lock.ts`'s register refuses a second FULL bench, but only `bench run` read it, and no
// command read memory at all.
//
// WHAT IS COUNTED AS AVAILABLE. Linux: `MemAvailable` (the kernel's own estimate of what can be
// allocated without swapping, page cache it can drop included) plus the free swap ABOVE HALF of
// `SwapTotal` — swap use is capped at half the device, so `max(0, SwapFree - SwapTotal / 2)`. The
// cap is bounded on both sides by what this host has measured:
//   - NO cap admits the incident. A quiet host here reads MemAvailable ~5.5 GB and SwapFree
//     ~10.1 GB of ~10.2 GB; counted whole, that is 15.6 GB, which admits the run and the sweep
//     together (11.2 GB of need) — the pair that died.
//   - NO swap at all refuses what has run safely for weeks: a solo `bench run --jobs 3` needs
//     3 × SHARD_BYTES = 7.5 GB, and MemAvailable alone is 5.5 GB.
//   - Capped at half: quiet, 5.5 + 5.0 = 10.5 GB, and the solo run fits. Beside that run at its
//     peak (measured 2026-10-20: MemAvailable 0.6 GB, SwapFree 6.8 GB) it is 0.6 + 1.7 = 2.3 GB,
//     so neither the 13:18 sweep nor a 3-worker vitest gate is admitted. Half of what is FREE, the
//     first cut of this check, read 0.6 + 3.4 = 4.0 GB there and admitted the gate: a discount of
//     the free swap keeps halving, never reaching the end of the device. On zram, this host's main
//     swap, the cap also has a physical reading: compressed pages still occupy RAM, so a swapped
//     byte is not a free byte.
// macOS: `vm_stat`'s free, inactive, purgeable and speculative pages — what the kernel hands to a
// new allocation without compressing or swapping anything that is in use. `os.freemem()` alone is
// the free-page count, which on a Mac that is merely in use is a few hundred MB: priced against it,
// the 3-worker vitest gate and a 1-shard run were both refused (a reading of 1.0 GB), and the door
// below would have become routine. Counting inactive and purgeable is still an under-read — the
// compressor gives more — which is the direction to be wrong in; it has not been measured on a real
// Mac, and where `vm_stat` cannot be read or parsed the reading falls back to `os.freemem()`. No
// swap: macOS grows its swap on demand, so there is no free-swap figure to discount.
// Everything else: `os.freemem()`, no swap.
//
// WHAT IS NEEDED. A per-command peak, as data (`PEAK_BYTES`), each measured one job at a time on an
// otherwise idle host; the figures, dates and commands are in docs/bench-cost.md §5. Plus
// `RESERVE_BYTES`, held back for what is not a heavy job: the session that launched it, an editor,
// the kernel's own growth while the job ramps up.
//
// WHAT IS ALREADY PROMISED. Available memory is read NOW, and a job registered a minute ago is
// still ramping up: a `bench run --jobs 3` measured 2.80 GB over its process tree 919 s in, against
// ~8.0 GB at the 13:18 OOM (docs/bench-cost.md §5). So every job this check admits takes a record
// in `run/lock.ts`'s register carrying the need it was admitted with — a run or a whole-corpus
// sweep as before, every other heavy command as a `kind: 'job'` record, the vitest gate under its
// shell's pid — and what such a job has not taken yet, its need less what its process tree holds
// now, is subtracted before anything else is admitted. Every admitted job, and not only runs: a
// promise only some jobs make protects only the jobs started after them, and whether a gate and a
// run were admitted together then depended on which started first. On Linux the tree is read
// from /proc; where it cannot be read, nothing is subtracted, which is this check without the
// correction, never a stricter one.
//
// REFUSE, NOT WAIT. Like the register, this decides and says why; it does not queue. A waiting job
// holds a terminal and a lane hostage on a condition nobody can see, while a refusal names the
// numbers and the next move — wait, lower `--jobs`, or scope the command.
//
// THE DOOR. `ASMLIFT_MEM_ADMISSION=off` skips the check and says so on stderr: the same reasoning as
// `--no-lock` in `run/lock.ts` — a refusal nobody can legitimately pass gets passed illegitimately.
// It is a door for a host whose reading is wrong (a container whose /proc/meminfo is the host's),
// not for running two heavy jobs at once.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { cpus, freemem, platform } from 'node:os';
import { pathToFileURL } from 'node:url';

import { type BenchLockState, readBenchLock, registerHeavyJob } from './lock';

/** One shard of `bench run`: its 1.3–1.7 GB peak on the largest fans, with headroom for the compile
 *  workers a big fan forks (`eval/asmlift.ts`'s ROW_COMPILE_WORKERS, and on Linux one worker for
 *  every fan of WORKER_FAN or more). At the 13:18 OOM three shards and their workers held ~7.6 GB,
 *  so ~2.5 GB each: this budget held. What failed was the divisor, not the budget (see
 *  `default-jobs.ts`). */
export const SHARD_BYTES = 2.5e9;

/** The peak of each heavy unit, in bytes of anonymous memory plus swap over the whole process tree,
 *  each a little above what was measured. docs/bench-cost.md §5 carries the measured figure, its
 *  date and the command behind each one. */
export const PEAK_BYTES = {
  /** a `bench run` shard; one shard ranking the corpus's dearest row measured 1.95 GB */
  shard: SHARD_BYTES,
  /** `bench fan <row>`: one row ranked or enumerated in one process, which is what a shard does
   *  with it, so it is budgeted as one shard. The dearest row's fan measured 1.77 GB */
  fan: SHARD_BYTES,
  /** one lift pass of `bench sweep` over the whole corpus, both map modes: measured 2.07 GB */
  sweepPass: 2.2e9,
  /** a whole-corpus `bench sweep --base`: one pass in a child while the parent holds both sides'
   *  records, measured 2.49 GB */
  sweepBase: 2.6e9,
  /** a whole-corpus `bench sweep --repeat N`: every later pass in this process while the first
   *  pass's records stay alive, measured 2.32 GB at `--repeat 2` */
  sweepRepeat: 2.5e9,
  /** the floor of a SCOPED sweep's pass: one row measured 0.25 GB */
  sweepScopedPass: 0.3e9,
  /** one published repro script `bench fidelity` runs. The asmlift script re-ranks its row as a
   *  shard does, so it is budgeted as one: the dearest row's script measured 1.53 GB before it
   *  stopped in this host's shell (exit 127, after building its target), a floor and not a peak */
  fidelityScript: SHARD_BYTES,
  /** one vitest worker of the root or matching suite, with its share of the main process: the root
   *  suite at 3 workers measured 2.70 GB */
  vitestWorker: 1.0e9,
} as const;

/** Held back from what is available for everything that is not a heavy job. */
export const RESERVE_BYTES = 0.5e9;

/** The share of `SwapTotal` this check lets swap use reach; free swap above it counts as available.
 *  See the header for the two measured bounds. */
export const SWAP_USE_CAP = 0.5;

/** The environment variable that turns the check off, and the value that does. */
export const ADMISSION_ENV = 'ASMLIFT_MEM_ADMISSION';

export interface MemoryReading {
  /** bytes this check counts as available, before the reserve */
  availableBytes: number;
  /** how that figure was arrived at, for the refusal text */
  how: string;
}

const GB = 1e9;
const gb = (b: number): string => `${(b / GB).toFixed(1)} GB`;

/** `/proc/meminfo`'s `MemAvailable` and `SwapFree`, in bytes; undefined when `MemAvailable` is not
 *  there (a kernel older than 3.14, or not Linux). */
export function parseMeminfo(text: string): { memAvailable: number; swapFree: number; swapTotal: number } | undefined {
  const field = (name: string): number | undefined => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const memAvailable = field('MemAvailable');
  if (memAvailable === undefined) {
    return undefined;
  }
  return { memAvailable, swapFree: field('SwapFree') ?? 0, swapTotal: field('SwapTotal') ?? 0 };
}

/** `vm_stat`'s free + inactive + purgeable + speculative pages, in bytes; undefined when the page
 *  size or the free count is not there. */
export function parseVmStat(text: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(text);
  const pages = (name: string): number | undefined => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const free = pages('free');
  if (size === null || free === undefined) {
    return undefined;
  }
  const n = free + (pages('inactive') ?? 0) + (pages('purgeable') ?? 0) + (pages('speculative') ?? 0);
  return n * Number(size[1]);
}

export interface MemoryDeps {
  platform?: string;
  meminfo?: () => string;
  vmStat?: () => string;
  freemem?: () => number;
}

/** What this machine has to give a new job, read now. */
export function readAvailableMemory(deps: MemoryDeps = {}): MemoryReading {
  const os = deps.platform ?? platform();
  const free = deps.freemem ?? freemem;
  if (os === 'linux') {
    let parsed: ReturnType<typeof parseMeminfo>;
    try {
      parsed = parseMeminfo((deps.meminfo ?? (() => readFileSync('/proc/meminfo', 'utf8')))());
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const swap = Math.max(0, parsed.swapFree - Math.floor(parsed.swapTotal * SWAP_USE_CAP));
      return {
        availableBytes: parsed.memAvailable + swap,
        how:
          `MemAvailable ${gb(parsed.memAvailable)} + ${gb(swap)} of swap (SwapFree ${gb(parsed.swapFree)} ` +
          `above ${SWAP_USE_CAP * 100}% of SwapTotal ${gb(parsed.swapTotal)})`,
      };
    }
  }
  if (os === 'darwin') {
    let bytes: number | undefined;
    try {
      bytes = parseVmStat((deps.vmStat ?? (() => execFileSync('vm_stat', { encoding: 'utf8', timeout: 5000 })))());
    } catch {
      bytes = undefined;
    }
    if (bytes !== undefined) {
      return {
        availableBytes: bytes,
        how: `free + inactive + purgeable + speculative ${gb(bytes)} (vm_stat, no swap counted)`,
      };
    }
  }
  const f = free();
  return { availableBytes: f, how: `free memory ${gb(f)} (os.freemem(), no swap counted)` };
}

/** Bytes of anonymous memory plus swap held by `pid` and every process descended from it, read from
 *  Linux /proc (`VmRSS` + `VmSwap`; VmRSS also counts shared file pages, so this over-reads what a
 *  job holds and under-reads what it has still to take — the lenient side, deliberately, since
 *  the correction is additive to a check that was already sound without it). Undefined where /proc
 *  cannot be read or the pid is gone. */
export function processTreeBytes(pid: number, proc: string = '/proc'): number | undefined {
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const p of pids) {
    let stat: string;
    try {
      stat = readFileSync(`${proc}/${p}/stat`, 'utf8');
    } catch {
      continue;
    }
    // `pid (comm) state ppid …`: comm may hold spaces and parentheses, so read after the LAST `)`.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!children.has(ppid)) {
      children.set(ppid, []);
    }
    children.get(ppid)!.push(Number(p));
  }
  let total = 0;
  let found = false;
  const queue = [pid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const p = queue.pop()!;
    if (seen.has(p)) {
      continue;
    }
    seen.add(p);
    let status: string;
    try {
      status = readFileSync(`${proc}/${p}/status`, 'utf8');
    } catch {
      continue;
    }
    found = true;
    for (const field of ['VmRSS', 'VmSwap']) {
      const m = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, 'm').exec(status);
      total += m ? Number(m[1]) * 1024 : 0;
    }
    queue.push(...(children.get(p) ?? []));
  }
  return found ? total : undefined;
}

/** What the live jobs in the register were admitted with and have not taken yet. A record with no
 *  `needBytes` (written before records carried one) and a job whose tree cannot be read add
 *  nothing. */
export function unspentBudgets(
  state: BenchLockState,
  held: (pid: number) => number | undefined = processTreeBytes,
): { bytes: number; jobs: number } {
  if (state.state !== 'held') {
    return { bytes: 0, jobs: 0 };
  }
  let bytes = 0;
  let jobs = 0;
  for (const r of state.records) {
    if (r.needBytes === undefined) {
      continue;
    }
    const h = held(r.pid);
    if (h === undefined) {
      continue;
    }
    const left = Math.max(0, r.needBytes - h);
    if (left > 0) {
      bytes += left;
      jobs++;
    }
  }
  return { bytes, jobs };
}

export interface AdmissibleDeps extends MemoryDeps {
  lockState?: () => BenchLockState;
  held?: (pid: number) => number | undefined;
}

/** What is available now, less what the registered jobs have still to take: the figure every
 *  admission decision and the default shard count read. */
export function readAdmissibleMemory(deps: AdmissibleDeps = {}): MemoryReading {
  const raw = readAvailableMemory(deps);
  let promised: { bytes: number; jobs: number };
  try {
    promised = unspentBudgets((deps.lockState ?? readBenchLock)(), deps.held);
  } catch {
    // an unreadable register is reported by `bench run`'s own lock path; here it promises nothing
    promised = { bytes: 0, jobs: 0 };
  }
  if (promised.bytes === 0) {
    return raw;
  }
  return {
    availableBytes: raw.availableBytes - promised.bytes,
    how: `${raw.how}, less ${gb(promised.bytes)} that ${promised.jobs} registered job${promised.jobs === 1 ? ' has' : 's have'} still to take`,
  };
}

/** What a command says about itself: its name, its peak need, and how that need was composed. */
export interface AdmissionRequest {
  command: string;
  needBytes: number;
  /** e.g. `3 shards × 2.5 GB` */
  need: string;
  /** what to do instead, besides waiting: lower `--jobs`, scope it */
  instead?: string;
}

/** Refusal text, or undefined when the request fits. Pure: the caller supplies the reading. */
export function admissionVerdict(
  req: AdmissionRequest,
  reading: MemoryReading,
  reserve: number = RESERVE_BYTES,
): string | undefined {
  const usable = reading.availableBytes - reserve;
  if (req.needBytes <= usable) {
    return undefined;
  }
  return [
    `${req.command} REFUSED: it needs ~${gb(req.needBytes)} of memory at its peak (${req.need}),`,
    `and this machine has ${gb(Math.max(0, usable))} to give: ${reading.how}, less a ${gb(reserve)} reserve.`,
    '',
    'Starting it anyway is how the 2026-10-20 13:18 OOM happened: three heavy jobs, each sane alone,',
    "and the kernel's OOM killer took the user's desktop session, not one of them.",
    'Wait for the other heavy job on this machine to finish (`pnpm bench in-flight`; `ps -eo pid,rss,args',
    '--sort=-rss | head`)' + (req.instead ? `, or ${req.instead}` : '') + '.',
    `If this reading is wrong for this host (a container reading the host's /proc/meminfo), ${ADMISSION_ENV}=off`,
    'skips the check and says so — never to run two heavy jobs at once.',
  ].join('\n');
}

export interface AdmitDeps extends AdmissibleDeps {
  env?: NodeJS.ProcessEnv;
  warn?: (s: string) => void;
}

/** The entry point every heavy command calls: the refusal text, or undefined to go ahead. */
export function admissionRefusal(req: AdmissionRequest, deps: AdmitDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  if ((env[ADMISSION_ENV] ?? '').toLowerCase() === 'off') {
    (deps.warn ?? ((s: string) => console.error(s)))(
      `[admission] ${ADMISSION_ENV}=off: ${req.command} starts without checking that this machine can hold ` +
        `its ~${gb(req.needBytes)} peak (${req.need}). You said so.`,
    );
    return undefined;
  }
  return admissionVerdict(req, readAdmissibleMemory(deps));
}

/** How many units of `perUnit` bytes fit in what is available now, less the reserve. */
export function unitsThatFit(perUnit: number, reading: MemoryReading = readAdmissibleMemory()): number {
  return Math.max(0, Math.floor((reading.availableBytes - RESERVE_BYTES) / perUnit));
}

/** The request of the vitest gate at `workers` workers. */
export function vitestRequest(workers: number): AdmissionRequest {
  return {
    command: `vitest (${workers} worker${workers === 1 ? '' : 's'})`,
    needBytes: workers * PEAK_BYTES.vitestWorker,
    need: `${workers} × ${gb(PEAK_BYTES.vitestWorker)} per worker`,
    // A one-file run is priced at the workers it is GIVEN, not the file count: a vitest filter is a
    // substring, and one can name any number of files. So the advice is the worker count, which a
    // one-file run loses nothing by.
    instead: 'run fewer workers (`VITEST_MAX_WORKERS=1`; a run of one test file loses nothing by it)',
  };
}

/** `scripts/gate-vitest.sh`'s entry point: `admission.ts vitest <workers|default> [<pid>]`. Exit 0 =
 *  go, 2 = refused (the gate script's own "did not run" code). One copy of the math, here.
 *
 *  With `<pid>` — the gate's own shell, which lives as long as its vitest run — an admitted run
 *  takes a `kind: 'job'` record under that pid, and its path is the one line printed on stdout,
 *  for the gate to remove when it exits. This process exits before vitest starts, so a record under
 *  its own pid would read stale at once and promise nothing. */
function main(argv: readonly string[]): number {
  const [what, n, pidArg] = argv;
  if (what !== 'vitest' || (pidArg !== undefined && !/^[1-9]\d*$/.test(pidArg))) {
    console.error('usage: admission.ts vitest <workers|default> [<pid>]');
    return 2;
  }
  // vitest's own default is (cpus - 1); anything that is not a plain integer (a `50%`) is priced at
  // that, the most it can mean.
  const workers = /^\d+$/.test(n ?? '') ? Math.max(1, Number(n)) : Math.max(1, cpus().length - 1);
  const req = vitestRequest(workers);
  const refusal = admissionRefusal(req);
  if (refusal !== undefined) {
    console.error(refusal);
    return 2;
  }
  if (pidArg !== undefined) {
    console.log(registerHeavyJob(`gate-vitest ${req.command}`, req.needBytes, Number(pidArg)));
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
