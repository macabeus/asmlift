// WHICH asmlift produced a number, sampled WHERE the number was produced.
//
// The artifact carries `meta.asmlift = { commit, dirty }` and `report/stale-check.ts` refuses to
// publish anything whose `dirty` is not `false`. Sampled at MERGE time alone that says nothing:
// merge runs minutes after the last case, so a run made against a modified working tree that was
// reverted before `bench:merge` publishes as `dirty: false`, with nothing anywhere saying the
// numbers came from code no commit holds — a silent wrong answer where a loud failure belongs.
// Two agents sharing one worktree are enough to produce it, one enumerating candidates while the
// other's uncommitted patch sits in `packages/core`.
//
// So the RUN stamps its own provenance into each tier file (`run/runner.ts` benchMeta) and
// `report/merge.ts` refuses to merge a tier whose stamp disagrees with merge time. The two
// samples together cover the whole window.
//
// STICKY, and that is the point rather than an optimization: a mutation that appears and is
// reverted mid-run must still be reported, so once a sample sees a dirty tree this process reports
// dirty for the rest of its life. Sampling is rate-limited (`flush()` runs after every case, and
// `git status` costs tens of milliseconds) — the rate limit can miss a mutation that lands and
// reverts inside one window, which is why this is a detector and not a proof.
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from './config';

// The benchmark's OWN regenerated artifacts are excluded, otherwise every run marks itself dirty.
const ARTIFACT_PATH = /^(apps\/benchmark\/results\/|apps\/web\/src\/pages\/benchmark\/data\/|apps\/web\/src\/data\/)/;
// UNTRACKED `.claude/commands/` files are excluded too: agent-workflow docs staged for a later
// commit cannot change what any run computes, and counting them stamps an honest run dirty.
// Deliberately NOT all of `.claude/` — an untracked settings file can carry env/hooks that a
// bench invocation launched through the agent would inherit.
const UNTRACKED_NONCODE = /^\.claude\/commands\//;

/** Does this `git status --porcelain` output describe a tree whose CODE differs from HEAD? Split
 *  out so the exclusions are testable without a git checkout to mutate. */
export function codeDirtyFrom(porcelain: string): boolean {
  return porcelain.split('\n').some((l) => {
    if (l.trim() === '') {
      return false;
    }
    const path = l.slice(3).replace(/^"|"$/g, '');
    return !ARTIFACT_PATH.test(path) && !(l.startsWith('??') && UNTRACKED_NONCODE.test(path));
  });
}

const SAMPLE_INTERVAL_MS = 2000;
let lastSample = 0;
let sticky: { commit: string; dirty: boolean } | undefined;

/** Which asmlift this process is running, with the working tree's dirtiness ORed over every
 *  sample taken so far. `undefined` only if git was unreadable. */
export function asmliftProvenance(): { commit: string; dirty: boolean } | undefined {
  const now = Date.now();
  if (sticky !== undefined && now - lastSample < SAMPLE_INTERVAL_MS) {
    return sticky;
  }
  lastSample = now;
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) {
    return sticky;
  }
  const status = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  sticky = {
    commit: head.stdout.trim(),
    dirty: (sticky?.dirty ?? false) || status.status !== 0 || codeDirtyFrom(status.stdout),
  };
  return sticky;
}

/** Test seam: forget the sticky sample. Not used by the harness. */
export function resetProvenanceSample(): void {
  sticky = undefined;
  lastSample = 0;
}

/** The RUN's provenance for a tier that was STITCHED from shard part files.
 *
 *  The default `bench run` path fans every tier across child processes, and only those children
 *  are alive while the numbers are made: each samples git after every case, so a tree that is
 *  mutated and reverted mid-run is recorded in the part files, at a resolution the parent process
 *  cannot match. Stitching therefore COMBINES the parts' stamps rather than re-sampling: a parent
 *  that only sampled after the last child exited would be sampling the same instant `bench:merge`
 *  does, and the run-time check would be comparing a measurement with itself. (`orchestrate` also
 *  samples before the first child spawns, so the parent's own sticky window covers the run; that
 *  is a second observer, not a substitute for the parts' — it still cannot see a mutation that
 *  appears and reverts entirely between its two samples.)
 *
 *  Combining is an OR over `dirty`, plus one more rule: shard stamps that disagree about HEAD mean
 *  the code moved while the tier was being measured, so no single commit holds those numbers —
 *  which is what `dirty` already means to `merge` and `report/stale-check.ts`. Parts written before
 *  the stamp existed carry `undefined` and contribute nothing, so an old part cannot mark a clean
 *  run dirty. */
export function combineProvenance(
  parts: readonly ({ commit: string; dirty: boolean } | undefined)[],
  own: { commit: string; dirty: boolean } | undefined,
): { commit: string; dirty: boolean } | undefined {
  const stamps = [...parts, own].filter((s) => s !== undefined);
  if (stamps.length === 0) {
    return undefined;
  }
  const commits = new Set(stamps.map((s) => s.commit));
  return { commit: stamps[0].commit, dirty: stamps.some((s) => s.dirty) || commits.size > 1 };
}
