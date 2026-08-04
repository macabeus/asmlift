// What one feature tag MEANS, in the same right-side drawer the row detail uses — so "what is this
// tag?" is answered where the question is asked, without leaving the table behind.
//
// Rendered entirely from the vocabulary in @asmlift/bench-schema, so adding a tag adds its entry.
import {
  EVIDENCE_LABEL,
  type EvidenceKind,
  FEATURE_BY_ID,
  FEATURE_GROUP_LABEL,
  type FunctionResult,
} from '@asmlift/bench-schema';
import { useMemo } from 'react';

import { CodeBlock } from '../../../shared/components/CodeBlock';
import { HoverCard } from '../../../shared/components/HoverCard';
import { Pill } from '../../../shared/components/Pill';
import { useOverlay } from '../../../shared/utils/overlay';
import type { ExplorerPreset } from '../lib/explorer-url';
import { matchRate } from '../lib/stats';
import { DECOMPILER_COLOR } from '../theme';

const EVIDENCE_COLOR: Record<EvidenceKind, string> = {
  source: '#38bdf8',
  codegen: '#a78bfa',
  judgement: '#94a3b8',
};

const EVIDENCE_HELP: Record<EvidenceKind, string> = {
  source: "Checked against the function's own C every time the benchmark runs.",
  codegen: "Read from this row's compiled code, so the same function can carry it on one toolchain and not another.",
  judgement: 'Assigned by hand. Reviewed against a minimum bar, but not something a tool can decide.',
};

const CODE_PRE = 'rounded-md bg-slate-950/70 p-3 text-[12px] leading-relaxed text-slate-200';

export function FeatureDetail({
  id,
  rows,
  onClose,
  onOpenFeature,
  onExplore,
}: {
  id: string;
  rows: FunctionResult[];
  onClose: () => void;
  /** follow a see-also link — swaps the drawer's subject without closing it */
  onOpenFeature: (id: string) => void;
  onExplore: (p: ExplorerPreset) => void;
}) {
  const def = FEATURE_BY_ID.get(id);
  const carrying = useMemo(() => rows.filter((r) => r.features.includes(id)), [rows, id]);

  useOverlay(onClose);

  // Only reachable from a hand-edited URL: the vocabulary is closed and the tests forbid publishing
  // a tag without a definition.
  if (!def) {
    return (
      <div className="fixed inset-0 z-40 flex">
        <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
        <div className="w-full max-w-xl border-l border-slate-700 bg-slate-900 p-6 shadow-2xl">
          <p className="text-sm text-slate-300">
            No feature is called <code className="font-mono text-slate-100">{id}</code>.
          </p>
          <button onClick={onClose} className="mt-4 rounded-md px-3 py-1 text-sm text-slate-400 hover:bg-slate-800">
            Close ✕
          </button>
        </div>
      </div>
    );
  }

  const color = EVIDENCE_COLOR[def.evidence];

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="scroll-slim w-full max-w-2xl overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-700 bg-slate-900/95 px-6 py-4 backdrop-blur-sm">
          <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-lg font-semibold text-white">{def.label}</h2>
              <Pill mono size="xs">
                {def.id}
              </Pill>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>{FEATURE_GROUP_LABEL[def.group]}</span>
              <span className="text-slate-600">·</span>
              <HoverCard
                content={<p className="text-xs leading-relaxed text-slate-300">{EVIDENCE_HELP[def.evidence]}</p>}
              >
                <Pill tint={color} dot tabIndex={0} className="cursor-help focus:outline-hidden">
                  {EVIDENCE_LABEL[def.evidence]}
                </Pill>
              </HoverCard>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md px-3 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            Close ✕
          </button>
        </div>

        <div className="space-y-5 p-6">
          {/* Summaries are written as lowercase fragments, to read as a clause in the picker and
              the hover card; here one opens a paragraph. */}
          <p className="text-sm leading-relaxed text-slate-200 first-letter:uppercase">{def.summary}</p>
          {def.detail && <p className="text-sm leading-relaxed text-slate-400">{def.detail}</p>}

          {def.example && (
            <div className="space-y-2">
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">C</div>
                <CodeBlock code={def.example.c} language="c" className={CODE_PRE} />
              </div>
              {def.example.asm && (
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                    compiled{def.example.toolchain ? ` · ${def.example.toolchain}` : ''}
                  </div>
                  <CodeBlock code={def.example.asm} language="asm" className={CODE_PRE} />
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">In this benchmark</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <span className="text-slate-300">
                <span className="font-mono text-white">{carrying.length}</span> rows
              </span>
              {carrying.length > 0 && (
                <span className="text-slate-500">
                  match rate{' '}
                  <span className="font-mono" style={{ color: DECOMPILER_COLOR.asmlift }}>
                    {(matchRate(carrying, 'asmlift') * 100).toFixed(0)}%
                  </span>
                  {' / '}
                  <span className="font-mono" style={{ color: DECOMPILER_COLOR.m2c }}>
                    {(matchRate(carrying, 'm2c') * 100).toFixed(0)}%
                  </span>
                  <span className="text-slate-600"> (asmlift / m2c)</span>
                </span>
              )}
            </div>
            <button
              onClick={() => {
                onExplore({ feature: [def.id] });
                onClose();
              }}
              className="mt-3 rounded-md border border-teal-700 bg-teal-900/40 px-3 py-1 text-sm font-medium text-teal-300 hover:bg-teal-900/70"
            >
              Filter the table to these {carrying.length} rows →
            </button>
          </div>

          {def.seeAlso && def.seeAlso.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">See also</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {def.seeAlso
                  .filter((s) => FEATURE_BY_ID.has(s))
                  .map((s) => (
                    <button
                      key={s}
                      onClick={() => onOpenFeature(s)}
                      title={FEATURE_BY_ID.get(s)!.summary}
                      className="rounded bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-300 hover:bg-teal-900/60 hover:text-teal-200"
                    >
                      {s}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
