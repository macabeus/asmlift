// How many shards `bench run` and `bench fidelity` start when no `--jobs` is given.
import { cpus, totalmem } from 'node:os';

// One shard's peak footprint, RAM plus swap. Measured on a full real-tier run: each of 8 shards
// reached 1.2–1.6 GB, and 8 of them exhausted 7.5 GiB of RAM and 9.5 GiB of swap. The kernel OOM
// killer then took the desktop session's D-Bus, not a shard, and logged the user out.
export const SHARD_BYTES = 2.5e9;

export const MAX_DEFAULT_JOBS = 8;

// Fewest of the cap, the CPU count and what physical memory holds at SHARD_BYTES each, and at
// least 1. Swap is not counted, because a shard pushed into swap stalls the whole host.
export const defaultJobs = (cpuCount = cpus().length, memBytes = totalmem()): number =>
  Math.max(1, Math.min(MAX_DEFAULT_JOBS, cpuCount, Math.floor(memBytes / SHARD_BYTES)));
