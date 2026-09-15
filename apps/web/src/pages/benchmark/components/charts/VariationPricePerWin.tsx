import type { VariationName } from '@asmlift/core/variation-tokens';
import { useEffect, useMemo, useRef, useState } from 'react';

import { type PricedVariation, plural } from '../../lib/fan';
import { tooltipTitle } from '../../lib/variation-text';
import { VARIATION_KIND_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

/** Below this chart width a label carrying its wins and rows leaves the bars too short to compare. */
const NARROW_WIDTH = 560;

/** One optimisation level's priced variations: those that won at that level, at that level's price. */
export interface LevelPrices {
  level: string;
  won: PricedVariation[];
}

/** The variations priced at any of the levels, dearest first by their dearest level. */
export function dearestFirst(series: readonly LevelPrices[]): VariationName[] {
  const top = new Map<VariationName, PricedVariation>();
  for (const v of series.flatMap((s) => s.won)) {
    const seen = top.get(v.name);
    if (!seen || v.price > seen.price) {
      top.set(v.name, v);
    }
  }
  return [...top.values()]
    .sort((a, b) => b.price - a.price || b.candidates - a.candidates || (a.name < b.name ? -1 : 1))
    .map((v) => v.name);
}

/** What one win carrying each variation cost, one bar series per optimisation level, dearest first.
 *
 *  BAR LENGTH IS THE PRICE, so the longest bar is the dearest win: a reader compares lengths whatever
 *  the label says. A variation that never won at a level has no price there, so its bar is absent; a
 *  bar of its cost would put a second quantity on this scale, and the page lists those beside the
 *  chart. With several levels drawn, each bar's label names its level. On a `narrow` chart the label is
 *  the price alone, so the bars keep the width, and the tooltip still says what the price stands on. */
export function pricePerWinOption(
  series: readonly LevelPrices[],
  names: readonly VariationName[],
  narrow = false,
): EChartsOption {
  const byLevel = series.map((s) => new Map(s.won.map((v) => [v.name, v])));
  return {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'item',
      formatter: (p) => {
        const one = (Array.isArray(p) ? p[0] : p) as { seriesIndex: number; dataIndex: number };
        const s = byLevel[one.seriesIndex].get(names[one.dataIndex])!;
        return [
          tooltipTitle(s.name),
          `<div>at ${series[one.seriesIndex].level}: ${Math.round(s.price).toLocaleString()} candidates per win</div>`,
          `<div>${s.candidates.toLocaleString()} candidates carried it, across the fans of ${s.rows} row${s.rows === 1 ? '' : 's'}; ${s.winners} won with it</div>`,
        ].join('');
      },
    },
    grid: { left: 8, right: narrow ? 72 : 176, top: 8, bottom: 28, containLabel: true },
    xAxis: {
      type: 'value',
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, hideOverlap: true },
      name: 'candidates per win',
      nameLocation: 'middle',
      nameGap: 24,
      nameTextStyle: { color: '#64748b', fontSize: 11 },
    },
    yAxis: {
      type: 'category',
      inverse: true, // the dearest on top
      data: [...names],
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, interval: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
      splitLine: { show: false },
    },
    series: series.map((s, i) => ({
      type: 'bar' as const,
      name: s.level,
      barMaxWidth: 11,
      data: names.map((n) => {
        const v = byLevel[i].get(n);
        return v
          ? { value: Math.round(v.price), itemStyle: { color: VARIATION_KIND_COLOR[v.kind], borderRadius: 2 } }
          : '-';
      }),
      label: {
        show: true,
        position: 'right' as const,
        fontSize: 11,
        color: '#cbd5e1',
        // a price stands on its wins and its rows, so a thin level's bar says how thin
        formatter: (p: { dataIndex: number }) => {
          const v = byLevel[i].get(names[p.dataIndex])!;
          const price = `${series.length > 1 ? `${s.level} ` : ''}${Math.round(v.price).toLocaleString()}`;
          return narrow ? price : `${price} · ${plural(v.winners, 'win')} / ${plural(v.rows, 'row')}`;
        },
      },
    })),
  };
}

export function VariationPricePerWin({
  series,
  names,
  onBarClick,
}: {
  series: readonly LevelPrices[];
  /** the variations drawn, dearest first (`dearestFirst`, or its head) */
  names: readonly VariationName[];
  onBarClick?: (name: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // MEMOIZED, as `VariationCostGain` explains: a new option under the pointer throws on mouseout.
  const option = useMemo(() => pricePerWinOption(series, names, narrow), [series, names, narrow]);
  const onEvents = useMemo(
    () =>
      onBarClick
        ? ({ click: (p: { dataIndex: number }) => onBarClick(names[p.dataIndex]) } as Record<
            string,
            (params: never) => void
          >)
        : undefined,
    [names, onBarClick],
  );

  const rowHeight = Math.max(1, series.length) * 14 + 6;
  return (
    <div ref={box}>
      <EChart option={option} height={Math.max(160, names.length * rowHeight + 50)} onEvents={onEvents} />
    </div>
  );
}
