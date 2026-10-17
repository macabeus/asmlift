import type { ReadabilityStats } from '../../lib/stats';
import { DECOMPILER_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

const METRICS = [
  { key: 'gotosPer100Lines', label: 'gotos\n/ 100 lines' },
  { key: 'castsPer100Lines', label: 'casts\n/ 100 lines' },
  { key: 'rawMemPer100Lines', label: 'raw memory casts\n/ 100 lines' },
  { key: 'addrDerefPer100Lines', label: 'address derefs\n/ 100 lines' },
  { key: 'verbosity', label: 'lines per\nreference line' },
] as const;

/** Readability-penalty density of asmlift's compiling outputs. Lower is better. */
export function ReadabilityBars({ stats }: { stats: ReadabilityStats }) {
  const option: EChartsOption = {
    tooltip: { ...tooltipDefaults, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 24, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: METRICS.map((m) => m.label),
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, interval: 0 },
    },
    yAxis: { type: 'value', ...axisCommon },
    series: [
      {
        name: 'asmlift',
        type: 'bar',
        itemStyle: { color: DECOMPILER_COLOR.asmlift, borderRadius: 3 },
        barMaxWidth: 26,
        data: METRICS.map((m) => Number(stats[m.key].toFixed(2))),
      },
    ],
  };
  return <EChart option={option} height={240} />;
}
