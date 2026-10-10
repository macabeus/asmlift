// A row's candidate compiles in worker PROCESSES, for the ranked driver (cli
// `decompileRankedParallel`). The harness's compile ladders are synchronous — each rung a blocking
// spawn — so a compiler that runs beside others needs a thread of control of its own; the ranking
// itself stays in this process, over the same enumeration and the same memoized scores, so the
// winner, the tie-breaks, the dropped list and the stillborn verdict are a one-worker ranking's.
//
// PROCESSES, NOT THREADS: a spawn costs what its parent weighs. Linux libuv starts every child with
// fork(), which copies the parent's page tables — measured from Node 24, 1.3 ms from a 50 MB
// process, 3 ms from this worker (~210 MB) and 50 ms from a `bench run` shard (~1.3 GB), where a
// worker THREAD spawns from too. An agbcc candidate is three spawns (cpp, agbcc, as), so from the
// shard it paid ~150 ms of page-table copying around ~50 ms of compiling.
import { absorbCacheStats, cacheSampleSeed } from '@asmlift/cli/candcache';
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./compile-worker.ts', import.meta.url));

/** A worker process loads TypeScript the way this process does: a `bench run` shard runs under tsx,
 *  whose loader it hands on; a process that did not load it (vitest) hands it over. */
const WORKER_EXEC_ARGV = process.execArgv.some((a) => a.includes('tsx'))
  ? process.execArgv
  : [...process.execArgv, '--import', 'tsx'];

/** The row a worker rebuilds its case from. */
export interface RowRef {
  tier: 'synthetic' | 'real';
  id: string;
  sym: string;
}

export type CompileRequest =
  | { kind: 'compile'; seq: number; source: string; symbol: string; backendId: string; declarations?: string }
  | { kind: 'stats' };

export type CompileReply =
  | { kind: 'object'; seq: number; obj: string }
  | { kind: 'error'; seq: number; message: string; diagnostic?: string }
  | { kind: 'stats'; stats: Record<string, number> };

/** A compile worker died: the harness failed, not a candidate, and the row fails its evaluation. */
export class CompilePoolDied extends Error {}

/** A pool of compile workers for one row: `worker()` starts one, `close()` collects every worker's
 *  candidate-cache counters into this process's and stops them.
 *
 *  A worker that dies is a HARNESS failure, never a candidate's: the compiles it held reject, and
 *  `close()` throws, so the row fails its evaluation instead of ranking over candidates a crash
 *  refused. */
export function compilePool(row: RowRef): { worker: () => CandidateCompiler; close: () => Promise<void> } {
  const threads: ChildProcess[] = [];
  let seq = 0;
  let closing = false;
  let failure: CompilePoolDied | undefined;
  const worker = (): CandidateCompiler => {
    const t = fork(WORKER, [JSON.stringify(row)], {
      execArgv: WORKER_EXEC_ARGV,
      // the process's audit sample, so the `[candcache]` line's `seed=` replays every worker's
      env: { ...process.env, ASMLIFT_CANDCACHE_SAMPLE_SEED: cacheSampleSeed() },
    });
    threads.push(t);
    const waiting = new Map<number, { resolve: (obj: string) => void; reject: (e: Error) => void }>();
    let died: Error | undefined;
    const die = (e: Error): void => {
      died ??= e;
      failure ??= new CompilePoolDied(`compile worker for ${row.id} died: ${e.message}`, { cause: e });
      for (const w of waiting.values()) {
        w.reject(failure);
      }
      waiting.clear();
    };
    t.on('message', (m: CompileReply) => {
      if (m.kind === 'stats') {
        return;
      }
      const w = waiting.get(m.seq);
      waiting.delete(m.seq);
      if (m.kind === 'object') {
        w?.resolve(m.obj);
      } else {
        w?.reject(m.diagnostic === undefined ? new Error(m.message) : new CompilerRejection(m.message, m.diagnostic));
      }
    });
    t.on('error', die);
    t.on('exit', (code, signal) => {
      if (!closing) {
        die(new Error(`exited with ${signal ?? `code ${code}`}`));
      }
    });
    return (source, symbol, backendId, declarations) =>
      new Promise<string>((resolve, reject) => {
        if (died !== undefined) {
          reject(failure);
          return;
        }
        const n = ++seq;
        waiting.set(n, { resolve, reject });
        const req: CompileRequest = {
          kind: 'compile',
          seq: n,
          source,
          symbol,
          backendId,
          ...(declarations === undefined ? {} : { declarations }),
        };
        t.send(req);
      });
  };
  const close = async (): Promise<void> => {
    closing = true;
    if (failure !== undefined) {
      await Promise.all(threads.map(stop));
      throw failure;
    }
    await Promise.all(
      threads.map(
        (t) =>
          new Promise<void>((resolve) => {
            const onStats = (m: CompileReply): void => {
              if (m.kind === 'stats') {
                t.off('message', onStats);
                absorbCacheStats(m.stats);
                resolve();
              }
            };
            t.on('message', onStats);
            t.send({ kind: 'stats' } satisfies CompileRequest);
          }),
      ),
    );
    await Promise.all(threads.map(stop));
  };
  return { worker, close };
}

/** Stop a worker and wait until it is gone: disconnecting ends it (compile-worker.ts exits on
 *  `disconnect`), and a worker that has not exited within five seconds is killed. */
function stop(t: ChildProcess): Promise<void> {
  if (t.exitCode !== null || t.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const kill = setTimeout(() => t.kill('SIGKILL'), 5000);
    t.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    if (t.connected) {
      t.disconnect();
    } else {
      t.kill('SIGKILL');
    }
  });
}
