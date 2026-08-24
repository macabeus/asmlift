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
//
// ON CONTENT, NOT ON A FILE LIST. The comparisons below are between two samples of the same tree at
// two moments, and `git status` answers with PATHS: two different edits to one already-modified file
// print the same status text, as do adding files to an already-untracked directory. That is the
// normal state of a perf round — `packages/` dirty by construction — so a reading that cannot see
// inside it would have called a bundle current while it ran the previous edit's code. `content`
// therefore hashes what every tracked-or-untracked source file under `packages/` CONTAINS.
//
// TWO LOADERS ANSWER THE QUESTION DIFFERENTLY. Under tsx the sources are read every run, so the
// checkout the CLI stands in IS the code it ran. The esbuild bundle (`dist/asmlift.mjs`, the fast
// loader docs/ranked-repro.md runs) froze `packages/` when it was built, so reading HEAD at run time
// would let a stale bundle name a commit whose code it is not running — a confidently wrong stamp
// where `unversioned` is an honest one. A bundle therefore stamps what scripts/build.mjs BAKED into
// it, and the checkout around it is evidence of one thing only: whether that bake is still current.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One reading of a tree — all four fields or none, since they come from the same run of git.
 *  `commit === null` means "not measurable": no git, or the CLI is running from an installed
 *  package rather than the asmlift checkout. */
export type SourceSample =
  | {
      /** What the stamp NAMES, because it is what a reader compares two runs by. */
      commit: string;
      /** `git rev-parse HEAD:packages` — the committed CONTENT of the loaded source, which is what
       *  two points in history have to share to be the same decompiler. A docs or benchmark-artifact
       *  commit moves `commit` and leaves this alone. */
      tree: string;
      /** Whether anything under `packages/` is uncommitted — the `+dirty` half of the stamp, which
       *  is a question about paths and is answered as one. */
      dirty: boolean;
      /** A digest of what every source file under `packages/` CONTAINS. Compared for equality
       *  against another sample of the same tree, so its exact value means nothing on its own. */
      content: string;
    }
  | { commit: null; tree: null; dirty: null; content: null };

/** A sample that answered. */
type Measured = Extract<SourceSample, { commit: string }>;

const UNMEASURABLE: SourceSample = { commit: null, tree: null, dirty: null, content: null };

const UNVERSIONED = 'asmlift source unversioned';

/** scripts/build.mjs bakes its reading of the checkout in through esbuild `--define`; a source run
 *  leaves the name undeclared. That absence is also how the stamp knows which loader it is on. */
declare const __ASMLIFT_BUILD__: SourceSample | undefined;

/** What this bundle was built from, or `null` when the CLI is running from source. */
export function bakedBuild(): SourceSample | null {
  return typeof __ASMLIFT_BUILD__ === 'undefined' ? null : __ASMLIFT_BUILD__;
}

/** Read HEAD and the working-tree CONTENT of the asmlift checkout the CLI's code lives in.
 *
 *  `at` is that code's directory, and defaults to this module's own — scripts/build.mjs passes
 *  `packages/cli/src` because it bundles and calls THIS function for the bake rather than restating
 *  the reading, which is the only way the two samples stay comparable as this one changes. */
export function sampleSourceTree(at: string = dirname(fileURLToPath(import.meta.url))): SourceSample {
  const top = spawnSync('git', ['-C', at, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) {
    return UNMEASURABLE;
  }
  const root = top.stdout.trim();
  // Installed from npm INTO a git repository, `--show-toplevel` answers about the USER's project —
  // a commit that says nothing about asmlift's sources, which is worse than saying nothing at all.
  // In the checkout this module is exactly `<root>/packages/cli/src` or, bundled, `<root>/packages/
  // cli/dist`; from node_modules it is neither.
  if (!['src', 'dist'].some((d) => resolve(root, 'packages', 'cli', d) === at)) {
    return UNMEASURABLE;
  }
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const tree = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD:packages'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', 'packages'], { encoding: 'utf8' });
  // Tracked AND untracked-but-not-ignored, one path per record: `dist/` and `node_modules/` are
  // gitignored, so building never changes the reading of the tree it is measuring.
  const list = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages'];
  const files = spawnSync('git', ['-C', root, ...list], { encoding: 'utf8' });
  if (head.status !== 0 || tree.status !== 0 || status.status !== 0 || files.status !== 0) {
    return UNMEASURABLE;
  }
  return {
    commit: head.stdout.trim(),
    tree: tree.stdout.trim(),
    dirty: status.stdout.trim() !== '',
    content: contentDigest(root, files.stdout),
  };
}

/** Hash every listed file's PATH and BYTES. ~30 ms over `packages/`, taken twice per ranked run. */
function contentDigest(root: string, list: string): string {
  const h = createHash('sha256');
  for (const path of list.split('\0').filter((p) => p !== '')) {
    h.update(path);
    h.update('\0');
    try {
      h.update(
        createHash('sha256')
          .update(readFileSync(resolve(root, path)))
          .digest(),
      );
    } catch {
      // Listed but unreadable — a file deleted since git enumerated it, or one the reader cannot
      // open. Recorded as its own state so it is never the same reading as an unchanged file.
      h.update('unreadable');
    }
  }
  return h.digest('hex');
}

/** The stamp, from a sample taken BEFORE the run, one taken AFTER it, and — when the CLI is a
 *  bundle — what that bundle was built from.
 *
 *  Two runtime samples rather than one because a single reading is blind to any edit not standing
 *  at that instant, and a parallel session's write to `packages/` usually outlives one end of a run.
 *  The pair reports an edit present at EITHER instant; one that lands and is reverted strictly
 *  between them is still invisible, so this narrows the blind window to the run without closing it.
 *  No such edit can reach a bundle, whose `packages/` is frozen at build time and whose one file
 *  node loads at startup, so there the pair serves the staleness comparison instead. */
export function sourceStamp(before: SourceSample, after: SourceSample, built: SourceSample | null): string {
  if (built !== null) {
    return bundleStamp(built, before, after);
  }
  if (before.commit === null || after.commit === null) {
    return UNVERSIONED;
  }
  const short = before.commit.slice(0, 7);
  if (before.commit !== after.commit || before.content !== after.content) {
    return `asmlift source ${short}, CHANGED DURING THE RUN`;
  }
  return `asmlift source ${short}${before.dirty ? '+dirty' : ''}`;
}

/** The bake names the code that ran; the checkout says whether that is still the checkout's code. */
function bundleStamp(built: SourceSample, before: SourceSample, after: SourceSample): string {
  if (built.commit === null) {
    return UNVERSIONED;
  }
  if (before.commit === null || after.commit === null) {
    // An installed package, whose surrounding repo is not asmlift's. The bake is true, but nothing
    // here can check it against anything, and a stamp indistinguishable from a verified one is the
    // confidently-wrong claim this file exists to prevent.
    return UNVERSIONED;
  }
  const base = `asmlift source ${built.commit.slice(0, 7)}${built.dirty ? '+dirty' : ''}`;
  const drift = driftFrom(built, before) ?? driftFrom(built, after);
  return drift === null ? base : `${base}, STALE BUNDLE: ${drift}`;
}

/** How a checkout's `packages/` disagrees with the bake, or `null` when it still agrees. On CONTENT,
 *  not on the commit: this repo commits regenerated benchmark artifacts and docs constantly, and a
 *  staleness alarm that fires on those is one nobody reads. The committed tree is checked first only
 *  because it can name the commit the checkout moved to; `content` is what decides. */
function driftFrom(built: Measured, checkout: Measured): string | null {
  if (checkout.tree !== built.tree) {
    return `packages/ differs from the checkout at ${checkout.commit.slice(0, 7)}`;
  }
  if (checkout.content !== built.content) {
    return 'packages/ edited since the build';
  }
  return null;
}
