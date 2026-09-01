// Pin the RUN-time provenance stamp and the merge refusal it feeds. The defect this exists for is
// a silent one: a bench run made against a modified working tree that was reverted before
// `bench:merge` published `dirty: false`, because merge sampled git only at merge time. Both
// halves are pinned — what counts as dirty, and that a disagreement THROWS rather than merges.
import type { BenchOutput } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import { codeDirtyFrom } from '../src/provenance';
import { checkTierProvenance } from '../src/report/merge';

const tier = (asmlift?: { commit: string; dirty: boolean }): BenchOutput =>
  ({ meta: { generatedAt: 'whenever', ...(asmlift ? { asmlift } : {}) }, results: [] }) as unknown as BenchOutput;

const NOW = { commit: 'aaaa', dirty: false };

describe('what counts as a dirty tree', () => {
  test('a modified source file does', () => {
    expect(codeDirtyFrom(' M packages/core/src/rank.ts\n')).toBe(true);
  });

  test('an untracked rig or knob does', () => {
    expect(codeDirtyFrom('?? packages/core/src/probe.ts\n')).toBe(true);
  });

  test("the benchmark's own regenerated artifacts do not", () => {
    expect(codeDirtyFrom(' M apps/benchmark/results/results.json\n M apps/web/src/data/summary.json\n')).toBe(false);
  });

  test('untracked .claude/commands/ docs do not, and untracked .claude/settings does', () => {
    expect(codeDirtyFrom('?? .claude/commands/attribute-function.md\n')).toBe(false);
    expect(codeDirtyFrom('?? .claude/settings.local.json\n')).toBe(true);
  });

  test('a clean tree is clean', () => {
    expect(codeDirtyFrom('')).toBe(false);
    expect(codeDirtyFrom('\n')).toBe(false);
  });
});

describe('the merge refusal', () => {
  test('a tier RUN against a dirty tree is refused, however clean merge time is', () => {
    expect(() => checkTierProvenance('real.json', tier({ commit: 'aaaa', dirty: true }), NOW)).toThrow(/dirty/);
  });

  test('a tier run at another commit is refused', () => {
    expect(() => checkTierProvenance('real.json', tier({ commit: 'bbbb', dirty: false }), NOW)).toThrow(/moved/);
  });

  test('agreement passes', () => {
    expect(() => checkTierProvenance('real.json', tier(NOW), NOW)).not.toThrow();
  });

  test('an OLD tier with no stamp passes — an absence is not a mutation', () => {
    expect(() => checkTierProvenance('real.json', tier(), NOW)).not.toThrow();
    expect(() => checkTierProvenance('real.json', undefined, NOW)).not.toThrow();
  });

  test('an unreadable git at merge time still catches a dirty RUN', () => {
    expect(() => checkTierProvenance('real.json', tier({ commit: 'aaaa', dirty: true }), undefined)).toThrow(/dirty/);
  });
});
