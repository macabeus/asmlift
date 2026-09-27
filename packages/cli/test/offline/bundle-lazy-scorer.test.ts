// The CLI bundle must not load the objdiff engine on a plain decompile. scripts/build.mjs keeps
// @matchkit/scoring external, and esbuild hoists an external's STATIC import to the top of the
// bundle, where it runs on every command: the engine loads, and a failure to load it breaks
// commands that never score. Only an `await import()` inside a lazily initialized module is safe.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const pkg = resolve(import.meta.dirname, '../..');

test('the bundle reaches @matchkit/scoring only through a lazy dynamic import', async () => {
  // The options of scripts/build.mjs that decide where an external import lands.
  const out = await build({
    entryPoints: [resolve(pkg, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['@matchkit/scoring', 'yaml'],
    write: false,
    logLevel: 'silent',
  });
  const text = out.outputFiles[0]!.text;
  const lines = text.split('\n').filter((line) => line.includes('@matchkit/scoring'));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(/await import\("@matchkit\/scoring(\/node)?"\)/);
    expect(line).toMatch(/^\s+/);
  }
});
