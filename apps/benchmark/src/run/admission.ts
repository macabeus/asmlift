// May this heavy command START on this machine NOW, given the memory it will need at its peak and the
// memory the machine has to give? One check, called by every heavy entry point: `bench run`,
// `bench fidelity`, `bench fan`, `bench sweep`, and every vitest run (`vitest.memory-admission.ts`,
// a globalSetup of both vitest configs).
//
// WHY. Three heavy jobs, each sane alone, together held 12.36 GB of rss+swap on a 7.5 GiB host with
// 9.5 GiB of swap, and the kernel OOM killer took the desktop session rather than a job
// (docs/bench-cost.md §5). `run/lock.ts`'s register only refuses a second FULL bench, and reads no
// memory.
//
// WHAT IS COUNTED AS AVAILABLE. Linux: `MemAvailable` (the kernel's own estimate of what can be
// allocated without swapping, page cache it can drop included) plus the zram swap's free space
// above half of its size — `max(0, min(Size, MemTotal) / 2 - Used)`, Size and Used summed over the
// ZRAM devices in /proc/swaps. Disk swap counts for nothing. Three readings bound the rule:
//   - Disk swap credited as any share of `SwapTotal` makes admission grow with any swapfile: a
//     16 GiB host with a 32 GiB disk swapfile would admit a `--jobs 6` run, a 7-worker vitest, a
//     `bench fan` and a project sweep together, 27 GB of need on 17 GB of RAM. A job pushed to disk
//     swap stalls the whole host (the rule `default-jobs.ts` keeps for the shard count), so the
//     pages a job needs to run are counted in RAM, or not at all.
//   - No swap at all refuses what runs safely: a solo `bench run --jobs 3` needs 3 × SHARD_BYTES =
//     7.5 GB, and a quiet host here (7.5 GiB of RAM, an 8.1 GB zram device) reads MemAvailable
//     ~5.5 GB. zram is compressed RAM, so part of a swapped page does come back: with half the
//     device credited the quiet reading is 5.5 + 3.96 = 9.45 GB — a solo `--jobs 3` fits and a
//     `--jobs 4` does not, as `default-jobs.ts` would size it. Beside that run at its peak
//     (measured: MemAvailable 0.6 GB, zram 3.4 GB used) it is 0.6 + 0.62 = 1.22 GB, so neither a
//     whole-corpus sweep nor a 3-worker vitest gate is admitted. Half the device and not all of it:
//     all of it reads 5.5 + 8.0 = 13.5 GB quiet, which admits a `--jobs 3` run and a whole `--base`
//     sweep together (10.1 GB of need); and a compressed page still occupies RAM.
//   - The device's size is a setting, not memory: zram-generator takes `zram-size = ram * 2`, and
//     half of a 2 × RAM device on this host's RAM reads 13.6 GB quiet, which admits a `--jobs 5`
//     run (12.5 GB of need, above the 12.36 GB this host OOMed holding) and the run + `--base`
//     sweep pair. What compressed pages can take back is bounded by RAM, so the size counted is
//     at most MemTotal; a device no larger than RAM, as here, reads the same.
// Where /proc/swaps cannot be read, no swap is counted.
// macOS: `vm_stat`'s free, inactive, purgeable and speculative pages — what the kernel hands to a
// new allocation without compressing or swapping anything that is in use. `os.freemem()` alone is
// the free-page count, a few hundred MB on a Mac that is merely in use: it would refuse a 3-worker
// vitest gate and a 1-shard run, and make the door below routine. Counting inactive and purgeable
// is still an under-read — the compressor gives more — which is the direction to be wrong in; it
// has not been measured on a real Mac, and where `vm_stat` cannot be read or parsed the reading
// falls back to `os.freemem()`. No swap: macOS grows its swap on demand, so there is no free-swap
// figure to discount.
// Everything else: `os.freemem()`, no swap.
//
// WHAT IS NEEDED. A per-command peak, as data (`PEAK_BYTES`), each measured one job at a time on an
// otherwise idle host; the figures, dates and commands are in docs/bench-cost.md §5. Plus
// `RESERVE_BYTES`, held back for what is not a heavy job: the session that launched it, an editor,
// the kernel's own growth while the job ramps up.
//
// WHAT IS ALREADY PROMISED. Available memory is read NOW, and a job registered a minute ago is
// still ramping up: a `bench run --jobs 3` measured 2.80 GB over its process tree 919 s in, against
// ~8.0 GB at its peak (docs/bench-cost.md §5). So every job this check admits takes a record
// in `run/lock.ts`'s register carrying the need it was admitted with — a run or a whole-corpus
// sweep as a run or sweep record, every other heavy command as a `kind: 'job'` record, a vitest run
// under vitest's own pid (`vitest.memory-admission.ts`) — and what such a job has not taken yet, its
// need less what its process tree holds now, is subtracted before anything else is admitted. Every
// admitted job, and not only runs: if only some jobs promised, whether a gate and a run are admitted
// together would depend on which started first. The tree
// is read from /proc on Linux and from `ps` where there is no /proc (macOS); a live record whose
// tree cannot be read at all is taken to hold nothing yet, so its whole need is subtracted. A
// record written before records carried a need (a lane on an older base) promises what that
// older `bench run` would have started: unknown is not a clearance, as in `run/lock.ts`.
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
import { cpus, freemem, platform, totalmem } from 'node:os';

import { type BenchLockRecord, type BenchLockState, readBenchLock } from './lock';

/** One shard of `bench run`: its 1.3–1.7 GB peak on the largest fans, with headroom for the compile
 *  workers a big fan forks (`eval/asmlift.ts`'s ROW_COMPILE_WORKERS, and on Linux one worker for
 *  every fan of WORKER_FAN or more). Three shards and their workers were seen holding ~7.6 GB
 *  together, ~2.5 GB each (docs/bench-cost.md §5). */
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
   *  pass's records stay alive, measured 2.39 GB at `--repeat 2` */
  sweepRepeat: 2.5e9,
  /** the floor of a SCOPED sweep's pass, what its process costs before it lifts much: one
   *  synthetic row measured 0.20 GB, one kleod row 0.23 GB */
  sweepScopedPass: 0.3e9,
  /** the same floor with `--base` or `--base-dir`: the parent and the child lifting one side are
   *  alive at once, so the floor is paid twice. One synthetic row against a base tree measured
   *  0.39, 0.41, 0.41 and 0.40 GB, against 0.23 GB without a base. `--repeat` stays in one process:
   *  one row at `--repeat 2` measured 0.23 GB, under the plain floor */
  sweepScopedBasedPass: 0.45e9,
  /** what a SCOPED sweep's pass costs for each real project it lifts a row of: `bench sweep
   *  --project <p> --tier real`, measured per project, plus a tenth. Not a share of the rows: a
   *  real row's price is its project's — the context and symbol map its rows load — so 68
   *  pokeemerald rows (3% of the corpus) cost three quarters of a whole pass. A project not in
   *  this table is priced at `sweepRealProjectUnmeasured`. */
  sweepRealProject: {
    pokeemerald: 1.8e9, // 1.55 / 1.57 / 1.63 GB
    'ac-decomp': 0.75e9, // 0.65 GB
    pikmin: 0.65e9, // 0.56 GB
    marioparty3: 0.6e9, // 0.53 GB
    marioparty4: 0.6e9, // 0.54 GB
    af: 0.55e9, // 0.49 GB
    snowboardkids2: 0.55e9, // 0.47 GB
    kleod: 0.5e9, // 0.42 GB
    sa3: 0.45e9, // 0.39 GB
  } as Readonly<Record<string, number>>,
  /** a real project `sweepRealProject` has no figure for: the dearest one measured */
  sweepRealProjectUnmeasured: 1.8e9,
  /** one published repro script `bench fidelity` runs. The asmlift script re-ranks its row as a
   *  shard does, so it is budgeted as one: the dearest row's script measured 1.53 GB before it
   *  stopped in this host's shell (exit 127, after building its target), a floor and not a peak */
  fidelityScript: SHARD_BYTES,
  /** one vitest worker of the root or matching suite, with its share of the main process: the root
   *  suite at 3 workers measured 2.70 and 2.71 GB, the matching suite at its single fork 0.98 GB
   *  (the Docker containers it starts are not in that tree) */
  vitestWorker: 1.1e9,
} as const;

/** Held back from what is available for everything that is not a heavy job. */
export const RESERVE_BYTES = 0.5e9;

/** The share of each zram device this check lets swap use reach; its free space above that counts
 *  as available. Disk swap counts for nothing. See the header for the two bounds. */
export const SWAP_USE_CAP = 0.5;

/** The environment variable that turns the check off, and the value that does. */
export const ADMISSION_ENV = 'ASMLIFT_MEM_ADMISSION';

export interface MemoryReading {
  /** bytes this check counts as available, before the reserve */
  availableBytes: number;
  /** how that figure was arrived at, for the refusal text */
  how: string;
  /** how many heavy jobs the register holds now; the refusal says to wait only when there is one */
  registeredJobs?: number;
}

const GB = 1e9;
const gb = (b: number): string => `${(b / GB).toFixed(1)} GB`;

/** `/proc/meminfo`'s `MemAvailable` in bytes; undefined when it is not there (a kernel older than
 *  3.14, or not Linux). */
export function parseMeminfo(text: string): number | undefined {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : undefined;
}

/** `/proc/meminfo`'s `MemTotal` in bytes; undefined when it is not there. */
export function parseMemTotal(text: string): number | undefined {
  const m = /^MemTotal:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : undefined;
}

export interface SwapDevice {
  name: string;
  type: string;
  sizeBytes: number;
  usedBytes: number;
}

/** `/proc/swaps`' devices, sizes in bytes. */
export function parseSwaps(text: string): SwapDevice[] {
  const out: SwapDevice[] = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+-?\d+\s*$/.exec(line);
    if (m) {
      out.push({ name: m[1], type: m[2], sizeBytes: Number(m[3]) * 1024, usedBytes: Number(m[4]) * 1024 });
    }
  }
  return out;
}

/** The swap this check counts as available: the zram devices' free space above `SWAP_USE_CAP` of
 *  their summed size, that size taken as at most `memTotalBytes` (RAM bounds what compressed pages
 *  can take back, whatever the devices are set to), and nothing for disk swap (see the header). */
export function zramCredit(
  devices: readonly SwapDevice[],
  memTotalBytes: number,
): { bytes: number; zramBytes: number; diskBytes: number } {
  let zramBytes = 0;
  let zramUsed = 0;
  let diskBytes = 0;
  for (const d of devices) {
    if (/^\/dev\/zram\d+$/.test(d.name)) {
      zramBytes += d.sizeBytes;
      zramUsed += d.usedBytes;
    } else {
      diskBytes += d.sizeBytes;
    }
  }
  const counted = Math.min(zramBytes, memTotalBytes);
  const bytes = Math.max(0, Math.floor(counted * (1 - SWAP_USE_CAP)) - zramUsed);
  return { bytes, zramBytes, diskBytes };
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
  swaps?: () => string;
  vmStat?: () => string;
  freemem?: () => number;
  /** RAM in bytes where /proc/meminfo has no `MemTotal` */
  totalmem?: () => number;
}

/** What this machine has to give a new job, read now. */
export function readAvailableMemory(deps: MemoryDeps = {}): MemoryReading {
  const os = deps.platform ?? platform();
  const free = deps.freemem ?? freemem;
  if (os === 'linux') {
    let memAvailable: number | undefined;
    let memTotal: number | undefined;
    try {
      const text = (deps.meminfo ?? (() => readFileSync('/proc/meminfo', 'utf8')))();
      memAvailable = parseMeminfo(text);
      memTotal = parseMemTotal(text);
    } catch {
      memAvailable = undefined;
    }
    if (memAvailable !== undefined) {
      let swap = { bytes: 0, zramBytes: 0, diskBytes: 0 };
      try {
        swap = zramCredit(
          parseSwaps((deps.swaps ?? (() => readFileSync('/proc/swaps', 'utf8')))()),
          memTotal ?? (deps.totalmem ?? totalmem)(),
        );
      } catch {
        // unreadable: no swap counted
      }
      return {
        availableBytes: memAvailable + swap.bytes,
        how:
          `MemAvailable ${gb(memAvailable)} + ${gb(swap.bytes)} of zram swap (free above ${SWAP_USE_CAP * 100}% of ` +
          `${gb(swap.zramBytes)} of zram, counted up to RAM; ${gb(swap.diskBytes)} of disk swap not counted)`,
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

/** `ps -A -o pid=,ppid=,rss=` (rss in KiB on Linux and macOS alike) as pid → [ppid, bytes]. */
export function parsePsTable(text: string): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) {
      out.set(Number(m[1]), [Number(m[2]), Number(m[3]) * 1024]);
    }
  }
  return out;
}

/** The bytes `pid` and every process descended from it hold: `parents` maps each pid to its
 *  parent, `bytesOf` reads one process. Undefined when `pid` is not in `parents`, or when no
 *  process of the tree could be read (it exited between the two reads). The one walker for both
 *  sources, /proc and `ps`. */
function treeBytes(
  pid: number,
  parents: ReadonlyMap<number, number>,
  bytesOf: (pid: number) => number | undefined,
): number | undefined {
  if (!parents.has(pid)) {
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const [p, ppid] of parents) {
    children.set(ppid, [...(children.get(ppid) ?? []), p]);
  }
  let total = 0;
  let found = false;
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    const p = queue.pop()!;
    if (seen.has(p)) {
      continue;
    }
    seen.add(p);
    const b = bytesOf(p);
    if (b !== undefined) {
      found = true;
      total += b;
    }
    queue.push(...(children.get(p) ?? []));
  }
  return found ? total : undefined;
}

const runPs = (): string => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 5000 });

/** Bytes of anonymous memory plus swap held by `pid` and every process descended from it, read from
 *  Linux /proc (`VmRSS` + `VmSwap`; VmRSS also counts shared file pages, so this over-reads what a
 *  job holds and under-reads what it has still to take). Where there is no
 *  /proc (macOS), from `ps`'s resident sizes, which count no swap. Undefined where neither can be
 *  read or the pid is gone. */
export function processTreeBytes(pid: number, proc: string = '/proc', ps: () => string = runPs): number | undefined {
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    try {
      const table = parsePsTable(ps());
      return treeBytes(pid, new Map([...table].map(([p, [ppid]]) => [p, ppid])), (p) => table.get(p)?.[1]);
    } catch {
      return undefined;
    }
  }
  const parents = new Map<number, number>();
  for (const p of pids) {
    let stat: string;
    try {
      stat = readFileSync(`${proc}/${p}/stat`, 'utf8');
    } catch {
      continue;
    }
    // `pid (comm) state ppid …`: comm may hold spaces and parentheses, so read after the LAST `)`.
    parents.set(Number(p), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
  }
  return treeBytes(pid, parents, (p) => {
    let status: string;
    try {
      status = readFileSync(`${proc}/${p}/status`, 'utf8');
    } catch {
      return undefined;
    }
    let bytes = 0;
    for (const field of ['VmRSS', 'VmSwap']) {
      const m = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, 'm').exec(status);
      bytes += m ? Number(m[1]) * 1024 : 0;
    }
    return bytes;
  });
}

/** What a record written WITHOUT a need promises: one from a lane on a base older than records that
 *  carry one. Only `bench run` took a record there, so it is priced as that `bench run` started —
 *  its `--jobs N`, 1 for `--serial`, and otherwise the default that base computed from physical
 *  memory alone (`min(8, cpus, totalmem / SHARD_BYTES)`), a shard each. A scoped run started fewer
 *  shards, which its record does not say: unknown is not a clearance (`run/lock.ts`), so it is
 *  priced as the most it could have started. */
export function legacyNeedBytes(
  r: Pick<BenchLockRecord, 'command' | 'kind'>,
  host: { cpus: number; totalmem: number } = { cpus: cpus().length, totalmem: totalmem() },
): number {
  if (r.kind === 'sweep') {
    return PEAK_BYTES.sweepBase;
  }
  if (r.kind === 'job') {
    return SHARD_BYTES;
  }
  const jobs = /(?:^|\s)--jobs(?:=|\s+)(\d+)(?=\s|$)/.exec(r.command);
  const n = /(?:^|\s)--serial(?=\s|$)/.test(r.command)
    ? 1
    : jobs
      ? Number(jobs[1])
      : Math.min(8, host.cpus, Math.floor(host.totalmem / SHARD_BYTES));
  return Math.max(1, n) * SHARD_BYTES;
}

/** What the live jobs in the register were admitted with and have not taken yet: each record's
 *  need (`legacyNeedBytes` for one that carries none) less what its process tree holds now. A live
 *  record whose tree cannot be read is taken to hold nothing yet. */
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
    const need = r.needBytes ?? legacyNeedBytes(r);
    const left = Math.max(0, need - (held(r.pid) ?? 0));
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
  let registeredJobs = 0;
  try {
    const state = (deps.lockState ?? readBenchLock)();
    registeredJobs = state.state === 'held' ? state.records.length : 0;
    promised = unspentBudgets(state, deps.held);
  } catch {
    // an unreadable register is reported by `bench run`'s own lock path; here it promises nothing
    promised = { bytes: 0, jobs: 0 };
  }
  if (promised.bytes === 0) {
    return { ...raw, registeredJobs };
  }
  return {
    availableBytes: raw.availableBytes - promised.bytes,
    how: `${raw.how}, less ${gb(promised.bytes)} that ${promised.jobs} registered job${promised.jobs === 1 ? ' has' : 's have'} still to take`,
    registeredJobs,
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
  const jobs = reading.registeredJobs ?? 0;
  const next =
    jobs > 0
      ? `Wait for the ${jobs === 1 ? 'heavy job' : `${jobs} heavy jobs`} registered on this machine to finish ` +
        '(`pnpm bench in-flight`)'
      : 'No heavy job is registered on this machine, so what holds the memory is outside the bench register ' +
        '(`ps -eo pid,rss,args --sort=-rss | head`); free it';
  return [
    `${req.command} REFUSED: it needs ~${gb(req.needBytes)} of memory at its peak (${req.need}),`,
    `and this machine has ${gb(Math.max(0, usable))} to give: ${reading.how}, less a ${gb(reserve)} reserve.`,
    'A job started past what memory and swap can hold is not the one the kernel OOM killer picks:',
    'it can take any process on the machine.',
    '',
    next + (req.instead ? `, or ${req.instead}` : '') + '.',
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

/** The request of `bench run` at `jobs` shards over `rows` rows (undefined for a whole tier, which
 *  has more rows than any `--jobs`): one shard per row up to `jobs`. `fitsNow` is how many shards
 *  the machine could take now, read only when the advice is built. */
export function runRequest(
  jobs: number,
  rows?: number,
  fitsNow: () => number = () => unitsThatFit(SHARD_BYTES),
): AdmissionRequest {
  const shards = Math.max(1, rows === undefined ? jobs : Math.min(jobs, rows));
  const fit = fitsNow();
  return {
    command: 'bench run',
    needBytes: shards * SHARD_BYTES,
    need: `${shards} shard${shards === 1 ? '' : 's'} × ${gb(SHARD_BYTES)}`,
    instead: fit >= 1 ? `run \`--jobs ${fit}\`, which fits now` : 'scope it with `--only`',
  };
}

/** The request of a vitest run at `workers` workers (`vitest.memory-admission.ts`). */
export function vitestRequest(workers: number): AdmissionRequest {
  return {
    command: `vitest (${workers} worker${workers === 1 ? '' : 's'})`,
    needBytes: workers * PEAK_BYTES.vitestWorker,
    need: `${workers} × ${gb(PEAK_BYTES.vitestWorker)} per worker`,
    // Priced at the workers a run is GIVEN, not its file count: a vitest filter is a substring and
    // can match any number of files. `VITEST_MAX_WORKERS` is read by `scripts/gate-vitest.sh` alone;
    // vitest itself reads `--maxWorkers`.
    instead:
      'run fewer workers: `--maxWorkers=1` (through `scripts/gate-vitest.sh`, `VITEST_MAX_WORKERS=1`); a run of one test file loses nothing by it',
  };
}
