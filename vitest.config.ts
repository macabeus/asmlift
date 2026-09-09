import { defineConfig } from 'vitest/config';

import { VITEST_CANDCACHE_DIR } from './vitest.candcache-store';

// Default config: every TOOLCHAIN-FREE suite (core, cli/offline, benchmark harness, web). No
// Docker, no blocking spawnSync — so these run in PARALLEL worker forks (the fast path; hosted
// CI gates the same suites via `test:offline` plus per-app vitest runs). The Docker-bound
// matching suites are excluded here and run separately through
// vitest.matching.config.ts (serial), so their emulated compiles never contend with these workers.
// Kept strict (no dangerouslyIgnoreUnhandledErrors) so a real unhandled error here fails loudly.
export default defineConfig({
  test: {
    environment: 'node',
    // THE CANDIDATE-OBJECT CACHE FENCE. Three pins, and each one was measured to be doing
    // something different; `test.env` reaches the forked workers, which is where every test here
    // runs. `packages/cli/test/offline/candcache-fence.test.ts` asserts all three from inside a
    // worker, so deleting one fails a test instead of silently changing what these suites read.
    //
    //   MODE — the correctness fence, and it is load-bearing, not forward defence. ABLATED (this
    //   `env` block removed) `pnpm test:offline` wrote 8 namespaces / 15 objects / 20 keys into
    //   the real store at `$TMPDIR/asmlift-candcache`, and those "objects" are what a test's
    //   throwaway `sh` "compiler" emits — C source text, and one line of Pascal. Ablated again
    //   with that store POISONED (every stored object replaced by a fixed string), 13 tests in
    //   `compile-command.test.ts` failed on the poison; fenced, against the same poisoned store,
    //   every one passed and the store tree came back byte-for-byte identical — no lease, no new
    //   entry. A green suite that was green because it read a cache is not a green suite.
    //
    //   SAMPLE — determinism, and this one was a live 1-in-50 flake. `on` mode audits a sampled
    //   fraction of served keys against a fresh compile, at 2% under a RANDOM per-run seed. The
    //   two cases in `candcache.test.ts` that assert "a hit is an execution that did not happen"
    //   must delete the mode pin to see the real default, and they therefore inherited that
    //   audit: a sampled key is withheld and recompiled, and the assertion counts the compile.
    //   Observed failing once in an ordinary run here, and reproduced deterministically at
    //   `ASMLIFT_CANDCACHE_SAMPLE=100` (both cases, `expected 5 to be 4`). Those cases are about
    //   the MODE default; the rate has its own suite (`candcache-sampling.test.ts`), which pins
    //   every rate it asserts.
    //
    //   DIR — the backstop for exactly the cases the mode pin cannot reach, because they delete
    //   it. Each hands `candCache` its own scratch store by hand; MEASURED, removing that one
    //   hand-written pin from a single case writes a fixture into the real store (1 namespace,
    //   1 key). Pinned here, such a case lands in a per-run throwaway instead — see
    //   vitest.candcache-store.ts, which also removes it.
    // WHY THIS IS NOT vitest's 5000 ms default. These suites are not pure-CPU unit tests: they
    // fork `sh` stand-in compilers, run `git`, and read vendored blobs off disk, so their cost is
    // external process time — the thing that degrades non-linearly when the machine is also
    // running a bench. Twice, `apps/benchmark/test` failed 8-12 tests on an UNMODIFIED tree, every
    // failure `Test timed out in 5000ms` and never an assertion, in a different set each run, with
    // a full `bench run` alongside; both times it was clean once the machine was quiet.
    //
    // The slowest test here is ~1.7 s idle, so 5 s is barely 3x headroom for work that is mostly
    // waiting on other processes. Tests that already knew this raised their own (`{ timeout:
    // 20_000 }` in m2c-setup, `}, 30_000)` in authored-facts, `}, 90_000)` in the fuzz sweeps) —
    // this is the same judgement applied where it belongs, matching vitest.matching.config.ts,
    // which sets 240_000 for the same reason: its work is a real compiler.
    //
    // It does not hide a hang: a hung test still fails, 15 s later. It does mean a timeout here is
    // evidence of a hang rather than of a busy laptop, which is what a gate should report.
    testTimeout: 20_000,
    env: {
      ASMLIFT_CANDCACHE: '0',
      ASMLIFT_CANDCACHE_SAMPLE: '0',
      ASMLIFT_CANDCACHE_DIR: VITEST_CANDCACHE_DIR,
    },
    globalSetup: ['./vitest.candcache-store.ts'],
    include: [
      'packages/core/test/**/*.test.ts',
      'packages/cli/test/offline/**/*.test.ts',
      // named explicitly rather than as `packages/*/test/**` — that glob would sweep in
      // packages/cli/test/matching, which is Docker-bound and has its own serial config
      'packages/toolchains/test/**/*.test.ts',
      'apps/*/test/**/*.test.{ts,tsx}',
    ],
  },
});
