// The Function Explorer's side of the fan: the sparse fan column, and the function detail's winning
// spelling with what the row considered and lost. Two samples, as the tab's tests: `FAN_SAMPLE`
// (ranked rows carrying `fanVariations`, one noncompile row) and the committed artifact the page
// renders. apps/web has no DOM, so components render through `renderToStaticMarkup`, and the
// Explorer's URL state through nuqs's testing adapter.
import { type FunctionResult, resolveRow } from '@asmlift/bench-schema';
import { VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { VARIATION_KINDS, parseVariation, variationToken } from '@asmlift/core/variation-tokens';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { Explorer } from '../src/pages/benchmark/components/Explorer';
import { WinningSpelling } from '../src/pages/benchmark/components/WinningSpelling';
import { rowHref } from '../src/pages/benchmark/lib/explorer-url';
import {
  FAN_CHIP_FLOOR,
  compactCount,
  compareFanChip,
  consideredButLost,
  fanChip,
  rowsFor,
  winnerNames,
  winningSpelling,
} from '../src/pages/benchmark/lib/fan';
import { hashToSearchParams } from '../src/shared/utils/hash-params';
import { FAN_SAMPLE } from './fan-sample';

// The feature picker reads the live fragment through `useSyncExternalStore` over `window`, which a
// server render has no snapshot for. The table under test does not depend on it. (`vi.mock` is
// hoisted above the imports.)
vi.mock('../src/shared/utils/hash-adapter', () => ({ useCurrentHash: () => '' }));

const artifact = (
  JSON.parse(readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8')) as {
    results: FunctionResult[];
  }
).results;

const NOT_WASTE = 'A losing candidate is not waste.';
const noop = () => {};
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const kindIndex = (name: string) => VARIATION_KINDS.indexOf(variationToken(name).variationKind);

describe.each([
  ['the sample', FAN_SAMPLE],
  ['the committed artifact', artifact],
])('the winning spelling and what was lost, over %s', (_, rows) => {
  test("the winning spelling is the winner's variations, every part once, grouped by kind in kind order", () => {
    for (const row of rows) {
      const groups = winningSpelling(row);
      const parts = groups.flatMap((g) => g.items.map((p) => p.part));
      // part of the fan's account: a row whose fan was not counted has none
      const expected = row.asmlift.fanVariations ? (row.asmlift.winnerVariations ?? []) : [];
      expect([...parts].sort(), row.id).toEqual([...expected].sort());
      expect(
        groups.map((g) => VARIATION_KINDS.indexOf(g.kind)),
        row.id,
      ).toEqual(groups.map((g) => VARIATION_KINDS.indexOf(g.kind)).sort((a, b) => a - b));
      for (const g of groups) {
        expect(g.items.length, row.id).toBeGreaterThan(0);
        expect(
          g.items.every((p) => variationToken(p.name).variationKind === g.kind),
          row.id,
        ).toBe(true);
        // within a kind, the order the winner applied them
        const published = (row.asmlift.winnerVariations ?? []).filter((part) => g.items.some((p) => p.part === part));
        expect(
          g.items.map((p) => p.part),
          row.id,
        ).toEqual(published);
      }
    }
  });

  test("considered and lost is the fan's variations minus the winner's", () => {
    for (const row of rows) {
      const lost = consideredButLost(row);
      const roster = row.asmlift.fanVariations ?? {};
      const won = winnerNames(row);
      const names = lost.flatMap((g) => g.items.map((v) => v.name));
      expect([...names].sort(), row.id).toEqual(
        Object.keys(roster)
          .filter((k) => !won.has(parseVariation(k).name))
          .sort(),
      );
      for (const g of lost) {
        for (const v of g.items) {
          expect(v.tally, `${row.id} ${v.name}`).toEqual(roster[v.name]);
          expect(variationToken(v.name).variationKind).toBe(g.kind);
        }
      }
      expect(lost.map((g) => kindIndex(g.items[0].name))).toEqual(
        lost.map((g) => kindIndex(g.items[0].name)).sort((a, b) => a - b),
      );
    }
  });

  test('the detail renders every part and every lost variation, each a link to its drawer that lists this row', () => {
    // a drawer's rows are the same for every link to it, so each is listed once, not once per link
    const listed = new Map<string, Set<FunctionResult>>();
    const drawerLists = (name: string): Set<FunctionResult> => {
      let set = listed.get(name);
      if (!set) {
        set = new Set(rowsFor(rows, name as never).map((r) => r.row));
        listed.set(name, set);
      }
      return set;
    };
    for (const row of rows) {
      const hash = rowHref(row.id, '#view=benchmark');
      const html = renderToStaticMarkup(<WinningSpelling fn={row} hash={hash} onOpenVariation={noop} />);
      const spelling = winningSpelling(row);
      const lost = consideredButLost(row);
      if (!row.asmlift.fanVariations) {
        expect(html, row.id).toBe(''); // its fan was never counted
        continue;
      }
      expect(html, row.id).not.toContain('`');

      const links = hrefs(html).map(hashToSearchParams);
      const expected = new Set([
        ...spelling.flatMap((g) => g.items.map((p) => p.name)),
        ...lost.flatMap((g) => g.items.map((v) => v.name)),
      ]);
      expect(new Set(links.map((p) => p.get('variation'))), row.id).toEqual(expected);
      for (const p of links) {
        // the drawer opens OVER this row's detail: closing it (dropping `variation`) returns here
        expect(p.get('view'), row.id).toBe('benchmark');
        expect(p.get('tab'), row.id).toBe('explorer');
        expect(resolveRow(rows, p.get('fn')!), row.id).toBe(row);
        // and the drawer it opens lists this row, whose own link comes back to this detail
        expect(drawerLists(p.get('variation')!).has(row), `${row.id} ${p.get('variation')}`).toBe(true);
      }
      for (const part of row.asmlift.winnerVariations ?? []) {
        expect(html, row.id).toContain(`>${part}</span>`);
      }

      const lostCount = lost.reduce((n, g) => n + g.items.length, 0);
      expect(html.includes(NOT_WASTE), row.id).toBe(lostCount > 0);
      expect(html.includes('No candidate won'), row.id).toBe(spelling.length === 0);
      // a row with no winner is never headed as if one was chosen
      expect(html.includes('The winning spelling'), row.id).toBe(spelling.length > 0);
      expect(html.includes('chosen from'), row.id).toBe(spelling.length > 0);
      expect(html.includes('No winning spelling'), row.id).toBe(spelling.length === 0);
    }
  });
});

test('a row with no winner lists every variation its fan carried as lost', () => {
  const row = FAN_SAMPLE.find((r) => !r.asmlift.winnerVariations)!;
  expect(row, 'the sample keeps a ranked row with no winner').toBeDefined();
  const names = consideredButLost(row).flatMap((g) => g.items.map((v) => v.name));
  expect([...names].sort()).toEqual(Object.keys(row.asmlift.fanVariations!).sort());
});

test("each winning variation shows its definition's title inline, not only on hover", () => {
  const row = FAN_SAMPLE.find((r) => r.id === 'synthetic:dmafield:agbcc')!;
  const html = renderToStaticMarkup(<WinningSpelling fn={row} hash="#view=benchmark" onOpenVariation={noop} />);
  for (const part of row.asmlift.winnerVariations!) {
    const title = VARIATION_DEFINITIONS[parseVariation(part).name].title.split('`')[0];
    expect(html).toContain(title.replace(/'/g, '&#x27;'));
  }
});

describe('the fan column', () => {
  test(`shows a chip exactly on the rows whose fan is past ${FAN_CHIP_FLOOR}`, () => {
    const chips = artifact.filter((r) => fanChip(r) !== null);
    expect(chips.map((r) => r.id)).toEqual(
      artifact.filter((r) => (r.asmlift.fanSize ?? 0) > FAN_CHIP_FLOOR).map((r) => r.id),
    );
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThan(artifact.length / 10); // sparse
  });

  test('compact counts fit a chip', () => {
    expect([101, 999, 1000, 8416, 9999, 27_360].map(compactCount)).toEqual(['101', '999', '1k', '8.4k', '10k', '27k']);
  });

  test.each([1, -1] as const)('sorted in direction %i, blank cells come last', (dir) => {
    const sorted = [...artifact].sort((a, b) => compareFanChip(a, b, dir));
    const chips = sorted.map(fanChip);
    const firstBlank = chips.indexOf(null);
    expect(chips.slice(firstBlank).every((n) => n === null)).toBe(true);
    const shown = chips.slice(0, firstBlank) as number[];
    expect(shown).toEqual([...shown].sort((a, b) => (a - b) * dir));
  });

  test.each([
    ['desc', -1],
    ['asc', 1],
  ] as const)('renders in the Explorer table, sorted %s from the URL, chips first', (dirKey, dir) => {
    const rows = [...FAN_SAMPLE];
    const html = renderToStaticMarkup(
      <NuqsTestingAdapter searchParams={`sort=fan&dir=${dirKey}`}>
        <Explorer rows={rows} hash="" onOpenInPlayground={noop} onOpenFeature={noop} onOpenVariation={noop} />
      </NuqsTestingAdapter>,
    );
    expect(html).toContain('>Fan<');
    const body = html.slice(html.indexOf('<tbody>'));
    const cells = body
      .split('<tr ')
      .slice(1)
      .map((tr) => ({
        sym: /<td class="px-3 py-2 font-mono text-slate-100">([^<]*)<\/td>/.exec(tr)![1],
        chip: /title="([\d,]+) candidates in this row&#x27;s fan">([^<]*)</.exec(tr),
      }));
    expect(cells.length).toBe(rows.length);
    const expected = [...rows].sort((a, b) => compareFanChip(a, b, dir));
    expect(cells.map((c) => c.sym)).toEqual(expected.map((r) => r.sym));
    expect(cells.map((c) => (c.chip ? Number(c.chip[1].replace(/,/g, '')) : null))).toEqual(expected.map(fanChip));
    expect(cells.filter((c) => c.chip).map((c) => c.chip![2])).toEqual(
      expected.flatMap((r) => (fanChip(r) === null ? [] : [compactCount(fanChip(r)!)])),
    );
    expect(html).not.toContain('rankSeconds');
  });
});
