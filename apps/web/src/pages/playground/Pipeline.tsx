// The Pipeline tab: the browser-pure TraceReport rendered as a stage timeline — each tower
// stage with its post-verify IR dump, pattern rewrites as before/after cards inside the
// idiom-fold stage. Stages whose IR is identical to the previous dump are dimmed "no change":
// a stage that did nothing on this input is information, not a display bug.
import type { PatternEvent, StageTrace, TraceReport } from '@asmlift/core/trace';

import { RankCandidates } from './RankPanel';
import type { Ranking } from './useRanking';

const dump =
  'scroll-slim overflow-x-auto whitespace-pre rounded bg-slate-950/70 p-2 font-mono text-[11px] leading-relaxed text-slate-300';

function PatternCard({ ev }: { ev: PatternEvent }) {
  return (
    <div className="mt-2 rounded-md border border-teal-900/60 bg-teal-950/20 p-2">
      <p className="mb-1.5 text-[11px] font-semibold text-teal-300">
        pattern <span className="font-mono">{ev.patternId}</span> — {ev.hits} hit{ev.hits > 1 ? 's' : ''}
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">before</p>
          <pre className={dump}>{ev.beforeIr}</pre>
        </div>
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">after</p>
          <pre className={dump}>{ev.afterIr}</pre>
        </div>
      </div>
    </div>
  );
}

function StageCard({ stage, changed, events }: { stage: StageTrace; changed: boolean; events: PatternEvent[] }) {
  return (
    <div
      className={`rounded-lg border p-2.5 ${changed ? 'border-slate-700 bg-slate-900/70' : 'border-slate-800/70 bg-slate-900/30'}`}
    >
      <details open={changed && stage.irDump !== undefined}>
        <summary className={`cursor-pointer text-xs ${changed ? '' : 'opacity-60'}`}>
          <span className="font-semibold text-slate-200">{stage.title}</span>
          {stage.verified && (
            <span className="ml-2 text-emerald-500" title="verifier passed after this stage">
              ✓
            </span>
          )}
          {!changed && (
            <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
              no change
            </span>
          )}
          {stage.note && <span className="ml-2 text-slate-500">{stage.note}</span>}
        </summary>
        {stage.irDump !== undefined && <pre className={`mt-2 ${dump}`}>{stage.irDump}</pre>}
      </details>
      {events.map((ev) => (
        <PatternCard key={ev.id} ev={ev} />
      ))}
    </div>
  );
}

export function Pipeline({ report, ranking }: { report: TraceReport; ranking: Ranking }) {
  if (report.trace.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-800 p-4 text-center text-sm text-slate-500">
        <p>The run declined before the first stage:</p>
        {report.declineReason && <p className="max-w-xl font-mono text-xs text-amber-300/90">{report.declineReason}</p>}
      </div>
    );
  }
  let prevDump: string | undefined;
  const stages = report.trace.map((stage) => {
    const changed = stage.irDump === undefined ? true : prevDump === undefined || stage.irDump !== prevDump;
    if (stage.irDump !== undefined) {
      prevDump = stage.irDump;
    }
    return { stage, changed };
  });
  return (
    <div className="scroll-slim h-full space-y-2 overflow-auto rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      {stages.map(({ stage, changed }, i) => (
        <StageCard
          key={`${stage.id}-${i}`}
          stage={stage}
          changed={changed}
          events={stage.id === 'stage:idiom' ? report.patternEvents : []}
        />
      ))}
      <RankCandidates ranking={ranking} />
    </div>
  );
}
