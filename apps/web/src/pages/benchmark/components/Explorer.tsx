import type { DecompilerId, FunctionResult, Outcome } from '@asmlift/bench-schema';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { useMemo } from 'react';

import type { ShareState } from '../../../shared/utils/permalink';
import { DECLINE_CLASSES, OTHER_CLASS, declineClassesOf } from '../lib/declines';
import { FILTER_PARSERS, FILTER_URL_KEYS, SORT_PARSERS, type SortKey, type Verdict } from '../lib/explorer-url';
import { canOpenInPlayground, playgroundShare } from '../lib/playground';
import { distinct, distinctFeatures } from '../lib/stats';
import { DECOMPILER_COLOR, ISA_LABEL, OUTCOME_LABEL, OUTCOME_ORDER, TOOLCHAIN_LABEL } from '../theme';
import { FunctionDetail } from './FunctionDetail';
import { Chip, GapBadge, OutcomeBadge } from './ui/Badge';

// Re-exported so the aggregates (Overview, Gap Analysis) keep their preset-type import here.
export type { ExplorerPreset, Filters } from '../lib/explorer-url';

const outcomeRank: Record<Outcome, number> = {
  match: 0,
  nonmatch: 1, // compiles, scored — closest to a match
  noncompile: 2, // claims completeness, fails to compile
  declined: 3, // explicit marker-bearing decline (never scored)
  failed: 4,
};

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-slate-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 focus:border-teal-500 focus:outline-hidden"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ScoreCell({ result }: { result: FunctionResult['asmlift'] }) {
  const score = result.score === null ? '' : result.maxScore ? `${result.score}/${result.maxScore}` : `${result.score}`;
  return (
    <div className="flex items-center gap-2">
      <OutcomeBadge outcome={result.outcome} />
      {score && <span className="font-mono text-xs text-slate-500">{score}</span>}
    </div>
  );
}

export function Explorer({
  rows,
  onOpenInPlayground,
}: {
  rows: FunctionResult[];
  /** hand a row's input to the playground view (the shell switches views + seeds the editor) */
  onOpenInPlayground: (s: ShareState) => void;
}) {
  // All URL state: filters replace history (no spam while narrowing), the selected row pushes
  // (Back closes the detail). Benchmark.tsx writes the same keys for the preset deep links.
  const [filters, setFilters] = useQueryStates(FILTER_PARSERS, { urlKeys: FILTER_URL_KEYS });
  const [{ sort: sortKey, dir: sortDir }, setSort] = useQueryStates(SORT_PARSERS);
  const [selectedId, setSelectedId] = useQueryState('fn', parseAsString.withOptions({ history: 'push' }));
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

  const projects = useMemo(() => distinct(rows, (r) => r.project), [rows]);
  const isas = useMemo(() => distinct(rows, (r) => r.isa), [rows]);
  const toolchains = useMemo(() => distinct(rows, (r) => r.toolchain), [rows]);
  const features = useMemo(() => distinctFeatures(rows), [rows]);

  const set = (patch: Partial<typeof filters>) => void setFilters(patch);

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (filters.project && r.project !== filters.project) {
        return false;
      }
      if (filters.isa && r.isa !== filters.isa) {
        return false;
      }
      if (filters.toolchain && r.toolchain !== filters.toolchain) {
        return false;
      }
      if (filters.tier && r.tier !== filters.tier) {
        return false;
      }
      if (filters.feature && !r.features.includes(filters.feature)) {
        return false;
      }
      if (filters.decline && !declineClassesOf(r).includes(filters.decline)) {
        return false;
      }
      if (q && !r.sym.toLowerCase().includes(q)) {
        return false;
      }
      if (filters.verdict) {
        const a = r.asmlift.outcome === 'match';
        const m = r.m2c.outcome === 'match';
        if (filters.verdict === 'disagree') {
          if (r.asmlift.outcome === r.m2c.outcome) {
            return false;
          }
        } else {
          const v = a && m ? 'both' : a ? 'asmlift-only' : m ? 'm2c-only' : 'neither';
          if (v !== filters.verdict) {
            return false;
          }
        }
      }
      if (filters.outcome) {
        const dec = filters.outcomeDecompiler;
        if (dec === 'any') {
          if (r.asmlift.outcome !== filters.outcome && r.m2c.outcome !== filters.outcome) {
            return false;
          }
        } else if (r[dec].outcome !== filters.outcome) {
          return false;
        }
      }
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'sym':
          cmp = a.sym.localeCompare(b.sym);
          break;
        case 'project':
          cmp = a.project.localeCompare(b.project) || a.sym.localeCompare(b.sym);
          break;
        case 'toolchain':
          cmp = a.toolchain.localeCompare(b.toolchain) || a.sym.localeCompare(b.sym);
          break;
        case 'asmlift':
          cmp = outcomeRank[a.asmlift.outcome] - outcomeRank[b.asmlift.outcome] || a.sym.localeCompare(b.sym);
          break;
        case 'm2c':
          cmp = outcomeRank[a.m2c.outcome] - outcomeRank[b.m2c.outcome] || a.sym.localeCompare(b.sym);
          break;
      }
      return cmp * dir;
    });
    return out;
  }, [rows, filters, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      void setSort({ dir: sortDir === 'asc' ? 'desc' : 'asc' });
    } else {
      void setSort({ sort: key, dir: null }); // null resets dir to its 'asc' default
    }
  };

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="space-y-4">
      {/* Filter row */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl bg-slate-800/40 p-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-slate-400">Search symbol</span>
          <input
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="function name…"
            className="w-48 rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 focus:border-teal-500 focus:outline-hidden"
          />
        </label>
        <Select
          label="Project"
          value={filters.project}
          onChange={(v) => set({ project: v })}
          options={[{ value: '', label: 'All' }, ...projects.map((p) => ({ value: p, label: p }))]}
        />
        <Select
          label="Assembly (ISA)"
          value={filters.isa}
          onChange={(v) => set({ isa: v })}
          options={[{ value: '', label: 'All' }, ...isas.map((t) => ({ value: t, label: ISA_LABEL[t] ?? t }))]}
        />
        <Select
          label="Toolchain"
          value={filters.toolchain}
          onChange={(v) => set({ toolchain: v })}
          options={[
            { value: '', label: 'All' },
            ...toolchains.map((t) => ({
              value: t,
              label: TOOLCHAIN_LABEL[t as keyof typeof TOOLCHAIN_LABEL] ?? t,
            })),
          ]}
        />
        <Select
          label="Tier"
          value={filters.tier}
          onChange={(v) => set({ tier: v })}
          options={[
            { value: '', label: 'All' },
            { value: 'synthetic', label: 'Synthetic' },
            { value: 'real', label: 'Real' },
          ]}
        />
        <Select
          label="Outcome of"
          value={filters.outcomeDecompiler}
          onChange={(v) => set({ outcomeDecompiler: v as DecompilerId | 'any' })}
          options={[
            { value: 'any', label: 'Either' },
            { value: 'asmlift', label: 'asmlift' },
            { value: 'm2c', label: 'm2c' },
          ]}
        />
        <Select
          label="Outcome"
          value={filters.outcome}
          onChange={(v) => set({ outcome: v })}
          options={[{ value: '', label: 'All' }, ...OUTCOME_ORDER.map((o) => ({ value: o, label: OUTCOME_LABEL[o] }))]}
        />
        <Select
          label="Head-to-head"
          value={filters.verdict}
          onChange={(v) => set({ verdict: v as Verdict })}
          options={[
            { value: '', label: 'All' },
            { value: 'asmlift-only', label: 'asmlift only' },
            { value: 'm2c-only', label: 'm2c only' },
            { value: 'both', label: 'both match' },
            { value: 'neither', label: 'neither' },
            { value: 'disagree', label: 'outcomes differ' },
          ]}
        />
        <Select
          label="asmlift decline"
          value={filters.decline}
          onChange={(v) => set({ decline: v })}
          options={[
            { value: '', label: 'All' },
            ...DECLINE_CLASSES.map((c) => ({ value: c.key, label: c.label })),
            { value: OTHER_CLASS.key, label: OTHER_CLASS.label },
          ]}
        />
        <Select
          label="Feature"
          value={filters.feature}
          onChange={(v) => set({ feature: v })}
          options={[{ value: '', label: 'All' }, ...features.map((f) => ({ value: f, label: f }))]}
        />
        <button
          onClick={() => void setFilters(null)}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
        >
          Reset
        </button>
        <span className="ml-auto self-center text-xs text-slate-400">
          {filtered.length} / {rows.length} functions
        </span>
      </div>

      {/* Table */}
      <div className="scroll-slim overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-slate-800/60 text-left text-xs uppercase tracking-wide text-slate-400">
              <Th onClick={() => toggleSort('sym')}>Symbol{arrow('sym')}</Th>
              <Th onClick={() => toggleSort('project')}>Project{arrow('project')}</Th>
              <Th onClick={() => toggleSort('toolchain')}>Toolchain{arrow('toolchain')}</Th>
              <Th>Features</Th>
              <Th onClick={() => toggleSort('asmlift')}>
                <span style={{ color: DECOMPILER_COLOR.asmlift }}>asmlift</span>
                {arrow('asmlift')}
              </Th>
              <Th onClick={() => toggleSort('m2c')}>
                <span style={{ color: DECOMPILER_COLOR.m2c }}>m2c</span>
                {arrow('m2c')}
              </Th>
              <Th>
                <span title="best compiling candidate's objdiff diff (differing/total instructions)">Gap</span>
              </Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                onClick={() => void setSelectedId(r.id)}
                className="cursor-pointer border-t border-slate-800 hover:bg-slate-800/40"
              >
                <td className="px-3 py-2 font-mono text-slate-100">{r.sym}</td>
                <td className="px-3 py-2 text-slate-300">{r.project}</td>
                <td className="px-3 py-2 text-slate-400">{TOOLCHAIN_LABEL[r.toolchain]}</td>
                <td className="px-3 py-2">
                  <div className="flex max-w-[220px] flex-wrap gap-1">
                    {r.features.slice(0, 4).map((f) => (
                      <Chip key={f}>{f}</Chip>
                    ))}
                    {r.features.length > 4 && (
                      <span className="text-[11px] text-slate-500">+{r.features.length - 4}</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <ScoreCell result={r.asmlift} />
                </td>
                <td className="px-3 py-2">
                  <ScoreCell result={r.m2c} />
                </td>
                <td className="px-3 py-2">
                  {r.gapSize ? <GapBadge gap={r.gapSize} /> : <span className="text-xs text-slate-600">—</span>}
                </td>
                <td className="px-3 py-2">
                  {canOpenInPlayground(r) && (
                    <button
                      title="Open in playground"
                      onClick={(e) => {
                        e.stopPropagation();
                        const share = playgroundShare(r);
                        if (share) {
                          onOpenInPlayground(share);
                        }
                      }}
                      className="rounded px-1.5 py-0.5 text-teal-400 hover:bg-slate-800 hover:text-teal-200"
                    >
                      ↗
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-slate-500">
                  No functions match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <FunctionDetail
          fn={selected}
          // Replace, not push: Back after closing must not reopen the detail.
          onClose={() => void setSelectedId(null, { history: 'replace' })}
          onOpenInPlayground={onOpenInPlayground}
        />
      )}
    </div>
  );
}

function Th({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2.5 font-semibold ${onClick ? 'cursor-pointer select-none hover:text-slate-200' : ''}`}
    >
      {children}
    </th>
  );
}
