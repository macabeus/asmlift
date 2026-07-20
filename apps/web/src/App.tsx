// The shell: a constant frame (shared Header card + primary tab row, in one max-width container)
// with two swappable views — the Playground (always mounted, so the editor keeps its state and the
// ranking worker stays warm) and the Benchmark (lazy — ECharts + the committed results.json are
// heavy, so a plain playground visit never downloads them; mounted on first visit, then kept alive
// and hidden). Because the header, tabs, and container are the shell's, toggling views never shifts
// the page frame. Navigation state lives in the query string via nuqs: `?view=benchmark` selects
// the Benchmark (absent = playground, the default), `?s=<lz-string>` is the playground permalink.
//
// The header follows the shared design system (Mizuchi / Transmuter / gba-kit): a rounded-2xl slate
// gradient panel with the logo (glow behind), a gradient-clip title, subtitle, right-side content,
// and a gradient underline strip. asmlift's accent is teal (the water spirit) + gold (the scrolls).
import { parseAsStringLiteral, useQueryState, useQueryStates } from 'nuqs';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';

import logoUrl from './assets/logo.png';
import { Playground } from './pages/playground/Playground';
import type { ShareState } from './shared/utils/permalink';
import { parseAsShareState } from './shared/utils/url-state';

const Benchmark = lazy(() => import('./pages/benchmark/Benchmark'));

const VIEWS = ['playground', 'benchmark'] as const;
export type View = (typeof VIEWS)[number];

const viewParser = parseAsStringLiteral(VIEWS).withDefault('playground');

const NAV: { id: View; label: string }[] = [
  { id: 'playground', label: 'Playground' },
  { id: 'benchmark', label: 'Benchmark' },
];

const SUBTITLE: Record<View, string> = {
  playground: 'a matching decompiler — assembly in, C out, in your browser',
  benchmark: 'asmlift vs m2c — the byte-exactness benchmark',
};

export function App() {
  // Pushed so Back returns to the previous view.
  const [view, setView] = useQueryState('view', viewParser.withOptions({ history: 'push' }));
  const [benchVisited, setBenchVisited] = useState(view === 'benchmark');
  // "Open in playground": the view switch and the row's share state as ONE pushed history entry.
  const [, setHandoff] = useQueryStates({ view: viewParser, s: parseAsShareState });

  useEffect(() => {
    if (view === 'benchmark') {
      setBenchVisited(true);
    }
  }, [view]);

  const navigate = useCallback(
    (v: View) => {
      if (v === 'benchmark') {
        setBenchVisited(true); // synchronously, so the first click never paints a blank frame
      }
      void setView(v);
    },
    [setView],
  );

  const openInPlayground = useCallback(
    (s: ShareState) => {
      void setHandoff({ view: 'playground', s }, { history: 'push' });
    },
    [setHandoff],
  );

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-[1400px] flex-col px-4 py-6">
        <header className="mb-6 overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 shadow-xl">
          <div className="flex items-center justify-between gap-6 px-6 py-5 sm:px-8">
            <div className="flex min-w-0 items-center gap-4 sm:gap-5">
              <div className="relative flex-shrink-0">
                <div className="absolute inset-0 rounded-full bg-amber-400/25 blur-xl" />
                <img
                  src={logoUrl}
                  alt="asmlift logo"
                  className="relative h-14 w-14 object-contain drop-shadow-lg sm:h-16 sm:w-16"
                />
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  <span className="bg-gradient-to-r from-teal-300 via-teal-200 to-amber-300 bg-clip-text text-transparent">
                    asmlift
                  </span>
                </h1>
                <p className="mt-0.5 truncate text-sm font-medium text-slate-400">{SUBTITLE[view]}</p>
              </div>
            </div>
          </div>
          <div className="h-1 bg-gradient-to-r from-teal-500 via-teal-400 to-amber-400" />
        </header>

        <nav className="mb-6 flex items-center gap-2">
          {NAV.map((n) => {
            const isActive = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => navigate(n.id)}
                className={`rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                  isActive
                    ? 'border border-teal-500/30 bg-teal-500/20 text-teal-300 shadow-lg shadow-teal-500/10'
                    : 'border border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                }`}
              >
                {n.label}
              </button>
            );
          })}
        </nav>

        <div className={view === 'playground' ? undefined : 'hidden'}>
          <Playground active={view === 'playground'} />
        </div>
        {benchVisited && (
          <div className={view === 'benchmark' ? undefined : 'hidden'}>
            <Suspense fallback={<BenchmarkLoading />}>
              <Benchmark onOpenInPlayground={openInPlayground} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

function BenchmarkLoading() {
  return <div className="grid min-h-[60vh] place-items-center text-sm text-slate-500">loading the benchmark…</div>;
}
