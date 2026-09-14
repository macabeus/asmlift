import { VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { useMemo } from 'react';

import { type VariationStats, pricePerWin } from '../../lib/fan';
import { VARIATION_KIND_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

/** A definition's title carries code spans such as `||`; the tooltip is HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What one win carrying each variation cost, dearest first.
 *
 *  BAR LENGTH IS THE PRICE, so the longest bar is the dearest win: a reader compares lengths
 *  whatever the label says. A variation that never won has no price and is not drawn, since a bar
 *  of its cost would put a second quantity on this scale; the page lists those beside the chart.
 *  `data` holds only variations that won, dearest first (`priced`). */
export function VariationPricePerWin({
  data,
  onBarClick,
}: {
  data: VariationStats[];
  onBarClick?: (name: string) => void;
}) {
  const bars = useMemo(() => [...data].reverse(), [data]); // a category scale draws bottom-up

  // MEMOIZED, as `VariationCostGain` explains: a new option under the pointer throws on mouseout.
  const option = useMemo(
    (): EChartsOption => ({
      tooltip: {
        ...tooltipDefaults,
        trigger: 'item',
        formatter: (p) => {
          const one = Array.isArray(p) ? p[0] : p;
          const s = bars[(one as { dataIndex: number }).dataIndex];
          return [
            `<div style="font-weight:600">${escapeHtml(VARIATION_DEFINITIONS[s.name].title.replace(/`/g, ''))} <span style="opacity:.6;font-family:monospace">${s.name}</span></div>`,
            `<div>${Math.round(pricePerWin(s)!).toLocaleString()} candidates per win</div>`,
            `<div>${s.candidates.toLocaleString()} candidates carried it, across the fans of ${s.rows} row${s.rows === 1 ? '' : 's'}; ${s.winners} won with it</div>`,
          ].join('');
        },
      },
      grid: { left: 8, right: 64, top: 8, bottom: 28, containLabel: true },
      xAxis: {
        type: 'value',
        ...axisCommon,
        name: 'candidates per win',
        nameLocation: 'middle',
        nameGap: 24,
        nameTextStyle: { color: '#64748b', fontSize: 11 },
      },
      yAxis: {
        type: 'category',
        data: bars.map((s) => s.name),
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, interval: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11 },
        splitLine: { show: false },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 11,
          data: bars.map((s) => ({
            value: Math.round(pricePerWin(s)!),
            itemStyle: { color: VARIATION_KIND_COLOR[s.kind], borderRadius: 2 },
          })),
          label: { show: true, position: 'right', fontSize: 11, color: '#cbd5e1', formatter: '{c}' },
        },
      ],
    }),
    [bars],
  );
  const onEvents = useMemo(
    () =>
      onBarClick
        ? ({ click: (p: { dataIndex: number }) => onBarClick(bars[p.dataIndex].name) } as Record<
            string,
            (params: never) => void
          >)
        : undefined,
    [bars, onBarClick],
  );

  return <EChart option={option} height={Math.max(160, bars.length * 20 + 50)} onEvents={onEvents} />;
}
