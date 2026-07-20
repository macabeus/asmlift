import type { MatchRateRow } from '../../lib/stats';
import { DECOMPILER_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, legendDefaults, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

const pct = (v: number) => Math.round(v * 100);

/**
 * Grouped bar of match-rate (%) per category for both decompilers.
 * `horizontal` flips it for long category lists (features).
 */
export function MatchRateBars<K extends string>({
  data,
  labelOf,
  horizontal = false,
  height = 320,
  showCount = false,
  onBarClick,
}: {
  data: MatchRateRow<K>[];
  labelOf: (key: K) => string;
  horizontal?: boolean;
  height?: number;
  showCount?: boolean;
  /** category click → the underlying key (deep-link into the Explorer) */
  onBarClick?: (key: K) => void;
}) {
  const categories = data.map((d) => (showCount ? `${labelOf(d.key)} (${d.total})` : labelOf(d.key)));

  const mkSeries = (dec: 'asmlift' | 'm2c') => ({
    name: dec,
    type: 'bar' as const,
    emphasis: { focus: 'series' as const },
    itemStyle: { color: DECOMPILER_COLOR[dec], borderRadius: 3 },
    barMaxWidth: 22,
    data: data.map((d) => pct(d[dec])),
  });

  const valueAxis = {
    type: 'value' as const,
    max: 100,
    ...axisCommon,
    axisLabel: { ...axisCommon.axisLabel, formatter: '{value}%' },
  };
  const catAxis = {
    type: 'category' as const,
    data: horizontal ? [...categories].reverse() : categories,
    ...axisCommon,
    axisLabel: {
      ...axisCommon.axisLabel,
      interval: 0,
      ...(horizontal ? {} : { rotate: 0 }),
    },
  };

  // For horizontal we reverse category order so the highest-count feature is on top.
  const seriesData = (dec: 'asmlift' | 'm2c') => (horizontal ? [...mkSeries(dec).data].reverse() : mkSeries(dec).data);

  const option: EChartsOption = {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => `${v}%`,
    },
    legend: { ...legendDefaults, top: 0 },
    grid: {
      left: horizontal ? 8 : 8,
      right: 24,
      top: 40,
      bottom: 8,
      containLabel: true,
    },
    xAxis: horizontal ? valueAxis : catAxis,
    yAxis: horizontal ? catAxis : valueAxis,
    series: [
      { ...mkSeries('asmlift'), data: seriesData('asmlift') },
      { ...mkSeries('m2c'), data: seriesData('m2c') },
    ],
  };

  return (
    <EChart
      option={option}
      height={height}
      onEvents={
        onBarClick
          ? {
              click: (params: { dataIndex: number }) => {
                // horizontal charts render categories reversed — undo before indexing
                const i = horizontal ? data.length - 1 - params.dataIndex : params.dataIndex;
                if (data[i]) {
                  onBarClick(data[i].key);
                }
              },
            }
          : undefined
      }
    />
  );
}
