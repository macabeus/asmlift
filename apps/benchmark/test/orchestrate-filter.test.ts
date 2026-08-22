import { describe, expect, it } from 'vitest';

import { emptySelectionError, shardQueue, tierIsFiltered } from '../src/run/orchestrate';

// A filter that selects no row used to print `✓ real: 0 results` and exit 0, having replaced a
// good 240-row `real.json` with `results: []` — the file `bench merge` reads next. The verdict is
// taken over the whole run because `--toolchain` only selects in `synthetic` and `--project` only
// in `real`, so "0 rows in this tier" is a legitimate answer for a filter that is not this tier's.
describe('tierIsFiltered', () => {
  it('is false with no filter at all — an unfiltered run can never reach the empty verdict', () => {
    expect(tierIsFiltered('synthetic', {})).toBe(false);
    expect(tierIsFiltered('real', {})).toBe(false);
  });

  it('reads --only in both tiers', () => {
    expect(tierIsFiltered('synthetic', { only: 'Foo' })).toBe(true);
    expect(tierIsFiltered('real', { only: 'Foo' })).toBe(true);
  });

  it('scopes --toolchain to synthetic and --project to real', () => {
    expect(tierIsFiltered('synthetic', { toolchain: 'agbcc' })).toBe(true);
    expect(tierIsFiltered('real', { toolchain: 'agbcc' })).toBe(false);
    expect(tierIsFiltered('real', { project: 'klonoa' })).toBe(true);
    expect(tierIsFiltered('synthetic', { project: 'klonoa' })).toBe(false);
  });
});

// The message is fail-loud output, so it must not claim a write did not happen when it did:
// `--project <typo>` with the default `--tier both` leaves real.json alone but runs synthetic
// WHOLE and rewrites it, because --project does not filter synthetic at all.
describe('emptySelectionError', () => {
  it('names only the tier files that were actually left alone', () => {
    expect(emptySelectionError({ project: 'nosuch' }, ['real']).message).toContain(
      'in tier(s) real — nothing was measured there, and results/real.json left unchanged',
    );
    expect(emptySelectionError({ only: 'Nope' }, ['synthetic', 'real']).message).toContain(
      'results/synthetic.json and results/real.json left unchanged',
    );
  });

  it('quotes back every filter that was in force', () => {
    const m = emptySelectionError({ only: 'Nope', toolchain: 'agbcc' }, ['synthetic']).message;
    expect(m).toContain('--only Nope');
    expect(m).toContain('--toolchain agbcc');
  });
});

// The two tier fans used to be two sequential `Promise.all`s, so every run paid both tiers'
// tails: the real fan could not start until the last synthetic shard exited, and then ran its own
// heaviest shard alone. One queue over `jobs` slots removes that — but only if the queue is still
// exactly the same set of shard tasks, since a shard's slice (`idx % jobs`) is what decides which
// rows it measures.
describe('shardQueue', () => {
  it('is a permutation of every tier × every shard — no row gained, none lost', () => {
    const q = shardQueue({ jobs: 8, tiers: ['synthetic', 'real'] });
    expect(q).toHaveLength(16);
    expect(new Set(q.map((t) => `${t.tier}/${t.shard}`)).size).toBe(16);
    for (const tier of ['synthetic', 'real'] as const) {
      expect(
        q
          .filter((t) => t.tier === tier)
          .map((t) => t.shard)
          .sort((a, b) => a - b),
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it('queues the expensive tier first whichever order --tier gave it', () => {
    for (const tiers of [['synthetic', 'real'] as const, ['real', 'synthetic'] as const]) {
      expect(shardQueue({ jobs: 2, tiers: [...tiers] })).toEqual([
        { tier: 'real', shard: 0 },
        { tier: 'real', shard: 1 },
        { tier: 'synthetic', shard: 0 },
        { tier: 'synthetic', shard: 1 },
      ]);
    }
  });

  it('leaves a single-tier run exactly as it was', () => {
    expect(shardQueue({ jobs: 3, tiers: ['synthetic'] })).toEqual([
      { tier: 'synthetic', shard: 0 },
      { tier: 'synthetic', shard: 1 },
      { tier: 'synthetic', shard: 2 },
    ]);
  });
});
