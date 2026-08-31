// The matching suite is the gate that catches match regressions, so it is the last suite that may
// ever be SERVED a cached candidate object. This globalSetup enforces two things for the whole
// run:
//
//   1. `verify`, never `on`. In verify mode every candidate is compiled for real and the stored
//      answer is audited against the fresh one, which always wins. A run in `on` mode would answer
//      from disk, and a match regression hiding behind a stale object is exactly the silent wrong
//      answer this cache exists to not be.
//   2. a mismatch FAILS the run. `verify` counts and says so on stderr, but vitest runs tests in
//      a forked worker and this file runs in the parent, so the counters are out of reach. The
//      cache writes each disagreement to `MISMATCH_LOG` as well, and teardown reads it.
//
// WHAT THIS IS AND IS NOT. Essentially every test in the suite compiles through
// `@asmlift/toolchains` (`scoreC`, `compileTargetAsm`, `compileMipsTarget`), which contains ZERO
// references to this cache — so those are not audited. Four files reach `compileFromCommand`
// (`ranked-parallel`, `self-declared-ab`, `decl-scope-axis`, `candcache-verify`); with no
// per-project opt-in to withhold, all of them compile through a live `verify` cache against the
// default store, and a disagreement fails the run for real. MEASURED, the whole suite against an
// empty private store (`ASMLIFT_CANDCACHE_DIR=<empty> pnpm test:matching`): 327 tests passed, 3
// namespaces holding 2 / 2 / 133 keys, and no `MISMATCHES.log` written at all. So this is a REAL
// gate over those files plus a self-test, and still forward defence for the toolchains path; what
// would make it a gate over the whole suite is threading the cache through `@asmlift/toolchains`.
//
// AND IT REFUSES, measured rather than reasoned. Re-run against that same store with every stored
// object overwritten by a fixed 19-byte string: every test STILL PASSES — verify mode never
// serves, so no assertion can move — and the run fails from the teardown below with 133
// disagreements in `MISMATCHES.log`. That is the shape to expect from this gate: it does not
// change what the suite decides, it decides whether the store was entitled to be believed. The
// status is vitest's own, not `CACHE_MISMATCH_EXIT`: the teardown runs in the vitest parent, which
// owns the exit code, while the counters live in the forked worker that compiled.
//
// THE STORE IS DELIBERATELY *NOT* ISOLATED HERE, and this is the one place in the repo where that
// is the right call. `vitest.config.ts` pins the offline/app suites at `ASMLIFT_CANDCACHE=0` and
// points them at a per-run throwaway store, because a test must never be served and must never
// write fixtures into the shared one. This suite is the opposite: it runs in `verify`, so it
// cannot be served, and the store it audits has to be THE SHARED ONE — the store `pnpm bench run`
// and the ranked runs have been filling. Pointed at a fresh directory every run it would find
// nothing to disagree with, and the gate would be vacuous while still printing green.
//
// SAY THE OTHER HALF TOO, because "the gate" overstates what the repo's wiring delivers:
// `pnpm test:matching` is in no `ci.yml` job, and in no local aggregate — `pnpm test:offline` and
// the two per-app vitest steps do not include it. It IS a step in `benchmark.yml` (before
// `pnpm bench run`, so a lost match fails the workflow rather than being published as a moved
// number) — but a hosted runner starts with an EMPTY store, so there the audit half of this file
// has nothing to audit and only the never-served half applies. The store this gate exists for
// only ever exists on a developer's machine.
//
// `ASMLIFT_CANDCACHE=0` still bypasses everything, which is the documented escape hatch.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

import { MISMATCH_LOG, OFF_WORDS, ON_WORDS } from '../../src/candcache';

export default function setup(): () => void {
  // ASK THE MODULE'S OWN LIST, not a two-element copy of it. `asked !== '0' && asked !== 'off'`
  // forced `verify` for `false`, `no`, `disable`, and the SET-AND-EMPTY state — every one of which
  // candcache.ts calls OFF and docs/ranked-repro.md describes as "touches no disk". Under a forced
  // `verify` such a run stores every key and appends to the SHARED `MISMATCHES.log`, so a
  // neighbour worktree's lines could then fail the teardown below. UNSET is deliberately NOT off
  // here: `process.env.ASMLIFT_CANDCACHE` being undefined means the module's default, which is
  // `on`, and this suite must upgrade that to `verify`.
  const raw = process.env.ASMLIFT_CANDCACHE;
  const asked = raw?.trim().toLowerCase() ?? '';
  if (raw === undefined || !OFF_WORDS.has(asked)) {
    if (ON_WORDS.has(asked)) {
      process.stderr.write(
        `[candcache] the matching suite runs in verify mode, not "${raw ?? ''}": it is the gate that ` +
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
  // The module's own answer for where the store is. Recomputing it here re-created the `??` bug
  // that put an empty ASMLIFT_CANDCACHE_DIR in the CURRENT DIRECTORY, in a second place.
  const log = MISMATCH_LOG;
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
