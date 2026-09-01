// THE FENCE ITSELF, asserted from inside a worker.
//
// The candidate-object cache is ON by default (packages/cli/src/candcache.ts), so every suite in
// `vitest.config.ts` — `test:offline`, `apps/benchmark/test` and `apps/web/test`, the last two
// being CI steps — would otherwise read and write the developer's real store at
// `$TMPDIR/asmlift-candcache`. That config pins three environment variables to stop it. This file
// is what makes deleting one of them fail a test instead of quietly changing what those suites
// read; the pins live in a config no test would otherwise look at, and the failure they prevent
// is a suite that PASSES.
//
// One file, not one per app: all three CI vitest steps run through the same `vitest.config.ts`
// object, so a regression in it is visible from any of them. If a future app grows its own vitest
// config, that config needs its own copy of the pins AND its own copy of this assertion — a test
// living here cannot see it.
//
// Read `process.env` and nothing else. Importing candcache.ts would tell you what the MODULE did
// with the environment, which is that module's own suites' job; what is at stake here is whether
// the environment the workers run in still carries the fence at all.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DEFAULT_STORE = join(tmpdir(), 'asmlift-candcache');

describe('the test fence over the candidate-object cache', () => {
  test('the cache is pinned OFF, so no test can be served a stored object', () => {
    // The correctness half. Ablated, `pnpm test:offline` served a poisoned store into 13 tests in
    // compile-command.test.ts; fenced, the same poisoned store left the suite green and its own
    // tree byte-for-byte unchanged — no lease, no new entry.
    expect(process.env.ASMLIFT_CANDCACHE, 'vitest.config.ts must pin ASMLIFT_CANDCACHE=0 — unset now means ON').toBe(
      '0',
    );
  });

  test('the sampled audit is pinned OFF, so a run is reproducible', () => {
    // `on` mode withholds a sampled key so the caller compiles it anyway, at 2% under a random
    // per-run seed. A case that deletes the mode pin to exercise the real default inherits that,
    // and an assertion counting compiles then fails once in a hundred runs. Two such cases exist.
    expect(
      process.env.ASMLIFT_CANDCACHE_SAMPLE,
      'vitest.config.ts must pin ASMLIFT_CANDCACHE_SAMPLE=0 — the default rate is random-seeded',
    ).toBe('0');
  });

  test('the store is a per-run directory, never the shared one a real run fills', () => {
    // The backstop for the cases that DELETE the mode pin: each pins its own scratch store by
    // hand today, and removing that one hand-written pin from a single case was measured writing
    // a test fixture into the shared store.
    const dir = process.env.ASMLIFT_CANDCACHE_DIR;
    expect(dir, 'vitest.config.ts must pin ASMLIFT_CANDCACHE_DIR to an isolated store').toBeTruthy();
    expect(dir, 'the test store must not be the default one every asmlift process shares').not.toBe(DEFAULT_STORE);
  });
});
