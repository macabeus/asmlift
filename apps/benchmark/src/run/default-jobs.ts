// How many shards `bench run` and `bench fidelity` start when no `--jobs` is given.
import { cpus, totalmem } from 'node:os';

// The memory budgeted per shard: its 1.3–1.7 GB peak on the largest fans (README), with headroom
// for the compile workers a big fan forks. 8 shards on a host with 7.5 GiB of RAM exhausted it
// and 9.5 GiB of swap, and the kernel OOM killer took the desktop session's D-Bus, not a shard.
export const SHARD_BYTES = 2.5e9;

export const MAX_DEFAULT_JOBS = 8;

// Fewest of the cap, the CPU count and what physical memory holds at SHARD_BYTES each, and at
// least 1. Only physical memory is divided: a shard pushed into swap stalls the whole host.
export const defaultJobs = (cpuCount = cpus().length, memBytes = totalmem()): number =>
  Math.max(1, Math.min(MAX_DEFAULT_JOBS, cpuCount, Math.floor(memBytes / SHARD_BYTES)));
