import type { MatchRateRow } from '../../lib/stats';
import { DECOMPILER_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

const pct = (v: number) => Math.round(v * 100);

/**
 * Bar of asmlift's match rate (%) per category.
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

  const rates = data.map((d) => pct(d.rate));

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
  const seriesData = horizontal ? [...rates].reverse() : rates;

  const option: EChartsOption = {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v) => `${v}%`,
    },
    grid: {
      left: 8,
      right: 24,
      top: 16,
      bottom: 8,
      containLabel: true,
    },
    xAxis: horizontal ? valueAxis : catAxis,
    yAxis: horizontal ? catAxis : valueAxis,
    series: [
      {
        name: 'asmlift',
        type: 'bar',
        itemStyle: { color: DECOMPILER_COLOR.asmlift, borderRadius: 3 },
        barMaxWidth: 22,
        data: seriesData,
      },
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
