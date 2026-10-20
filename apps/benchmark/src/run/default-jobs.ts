// How many shards `bench run` and `bench fidelity` start when no `--jobs` is given.
import { cpus, totalmem } from 'node:os';

import { type MemoryReading, SHARD_BYTES, readAdmissibleMemory, unitsThatFit } from './admission';

export { SHARD_BYTES };

export const MAX_DEFAULT_JOBS = 8;

// Fewest of the cap, the CPU count, what physical memory holds at SHARD_BYTES each, and what the
// machine has AVAILABLE NOW holds at SHARD_BYTES each after admission.ts's reserve — and at least 1.
//
// The physical-memory bound came first: 8 shards on a host with 7.5 GiB of RAM exhausted it and
// 9.5 GiB of swap, and the kernel OOM killer took the desktop session's D-Bus, not a shard. It
// stays, because a host with a large swap would otherwise be handed more shards than RAM can run
// without stalling. It gave 3 here, and at the 2026-10-20 13:18 OOM those 3 shards and their
// workers held ~7.6 GB — the per-shard budget held. What dividing physical memory left out was
// everything else on the machine: the desktop, the session that launched the run, another round's
// sweep. So the available-memory bound: a default run beside a heavy job starts fewer shards, and
// a default run on this host quiet starts the same 3 as before.
//
// At least 1 even when not one shard fits: the run's own admission check is what refuses then, with
// the numbers, rather than a 0 here that `cli.ts` would read as a bad `--jobs`.
export const defaultJobs = (
  cpuCount = cpus().length,
  memBytes = totalmem(),
  available: MemoryReading = readAdmissibleMemory(),
): number =>
  Math.max(
    1,
    Math.min(MAX_DEFAULT_JOBS, cpuCount, Math.floor(memBytes / SHARD_BYTES), unitsThatFit(SHARD_BYTES, available)),
  );
