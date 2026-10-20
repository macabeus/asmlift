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
// allocated without swapping, page cache it can drop included) plus HALF of `SwapFree`. The half is
// bounded on both sides by what this host has measured:
//   - ALL of the swap admits the incident. A quiet host here reads MemAvailable ~5.5 GB and SwapFree
//     ~10.1 GB; counted whole, that is 15.6 GB, which admits the run and the sweep together (11.2 GB
//     of need) — the pair that died.
//   - NONE of the swap refuses what has run safely for weeks: a solo `bench run --jobs 3` needs
//     3 × SHARD_BYTES = 7.5 GB, and MemAvailable alone is 5.5 GB.
//   - HALF gives 5.5 + 5.1 = 10.6 GB: the solo run fits, and the sweep beside it (2.6 GB left)
//     does not. On zram — this host's main swap device — the half also has a physical reading:
//     compressed pages still occupy RAM, so a swapped byte is not a free byte.
// macOS and everything else: `os.freemem()`, and no swap. On macOS that is the free-page count,
// which leaves out inactive and purgeable memory the system would hand over, so it under-reads —
// the direction to be wrong in. macOS grows its swap on demand, so there is no free-swap figure to
// discount.
//
// WHAT IS NEEDED. A per-command peak, as data (`PEAK_BYTES`), each measured one job at a time on an
// otherwise idle host; the figures, dates and commands are in docs/bench-cost.md §5. Plus
// `RESERVE_BYTES`, held back for what is not a heavy job: the session that launched it, an editor,
// the kernel's own growth while the job ramps up.
//
// REFUSE, NOT WAIT. Like the register, this decides and says why; it does not queue. A waiting job
// holds a terminal and a lane hostage on a condition nobody can see, while a refusal names the
// numbers and the next move — wait, lower `--jobs`, or scope the command.
//
// THE DOOR. `ASMLIFT_MEM_ADMISSION=off` skips the check and says so on stderr: the same reasoning as
// `--no-lock` in `run/lock.ts` — a refusal nobody can legitimately pass gets passed illegitimately.
// It is a door for a host whose reading is wrong (a container whose /proc/meminfo is the host's),
// not for running two heavy jobs at once.
import { readFileSync } from 'node:fs';
import { cpus, freemem, platform } from 'node:os';
import { pathToFileURL } from 'node:url';

/** One shard of `bench run`: its 1.3–1.7 GB peak on the largest fans, with headroom for the compile
 *  workers a big fan forks (`eval/asmlift.ts`'s ROW_COMPILE_WORKERS, and on Linux one worker for
 *  every fan of WORKER_FAN or more). At the 13:18 OOM three shards and their workers held ~7.6 GB,
 *  so ~2.5 GB each: this budget held. What failed was the divisor, not the budget (see
 *  `default-jobs.ts`). */
export const SHARD_BYTES = 2.5e9;

/** The measured peak of each heavy unit, in bytes of anonymous memory plus swap over the whole
 *  process tree. docs/bench-cost.md §5 carries the date and command behind each one. */
export const PEAK_BYTES = {
  /** a `bench run` shard ranking the corpus's dearest row */
  shard: SHARD_BYTES,
  /** `bench fan <row>`: one row ranked or enumerated in one process, exactly what a shard does with
   *  it — so budgeted as one shard rather than as a second, smaller figure that would have to be
   *  re-measured every time the largest fan grows */
  fan: SHARD_BYTES,
  /** one lift pass of `bench sweep` over the whole corpus, both map modes */
  sweepPass: 2.1e9,
  /** one lift pass of a SCOPED `bench sweep` (`--only`/`--project`/`--asm-dir`) */
  sweepScopedPass: 0.3e9,
  /** one published repro script `bench fidelity` runs (an `asmlift` or `m2c` invocation and its
   *  compile) */
  fidelityScript: 0.5e9,
  /** one vitest worker of the root or matching suite, plus its share of the main process */
  vitestWorker: 1.0e9,
} as const;

/** Held back from what is available for everything that is not a heavy job. */
export const RESERVE_BYTES = 0.5e9;

/** How much of the free swap counts as available — see the header for the two measured bounds. */
export const SWAP_DISCOUNT = 0.5;

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
export function parseMeminfo(text: string): { memAvailable: number; swapFree: number } | undefined {
  const field = (name: string): number | undefined => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const memAvailable = field('MemAvailable');
  if (memAvailable === undefined) {
    return undefined;
  }
  return { memAvailable, swapFree: field('SwapFree') ?? 0 };
}

export interface MemoryDeps {
  platform?: string;
  meminfo?: () => string;
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
      const swap = Math.floor(parsed.swapFree * SWAP_DISCOUNT);
      return {
        availableBytes: parsed.memAvailable + swap,
        how: `MemAvailable ${gb(parsed.memAvailable)} + ${SWAP_DISCOUNT * 100}% of SwapFree ${gb(parsed.swapFree)}`,
      };
    }
  }
  const f = free();
  return { availableBytes: f, how: `free memory ${gb(f)} (os.freemem(), no swap counted)` };
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

export interface AdmitDeps extends MemoryDeps {
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
  return admissionVerdict(req, readAvailableMemory(deps));
}

/** How many units of `perUnit` bytes fit in what is available now, less the reserve. */
export function unitsThatFit(perUnit: number, reading: MemoryReading = readAvailableMemory()): number {
  return Math.max(0, Math.floor((reading.availableBytes - RESERVE_BYTES) / perUnit));
}

/** The request of the vitest gate at `workers` workers. */
export function vitestRequest(workers: number): AdmissionRequest {
  return {
    command: `vitest (${workers} worker${workers === 1 ? '' : 's'})`,
    needBytes: workers * PEAK_BYTES.vitestWorker,
    need: `${workers} × ${gb(PEAK_BYTES.vitestWorker)} per worker`,
    instead: 'run fewer workers (`VITEST_MAX_WORKERS=1`), or one test file',
  };
}

/** `scripts/gate-vitest.sh`'s entry point: `admission.ts vitest <workers|default>`. Exit 0 = go,
 *  2 = refused (the gate script's own "did not run" code). One copy of the math, here. */
function main(argv: readonly string[]): number {
  const [what, n] = argv;
  if (what !== 'vitest') {
    console.error('usage: admission.ts vitest <workers|default>');
    return 2;
  }
  // vitest's own default is (cpus - 1); anything that is not a plain integer (a `50%`) is priced at
  // that, the most it can mean.
  const workers = /^\d+$/.test(n ?? '') ? Math.max(1, Number(n)) : Math.max(1, cpus().length - 1);
  const refusal = admissionRefusal(vitestRequest(workers));
  if (refusal !== undefined) {
    console.error(refusal);
    return 2;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
