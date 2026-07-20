import type { H2HRow } from '../../lib/stats';
import { H2H_COLOR, H2H_LABEL } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, legendDefaults, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

const VERDICTS = ['both', 'asmliftOnly', 'm2cOnly', 'neither'] as const;

/**
 * Head-to-head: one horizontal stacked bar per group, split into who matched byte-exact —
 * both, asmlift-only, m2c-only, or neither. This is the competitive view the per-decompiler
 * match rates can't show: the asmlift-only vs m2c-only segments are the exclusive wins.
 */
export function HeadToHead<K extends string>({
  data,
  labelOf,
  height = 320,
}: {
  data: H2HRow<K>[];
  labelOf: (key: K) => string;
  height?: number;
}) {
  // reverse so the first group renders on top (ECharts category axis is bottom-up).
  const rows = [...data].reverse();
  const categories = rows.map((d) => `${labelOf(d.key)} (${d.total})`);

  const series = VERDICTS.map((v) => ({
    name: H2H_LABEL[v],
    type: 'bar' as const,
    stack: 'total',
    emphasis: { focus: 'series' as const },
    itemStyle: { color: H2H_COLOR[v], borderColor: '#0f172a', borderWidth: 2 },
    label: {
      show: true,
      color: '#0f172a',
      fontWeight: 600 as const,
      formatter: (p: { value?: unknown }) => (Number(p.value) > 0 ? `${p.value}` : ''),
    },
    data: rows.map((d) => d[v]),
  }));

  const option: EChartsOption = {
    tooltip: { ...tooltipDefaults, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { ...legendDefaults, top: 0 },
    grid: { left: 8, right: 24, top: 40, bottom: 8, containLabel: true },
    xAxis: { type: 'value', ...axisCommon },
    yAxis: {
      type: 'category',
      data: categories,
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, interval: 0 },
    },
    series,
  };

  return <EChart option={option} height={height} />;
}
