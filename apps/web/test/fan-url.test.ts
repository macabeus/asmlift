// The Fan Explorer's URL state: the tab, the variation drawer's key, and the link from a drawer row
// to that row's detail in the Function Explorer.
import { type FunctionResult, resolveRow } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import {
  FEATURE_TERM_KEY,
  TAB_IDS,
  VARIATION_TERM_KEY,
  rowHref,
  tabParser,
  variationHref,
} from '../src/pages/benchmark/lib/explorer-url';
import { hashToSearchParams } from '../src/shared/utils/hash-params';

const rows = (
  JSON.parse(readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8')) as {
    results: FunctionResult[];
  }
).results;

test('the Fan Explorer is a tab, beside the Function Explorer', () => {
  expect(TAB_IDS.indexOf('fan')).toBe(TAB_IDS.indexOf('explorer') + 1);
  expect(tabParser.parse('fan')).toBe('fan');
});

test('the drawer key speaks the reader vocabulary, and is not the feature key', () => {
  expect(VARIATION_TERM_KEY).toBe('variation');
  expect(VARIATION_TERM_KEY).not.toBe(FEATURE_TERM_KEY);
});

test("a variation link keeps the reader's view, an open feature included, and replaces an open variation", () => {
  const params = hashToSearchParams(variationHref('coalesce', '#tab=fan&about=loop&variation=unsigned'));
  expect(params.get('tab')).toBe('fan');
  expect(params.get('about')).toBe('loop');
  expect(params.getAll('variation')).toEqual(['coalesce']);
});

test('a row link opens that row in the Function Explorer, on every row of the artifact', () => {
  const wrong = rows.filter((r) => {
    const p = hashToSearchParams(rowHref(r.id, '#view=benchmark&tab=fan'));
    return p.get('tab') !== 'explorer' || resolveRow(rows, p.get('fn')!) !== r;
  });
  expect(wrong.map((r) => r.id)).toEqual([]);
});

test("a row link stays in the Benchmark view and drops the reader's filters and open drawers", () => {
  const p = hashToSearchParams(
    rowHref('sa3:sub_803213C:agbcc', '#view=benchmark&tab=fan&project=kleod&variation=volatile'),
  );
  expect([...p.keys()].sort()).toEqual(['fn', 'tab', 'view']);
  expect(p.get('view')).toBe('benchmark');
});
