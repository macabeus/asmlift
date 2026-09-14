import { VARIATION_DEFINITIONS, VARIATION_KIND_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { VARIATION_KINDS } from '@asmlift/core/variation-tokens';

import { type VariationStats, pricePerWin, winRate } from '../../lib/fan';
import { VARIATION_KIND_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, legendDefaults, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

type Point = [candidates: number, ratePct: number, rows: number, name: string];

/** A definition's title carries code spans such as `||`; the tooltip is HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Cost against gain, one bubble per variation some fan carried: candidates carried (log) across,
 *  win RATE up, rows carried as the bubble's area, kind as its colour.
 *
 *  A RATE, NOT A COUNT, on the vertical: wins alone put "carried by one fan, won it" and "carried by
 *  forty fans, won one" at the same height, the opposite reading. Reach is the bubble instead.
 *
 *  LOG ACROSS, because cost spans orders of magnitude and a few rows hold most candidates: on a
 *  linear scale every cheap variation stacks into one column at the left edge. */
export function VariationCostGain({
  data,
  onPointClick,
}: {
  data: VariationStats[];
  onPointClick?: (name: string) => void;
}) {
  const option: EChartsOption = {
    legend: { ...legendDefaults, top: 0, data: VARIATION_KINDS.map((k) => VARIATION_KIND_DEFINITIONS[k].title) },
    tooltip: {
      ...tooltipDefaults,
      trigger: 'item',
      formatter: (p) => {
        const one = Array.isArray(p) ? p[0] : p;
        const [, , , name] = one.value as Point;
        const s = data.find((d) => d.name === name)!;
        const price = pricePerWin(s);
        return [
          `<div style="font-weight:600">${escapeHtml(VARIATION_DEFINITIONS[s.name].title.replace(/`/g, ''))} <span style="opacity:.6;font-family:monospace">${s.name}</span></div>`,
          `<div>${s.candidates.toLocaleString()} candidates carried it, in ${s.rows} row fan${s.rows === 1 ? '' : 's'}</div>`,
          `<div>won ${s.winners} of those rows (${Math.round((winRate(s) ?? 0) * 100)}%)</div>`,
          price === null
            ? '<div style="opacity:.7">no win</div>'
            : `<div>${Math.round(price).toLocaleString()} candidates per win</div>`,
        ].join('');
      },
    },
    grid: { left: 14, right: 36, top: 40, bottom: 14, containLabel: true },
    xAxis: {
      type: 'log',
      ...axisCommon,
      min: 1,
      name: 'candidates carried',
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { color: '#64748b', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      ...axisCommon,
      min: 0,
      max: 100,
      name: 'win rate',
      nameLocation: 'middle',
      nameGap: 40,
      nameTextStyle: { color: '#64748b', fontSize: 11 },
      axisLabel: { ...axisCommon.axisLabel, formatter: '{value}%' },
    },
    // One series per kind, so the legend names the colours and toggles a kind off.
    series: VARIATION_KINDS.map((kind) => ({
      type: 'scatter' as const,
      name: VARIATION_KIND_DEFINITIONS[kind].title,
      itemStyle: { color: VARIATION_KIND_COLOR[kind], opacity: 0.8 },
      data: data
        .filter((s) => s.kind === kind)
        .map((s): Point => [s.candidates, Math.round((winRate(s) ?? 0) * 100), s.rows, s.name]),
      symbolSize: (value: Point) => 7 + Math.sqrt(value[2]) * 2.5,
      label: {
        show: true,
        position: 'right' as const,
        fontSize: 10,
        color: '#94a3b8',
        formatter: (p: { value?: unknown }) => (p.value as Point)[3],
      },
      // Many variations share a rate band; their names would print on top of each other. The ones
      // that collide are dropped, and the tooltip is the complete reading either way.
      labelLayout: { hideOverlap: true },
    })),
  };

  return (
    <EChart
      option={option}
      height={380}
      onEvents={
        onPointClick
          ? ({ click: (p: { value: Point }) => onPointClick(p.value[3]) } as Record<string, (params: never) => void>)
          : undefined
      }
    />
  );
}
