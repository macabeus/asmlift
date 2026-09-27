// The CLI bundle loads the objdiff engine on the scoring path alone: every import of the external
// @matchkit/scoring is a lazy `await import()` (score.ts says why).
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
    expect(line).toMatch(/await import\("@matchkit\/scoring(\/files)?"\)/);
    expect(line).toMatch(/^\s+/);
  }
});
