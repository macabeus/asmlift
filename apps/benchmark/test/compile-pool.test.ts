// A row's candidate compiles on worker threads (src/eval/compile-pool.ts): a thread compiles what the
// ranked pass's own compiler compiles, a rejection comes back as the rejection it was, and the
// threads' candidate-cache counters reach this thread's. Real threads and a real agbcc row, so it
// needs agbcc and skips without it.
import { absorbCacheStats, cacheStats } from '@asmlift/cli/candcache';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { agbccAvailable } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { syntheticCases } from '../src/cases/synthetic';
import { benchCompilerFor } from '../src/decomp-config';
import { compilePool } from '../src/eval/compile-pool';

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

  test('adds another thread counters to this one', () => {
    const before = cacheStats().hit ?? 0;
    absorbCacheStats({ hit: 3, sampledPending: 9 });
    expect(cacheStats().hit).toBe(before + 3);
    expect(cacheStats()).not.toHaveProperty('sampledPending');
  });
});
