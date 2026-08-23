// The stamp on the `[ranked]` line (src/provenance.ts). The FORMATTER is what is pinned here: the
// sampler shells out to git, and its one interesting behaviour — refusing to answer about a tree
// that is not asmlift's — is a path this checkout cannot be in.
import { describe, expect, test } from 'vitest';

import { type SourceSample, sampleSourceTree, sourceStamp } from '../../src/provenance';

const at = (commit: string, status = ''): SourceSample => ({ commit, status });

describe('sourceStamp', () => {
  test('a clean tree names the commit and nothing else', () => {
    expect(sourceStamp(at('8f1e183a'), at('8f1e183a'))).toBe('asmlift source 8f1e183');
  });

  test('an uncommitted source change is stamped, because the commit alone would be a false claim', () => {
    expect(
      sourceStamp(
        at('8f1e183a', ' M packages/core/src/target.ts\n'),
        at('8f1e183a', ' M packages/core/src/target.ts\n'),
      ),
    ).toBe('asmlift source 8f1e183+dirty');
  });

  test('THE RUN THIS EXISTS FOR: an edit made during the run and reverted before it ended', () => {
    // Both single-ended readings are clean — the write landed after the first and the revert before
    // the second — and the score was 36 points off with a spotless log. Only the PAIR sees it.
    const clean = at('8f1e183a');
    const edited = at('8f1e183a', ' M packages/core/src/target.ts\n');
    expect(sourceStamp(clean, edited)).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
    expect(sourceStamp(edited, clean)).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
  });

  test('a commit that moved mid-run is the same refusal', () => {
    expect(sourceStamp(at('8f1e183a'), at('2165836b'))).toBe('asmlift source 8f1e183, CHANGED DURING THE RUN');
  });

  test('an unmeasurable tree says so rather than omitting the field', () => {
    // Absence is what the whole line exists to stop being evidence for anything.
    expect(sourceStamp({ commit: null, status: null }, at('8f1e183a'))).toBe('asmlift source unversioned');
    expect(sourceStamp(at('8f1e183a'), { commit: null, status: null })).toBe('asmlift source unversioned');
  });
});

describe('sampleSourceTree', () => {
  test('in this checkout it answers, and answers the same way twice', () => {
    const a = sampleSourceTree();
    expect(a.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sampleSourceTree()).toEqual(a);
  });
});
