// A row's candidate compiles in worker processes (src/eval/compile-pool.ts): a worker compiles what
// the ranked pass's own compiler compiles, a rejection comes back as the rejection it was, and the
// workers' candidate-cache counters reach this process's; a worker that dies fails the pool. Real
// workers and a real agbcc row, so it needs agbcc and skips without it.
import { absorbCacheStats, cacheStats } from '@asmlift/cli/candcache';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { agbccAvailable } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { realCases } from '../src/cases/real';
import { syntheticCases } from '../src/cases/synthetic';
import { benchCompilerFor } from '../src/decomp-config';
import { PARALLEL_FAN, WORKER_FAN, rowCompiler, runAsmlift, workerFanFor } from '../src/eval/asmlift';
import { CompilePoolDied, compilePool } from '../src/eval/compile-pool';

describe.skipIf(!agbccAvailable())('a row compile pool', () => {
  test('compiles as the row compiler does, and returns a rejection as a CompilerRejection', async () => {
    const [c] = syntheticCases({ only: 'divc', toolchain: 'agbcc' }).filter((x) => x.id === 'synthetic:divc:agbcc');
    const direct = benchCompilerFor(c.toolchain.id, c.codegen.cflags);
    const source = 's32 divc(s32 a0) {\n    return a0 / 7;\n}\n';
    const pool = compilePool({ tier: 'synthetic', id: c.id, sym: 'divc' });
    try {
      const compile = pool.worker();
      const viaWorker = await compile(source, 'divc', 'c');
      expect(readFileSync(viaWorker)).toEqual(readFileSync(await direct(source, 'divc', 'c')));
      const refused = await compile('s32 divc(s32 a0) { return a0 +; }\n', 'divc', 'c').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(CompilerRejection);
      expect((refused as CompilerRejection).diagnostic).toMatch(/error/i);
    } finally {
      await pool.close();
    }
  }, 120_000);

  // The real tier ranks with the project-context compile, so a worker must rebuild the row's own
  // compiler rather than the synthetic tier's.
  test('compiles a real row in its project context, as the row compiler does', async () => {
    const [c] = realCases({ only: 'DivideQ8' }).filter((x) => x.id === 'kleod:DivideQ8:agbcc');
    const source = 's32 DivideQ8(s16 a0, u32 a1) {\n    return (s16)((a0 << 8) / (s16)a1);\n}\n';
    const pool = compilePool({ tier: 'real', id: c.id, sym: c.sym });
    try {
      const viaWorker = await pool.worker()(source, c.sym, 'c');
      expect(readFileSync(viaWorker)).toEqual(
        readFileSync(await rowCompiler(c.toolchain, c.codegen, c.compile)(source, c.sym, 'c')),
      );
    } finally {
      await pool.close();
    }
  }, 120_000);

  test('a worker that dies fails its compiles and the pool, never a candidate alone', async () => {
    const pool = compilePool({ tier: 'synthetic', id: 'synthetic:nosuchrow:agbcc', sym: 'nosuchrow' });
    const refused = await pool
      .worker()('int nosuchrow;', 'nosuchrow', 'c')
      .catch((e: unknown) => e);
    expect(refused).not.toBeInstanceOf(CompilerRejection);
    expect(String(refused)).toMatch(/compile worker for synthetic:nosuchrow:agbcc died/);
    await expect(pool.close()).rejects.toThrow(/died/);
  }, 120_000);

  // A worker that dies while `close()` waits for its stats — here it fails at start and no compile
  // ever waits on it — settles the wait instead of leaving `close()` open forever.
  test('close() settles when a worker dies with its stats outstanding', async () => {
    const pool = compilePool({ tier: 'synthetic', id: 'synthetic:nosuchrow:agbcc', sym: 'nosuchrow' });
    pool.worker();
    await expect(pool.close()).rejects.toThrow(/died/);
  }, 60_000);

  // …and the row fails its evaluation rather than publishing the crash as every candidate's refusal.
  // dmascope's fan is past PARALLEL_FAN, so its compiles go to workers.
  test('a big fan whose workers die fails the row instead of publishing a noncompile', async () => {
    const [c] = syntheticCases({ only: 'dmascope', toolchain: 'agbcc' }).filter(
      (x) => x.id === 'synthetic:dmascope:agbcc',
    );
    const { obj, asm } = c.build();
    const lost = { tier: 'synthetic' as const, id: 'synthetic:nosuchrow:agbcc', sym: c.sym };
    await expect(runAsmlift(c.toolchain, c.codegen, c.sym, asm, obj, lost, c.proto)).rejects.toBeInstanceOf(
      CompilePoolDied,
    );
  }, 300_000);

  test('adds another worker counters to this one', () => {
    const before = cacheStats().hit ?? 0;
    absorbCacheStats({ hit: 3 });
    expect(cacheStats().hit).toBe(before + 3);
  });

  test('refuses a worker that ended with an audit still withheld', () => {
    expect(() => absorbCacheStats({ hit: 1, sampledPending: 2 })).toThrow(/2 sampled audit/);
  });
});

// Toolchain-free: which fans leave the shard. On Linux a spawn forks the shard, so a mid-sized fan
// goes to one worker; on macOS a spawn costs the same from either, so only a big fan does.
describe('the worker band', () => {
  test.each([
    ['linux', WORKER_FAN],
    ['darwin', PARALLEL_FAN],
    ['win32', PARALLEL_FAN],
  ] as const)('%s → fans of %i or more', (platform, fan) => {
    expect(workerFanFor(platform)).toBe(fan);
  });
});
