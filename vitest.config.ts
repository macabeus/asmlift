import { defineConfig } from 'vitest/config';

// Default config: every TOOLCHAIN-FREE suite (core, cli/offline, benchmark harness, web). No
// Docker, no blocking spawnSync — so these run in PARALLEL worker forks (the fast path; hosted
// CI gates the same suites via `test:offline` plus per-app vitest runs). The Docker-bound
// matching suites are excluded here and run separately through
// vitest.matching.config.ts (serial), so their emulated compiles never contend with these workers.
// Kept strict (no dangerouslyIgnoreUnhandledErrors) so a real unhandled error here fails loudly.
export default defineConfig({
  test: {
    environment: 'node',
    // THE CANDIDATE-OBJECT CACHE IS PINNED OFF FOR EVERY TEST IN THIS CONFIG, and it has to be
    // named here because the module's default is now ON (packages/cli/src/candcache.ts): an
    // unpinned suite would read and write the developer's real store at
    // `$TMPDIR/asmlift-candcache`, so a compile a test expects to happen would be answered from
    // disk. A green suite that was green because it read a cache is not a green suite, and the
    // store it wrote would carry objects built by a test's throwaway `sh` "compiler".
    // `test.env` reaches the forked workers, which is where every test here runs.
    // The candcache suites themselves DELETE the variable per case (`load({ ASMLIFT_CANDCACHE:
    // undefined })`) against their own scratch store, so the default-on behaviour is still
    // exercised — deliberately, and never against the shared one.
    env: { ASMLIFT_CANDCACHE: '0' },
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
