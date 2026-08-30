// The matching suite is the gate that catches match regressions, and it is in neither CI nor the
// benchmark — so it is the last suite that may ever be SERVED a cached candidate object. This
// globalSetup enforces two things for the whole run:
//
//   1. `verify`, never `on`. In verify mode every candidate is compiled for real and the stored
//      bytes are compared against the fresh ones, which the fresh ones always win. A run in `on`
//      mode would answer from disk, and a match regression hiding behind a stale object is
//      exactly the silent wrong answer this cache exists to not be.
//   2. a mismatch FAILS the run. `verify` counts and says so on stderr, but vitest runs tests in
//      a forked worker and this file runs in the parent, so the counters are out of reach. The
//      cache writes each disagreement to `MISMATCH_LOG` as well, and teardown reads it.
//
// `ASMLIFT_CANDCACHE=0` still bypasses everything, which is the documented escape hatch.
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { MISMATCH_LOG } from '../../src/candcache';

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
  rmSync(MISMATCH_LOG, { force: true });

  return function teardown(): void {
    if (!existsSync(MISMATCH_LOG)) {
      return;
    }
    const lines = readFileSync(MISMATCH_LOG, 'utf8').trim();
    rmSync(MISMATCH_LOG, { force: true });
    if (lines !== '') {
      throw new Error(
        `the candidate-object cache served bytes a fresh compile disagrees with — every stored ` +
          `object under that namespace is suspect:\n${lines}\n` +
          `Drop the store (ASMLIFT_CANDCACHE_DIR, default $TMPDIR/asmlift-candcache) and find the ` +
          `input the namespace is not measuring.`,
      );
    }
  };
}
