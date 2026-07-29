import type { DecompilerResult, GapSize, Outcome } from '@asmlift/bench-schema';

import { GAP_BUCKETS, GAP_BUCKET_COLOR, OUTCOME_COLOR, OUTCOME_LABEL } from '../../theme';

/** Solid-dot + tinted-pill badge, colored by outcome. */
export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const color = OUTCOME_COLOR[outcome];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${color}22`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

/** Measured gap-size pill: differing / total objdiff instruction rows of the best scored candidate. */
export function GapBadge({ gap }: { gap: GapSize }) {
  const bucket = GAP_BUCKETS.find((b) => gap.score <= b.max) ?? GAP_BUCKETS[GAP_BUCKETS.length - 1];
  const color = GAP_BUCKET_COLOR[bucket.key];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-xs font-medium"
      style={{ backgroundColor: `${color}22`, color }}
      title={`best compiling candidate: ${gap.decompiler}, ${(gap.ratio * 100).toFixed(0)}% of instructions differ`}
    >
      {gap.score}/{gap.maxScore}
    </span>
  );
}

/** Symbol-map provenance pill (asmlift rows only — m2c results never carry these fields):
 *  teal = the winning candidate's output references map symbols, slate = ran with the map but
 *  the winner named none of them, amber = the never-worse backstop re-ran the row raw. */
export function SymbolsBadge({ result }: { result: DecompilerResult }) {
  const pill = (cls: string, label: string, title: string) => (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${cls}`} title={title}>
      {label}
    </span>
  );
  if (result.symbolMapFellBack) {
    return pill(
      'bg-amber-500/15 text-amber-300',
      'symbols: fell back',
      'the symbol map induced a gap — the never-worse backstop re-ran (and classified) this row raw',
    );
  }
  if (!result.symbolMap) {
    return null;
  }
  return (result.symbolsUsed?.length ?? 0) > 0
    ? pill(
        'bg-teal-500/15 text-teal-300',
        'symbols',
        "the winning candidate's output references the project's symbol map (chips below)",
      )
    : pill(
        'bg-slate-600/30 text-slate-400',
        'symbols: unused',
        'ran with the symbol map, but the winning spelling referenced none of its symbols',
      );
}

/** Neutral tag chip for features. */
export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded bg-slate-700/60 px-1.5 py-0.5 text-[11px] font-mono text-slate-300">
      {children}
    </span>
  );
}
