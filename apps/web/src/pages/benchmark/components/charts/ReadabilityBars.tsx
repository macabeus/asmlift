import type { ReadabilityStats } from '../../lib/stats';
import { DECOMPILER_COLOR } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, legendDefaults, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

const METRICS = [
  { key: 'gotosPer100Lines', label: 'gotos\n/ 100 lines' },
  { key: 'castsPer100Lines', label: 'casts\n/ 100 lines' },
  { key: 'rawMemPer100Lines', label: 'raw memory casts\n/ 100 lines' },
  { key: 'addrDerefPer100Lines', label: 'address derefs\n/ 100 lines' },
  { key: 'verbosity', label: 'lines per\nreference line' },
] as const;

/** Readability-penalty density of each decompiler's compiling outputs. Lower is better. */
export function ReadabilityBars({ asmlift, m2c }: { asmlift: ReadabilityStats; m2c: ReadabilityStats }) {
  const mk = (dec: 'asmlift' | 'm2c', s: ReadabilityStats) => ({
    name: dec,
    type: 'bar' as const,
    emphasis: { focus: 'series' as const },
    itemStyle: { color: DECOMPILER_COLOR[dec], borderRadius: 3 },
    barMaxWidth: 26,
    data: METRICS.map((m) => Number(s[m.key].toFixed(2))),
  });
  const option: EChartsOption = {
    tooltip: { ...tooltipDefaults, trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { ...legendDefaults, top: 0 },
    grid: { left: 8, right: 24, top: 40, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: METRICS.map((m) => m.label),
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, interval: 0 },
    },
    yAxis: { type: 'value', ...axisCommon },
    series: [mk('asmlift', asmlift), mk('m2c', m2c)],
  };
  return <EChart option={option} height={240} />;
}
