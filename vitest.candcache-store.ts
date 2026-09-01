// The candidate-object store TEST RUNS get, and the teardown that removes it.
//
// This is the SECOND half of the test fence, and it exists because the first half cannot cover
// the suites that must escape it. `vitest.config.ts` pins `ASMLIFT_CANDCACHE=0`, which is what
// keeps a test from being SERVED a cached object; but the candcache suites DELETE that variable
// per case, precisely so they can exercise the module's real default — and a case that deletes it
// is a case the mode pin no longer protects. Each of those cases hands `candCache` its own
// scratch `ASMLIFT_CANDCACHE_DIR` by hand today; MEASURED, removing that one hand-written pin
// from a single case is enough to write a test fixture straight into the developer's real store
// at `$TMPDIR/asmlift-candcache` (1 namespace, 1 key, containing the fixture's C text). So the
// store location is pinned here too: a case that forgets its own lands in a throwaway directory
// instead of the one `pnpm bench run` and the ranked runs are filling.
//
// PER RUN, not per user: two developers — or two worktrees of this repo running rounds in
// parallel, which is how this project works — must not be able to hand each other a test's
// leftovers. The name is derived from the vitest main process's PID rather than `mkdtemp` on
// purpose: `vitest.config.ts` and this globalSetup are loaded as two separate module instances in
// that one process, so a random name would give them two different directories and the teardown
// would delete a directory nothing wrote to.
//
// NOT for `vitest.matching.config.ts`, deliberately. That suite runs in `verify` mode against the
// SHARED default store, which is the whole point of it: it is the only thing in this repo that
// audits the store a developer's real runs have been filling, and pointing it at a fresh isolated
// directory would make every lookup a miss and the audit vacuous. See
// packages/cli/test/matching/candcache-gate.ts.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VITEST_CANDCACHE_DIR = join(tmpdir(), `asmlift-candcache-vitest-${process.pid}`);

export default function setup(): () => void {
  // Nothing is created up front: candcache.ts only mkdirs a store when something actually engages
  // it, so on a correctly fenced run this directory never exists and the teardown is a no-op.
  // When it DOES exist, something escaped the mode pin — the removal is what keeps that from
  // becoming state the next run reads.
  return function teardown(): void {
    rmSync(VITEST_CANDCACHE_DIR, { recursive: true, force: true });
  };
}
