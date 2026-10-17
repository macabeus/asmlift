import type { Outcome } from '@asmlift/bench-schema';

import type { OutcomeRow } from '../../lib/stats';
import { CHART, OUTCOME_COLOR, OUTCOME_LABEL, OUTCOME_ORDER } from '../../theme';
import { EChart } from './EChart';
import { axisCommon, tooltipDefaults } from './echarts';
import type { EChartsOption } from './echarts';

const share = (n: number, total: number) => (total === 0 ? 0 : (100 * n) / total);

/** A segment narrower than this many percent carries no label: its digits would not fit. */
const LABEL_FLOOR = 8;

/**
 * One 100%-stacked horizontal bar per category: how asmlift's outcomes split within it, best to
 * worst left to right. Categories read top-down in `data` order.
 */
export function OutcomeBars<K extends string>({
  data,
  labelOf,
  onSegmentClick,
}: {
  data: OutcomeRow<K>[];
  labelOf: (key: K) => string;
  /** segment click → its category and outcome (deep-link into the Explorer) */
  onSegmentClick?: (key: K, outcome: Outcome) => void;
}) {
  // ECharts draws a category axis bottom-up; reverse so the first row sits on top.
  const rows = [...data].reverse();

  const option: EChartsOption = {
    tooltip: {
      ...tooltipDefaults,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const first = Array.isArray(params) ? params[0] : params;
        const row = rows[first.dataIndex];
        const lines = OUTCOME_ORDER.filter((o) => row.counts[o] > 0).map(
          (o) =>
            `<span style="color:${OUTCOME_COLOR[o]}">●</span> ${OUTCOME_LABEL[o]}: <b>${row.counts[o]}</b> (${Math.round(share(row.counts[o], row.total))}%)`,
        );
        return `<b>${labelOf(row.key)}</b> — ${row.total} functions<br/>${lines.join('<br/>')}`;
      },
    },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: {
      type: 'value',
      max: 100,
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, formatter: '{value}%' },
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => `${labelOf(r.key)} (${r.total})`),
      ...axisCommon,
      axisLabel: { ...axisCommon.axisLabel, interval: 0 },
    },
    series: OUTCOME_ORDER.map((outcome) => ({
      id: outcome,
      name: OUTCOME_LABEL[outcome],
      type: 'bar' as const,
      stack: 'total',
      barMaxWidth: 22,
      itemStyle: { color: OUTCOME_COLOR[outcome], borderColor: CHART.labelHalo, borderWidth: 1 },
      label: {
        show: true,
        color: CHART.labelHalo,
        fontWeight: 600 as const,
        formatter: (p: { value?: unknown }) => {
          const v = Number(p.value);
          return v >= LABEL_FLOOR ? `${Math.round(v)}%` : '';
        },
      },
      data: rows.map((r) => share(r.counts[outcome], r.total)),
    })),
  };

  return (
    <EChart
      option={option}
      height={rows.length * 30 + 40}
      onEvents={
        onSegmentClick
          ? {
              click: (p: { dataIndex: number; seriesId?: string }) => {
                const row = rows[p.dataIndex];
                if (row && p.seriesId) {
                  onSegmentClick(row.key, p.seriesId as Outcome);
                }
              },
            }
          : undefined
      }
    />
  );
}

/** The outcome key shared by every outcome chart on a panel. */
export function OutcomeLegend() {
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
      {OUTCOME_ORDER.map((o) => (
        <span key={o} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-xs" style={{ backgroundColor: OUTCOME_COLOR[o] }} />
          {OUTCOME_LABEL[o]}
        </span>
      ))}
    </div>
  );
}
