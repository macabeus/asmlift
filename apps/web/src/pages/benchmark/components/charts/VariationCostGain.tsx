import { VARIATION_KIND_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { VARIATION_KINDS } from '@asmlift/core/variation-tokens';
import { useMemo } from 'react';

import { type VariationStats, pricePerWin, winRate } from '../../lib/fan';
import { tooltipTitle } from '../../lib/variation-text';
import { CHART, type LevelMarker, VARIATION_KIND_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

type Point = [candidates: number, ratePct: number, rows: number, name: string, level: string];

/** One optimisation level's bubbles: the variations some fan at that level carried, with that level's
 *  totals. */
export interface LevelSeries {
  level: string;
  marker: LevelMarker;
  variations: VariationStats[];
}

/** How many bubbles carry their name on the plot. */
const LABELLED = 12;

/** The smallest bubble drawn, in pixels, so a bubble of a few rows stays visible and clickable. */
const BUBBLE_FLOOR = 6;

/** A bubble's diameter for the rows that carried its variation. The AREA is proportional to the
 *  rows, so the diameter grows with their square root; only bubbles under the floor are enlarged. */
export function bubbleSize(rows: number): number {
  return Math.max(BUBBLE_FLOOR, 3 * Math.sqrt(rows));
}

const point = (level: string, s: VariationStats): Point => [
  s.candidates,
  Math.round((winRate(s) ?? 0) * 100),
  s.rows,
  s.name,
  level,
];

/** Cost against gain, one series per optimisation level and one bubble per variation some fan at that
 *  level carried: candidates carried (log) across, win RATE up, rows carried as the bubble's area, kind
 *  as its colour, level as its shape.
 *
 *  A RATE, NOT A COUNT, on the vertical: wins alone put "carried by one fan, won it" and "carried by
 *  forty fans, won one" at the same height, the opposite reading. Reach is the bubble instead.
 *
 *  LOG ACROSS, because cost spans orders of magnitude and a few rows hold most candidates: on a
 *  linear scale every cheap variation stacks into one column at the left edge.
 *
 *  THE NAMES are one series of invisible bubbles drawn above every level's: a label belongs to its own
 *  series, so on a level's series a later level's bubbles would paint over it, and `hideOverlap` only
 *  compares labels within one layout pass. The halo keeps a name legible where it crosses a bubble.
 *  `silent`, so a click reaches the bubble underneath. The bubble is hidden by a transparent COLOUR: a
 *  label inherits its symbol's opacity, so `opacity: 0` would hide the names too. */
export function costGainOption(series: readonly LevelSeries[]): EChartsOption {
  // NAMED ON THE CHART: only the bubbles the most rows carried. Fifty names over one plot print over
  // each other; every bubble's tooltip names it, and the catalogue lists all.
  const labelled = series
    .flatMap((s) => s.variations.map((v) => point(s.level, v)))
    .sort((a, b) => b[2] - a[2])
    .slice(0, LABELLED);
  return {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'item',
      formatter: (p) => {
        const one = Array.isArray(p) ? p[0] : p;
        const [, , , name, level] = one.value as Point;
        const s = series.find((l) => l.level === level)!.variations.find((v) => v.name === name)!;
        const price = pricePerWin(s);
        return [
          tooltipTitle(s.name),
          `<div>at ${level}: ${s.candidates.toLocaleString()} candidates carried it, across the fans of ${s.rows} row${s.rows === 1 ? '' : 's'}</div>`,
          `<div>won ${s.winners} of those rows (${Math.round((winRate(s) ?? 0) * 100)}%)</div>`,
          price === null
            ? '<div style="opacity:.7">no win</div>'
            : `<div>${Math.round(price).toLocaleString()} candidates per win</div>`,
        ].join('');
      },
    },
    // `containLabel` makes room for the tick labels only: the bottom holds the axis name below its
    // `nameGap`, and the right the label of a bubble at the largest cost.
    grid: { left: 14, right: 72, top: 16, bottom: 40, containLabel: true },
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
    series: [
      ...series.map((s) => ({
        type: 'scatter' as const,
        name: s.level,
        symbol: s.marker.symbol,
        data: s.variations.map((v) => ({
          value: point(s.level, v),
          itemStyle: { color: VARIATION_KIND_COLOR[v.kind], opacity: 0.8 },
        })),
        symbolSize: (value: Point) => bubbleSize(value[2]),
      })),
      {
        type: 'scatter' as const,
        name: 'names',
        silent: true,
        z: 10,
        tooltip: { show: false },
        itemStyle: { color: 'transparent' },
        data: labelled,
        symbolSize: (value: Point) => bubbleSize(value[2]),
        label: {
          show: true,
          position: 'right' as const,
          fontSize: 10,
          color: '#cbd5e1',
          textBorderColor: CHART.labelHalo,
          textBorderWidth: 3,
          formatter: (p: { value?: unknown }) => (p.value as Point)[3],
        },
        labelLayout: { hideOverlap: true },
      },
    ],
  };
}

/** The cost-against-gain chart. THE KEY IS HTML, above the plot: it wraps at any width, where an
 *  ECharts legend either wraps into the plot or scrolls a kind out of sight. */
export function VariationCostGain({
  series,
  onPointClick,
}: {
  series: readonly LevelSeries[];
  onPointClick?: (name: string) => void;
}) {
  // MEMOIZED, option and events both: a new option under the pointer makes ECharts replace the
  // series the pending mouseout still points at, which throws. The page re-renders on every fragment
  // change, and a bubble click is one.
  const option = useMemo(() => costGainOption(series), [series]);
  const onEvents = useMemo(
    () =>
      onPointClick
        ? ({ click: (p: { value: Point }) => onPointClick(p.value[3]) } as Record<string, (params: never) => void>)
        : undefined,
    [onPointClick],
  );

  return (
    <>
      <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        {VARIATION_KINDS.map((kind) => (
          <li key={kind} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: VARIATION_KIND_COLOR[kind] }} />
            {VARIATION_KIND_DEFINITIONS[kind].title}
          </li>
        ))}
      </ul>
      <ul aria-label="levels drawn" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        {series.map((s) => (
          <li key={s.level} className="flex items-center gap-1.5 whitespace-nowrap font-mono">
            <span aria-hidden className="text-slate-300">
              {s.marker.glyph}
            </span>
            {s.level}
          </li>
        ))}
      </ul>
      <EChart option={option} height={380} onEvents={onEvents} />
    </>
  );
}
