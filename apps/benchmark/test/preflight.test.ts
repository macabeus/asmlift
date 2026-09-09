// The START-time half of the provenance story. `provenance.test.ts` pins the mid-run sample and the
// merge refusal; this pins what is refused before the run spends anything, and — the part that
// actually matters — what is NOT refused, because a preflight that stops the `--only` dev loop
// would be traded away within a round.
import { describe, expect, test } from 'vitest';

import { cppRefusal, dirtyTreeRefusal, runIsWholeTier } from '../src/run/preflight';

describe('which runs are checked at all', () => {
  test('an unfiltered run of either tier is — it rewrites the tier file whole', () => {
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'] })).toBe(true);
    expect(runIsWholeTier({ tiers: ['real'] })).toBe(true);
    expect(runIsWholeTier({ tiers: ['synthetic'] })).toBe(true);
  });

  test('the scoped dev loop is NOT — a dirty tree is the point of it', () => {
    expect(runIsWholeTier({ tiers: ['real'], only: 'sub_802DFC8' })).toBe(false);
    expect(runIsWholeTier({ tiers: ['synthetic'], toolchain: 'agbcc' })).toBe(false);
    expect(runIsWholeTier({ tiers: ['real'], project: 'kleod' })).toBe(false);
  });

  test('a filter that selects in only ONE of two tiers still leaves the other whole', () => {
    // `--toolchain` filters synthetic alone, so `--tier both --toolchain agbcc` rewrites real.json
    // in full — the same file merge publishes.
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'], toolchain: 'agbcc' })).toBe(true);
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'], project: 'kleod' })).toBe(true);
    // `--only` reads both tiers, so it scopes the whole run.
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'], only: 'dmaback' })).toBe(false);
  });

  test('a shard CHILD is exempt — its parent already answered, once', () => {
    expect(runIsWholeTier({ tiers: ['real'], shard: '3/8' })).toBe(false);
  });
});

describe('the dirty-tree refusal', () => {
  test('names every offending path, so nobody re-runs git status to guess', () => {
    const msg = dirtyTreeRefusal(['?? .envrc.probe', 'M packages/core/src/rank.ts']);
    expect(msg).toContain('.envrc.probe');
    expect(msg).toContain('packages/core/src/rank.ts');
    expect(msg).toContain('2 paths');
  });

  test('points at the ONE sanctioned name for a local env file', () => {
    // Without a sanctioned name the refusal is just an obstacle, and the round routes around it.
    expect(dirtyTreeRefusal(['?? envrc.sh'])).toContain('.envrc.local');
  });

  test('a clean tree refuses nothing', () => {
    expect(dirtyTreeRefusal([])).toBeUndefined();
  });
});

describe('the cpp probe refusal', () => {
  test('a cpp that ignores -o is refused, with what it did', () => {
    const msg = cppRefusal({ ok: false, how: 'exit 1: cc: error: no input files' });
    expect(msg).toContain('no input files');
    expect(msg).toContain('ASMLIFT_CPP');
  });

  test('a working cpp refuses nothing', () => {
    expect(cppRefusal({ ok: true, how: 'ok' })).toBeUndefined();
  });
});
