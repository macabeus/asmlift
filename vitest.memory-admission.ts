import { rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { TestProject } from 'vitest/node';

import { admissionRefusal, vitestRequest } from './apps/benchmark/src/run/admission';
import { registerHeavyJob } from './apps/benchmark/src/run/lock';

// THE MEMORY ADMISSION CHECK FOR EVERY VITEST RUN, as a globalSetup of both configs. It sits here
// and not in `scripts/gate-vitest.sh` because the gate is one of several ways vitest starts:
// `pnpm test:offline`, `pnpm exec vitest run <file>`, `pnpm --filter <pkg> exec vitest run` (vitest
// finds this config up the tree) and CI's own runs all bypassed a check that lived in the gate. A
// root suite at vitest's default worker count (cpus - 1, 7 on the 8-thread host of the 2026-10-20
// OOM) is priced at 7 GB; nothing priced it before.
//
// A globalSetup runs in vitest's MAIN process before any test file, so the admitted run takes its
// `kind: 'job'` record in the machine-wide register under vitest's own pid: the record lasts exactly
// as long as the job it promises for. Under the gate's shell pid it did not — a TERM to that shell
// skips dash's EXIT trap and orphans vitest, its esbuild service and its workers, still holding and
// growing memory under a record that names a dead pid. Here a killed vitest is a dead pid, and a
// live vitest is a live record. The teardown removes it at once on a normal exit.
//
// A refusal throws, and vitest exits without running a test; the text is admission.ts's, with the
// numbers and the way forward. `ASMLIFT_MEM_ADMISSION=off` skips it, saying so.

/** The workers this run starts, as vitest's pools resolve it (`maxForks`/`maxThreads`, then
 *  `maxWorkers`, then cpus - 1, or half the cpus in watch mode); one for a single fork or thread. */
export function vitestWorkers(config: TestProject['vitest']['config'], cpus: number = availableParallelism()): number {
  const pool = config.pool === 'threads' || config.pool === 'vmThreads' ? 'threads' : 'forks';
  const opts = (config.poolOptions?.[pool] ?? {}) as {
    singleFork?: boolean;
    singleThread?: boolean;
    maxForks?: number | string;
    maxThreads?: number | string;
  };
  if (opts.singleFork === true || opts.singleThread === true || config.fileParallelism === false) {
    return 1;
  }
  const max = pool === 'threads' ? opts.maxThreads : opts.maxForks;
  const n = Number(max ?? config.maxWorkers ?? (config.watch ? Math.floor(cpus / 2) : cpus - 1));
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : Math.max(1, cpus - 1);
}

export default function setup(project: TestProject): (() => void) | undefined {
  const req = vitestRequest(vitestWorkers(project.vitest.config));
  const refusal = admissionRefusal(req);
  if (refusal !== undefined) {
    throw new Error(`[memory admission] ${refusal}`);
  }
  const record = registerHeavyJob(`vitest ${process.argv.slice(2).join(' ')}`.trim(), req.needBytes, process.pid);
  return () => rmSync(record, { force: true });
}
