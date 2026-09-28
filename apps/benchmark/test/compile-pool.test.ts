// A row's candidate compiles on worker threads (src/eval/compile-pool.ts): a thread compiles what the
// ranked pass's own compiler compiles, a rejection comes back as the rejection it was, and the
// threads' candidate-cache counters reach this thread's; a thread that dies fails the pool. Real threads and a real agbcc row, so it
// needs agbcc and skips without it.
import { absorbCacheStats, cacheStats } from '@asmlift/cli/candcache';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { agbccAvailable } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { realCases } from '../src/cases/real';
import { syntheticCases } from '../src/cases/synthetic';
import { benchCompilerFor } from '../src/decomp-config';
import { rowCompiler, runAsmlift } from '../src/eval/asmlift';
import { CompilePoolDied, compilePool } from '../src/eval/compile-pool';

describe.skipIf(!agbccAvailable())('a row compile pool', () => {
  test('compiles as the row compiler does, and returns a rejection as a CompilerRejection', async () => {
    const [c] = syntheticCases({ only: 'divc', toolchain: 'agbcc' }).filter((x) => x.id === 'synthetic:divc:agbcc');
    const direct = benchCompilerFor(c.toolchain.id, c.codegen.cflags);
    const source = 's32 divc(s32 a0) {\n    return a0 / 7;\n}\n';
    const pool = compilePool({ tier: 'synthetic', id: c.id, sym: 'divc' });
    try {
      const compile = pool.worker();
      const viaThread = await compile(source, 'divc', 'c');
      expect(readFileSync(viaThread)).toEqual(readFileSync(direct(source, 'divc', 'c')));
      const refused = await compile('s32 divc(s32 a0) { return a0 +; }\n', 'divc', 'c').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(CompilerRejection);
      expect((refused as CompilerRejection).diagnostic).toMatch(/error/i);
    } finally {
      await pool.close();
    }
  }, 120_000);

  // The real tier ranks with the project-context compile, so a thread must rebuild the row's own
  // compiler rather than the synthetic tier's.
  test('compiles a real row in its project context, as the row compiler does', async () => {
    const [c] = realCases({ only: 'DivideQ8' }).filter((x) => x.id === 'kleod:DivideQ8:agbcc');
    const source = 's32 DivideQ8(s16 a0, u32 a1) {\n    return (s16)((a0 << 8) / (s16)a1);\n}\n';
    const pool = compilePool({ tier: 'real', id: c.id, sym: c.sym });
    try {
      const viaThread = await pool.worker()(source, c.sym, 'c');
      expect(readFileSync(viaThread)).toEqual(
        readFileSync(rowCompiler(c.toolchain, c.codegen, c.compile)(source, c.sym, 'c')),
      );
    } finally {
      await pool.close();
    }
  }, 120_000);

  test('a thread that dies fails its compiles and the pool, never a candidate alone', async () => {
    const pool = compilePool({ tier: 'synthetic', id: 'synthetic:nosuchrow:agbcc', sym: 'nosuchrow' });
    const refused = await pool
      .worker()('int nosuchrow;', 'nosuchrow', 'c')
      .catch((e: unknown) => e);
    expect(refused).not.toBeInstanceOf(CompilerRejection);
    expect(String(refused)).toMatch(/compile thread for synthetic:nosuchrow:agbcc died/);
    await expect(pool.close()).rejects.toThrow(/died/);
  }, 120_000);

  // …and the row fails its evaluation rather than publishing the crash as every candidate's refusal.
  // dmascope's fan is past PARALLEL_FAN, so its compiles go to threads.
  test('a big fan whose threads die fails the row instead of publishing a noncompile', async () => {
    const [c] = syntheticCases({ only: 'dmascope', toolchain: 'agbcc' }).filter(
      (x) => x.id === 'synthetic:dmascope:agbcc',
    );
    const { obj, asm } = c.build();
    const lost = { tier: 'synthetic' as const, id: 'synthetic:nosuchrow:agbcc', sym: c.sym };
    await expect(runAsmlift(c.toolchain, c.codegen, c.sym, asm, obj, lost, c.proto)).rejects.toBeInstanceOf(
      CompilePoolDied,
    );
  }, 300_000);

  test('adds another thread counters to this one', () => {
    const before = cacheStats().hit ?? 0;
    absorbCacheStats({ hit: 3 });
    expect(cacheStats().hit).toBe(before + 3);
  });

  test('refuses a thread that ended with an audit still withheld', () => {
    expect(() => absorbCacheStats({ hit: 1, sampledPending: 2 })).toThrow(/2 sampled audit/);
  });
});
