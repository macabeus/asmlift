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
// AND IT SAYS SO AT THE TRANSITION, on the run's own stderr — see `wentDirtyNotice`.
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

/** WHICH lines of this `git status --porcelain` output make the tree's CODE differ from HEAD.
 *  Split out so the exclusions are testable without a git checkout to mutate, and returning the
 *  lines rather than a boolean because the two callers want different things from one rule: the
 *  provenance stamp asks only whether, while `run/preflight.ts` refuses a run and must say WHICH
 *  file — a refusal that names none sends the reader back to `git status` to guess which of its
 *  lines this rule counted, among the run's own artifact churn. */
export function codeDirtyPaths(porcelain: string): string[] {
  return (
    porcelain
      .split('\n')
      .filter((l) => {
        if (l.trim() === '') {
          return false;
        }
        const path = l.slice(3).replace(/^"|"$/g, '');
        return !ARTIFACT_PATH.test(path) && !(l.startsWith('??') && UNTRACKED_NONCODE.test(path));
      })
      // Trailing whitespace only. Porcelain's first two columns are staged-then-unstaged, and
      // `l.trim()` would eat the leading one: ` M x` (unstaged) comes back as `M x`, which reads
      // as the staged form — the distinction this refusal exists to spare the reader a second
      // `git status` for.
      .map((l) => l.replace(/\s+$/, ''))
  );
}

/** Does this `git status --porcelain` output describe a tree whose CODE differs from HEAD? */
export function codeDirtyFrom(porcelain: string): boolean {
  return codeDirtyPaths(porcelain).length > 0;
}

/** The repo paths a benchmark measurement depends on — the SAME list
 *  `scripts/check-artifact-provenance.sh` invalidates the committed artifact on, kept in step by
 *  `fidelity-provenance.test.ts` because two copies of a list like this drift silently and the
 *  drift is only ever discovered by a gate that should have fired. Deliberately the WIDE list
 *  (`paths`, not `measures`): asking "could this commit have changed a number" must err toward
 *  yes. */
export const MEASURED_PATHS = [
  'packages/core/src',
  'packages/cli/src',
  'packages/toolchains/src',
  'apps/benchmark/src',
  'apps/benchmark/dataset',
];

/** The subset of `MEASURED_PATHS` that DECIDES a measurement — the decompiler, the ranking and
 *  scoring it is graded by, the compilers it is driven through, and the inputs. Same list as
 *  `measures` in `scripts/check-artifact-provenance.sh`, kept in step by
 *  `fidelity-provenance.test.ts` for the same reason `MEASURED_PATHS` is.
 *
 *  The remainder (`apps/benchmark/src`) is the harness AROUND the decompiler, where the script
 *  REPORTS a base change rather than failing it — not because such a commit is provably
 *  row-neutral, but because of what has ever landed there. Anything asking "must this number be
 *  re-measured" splits the two: a hit here is an answer, a hit in the remainder is a note. */
export const SCORING_PATHS = [
  'packages/core/src',
  'packages/cli/src',
  'packages/toolchains/src',
  'apps/benchmark/dataset',
];

/** Do two commits hold the SAME measured code? `false` when git cannot say — a question git
 *  declines is not a yes.
 *
 *  This is what separates "the code moved between the run and now", which invalidates a tier
 *  file, from "the artifact was committed since the run", which does not: an artifact-only
 *  commit changes HEAD's sha and nothing a run computes. A check that compares SHAS calls both
 *  of those the same thing, and then reports "the code moved" for a commit that moved no code —
 *  a published error naming a cause the run does not have. */
export function sameMeasuredCode(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const r = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--quiet', a, b, '--', ...MEASURED_PATHS], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

/** The ref a run's change set is measured against. The branch point, because that is what every
 *  comparison gate in this harness already uses (`--base origin/main`) and what a round's work
 *  actually is. */
export const TREE_BASE_REF = 'origin/main';

/** How many changed paths a run records before it summarises the rest. A rebase or a `pnpm format`
 *  sweep can touch hundreds, and the artifact is committed. */
export const TREE_PATHS_RECORDED = 40;

/** WHAT THE TREE THAT PRODUCED THESE NUMBERS CHANGES, against the branch point — recorded on the
 *  artifact so "could a cheaper gate have covered this invocation?" is answerable at all.
 *
 *  Every transcript logs the bench command and its output and NONE logs the working tree at that
 *  instant, so the question "did this run need to happen" has never been askable after the fact:
 *  131 h of full-tier bench across 99 runs, and no record anywhere of what any of them was
 *  testing. This is that record, and it costs two `git` calls once per process. */
export interface TreeState {
  /** the ref the change set is measured against */
  base: string;
  /** the merge-base commit with it — a ref name is a different commit on every machine */
  baseCommit: string;
  /** repo-relative paths that differ between that commit and the WORKING TREE: this branch's own
   *  commits AND anything uncommitted, in one list, because both are equally "what this run was
   *  measuring" and a run cannot tell them apart by looking at a number it produced. */
  changed: string[];
  /** how many more there were than `changed` lists */
  more?: number;
}

/** `git diff --name-only <base>`'s output as the capped list the artifact carries. Pure, so the
 *  cap is testable without a checkout to dirty. */
export function treeChangeSet(nameOnly: string, cap = TREE_PATHS_RECORDED): Pick<TreeState, 'changed' | 'more'> {
  const all = nameOnly.split('\n').filter((l) => l.trim() !== '');
  return { changed: all.slice(0, cap), ...(all.length > cap ? { more: all.length - cap } : {}) };
}

/** Sampled ONCE per process and memoized — `undefined` memoizes too, so an unresolvable base is
 *  not re-asked once per case. */
let treeSample: { value: TreeState | undefined } | undefined;

/** The run's change set, or `undefined` when git cannot answer.
 *
 *  REFUSES, rather than guessing, when `origin/main` is not in this checkout (a fork, a shallow
 *  CI clone, a checkout that never fetched): there is no honest fallback — comparing against
 *  `HEAD` would record the empty list for every run and read as "this run tested nothing".
 *
 *  WHY SAMPLING IT AT MERGE TIME IS THE SAME ANSWER AS SAMPLING IT AT LAUNCH, which is what lets
 *  this ride on `benchMeta` with no plumbing through the shards: the COMMITTED half cannot move,
 *  because `report/merge.ts` refuses a tier whose run-time stamp names a different commit than
 *  merge time. The UNCOMMITTED half cannot be non-empty on any run that is allowed to publish,
 *  because `run/preflight.ts` refuses a whole-tier run on a code-dirty tree and `provenance`'s own
 *  sticky sample stamps anything that goes dirty mid-run, which `merge` then refuses. A scoped dev
 *  loop may of course run dirty — and there this records exactly the uncommitted edit it was
 *  testing, which is the case the question is about. */
export function treeState(): TreeState | undefined {
  if (treeSample !== undefined) {
    return treeSample.value;
  }
  treeSample = { value: undefined };
  const base = spawnSync('git', ['-C', REPO_ROOT, 'merge-base', TREE_BASE_REF, 'HEAD'], { encoding: 'utf8' });
  if (base.status !== 0 || base.stdout.trim() === '') {
    return undefined;
  }
  const baseCommit = base.stdout.trim();
  // ONE `git diff` against the merge-base COMMIT, with no second revision: that form compares it
  // against the working tree, so this branch's commits and its uncommitted edits arrive together
  // rather than as two lists a reader has to union.
  const diff = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--name-only', baseCommit], { encoding: 'utf8' });
  if (diff.status !== 0) {
    return undefined;
  }
  treeSample = { value: { base: TREE_BASE_REF, baseCommit, ...treeChangeSet(diff.stdout) } };
  return treeSample.value;
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
  const wasDirty = sticky?.dirty ?? false;
  sticky = {
    commit: head.stdout.trim(),
    dirty: wasDirty || status.status !== 0 || codeDirtyFrom(status.stdout),
  };
  const notice = wentDirtyNotice(wasDirty, sticky.dirty, status.status === 0 ? codeDirtyPaths(status.stdout) : []);
  if (notice !== undefined) {
    console.error(notice);
  }
  return sticky;
}

/** SAY SO, at the transition, once.
 *
 *  The verdict this samples for is already correct without a word printed: `merge` refuses the
 *  tier and `stale-check` refuses to publish it. What it is not is TIMELY — the round finds out at
 *  `bench:merge`, and the incident that cost the most was 2,420 s of measurement that had already
 *  been worthless for 30 of its 40 minutes. The sample that decides it is taken after every case,
 *  so the loss is knowable within ~2 s and was simply never said aloud.
 *
 *  DETECTIVE, where `run/lock.ts` is preventive, and it does not replace it: the register only
 *  works if whoever edits the tree asks first, while this fires whatever the cause — an agent that
 *  never read a brief, an editor autosave, a neighbour worktree's `pnpm format` sweeping this one.
 *  It fires in the SHARD CHILDREN too, which is where the samples with real resolution are taken:
 *  `orchestrate.ts` spawns them with stderr `inherit`, so the line reaches the run's own log.
 *
 *  Sticky means this can only happen once per process, so there is no rate limit to add. */
export function wentDirtyNotice(wasDirty: boolean, nowDirty: boolean, paths: readonly string[]): string | undefined {
  // The EDGE, not the state: sticky means `nowDirty` stays true for the rest of the process, and a
  // line per case for 291 cases would bury the one that says what happened.
  if (wasDirty || !nowDirty) {
    return undefined;
  }
  const shown = paths.slice(0, 5);
  return [
    '',
    `[provenance] THE TREE WENT DIRTY MID-RUN, in ${paths.length || 'some'} path(s):`,
    ...shown.map((p) => `  ${p}`),
    ...(paths.length > shown.length ? [`  …and ${paths.length - shown.length} more`] : []),
    'This sample is STICKY: every tier this process writes is now stamped dirty, `bench:merge`',
    'will refuse it, and reverting the edit does not undo that. STOP NOW rather than at the end —',
    'revert or commit, then start the run again. (`pnpm bench in-flight` before an edit is the',
    'check that would have prevented this.)',
    '',
  ].join('\n');
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
