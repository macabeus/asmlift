import type { FunctionResult } from '@asmlift/bench-schema';

import { outcomeCounts } from '../../lib/stats';
import { OUTCOME_COLOR, OUTCOME_GLOSS, OUTCOME_LABEL, OUTCOME_ORDER } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, legendDefaults, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

/**
 * The headline chart: two stacked horizontal bars (asmlift, m2c) showing the
 * match / nonmatch / noncompile / declined / failed split.
 */
export function OutcomeDistribution({ rows }: { rows: FunctionResult[] }) {
  const asmlift = outcomeCounts(rows, 'asmlift');
  const m2c = outcomeCounts(rows, 'm2c');

  const series = OUTCOME_ORDER.map((outcome) => ({
    name: OUTCOME_LABEL[outcome],
    type: 'bar' as const,
    stack: 'total',
    emphasis: { focus: 'series' as const },
    itemStyle: {
      color: OUTCOME_COLOR[outcome],
      borderColor: '#0f172a',
      borderWidth: 2,
    },
    label: {
      show: true,
      color: '#0f172a',
      fontWeight: 600 as const,
      formatter: (p: { value?: unknown }) => (Number(p.value) > 0 ? `${p.value}` : ''),
    },
    data: [m2c[outcome], asmlift[outcome]], // categories are rendered bottom-up
  }));

  const option: EChartsOption = {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
    },
    legend: {
      ...legendDefaults,
      top: 0,
      // Hovering a legend label shows that outcome's definition (the glossary lives here now —
      // there is no separate "how to read this" card).
      tooltip: {
        ...tooltipDefaults,
        show: true,
        confine: true,
        formatter: (p: { name?: string }) => {
          const outcome = OUTCOME_ORDER.find((o) => OUTCOME_LABEL[o] === p.name);
          const gloss = outcome ? OUTCOME_GLOSS[outcome] : '';
          return `<div style="max-width:340px;white-space:normal"><b>${p.name}</b> — ${gloss}</div>`;
        },
      },
    },
    grid: { left: 70, right: 24, top: 40, bottom: 8, containLabel: true },
    xAxis: { type: 'value', ...axisCommon },
    yAxis: {
      type: 'category',
      data: ['m2c', 'asmlift'],
      ...axisCommon,
      axisLabel: {
        ...axisCommon.axisLabel,
        fontWeight: 700,
        fontFamily: 'ui-monospace, monospace',
      },
    },
    series,
  };

  return <EChart option={option} height={200} />;
}
