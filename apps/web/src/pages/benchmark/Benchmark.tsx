// The Benchmark view — the m2c-vs-asmlift report, lazy-loaded as its own chunk (ECharts + the
// committed results.json are heavy, so a plain playground visit never pays for them). Rendered by
// the shell (../App.tsx), which owns the shared header + primary nav, so this view only renders its
// own context row, sub-tabs, and content — the page frame stays put when toggling. `onOpenInPlayground`
// hands a row's input back to the editor. Syntax highlighting uses the global VS Code `.pl-*` palette
// in index.css (shared with the playground and the rest of the family), so no per-view stylesheet.
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { useCallback } from 'react';

import summary from '../../data/summary.json';
import type { ShareState } from '../../shared/utils/permalink';
import { Disclaimer } from './components/Disclaimer';
import { Explorer, type ExplorerPreset } from './components/Explorer';
import { GapAnalysis } from './components/GapAnalysis';
import { Methodology } from './components/Methodology';
import { Overview } from './components/Overview';
import { meta, results } from './lib/data';
import { FILTERS_RESET, FILTER_PARSERS, FILTER_URL_KEYS, type TabId, tabParser } from './lib/explorer-url';
import { DECOMPILER_COLOR } from './theme';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'explorer', label: 'Function Explorer' },
  { id: 'gap', label: 'Gap Analysis' },
  { id: 'methodology', label: 'Methodology' },
];

export default function Benchmark({ onOpenInPlayground }: { onOpenInPlayground: (s: ShareState) => void }) {
  // Pushed so Back walks sub-tabs.
  const [tab, setTab] = useQueryState('tab', tabParser.withOptions({ history: 'push' }));
  const [, setFilters] = useQueryStates(FILTER_PARSERS, { urlKeys: FILTER_URL_KEYS });
  const [, setSelectedId] = useQueryState('fn', parseAsString);
  // An aggregate's preset replaces the WHOLE filter set and closes any open detail; all three
  // writes land as one pushed history entry, so Back returns to the aggregate that was clicked.
  const openExplorer = useCallback(
    (p: ExplorerPreset) => {
      void setFilters({ ...FILTERS_RESET, ...p }, { history: 'push' });
      void setSelectedId(null, { history: 'push' });
      void setTab('explorer');
    },
    [setFilters, setSelectedId, setTab],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div className="flex flex-col gap-1">
            <div>
              <span className="font-mono text-sm">
                <span style={{ color: DECOMPILER_COLOR.asmlift }}>asmlift</span>
                <span className="text-slate-500"> vs </span>
                <span style={{ color: DECOMPILER_COLOR.m2c }}>m2c</span>
              </span>
              <p className="text-xs text-slate-500">
                {meta.counts.total} functions · {meta.toolchains.length} toolchains · generated{' '}
                {meta.generatedAt.slice(0, 10)}
                {meta.asmlift && (
                  <>
                    {' '}
                    · asmlift{' '}
                    <span className="font-mono">
                      {meta.asmlift.commit.slice(0, 7)}
                      {meta.asmlift.dirty ? '+dirty' : ''}
                    </span>
                  </>
                )}{' '}
                · m2c <span className="font-mono">{summary.m2cCommit.slice(0, 7)}</span>
              </p>
            </div>

            <Disclaimer />
          </div>
        </div>

        <nav className="mt-4 flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-teal-500/15 text-teal-300'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <main>
        {tab === 'overview' && <Overview rows={results} onExplore={openExplorer} />}
        {tab === 'explorer' && <Explorer rows={results} onOpenInPlayground={onOpenInPlayground} />}
        {tab === 'gap' && <GapAnalysis rows={results} onExplore={openExplorer} />}
        {tab === 'methodology' && <Methodology rows={results} />}
      </main>
    </div>
  );
}
