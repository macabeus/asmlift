// The Benchmark view — the asmlift-vs-m2c report, lazy-loaded as its own chunk (ECharts + the
// committed results.json are heavy, so a plain playground visit never pays for them). Rendered by
// the shell (../App.tsx), which owns the shared header + primary nav, so this view only renders its
// own sub-tabs and content — the page frame stays put when toggling. `onOpenInPlayground`
// hands a row's input back to the editor. Syntax highlighting uses the global VS Code `.pl-*` palette
// in index.css (shared with the playground and the rest of the family), so no per-view stylesheet.
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { useCallback } from 'react';

import { useCurrentHash } from '../../shared/utils/hash-adapter';
import type { ShareState } from '../../shared/utils/permalink';
import { Explorer, type ExplorerPreset } from './components/Explorer';
import { FanExplorer } from './components/FanExplorer';
import { FeatureDetail } from './components/FeatureDetail';
import { GapAnalysis } from './components/GapAnalysis';
import { Methodology } from './components/Methodology';
import { Overview } from './components/Overview';
import { VariationDetail } from './components/VariationDetail';
import { results } from './lib/data';
import {
  FEATURE_TERM_KEY,
  FEATURE_TERM_PARSER,
  FILTERS_RESET,
  FILTER_PARSERS,
  FILTER_URL_KEYS,
  type TabId,
  VARIATION_TERM_KEY,
  VARIATION_TERM_PARSER,
  tabParser,
} from './lib/explorer-url';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'explorer', label: 'Function Explorer' },
  { id: 'fan', label: 'Fan Explorer' },
  { id: 'gap', label: 'Gap Analysis' },
  { id: 'methodology', label: 'Methodology' },
];

export default function Benchmark({ onOpenInPlayground }: { onOpenInPlayground: (s: ShareState) => void }) {
  // Pushed so Back walks sub-tabs.
  const [tab, setTab] = useQueryState('tab', tabParser.withOptions({ history: 'push' }));
  const [, setFilters] = useQueryStates(FILTER_PARSERS, { urlKeys: FILTER_URL_KEYS });
  const [, setSelectedId] = useQueryState('fn', parseAsString);
  const [aboutFeature, setAboutFeature] = useQueryState(FEATURE_TERM_KEY, FEATURE_TERM_PARSER);
  const [aboutVariation, setAboutVariation] = useQueryState(VARIATION_TERM_KEY, VARIATION_TERM_PARSER);
  const hash = useCurrentHash();
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

  // Pushed, so Back closes the drawer and returns to the filter that was open — as the row drawer
  // does.
  const openFeature = useCallback((id: string) => void setAboutFeature(id, { history: 'push' }), [setAboutFeature]);
  const openVariation = useCallback(
    (name: string) => void setAboutVariation(name, { history: 'push' }),
    [setAboutVariation],
  );

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap gap-1">
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

      <main>
        {tab === 'overview' && <Overview rows={results} onExplore={openExplorer} />}
        {tab === 'explorer' && (
          <Explorer
            rows={results}
            hash={hash}
            onOpenInPlayground={onOpenInPlayground}
            onOpenFeature={openFeature}
            onOpenVariation={openVariation}
          />
        )}
        {tab === 'fan' && <FanExplorer rows={results} hash={hash} onOpenVariation={openVariation} />}
        {tab === 'gap' && <GapAnalysis rows={results} onExplore={openExplorer} />}
        {tab === 'methodology' && <Methodology rows={results} />}
      </main>

      {/* Above every tab, not inside one: a tag can be asked about from the table, the picker or a
          chart, and the answer should not depend on which. */}
      {aboutFeature && (
        <FeatureDetail
          id={aboutFeature}
          rows={results}
          onClose={() => void setAboutFeature(null, { history: 'replace' })}
          onOpenFeature={openFeature}
          onExplore={openExplorer}
        />
      )}

      {/* Above every tab for the same reason, on its own key: a variation is asked about from the
          catalogue, a chart, and a row's winning spelling. */}
      {aboutVariation && (
        <VariationDetail
          name={aboutVariation}
          rows={results}
          hash={hash}
          onClose={() => void setAboutVariation(null, { history: 'replace' })}
          onOpenVariation={openVariation}
        />
      )}
    </div>
  );
}
