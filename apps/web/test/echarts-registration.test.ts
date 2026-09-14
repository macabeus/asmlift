// ECharts is registered tree-shaken, in `charts/echarts.ts`. A series type missing from that list
// draws NO series and reports NO error while its grid and axes still render, so the chart looks live
// and empty — exactly how the Fan Explorer's first scatter shipped. This reads every series type the
// chart components name and asks ECharts itself whether it is registered.
import { ComponentModel } from 'echarts/core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Imported for its side effect: the registration under test.
import '../src/pages/benchmark/components/charts/echarts';

const CHARTS = join(import.meta.dirname, '../src/pages/benchmark/components/charts');

/** Every series type ECharts ships. A `type:` literal that names none of these is a scale or a
 *  pointer (`value`, `category`, `log`, `shadow`), not a series. */
const SERIES_TYPES = new Set([
  'bar',
  'boxplot',
  'candlestick',
  'custom',
  'effectScatter',
  'funnel',
  'gauge',
  'graph',
  'heatmap',
  'line',
  'lines',
  'map',
  'parallel',
  'pictorialBar',
  'pie',
  'radar',
  'sankey',
  'scatter',
  'sunburst',
  'themeRiver',
  'tree',
  'treemap',
]);

function seriesTypesUsed(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of readdirSync(CHARTS).filter((f) => f.endsWith('.tsx'))) {
    // an axis pointer's `type: 'line'` names a pointer, not a series
    const text = readFileSync(join(CHARTS, file), 'utf8').replace(/axisPointer:\s*\{[^}]*\}/g, '');
    for (const [, type] of text.matchAll(/\btype:\s*'([A-Za-z]+)'/g)) {
      if (SERIES_TYPES.has(type)) {
        used.set(type, [...(used.get(type) ?? []), file]);
      }
    }
  }
  return used;
}

test('the scan finds the series the pages draw', () => {
  expect([...seriesTypesUsed().keys()].sort()).toEqual(expect.arrayContaining(['bar', 'scatter']));
});

test('every series type a chart names is registered', () => {
  // ECharts' class registry (`enableClassManagement`) is public at run time and absent from its types.
  const registry = ComponentModel as unknown as { getClass(mainType: string, subType: string): unknown };
  const unregistered = [...seriesTypesUsed()]
    .filter(([type]) => !registry.getClass('series', type))
    .map(([type, files]) => `${type} (${files.join(', ')})`);
  expect(unregistered).toEqual([]);
});
