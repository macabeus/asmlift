// Self-verifying `test:offline` layout. The hosted CI gate runs the root package.json's
// `test:offline` script, which lists two DIRECTORIES: `packages/core/test` and
// `packages/cli/test/offline`. This meta-test enforces the rule that makes those directories
// meaningful — a suite needs a toolchain iff it imports @asmlift/toolchains (the pinned
// compile/score implementations that spawn agbcc/IDO/KMC/mwcc) or `docker-gate` — so drift is
// a CI failure instead of a comment. (cli's `src/score` is a toolchain-FREE seam: the registry
// + objdiff, offline-safe by design.)
//   • every @asmlift/core suite must be toolchain-free (core has no score.ts to import);
//   • every `cli/test/offline` suite must be toolchain-free (it runs on hosted CI);
//   • every `cli/test/matching` suite must import a toolchain helper — one that doesn't is
//     offline-safe coverage that hosted CI silently never runs (move it to offline/).
// This file is itself offline and covered by the core dir entry.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const coreTestDir = import.meta.dirname;
const cliTestDir = join(coreTestDir, '..', '..', 'cli', 'test');
const pkg = JSON.parse(readFileSync(join(coreTestDir, '../../..', 'package.json'), 'utf8'));

// Real import statements only, at any relative depth; optional `.ts` extensions and cross-dir
// spellings count too — an evasion here would run a toolchain suite on a hosted runner (loud
// later, but the derivation should not be foolable).
const TOOLCHAIN_IMPORT =
  /from\s+["'](?:@asmlift\/toolchains(?:\/[^"']+)?|[^"']*\/toolchains\/src\/[^"']+|(?:\.\/|(?:\.\.\/)+)docker-gate|[^"']*\/cli\/test\/matching\/docker-gate)(?:\.ts)?["']/;

const suites = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
const usesToolchain = (dir: string, f: string) => TOOLCHAIN_IMPORT.test(readFileSync(join(dir, f), 'utf8'));

test('test:offline runs exactly the two toolchain-free directories', () => {
  const script: string = pkg.scripts['test:offline'];
  expect(script).toBe('vitest run packages/core/test packages/cli/test/offline');
});

test('every core suite is toolchain-free', () => {
  const dirty = suites(coreTestDir).filter((f) => usesToolchain(coreTestDir, f));
  expect(dirty, `core suites importing a toolchain helper (move to cli/test/matching): ${dirty.join(', ')}`).toEqual(
    [],
  );
});

test('every cli/test/offline suite is toolchain-free', () => {
  const dir = join(cliTestDir, 'offline');
  const dirty = suites(dir).filter((f) => usesToolchain(dir, f));
  expect(dirty, `offline suites importing a toolchain helper (move to matching/): ${dirty.join(', ')}`).toEqual([]);
});

test('every cli/test/matching suite uses a toolchain (else hosted CI never runs it)', () => {
  const dir = join(cliTestDir, 'matching');
  const strays = suites(dir).filter((f) => !usesToolchain(dir, f));
  expect(strays, `toolchain-free suites hiding in matching/ (move to offline/): ${strays.join(', ')}`).toEqual([]);
});
