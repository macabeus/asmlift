// WHICH asmlift produced a number, sampled WHERE the number was produced.
//
// The published artifact has carried `meta.asmlift = { commit, dirty }` for a long time, and
// `report/stale-check.ts` refuses to publish anything whose `dirty` is not `false`. That check was
// sampled at MERGE time only, and merge runs minutes after the last case — so a run made against a
// modified working tree that was reverted before `bench:merge` published as `dirty: false`, with
// nothing anywhere saying the numbers came from code no commit holds. That is the exact shape the
// standing rule forbids: a silent wrong answer where a loud failure belongs. It is not theoretical
// — two agents sharing one worktree produced it, one of them enumerating candidates while the
// other's uncommitted patch sat in `packages/core`.
//
// So the RUN stamps its own provenance into each tier file (`run/runner.ts` benchMeta) and
// `report/merge.ts` refuses to merge a tier whose stamp disagrees with merge time. The two
// samples together cover the whole window.
//
// STICKY, and that is the point rather than an optimization: a mutation that appears and is
// reverted mid-run must still be reported, so once a sample sees a dirty tree this process reports
// dirty for the rest of its life. Sampling is rate-limited (`flush()` runs after every case, and
// `git status` is ~35ms) — the rate limit can miss a mutation that lands and reverts inside one
// window, which is why this is a detector and not a proof.
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
