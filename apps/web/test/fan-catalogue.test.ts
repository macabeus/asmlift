// The Fan Explorer's numbers, held to a direct count over the rows. Two samples: `FAN_SAMPLE`, ranked
// rows carrying `fanVariations` over three toolchains (one of them noncompile), and the committed
// artifact the tab renders.
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
import { FAN_SAMPLE } from './fan-sample';

const artifact = (
  JSON.parse(readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8')) as {
    results: FunctionResult[];
  }
).results;

describe.each([
  ['the sample', FAN_SAMPLE],
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

  test('rows, winners and candidates equal a direct count over the rows whose fan carried the variation', () => {
    for (const { name } of VARIATION_TOKENS) {
      const s = stats.get(name)!;
      const carried = rows.filter((r) => r.asmlift.fanVariations?.[name]);
      expect(s.rows, name).toBe(carried.length);
      expect(s.winners, name).toBe(carried.filter((r) => hasVariation(r.asmlift.winnerVariations ?? [], name)).length);
      expect(s.candidates, name).toBe(carried.reduce((a, r) => a + r.asmlift.fanVariations![name].candidates, 0));
    }
  });

  test('a win rate never passes one, a price per win is never zero, and each is null exactly when undefined', () => {
    for (const s of stats.values()) {
      const rate = winRate(s);
      expect(rate === null, s.name).toBe(s.rows === 0);
      expect(rate ?? 0, s.name).toBeLessThanOrEqual(1);
      const price = pricePerWin(s);
      expect(price === null, s.name).toBe(s.winners === 0);
      expect(price, s.name).not.toBe(0);
    }
  });

  test('a row whose fan was counted carries every variation its winner does', () => {
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

describe('over the sample', () => {
  const stats = variationStats(FAN_SAMPLE);

  test('it is the sample it claims to be', () => {
    expect(fanCoverage(FAN_SAMPLE).rows).toBe(FAN_SAMPLE.length);
    expect(new Set(FAN_SAMPLE.map((r) => r.toolchain)).size).toBe(3);
    expect(FAN_SAMPLE.some((r) => r.asmlift.outcome === 'noncompile')).toBe(true);
    expect(FAN_SAMPLE.some((r) => Object.values(r.asmlift.fanVariations!).some((t) => t.withheld))).toBe(true);
  });

  test('the two signedness entries sum to the candidates in every fan', () => {
    expect(stats.get('unsigned')!.candidates + stats.get('signed')!.candidates).toBe(
      fanCoverage(FAN_SAMPLE).candidates,
    );
  });

  test("a variation's rows: winners first, this variation lit in the winner's variations, subject and all", () => {
    for (const name of ['volatile', 'coalesce'] as const) {
      const list = rowsFor(FAN_SAMPLE, name);
      const won = list.filter((r) => r.won);
      expect(won.length, name).toBe(stats.get(name)!.winners);
      expect(list.length, name).toBe(stats.get(name)!.rows);
      expect(list.slice(0, won.length), name).toEqual(won);
      for (const r of list) {
        expect(r.winner.some((p) => p.lit)).toBe(r.won);
        expect(r.winner.map((p) => p.part)).toEqual(r.row.asmlift.winnerVariations ?? []);
      }
    }
    expect(rowsFor(FAN_SAMPLE, 'coalesce').flatMap((r) => r.winner.filter((p) => p.lit).map((p) => p.part))).toEqual([
      'coalesce-v1-v0',
    ]);
  });

  test('a noncompile row is listed as considered and lost, with no winner', () => {
    const lost = rowsFor(FAN_SAMPLE, 'sinkinit').find((r) => r.row.asmlift.outcome === 'noncompile');
    expect(lost).toMatchObject({ won: false, winner: [], tally: { candidates: 1, dropped: 1 } });
  });

  test('a row whose fan was not counted counts nowhere, its winner included', () => {
    const { fanVariations: _, ...uncounted } = FAN_SAMPLE[0].asmlift;
    const row: FunctionResult = { ...FAN_SAMPLE[0], id: 'synthetic:uncounted:agbcc', asmlift: uncounted };
    expect(variationStats([...FAN_SAMPLE, row])).toEqual(stats);
    for (const { name } of VARIATION_TOKENS) {
      expect(rowsFor([...FAN_SAMPLE, row], name)).toEqual(rowsFor(FAN_SAMPLE, name));
    }
  });
});
