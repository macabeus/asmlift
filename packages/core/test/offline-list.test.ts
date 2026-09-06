// Self-verifying `test:offline` layout. The hosted CI gate runs the root package.json's
// `test:offline` script, which lists three DIRECTORIES: `packages/core/test`,
// `packages/cli/test/offline` and `packages/toolchains/test`. This meta-test enforces the rule
// that makes those directories meaningful — a suite needs a toolchain iff it imports
// @asmlift/toolchains (the pinned compile/score implementations that spawn agbcc/IDO/KMC/mwcc),
// `docker-gate`, or `checkout-gate` (bench-owned project checkout + native binutils) — so drift
// is a CI failure instead of a comment. (cli's `src/score` is a toolchain-FREE seam: the registry
// + objdiff, offline-safe by design.)
//   • every @asmlift/core suite must be toolchain-free (core has no score.ts to import);
//   • every `cli/test/offline` suite must be toolchain-free (it runs on hosted CI);
//   • every `cli/test/matching` suite must import a toolchain helper — one that doesn't is
//     offline-safe coverage that hosted CI silently never runs (move it to offline/).
//
// `packages/toolchains/test` IS THE ONE DIRECTORY THE IMPORT DERIVATION CANNOT JUDGE: the package
// under test is @asmlift/toolchains, so every suite there imports it by construction and the rule
// above would misread injected fakes as real compilers. No weaker proxy is offered in its place —
// what stands there is the hosted run itself, which has no agbcc, no IDO and no Docker, so a suite
// that needs one goes RED rather than silent. What IS derivable is the drift that hid the
// directory in the first place: a suite reachable through `vitest.config.ts` but not through the
// script CI runs is collected by nobody, so the two lists are checked against each other.
//
// This file is itself offline and covered by the core dir entry.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const coreTestDir = import.meta.dirname;
const cliTestDir = join(coreTestDir, '..', '..', 'cli', 'test');
const pkg = JSON.parse(readFileSync(join(coreTestDir, '../../..', 'package.json'), 'utf8'));

// Real import statements only, at any relative depth; optional `.ts` extensions and cross-dir
// spellings count too — an evasion here would run a toolchain suite on a hosted runner (loud
// later, but the derivation should not be foolable).
const TOOLCHAIN_IMPORT =
  /from\s+["'](?:@asmlift\/toolchains(?:\/[^"']+)?|[^"']*\/toolchains\/src\/[^"']+|(?:\.\/|(?:\.\.\/)+)(?:docker|checkout)-gate|[^"']*\/cli\/test\/matching\/(?:docker|checkout)-gate)(?:\.ts)?["']/;

const suites = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
const usesToolchain = (dir: string, f: string) => TOOLCHAIN_IMPORT.test(readFileSync(join(dir, f), 'utf8'));

const OFFLINE_DIRS = ['packages/core/test', 'packages/cli/test/offline', 'packages/toolchains/test'];

test('test:offline runs exactly the toolchain-free directories', () => {
  const script: string = pkg.scripts['test:offline'];
  expect(script).toBe(`vitest run ${OFFLINE_DIRS.join(' ')}`);
});

// CI runs `pnpm run test:offline`, never a bare `vitest run`, so a directory in the config's
// include and not in the script is collected by nobody on a hosted runner. That is how
// `packages/toolchains` sat with no test directory and three throw sites nothing could reach.
test('every directory the vitest config collects is one the CI script runs', () => {
  const cfg = readFileSync(join(coreTestDir, '../../..', 'vitest.config.ts'), 'utf8');
  const globs = [...cfg.matchAll(/'([^']*\/test[^']*\*[^']*)'/g)].map((m) => m[1]);
  // `apps/` is exempt HERE and checked in the test below instead: the app suites are not part of
  // `test:offline` at all — CI gives each one its own `vitest run` step — so measuring them
  // against this script's directory list would be the wrong question.
  const uncovered = globs.filter((g) => !OFFLINE_DIRS.some((d) => g.startsWith(d)) && !g.startsWith('apps/'));
  expect(uncovered, `collected by vitest.config.ts but not by test:offline: ${uncovered.join(', ')}`).toEqual([]);
});

// The `apps/` half of the same drift: `apps/*/test` is in the config's include, so a suite there is
// collected locally whether or not any hosted job runs it. NAMING, NOT TRIGGER PARITY — the app
// steps live in different CI jobs from `test:offline`, with their own `if`/path conditions, so this
// proves each directory is named by some `vitest run` step and nothing about when that job fires.
test('every apps/*/test directory on disk is named by a `vitest run` step in CI', () => {
  const root = join(coreTestDir, '../../..');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const appTestDirs = readdirSync(join(root, 'apps'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, 'apps', e.name, 'test')))
    .map((e) => `apps/${e.name}/test`);
  expect(appTestDirs.length, 'no apps/*/test directory found — this check would assert nothing').toBeGreaterThan(0);
  const unrun = appTestDirs.filter((d) => !new RegExp(`vitest run [^\\n]*${d}(?![\\w/])`).test(ci));
  expect(unrun, `app test directories no CI \`vitest run\` step names: ${unrun.join(', ')}`).toEqual([]);
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
