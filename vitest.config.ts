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
    include: [
      'packages/core/test/**/*.test.ts',
      'packages/cli/test/offline/**/*.test.ts',
      'apps/*/test/**/*.test.{ts,tsx}',
    ],
  },
});
