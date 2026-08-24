// The stamp on the `[ranked]` line (src/provenance.ts). The FORMATTER is what is pinned here: the
// sampler shells out to git, and its one interesting behaviour — refusing to answer about a tree
// that is not asmlift's — is a path this checkout cannot be in. The bundle's bake is likewise a
// build artifact, so its state matrix is exercised by passing samples rather than by building.
import { describe, expect, test } from 'vitest';

import { type SourceSample, bakedBuild, sampleSourceTree, sourceStamp } from '../../src/provenance';

/** `tree` defaults to one per commit; the two are given separately only where a commit moved
 *  WITHOUT `packages/` moving, which is what a docs or benchmark-artifact commit does. */
const at = (commit: string, status = '', tree = `tree-of-${commit}`): SourceSample => ({ commit, tree, status });
const NONE: SourceSample = { commit: null, tree: null, status: null };

describe('sourceStamp from source', () => {
  test('a clean tree names the commit and nothing else', () => {
    expect(sourceStamp(at('8f1e183a'), at('8f1e183a'), null)).toBe('asmlift source 8f1e183');
  });

  test('an uncommitted source change is stamped, because the commit alone would be a false claim', () => {
    expect(
      sourceStamp(
        at('8f1e183a', ' M packages/core/src/target.ts\n'),
        at('8f1e183a', ' M packages/core/src/target.ts\n'),
        null,
      ),
    ).toBe('asmlift source 8f1e183+dirty');
  });

  test('THE RUN THIS EXISTS FOR: an edit made during the run and reverted before it ended', () => {
    // Both single-ended readings are clean — the write landed after the first and the revert before
    // the second — and the score was 36 points off with a spotless log. Only the PAIR sees it.
    const clean = at('8f1e183a');
    const edited = at('8f1e183a', ' M packages/core/src/target.ts\n');
    expect(sourceStamp(clean, edited, null)).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
    expect(sourceStamp(edited, clean, null)).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
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
    const dirty = at('8f1e183a', ' M packages/core/src/target.ts\n');
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
    const shared = 'a1b2c3d';
    expect(sourceStamp(at('2165836b', '', shared), at('2165836b', '', shared), at('8f1e183a', '', shared))).toBe(
      'asmlift source 8f1e183',
    );
  });

  test('an edit to packages/ since the build is the same staleness at the same commit', () => {
    const edited = at('8f1e183a', ' M packages/core/src/target.ts\n');
    expect(sourceStamp(edited, edited, at('8f1e183a'))).toBe(
      'asmlift source 8f1e183, STALE BUNDLE: packages/ edited since the build',
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
});

describe('bakedBuild', () => {
  test('a source run has no bake, which is what selects the source rules', () => {
    expect(bakedBuild()).toBeNull();
  });
});
