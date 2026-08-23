// WHICH SOURCE TREE PRODUCED A RANKED SCORE, as a field on the line that carries the score.
//
// docs/ranked-repro.md's argument for the `[ranked]` line is that "a clean run, a truncated log and
// a killed run left identical evidence". The same hole sat one level up: a run against DIFFERENT
// SOURCES left identical evidence too. A reviewer hit it — a second session wrote `target.ts` inside
// a worktree at the moment a ranked run launched and restored it before the run ended, `git status`
// was clean before and after, and the run returned 455 against a reproducible 419 with a spotless
// log. Rounds run in parallel worktrees other agents write to, so this is now a normal hazard rather
// than a freak one, and a score is only comparable to another when both name the tree they measured.
//
// SCOPED TO `packages/`, which is the source a CLI run actually loads (@asmlift/core, this package,
// @asmlift/toolchains). A regenerated benchmark artifact cannot change what a ranked run computes,
// and counting it would stamp every honest run dirty — the same reasoning the benchmark's own
// provenance stamp uses, spelled for this caller instead of shared, because a published CLI cannot
// import the benchmark's policy.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One reading of the tree. `commit === null` means "not measurable" — no git, or the CLI is
 *  running from an installed package rather than the asmlift checkout. */
export interface SourceSample {
  commit: string | null;
  /** `git status --porcelain -- packages`, verbatim. Compared between two samples, so its exact
   *  text matters and its meaning does not. */
  status: string | null;
}

const UNMEASURABLE: SourceSample = { commit: null, status: null };

/** Read HEAD and the working-tree state of the asmlift checkout THIS FILE lives in. */
export function sampleSourceTree(): SourceSample {
  const here = dirname(fileURLToPath(import.meta.url));
  const top = spawnSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) {
    return UNMEASURABLE;
  }
  const root = top.stdout.trim();
  // Installed from npm INTO a git repository, `--show-toplevel` answers about the USER's project —
  // a commit that says nothing about asmlift's sources, which is worse than saying nothing at all.
  // In the checkout this file is exactly `<root>/packages/cli/src/provenance.ts`; from node_modules
  // it is not.
  if (resolve(root, 'packages', 'cli', 'src') !== here) {
    return UNMEASURABLE;
  }
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', 'packages'], { encoding: 'utf8' });
  if (head.status !== 0 || status.status !== 0) {
    return UNMEASURABLE;
  }
  return { commit: head.stdout.trim(), status: status.stdout };
}

/** The stamp, from a sample taken BEFORE the run and one taken AFTER it. Two samples rather than
 *  one because the failure that motivated this was an edit made DURING a run and reverted before it
 *  ended: a single reading at either end reports a clean tree for it. */
export function sourceStamp(before: SourceSample, after: SourceSample): string {
  if (before.commit === null || after.commit === null) {
    return 'asmlift source unversioned';
  }
  const short = before.commit.slice(0, 7);
  if (before.commit !== after.commit || before.status !== after.status) {
    return `asmlift source ${short}, CHANGED DURING THE RUN`;
  }
  return `asmlift source ${short}${before.status === '' ? '' : '+dirty'}`;
}
