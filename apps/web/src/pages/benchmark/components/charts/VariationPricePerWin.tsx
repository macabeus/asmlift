import { VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';

import { type VariationStats, pricePerWin } from '../../lib/fan';
import { VARIATION_KIND_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

/** A variation that never won has no ratio to show: its bar is cost alone, in a colour of its own. */
const NO_WIN = '#64748b'; // slate-500

/** A definition's title carries code spans such as `||`; the tooltip is HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What one win carrying each variation cost, dearest first.
 *
 *  ONE QUANTITY ON THE SCALE, and it is candidates carried. A bar whose length was the ratio for
 *  some variations and the raw cost for the never-won ones would put two quantities on one scale,
 *  and the eye compares lengths whatever the label says. So length is cost, ORDER is the price per
 *  win, and the price is the label at the bar's end. `data` arrives in that order (`priced`). */
export function VariationPricePerWin({
  data,
  onBarClick,
}: {
  data: VariationStats[];
  onBarClick?: (name: string) => void;
}) {
  const bars = [...data].reverse(); // a category scale draws bottom-up

  const option: EChartsOption = {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'item',
      formatter: (p) => {
        const one = Array.isArray(p) ? p[0] : p;
        const s = bars[(one as { dataIndex: number }).dataIndex];
        const price = pricePerWin(s);
        return [
          `<div style="font-weight:600">${escapeHtml(VARIATION_DEFINITIONS[s.name].title.replace(/`/g, ''))} <span style="opacity:.6;font-family:monospace">${s.name}</span></div>`,
          `<div>${s.candidates.toLocaleString()} candidates carried it, in ${s.rows} row fan${s.rows === 1 ? '' : 's'}</div>`,
          `<div>${s.winners} win${s.winners === 1 ? '' : 's'}</div>`,
          price === null
            ? '<div style="opacity:.7">no win</div>'
            : `<div>${Math.round(price).toLocaleString()} candidates per win</div>`,
        ].join('');
      },
    },
    grid: { left: 8, right: 84, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', ...axisCommon },
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
        data: bars.map((s) => {
          const price = pricePerWin(s);
          return {
            value: s.candidates,
            itemStyle: { color: price === null ? NO_WIN : VARIATION_KIND_COLOR[s.kind], borderRadius: 2 },
            label: {
              show: true,
              position: 'right' as const,
              fontSize: 11,
              color: price === null ? NO_WIN : '#cbd5e1',
              formatter: price === null ? 'no win' : `${Math.round(price).toLocaleString()} / win`,
            },
          };
        }),
      },
    ],
  };

  return (
    <EChart
      option={option}
      height={Math.max(200, bars.length * 18 + 30)}
      onEvents={
        onBarClick
          ? ({ click: (p: { dataIndex: number }) => onBarClick(bars[p.dataIndex].name) } as Record<
              string,
              (params: never) => void
            >)
          : undefined
      }
    />
  );
}
