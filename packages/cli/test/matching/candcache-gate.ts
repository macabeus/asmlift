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
// WHAT THIS IS AND IS NOT, measured rather than assumed. Essentially every test in the suite
// compiles through `@asmlift/toolchains` (`scoreC`, `compileTargetAsm`, `compileMipsTarget`), which
// contains ZERO references to this cache — so on a normal run the default store stays empty and
// nothing is audited. The four files that go through `compileFromCommand` pass no `cacheInputs`
// except `candcache-verify.test.ts`, which brings its own `ASMLIFT_CANDCACHE_DIR`. So this is
// FORWARD DEFENCE plus a self-test, not a gate over the suite's match assertions: it guarantees
// that IF a matching test ever compiles through a cached seam, it is audited and a disagreement
// stops the run. Calling it "verify mode wired into pnpm test:matching" overstates it; what would
// make it a real gate is threading the cache through `@asmlift/toolchains`.
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
