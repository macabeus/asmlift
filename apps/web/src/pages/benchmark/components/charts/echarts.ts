// Single tree-shaken ECharts registration point. Every chart imports the wrapped
// `EChart` component + shared tooltip/grid defaults from here, so we register each
// renderer/component exactly once and keep the bundle small.
import type { EChartsOption } from 'echarts';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

import { CHART } from '../../theme';

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export { echarts, ReactEChartsCore };
export type { EChartsOption };

/** Shared tooltip styling matching the dark-slate theme. */
export const tooltipDefaults: EChartsOption['tooltip'] = {
  backgroundColor: CHART.tooltipBg,
  borderColor: CHART.tooltipBorder,
  textStyle: { color: CHART.tooltipText, fontSize: 12 },
  extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.4);',
};

/** Axis label + line styling for both axes. */
export const axisCommon = {
  axisLine: { lineStyle: { color: CHART.grid } },
  axisTick: { lineStyle: { color: CHART.grid } },
  axisLabel: { color: CHART.axisLabel, fontSize: 12 },
  splitLine: { lineStyle: { color: CHART.grid, opacity: 0.5 } },
} as const;

export const legendDefaults = {
  textStyle: { color: CHART.axisLabel },
  icon: 'roundRect',
  itemWidth: 12,
  itemHeight: 12,
} as const;
