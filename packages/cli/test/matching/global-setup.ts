// Fail FAST, with a named remedy, when the native toolchains are absent: without this gate a
// fresh clone running `pnpm test` hits one cryptic spawn failure per fixture instead of one
// answer. agbcc + IDO are the matching suite's core (the default fixture toolchain and the
// MIPS baseline) — with either missing, the suite cannot mean anything, so refusing loudly
// beats skipping green. The Docker suites keep their own per-suite gates (docker-gate.ts):
// those toolchains are legitimately optional per-machine.
import { IDO_TOOLCHAIN, TOOLCHAIN, agbccAvailable, idoAvailable } from '@asmlift/toolchains';

export default function setup(): void {
  const missing: string[] = [];
  if (!agbccAvailable()) {
    missing.push(`agbcc at ${TOOLCHAIN.agbcc} (override: ASMLIFT_AGBCC)`);
  }
  if (!idoAvailable()) {
    missing.push(`IDO 7.1 cc at ${IDO_TOOLCHAIN.cc} (override: ASMLIFT_IDO_CC)`);
  }
  if (missing.length > 0) {
    throw new Error(
      `the matching suite compiles with the pinned native toolchains, and this machine is missing:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        `\nWithout them, run the toolchain-free gate instead: pnpm run test:offline.\n` +
        `Setup: packages/cli/CONTRIBUTION.md#the-pinned-toolchains — the public fetch recipe ` +
        `for every toolchain is .github/workflows/benchmark.yml.`,
    );
  }
}
