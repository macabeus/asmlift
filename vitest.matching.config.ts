import { defineConfig } from 'vitest/config';

// The TOOLCHAIN-BOUND matching suites (packages/cli/test/matching): decompile → recompile with the
// real agbcc/IDO/KMC/mwcc toolchains → objdiff. They shell out to i386/qemu-emulated Docker via
// synchronous spawnSync, so they get their OWN run, kept fully serial:
//   • Emulated compiles are single-threaded and CPU-heavy; running several at once just thrashes one
//     CPU, ballooning each from seconds to minutes past the timeout — serial is both correct and,
//     for emulated compiles, faster wall-clock.
//   • vitest.worker-yield.ts lets the worker read its runner's replies between tests, so a file of
//     compiles holds the thread one test at a time. A single test whose own compiles block past
//     vitest's fixed 60 s worker↔main RPC deadline still raises "Timeout calling onTaskUpdate";
//     `dangerouslyIgnoreUnhandledErrors` keeps that from failing a run whose files all passed. A
//     run that lost its fork over it still fails scripts/gate-vitest.sh, which counts the files.
// Run via `pnpm test` (which runs the default offline config first, then this one).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/cli/test/matching/**/*.test.ts'],
    // refuse loudly (naming the remedy) when the native agbcc/IDO toolchains are absent,
    // instead of failing cryptically once per fixture — see the file's header comment
    // + candcache-gate.ts: this suite may never be SERVED a cached candidate object, so it forces
    // the cross-run cache into `verify` mode (compile anyway, audit the store) and fails the run
    // on any stored-vs-fresh disagreement. Read that file's header for what it does and does NOT
    // cover — today the suite compiles almost entirely through @asmlift/toolchains, which does not
    // use the cache at all, so this is forward defence rather than a gate over the match
    // assertions.
    globalSetup: ['packages/cli/test/matching/global-setup.ts', 'packages/cli/test/matching/candcache-gate.ts'],
    setupFiles: ['./vitest.worker-yield.ts'],
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 240_000,
    hookTimeout: 240_000,
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
