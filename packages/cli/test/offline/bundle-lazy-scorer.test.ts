// A plain decompile runs from the CLI bundle even when @match-kit/scoring cannot be loaded: the bundle
// loads the objdiff engine on the scoring path alone (score.ts says why).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const pkg = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'asmlift-bundle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const node = (args: string[]) => spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });

beforeAll(async () => {
  // The options of scripts/build.mjs that decide where an external import lands.
  await build({
    entryPoints: [resolve(pkg, 'src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['@match-kit/scoring', 'yaml'],
    outfile: join(dir, 'asmlift.mjs'),
    logLevel: 'silent',
  });
  // Of the two externals, only yaml resolves next to the bundle.
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(realpathSync(join(pkg, 'node_modules/yaml')), join(dir, 'node_modules/yaml'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
});

test('@match-kit/scoring does not resolve next to the bundle', () => {
  expect(node(['--input-type=module', '-e', "await import('@match-kit/scoring')"]).status).not.toBe(0);
});

test('a plain decompile runs from the bundle without it', () => {
  const asm = join(pkg, '../core/test/corpus/agbcc-clamp0.s');
  const run = node(['asmlift.mjs', asm, '--target', 'agbcc']);
  expect(run.stderr).not.toMatch(/match-kit/);
  expect(run.status).toBe(0);
  expect(run.stdout).toMatch(/clamp0\(/);
});
