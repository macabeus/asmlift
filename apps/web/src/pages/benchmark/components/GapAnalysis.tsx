import type { FunctionResult } from '@asmlift/bench-schema';

import { declinePareto } from '../lib/declines';
import type { ExplorerPreset } from './Explorer';
import { DeclinePareto } from './charts/DeclinePareto';
import { Panel } from './ui/Section';

export function GapAnalysis({
  rows,
  onExplore,
}: {
  rows: FunctionResult[];
  onExplore: (preset: ExplorerPreset) => void;
}) {
  const pareto = declinePareto(rows);

  return (
    <div className="space-y-6">
      <Panel
        title="What blocks asmlift — the decline-reason Pareto"
        subtitle="Every asmlift's declined functions names WHY it declined. Grouped by missing capability: the roadmap view — which capability would win the most functions. A function counts toward every class it exhibits."
      >
        <DeclinePareto
          data={pareto}
          onBarClick={(key) => onExplore({ outcomeDecompiler: 'asmlift', outcome: 'declined', decline: key })}
        />
      </Panel>
    </div>
  );
}
