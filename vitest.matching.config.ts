import { defineConfig } from 'vitest/config';

// The TOOLCHAIN-BOUND matching suites (packages/cli/test/matching): decompile → recompile with the
// real agbcc/IDO/KMC/mwcc toolchains → objdiff. They shell out to i386/qemu-emulated Docker via
// synchronous spawnSync, so they get their OWN run, kept fully serial:
//   • Emulated compiles are single-threaded and CPU-heavy; running several at once just thrashes one
//     CPU, ballooning each from seconds to minutes past the timeout — serial is both correct and,
//     for emulated compiles, faster wall-clock.
//   • Even serially, a slow compile can block the worker's event loop past vitest's hard-coded 60s
//     worker↔main RPC timeout, surfacing a benign "Timeout calling onTaskUpdate" unhandled error
//     (the test still passes). `dangerouslyIgnoreUnhandledErrors` keeps that reporting hiccup from
//     failing an otherwise-green run — real assertion failures and thrown errors still fail loudly.
// Run via `pnpm test` (which runs the default offline config first, then this one).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/cli/test/matching/**/*.test.ts'],
    // refuse loudly (naming the remedy) when the native agbcc/IDO toolchains are absent,
    // instead of failing cryptically once per fixture — see the file's header comment
    globalSetup: ['packages/cli/test/matching/global-setup.ts'],
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 240_000,
    hookTimeout: 240_000,
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
