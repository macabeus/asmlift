// The matching suite is the gate that catches match regressions, and it is in neither CI nor the
// benchmark — so it is the last suite that may ever be SERVED a cached candidate object. This
// globalSetup enforces two things for the whole run:
//
//   1. `verify`, never `on`. In verify mode every candidate is compiled for real and the stored
//      answer is audited against the fresh one, which always wins. A run in `on` mode would answer
//      from disk, and a match regression hiding behind a stale object is exactly the silent wrong
//      answer this cache exists to not be.
//   2. a mismatch FAILS the run. `verify` counts and says so on stderr, but vitest runs tests in
//      a forked worker and this file runs in the parent, so the counters are out of reach. The
//      cache writes each disagreement to `MISMATCH_LOG` as well, and teardown reads it.
//
// WHAT THIS IS AND IS NOT, RE-measured after `tools.asmlift.cacheInputs` was deleted. Essentially
// every test in the suite compiles through `@asmlift/toolchains` (`scoreC`, `compileTargetAsm`,
// `compileMipsTarget`), which contains ZERO references to this cache — so those are still not
// audited. What CHANGED is the rest: four files reach `compileFromCommand`
// (`ranked-parallel`, `self-declared-ab`, `decl-scope-axis`, `candcache-verify`), and they used to
// pass no `cacheInputs`, so three of them ran with the cache structurally OFF. There is no opt-in
// any more — the namespace measures what the command reads instead of being told — so all three
// now compile through a live `verify` cache against the default store, and a disagreement fails
// the run for real. MEASURED, those three files against an empty private store: 1 namespace,
// 142 stored keys, 0 mismatches (it was 0 keys before, `OFF_CACHE`). So this is a REAL gate over those three files plus a self-test, and still
// forward defence for the toolchains path; what would make it a gate over the whole suite is
// threading the cache through `@asmlift/toolchains`.
//
// `ASMLIFT_CANDCACHE=0` still bypasses everything, which is the documented escape hatch.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mismatchLogFor } from '../../src/candcache';

export default function setup(): () => void {
  const asked = process.env.ASMLIFT_CANDCACHE ?? '';
  if (asked !== '0' && asked !== 'off') {
    if (asked === '1' || asked === 'on') {
      process.stderr.write(
        `[candcache] the matching suite runs in verify mode, not "${asked}": it is the gate that ` +
          `catches match regressions, so it compiles every candidate and only AUDITS the store.\n`,
      );
    }
    process.env.ASMLIFT_CANDCACHE = 'verify';
  }
  // Read the log by OFFSET; never delete it. The default store is ONE per-user directory shared by
  // every asmlift process on the box, and this repo's way of working is several worktrees at once:
  // deleting the log here erased the record a verify bench run in another worktree was writing,
  // and inherited its lines the other way round. The tail this run appended is the only part that
  // is this run's answer.
  const log = mismatchLogFor(process.env.ASMLIFT_CANDCACHE_DIR ?? join(tmpdir(), 'asmlift-candcache'));
  const startedAt = existsSync(log) ? statSync(log).size : 0;

  return function teardown(): void {
    if (!existsSync(log) || statSync(log).size <= startedAt) {
      return;
    }
    const fd = openSync(log, 'r');
    const buf = Buffer.alloc(statSync(log).size - startedAt);
    try {
      readSync(fd, buf, 0, buf.length, startedAt);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString('utf8').trim();
    if (lines !== '') {
      throw new Error(
        `the candidate-object cache served bytes a fresh compile disagrees with — every stored ` +
          `object under that namespace is suspect:\n${lines}\n` +
          `The store is shared: these lines may have been written by another process against ` +
          `${log}. Drop it (ASMLIFT_CANDCACHE_DIR, default $TMPDIR/asmlift-candcache) and find the ` +
          `input the namespace is not measuring.`,
      );
    }
  };
}
