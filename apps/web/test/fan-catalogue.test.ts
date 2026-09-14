// The Fan Explorer's numbers, held to a direct count over the rows. Two samples: the fixture, real
// producer output that carries `fanVariations` (six synthetic rows and five real ones, over three
// toolchains, one of them noncompile), and the committed artifact the tab renders.
import type { FunctionResult } from '@asmlift/bench-schema';
import { VARIATION_KINDS, VARIATION_TOKENS, hasVariation } from '@asmlift/core/variation-tokens';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  catalogue,
  fanCoverage,
  pricePerWin,
  priced,
  rowsFor,
  variationStats,
  winRate,
} from '../src/pages/benchmark/lib/fan';

const load = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { results: FunctionResult[] }).results;
const fixture = load(join(import.meta.dirname, 'fixtures/fan-rows.json'));
const artifact = load(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'));

describe.each([
  ['the fixture', fixture],
  ['the committed artifact', artifact],
])('over %s', (_, rows) => {
  const stats = variationStats(rows);

  test('the catalogue holds every registered variation exactly once, grouped by kind in name order', () => {
    const groups = catalogue(stats);
    expect(groups.map((g) => g.kind)).toEqual([...VARIATION_KINDS]);
    const names = groups.flatMap((g) => g.variations.map((s) => s.name));
    expect([...names].sort()).toEqual(VARIATION_TOKENS.map((t) => t.name).sort());
    for (const g of groups) {
      expect(g.variations.every((s) => s.kind === g.kind)).toBe(true);
      const winners = g.variations.map((s) => s.winners);
      expect(winners).toEqual([...winners].sort((a, b) => b - a));
    }
  });

  test('winners, rows and candidates equal a direct count over the rows', () => {
    for (const { name } of VARIATION_TOKENS) {
      const s = stats.get(name)!;
      expect(s.winners, name).toBe(rows.filter((r) => hasVariation(r.asmlift.winnerVariations ?? [], name)).length);
      expect(s.rows, name).toBe(rows.filter((r) => r.asmlift.fanVariations?.[name]).length);
      expect(s.candidates, name).toBe(rows.reduce((a, r) => a + (r.asmlift.fanVariations?.[name]?.candidates ?? 0), 0));
    }
  });

  test('a row that recorded its fan carries every variation its winner does', () => {
    const missing = rows
      .filter((r) => r.asmlift.fanVariations)
      .flatMap((r) =>
        (r.asmlift.winnerVariations ?? [])
          .filter(
            (part) => !VARIATION_TOKENS.some((t) => t.name in r.asmlift.fanVariations! && hasVariation([part], t.name)),
          )
          .map((part) => `${r.id}: ${part}`),
      );
    expect(missing).toEqual([]);
  });

  test('the price per win runs dearest first, then the never-won', () => {
    const prices = priced(stats).map(pricePerWin);
    const won = prices.filter((p) => p !== null);
    expect(prices.slice(0, won.length)).toEqual(won);
    expect(won).toEqual([...won].sort((a, b) => b - a));
  });
});

describe('over the fixture, where every row recorded its fan', () => {
  const stats = variationStats(fixture);

  test('it is the sample it claims to be', () => {
    expect(fanCoverage(fixture).rows).toBe(fixture.length);
    expect(new Set(fixture.map((r) => r.toolchain)).size).toBe(3);
    expect(fixture.some((r) => r.asmlift.outcome === 'noncompile')).toBe(true);
  });

  test('the two signedness entries sum to the candidates in every fan', () => {
    expect(stats.get('unsigned')!.candidates + stats.get('signed')!.candidates).toBe(fanCoverage(fixture).candidates);
  });

  test('a win rate never exceeds one, and is null only where no fan carried the variation', () => {
    for (const s of stats.values()) {
      const rate = winRate(s);
      expect(rate === null, s.name).toBe(s.rows === 0);
      expect(rate ?? 0, s.name).toBeLessThanOrEqual(1);
    }
  });

  test("a variation's rows: winners first, this variation lit in the winner's variations, losers unlit", () => {
    const list = rowsFor(fixture, 'volatile');
    const won = list.filter((r) => r.won);
    expect(won.length).toBe(stats.get('volatile')!.winners);
    expect(list.length).toBe(stats.get('volatile')!.rows);
    expect(list.slice(0, won.length)).toEqual(won);
    for (const r of list) {
      expect(r.winner.some((p) => p.lit)).toBe(r.won);
      expect(r.winner.map((p) => p.part)).toEqual(r.row.asmlift.winnerVariations ?? []);
    }
  });

  test('a noncompile row is listed as considered and lost, with no winner', () => {
    const lost = rowsFor(fixture, 'sinkinit').find((r) => r.row.asmlift.outcome === 'noncompile');
    expect(lost).toMatchObject({ won: false, winner: [], tally: { candidates: 1, dropped: 1 } });
  });
});
