import type { ParetoRow } from '../../lib/declines';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

/**
 * The decline-reason Pareto: rows blocked per missing capability, largest first — the roadmap
 * question raw outcome counts can't answer. Bars deep-link into the Explorer filtered to that
 * decline class; the tooltip carries real example markers.
 */
export function DeclinePareto({ data, onBarClick }: { data: ParetoRow[]; onBarClick?: (key: string) => void }) {
  // horizontal, largest on top
  const rows = [...data].reverse();
  const option: EChartsOption = {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'item',
      formatter: (p) => {
        const one = Array.isArray(p) ? p[0] : p;
        const r = rows[(one as { dataIndex: number }).dataIndex];
        const ex = r.examples
          .map((e) => `<div style="opacity:.75;max-width:520px;white-space:normal">· ${escapeHtml(e)}</div>`)
          .join('');
        return `<div style="font-weight:600">${escapeHtml(r.label)} — ${r.count} function(s)</div>${ex}`;
      },
    },
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', ...axisCommon },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.label),
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, interval: 0, width: 280, overflow: 'truncate' as const },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 18,
        data: rows.map((r) => r.count),
        itemStyle: { color: '#a855f7', borderRadius: 3 }, // the `declined` purple
        label: { show: true, position: 'right', color: '#94a3b8', fontSize: 11 },
      },
    ],
  };
  return (
    <EChart
      option={option}
      height={Math.max(220, rows.length * 34)}
      onEvents={onBarClick ? { click: (p: { dataIndex: number }) => onBarClick(rows[p.dataIndex].key) } : undefined}
    />
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
