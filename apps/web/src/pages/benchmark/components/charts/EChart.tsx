import { type EChartsOption, ReactEChartsCore, echarts } from './echarts';

interface EChartProps {
  option: EChartsOption;
  /** CSS height; charts default to a comfortable panel height. */
  height?: number | string;
  className?: string;
  /** echarts event map (e.g. { click: handler }) — used for chart→Explorer deep links. */
  onEvents?: Record<string, (params: never) => void>;
}

/** Thin wrapper: transparent background, autoresize, our tree-shaken core. */
export function EChart({ option, height = 320, className, onEvents }: EChartProps) {
  return (
    <ReactEChartsCore
      echarts={echarts}
      option={{ backgroundColor: 'transparent', ...option }}
      notMerge
      lazyUpdate
      style={{ height, width: '100%' }}
      className={className}
      opts={{ renderer: 'canvas' }}
      onEvents={onEvents as never}
    />
  );
}
