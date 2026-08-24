// The stamp on the `[ranked]` line (src/provenance.ts). Two halves: the FORMATTER, exercised by
// passing samples, and the SAMPLER's one load-bearing property — that it can tell two states of a
// dirty `packages/` apart, which is what every comparison below rests on.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { type SourceSample, bakedBuild, sampleSourceTree, sourceStamp } from '../../src/provenance';

/** A sample of a CLEAN tree at `commit`. `tree` and `content` default so that two samples of the
 *  same committed tree agree — which is what a commit that left `packages/` alone looks like. */
const at = (commit: string, over: Partial<Extract<SourceSample, { commit: string }>> = {}): SourceSample => {
  const tree = over.tree ?? `tree-of-${commit}`;
  return { commit, tree, dirty: false, content: `content-of-${tree}`, ...over };
};
/** A dirty tree, where `content` IS the edit — two different edits are two different values. */
const edited = (commit: string, edit: string): SourceSample => at(commit, { dirty: true, content: edit });
const NONE: SourceSample = { commit: null, tree: null, dirty: null, content: null };

describe('sourceStamp from source', () => {
  test('a clean tree names the commit and nothing else', () => {
    expect(sourceStamp(at('8f1e183a'), at('8f1e183a'), null)).toBe('asmlift source 8f1e183');
  });

  test('an uncommitted source change is stamped, because the commit alone would be a false claim', () => {
    const dirty = edited('8f1e183a', 'target.ts edit 1');
    expect(sourceStamp(dirty, dirty, null)).toBe('asmlift source 8f1e183+dirty');
  });

  test('THE RUN THIS EXISTS FOR: an edit made during the run and reverted before it ended', () => {
    // Both single-ended readings are clean — the write landed after the first and the revert before
    // the second — and the score was 36 points off with a spotless log. Only the PAIR sees it.
    const clean = at('8f1e183a');
    const dirty = edited('8f1e183a', 'target.ts edit 1');
    expect(sourceStamp(clean, dirty, null)).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
    expect(sourceStamp(dirty, clean, null)).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
  });

  test('…including an edit to a file the tree was ALREADY carrying dirty', () => {
    // A perf round's tree is dirty by construction, so a mid-run write lands on a path the tree
    // already listed. As a file LIST that is one unchanging run; as CONTENT it is two.
    expect(sourceStamp(edited('8f1e183a', 'edit 1'), edited('8f1e183a', 'edit 2'), null)).toBe(
      'asmlift source 8f1e183, CHANGED DURING THE RUN',
    );
  });

  test('a commit that moved mid-run is the same refusal', () => {
    expect(sourceStamp(at('8f1e183a'), at('2165836b'), null)).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
  });

  test('an unmeasurable tree says so rather than omitting the field', () => {
    // Absence is what the whole line exists to stop being evidence for anything.
    expect(sourceStamp(NONE, at('8f1e183a'), null)).toBe('asmlift source unversioned');
    expect(sourceStamp(at('8f1e183a'), NONE, null)).toBe('asmlift source unversioned');
  });
});

describe('sourceStamp from a bundle', () => {
  test('a fresh bundle stamps exactly what a source run in the same checkout stamps', () => {
    // The point of offering the faster loader at all: swapping it in moves no line anyone quotes.
    expect(sourceStamp(at('8f1e183a'), at('8f1e183a'), at('8f1e183a'))).toBe('asmlift source 8f1e183');
  });

  test('a bundle built from a dirty tree carries the dirt it baked', () => {
    const dirty = edited('8f1e183a', 'target.ts edit 1');
    expect(sourceStamp(dirty, dirty, dirty)).toBe('asmlift source 8f1e183+dirty');
  });

  test('a bundle the checkout has moved past is LOUD, and still names the code that ran', () => {
    // The reason a bundle cannot just read HEAD: it would answer 2165836 while running 8f1e183.
    expect(sourceStamp(at('2165836b'), at('2165836b'), at('8f1e183a'))).toBe(
      'asmlift source 8f1e183, STALE BUNDLE: packages/ differs from the checkout at 2165836',
    );
  });

  test('a commit that left packages/ alone is NOT staleness', () => {
    // Docs and the regenerated benchmark artifact are committed constantly. An alarm that fires on
    // those is an alarm nobody reads, and the bundle really is still this checkout's decompiler.
    const t = { tree: 'a1b2c3d' };
    expect(sourceStamp(at('2165836b', t), at('2165836b', t), at('8f1e183a', t))).toBe('asmlift source 8f1e183');
  });

  test('an edit to packages/ since the build is the same staleness at the same commit', () => {
    const dirty = edited('8f1e183a', 'target.ts edit 1');
    expect(sourceStamp(dirty, dirty, at('8f1e183a'))).toBe(
      'asmlift source 8f1e183, STALE BUNDLE: packages/ edited since the build',
    );
  });

  test('THE STATE A PERF ROUND LIVES IN: the bundle baked one edit, the tree now holds another', () => {
    // Same commit, same committed tree, and dirty in the same FILES on both sides — every reading
    // of this that stops at paths is identical, and the bundle is running the first edit's code.
    const built = edited('8f1e183a', 'rank.ts edit 1');
    const now = edited('8f1e183a', 'rank.ts edit 2');
    expect(sourceStamp(now, now, built)).toBe(
      'asmlift source 8f1e183+dirty, STALE BUNDLE: packages/ edited since the build',
    );
  });

  test('a checkout that moves DURING the run is stale at whichever end disagrees', () => {
    // Neither end can invalidate the run — the bundle is frozen — but a bake only one of the two
    // samples agrees with is not one anybody should quote as current.
    const built = at('8f1e183a');
    const moved = at('2165836b');
    const stale = 'asmlift source 8f1e183, STALE BUNDLE: packages/ differs from the checkout at 2165836';
    expect(sourceStamp(built, moved, built)).toBe(stale);
    expect(sourceStamp(moved, built, built)).toBe(stale);
  });

  test('an installed package stays unversioned, bake or no bake', () => {
    // Nothing around it can check the bake, and a stamp indistinguishable from a verified one is
    // exactly the confidently-wrong claim `unversioned` refuses to make.
    expect(sourceStamp(NONE, NONE, at('8f1e183a'))).toBe('asmlift source unversioned');
    expect(sourceStamp(at('8f1e183a'), at('8f1e183a'), NONE)).toBe('asmlift source unversioned');
  });
});

describe('sampleSourceTree', () => {
  test('in this checkout it answers, and answers the same way twice', () => {
    const a = sampleSourceTree();
    expect(a.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sampleSourceTree()).toEqual(a);
  });

  test('every state of a dirty packages/ reads differently, which is what the stamps compare', () => {
    // The formatter above only compares samples, so it is exactly as sharp as the sampler's ability
    // to DIFFER — and a file list cannot tell these three states apart: git names the same one path
    // for both writes below, and collapses an untracked directory to one entry however many files
    // land in it.
    const dir = resolve(import.meta.dirname, '__provenance-probe__');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.txt'), 'one');
      const first = sampleSourceTree();
      writeFileSync(join(dir, 'a.txt'), 'two');
      const rewritten = sampleSourceTree();
      writeFileSync(join(dir, 'b.txt'), 'three');
      const added = sampleSourceTree();
      expect(first.dirty).toBe(true);
      expect(first.tree).toBe(rewritten.tree); // nothing was committed; only the worktree moved
      expect(new Set([first.content, rewritten.content, added.content]).size).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bakedBuild', () => {
  test('a source run has no bake, which is what selects the source rules', () => {
    expect(bakedBuild()).toBeNull();
  });
});
