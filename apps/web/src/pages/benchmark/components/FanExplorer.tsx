// The Fan Explorer: the variations asmlift writes a function in, grouped by kind and ranked by
// winners, with what each one cost and returned at each optimisation level. Every number comes from
// `lib/fan.ts` over the one artifact the rest of the page renders, and every entry's prose from
// `@asmlift/core/variation-definitions`, so a registered variation is an entry here without an edit.
import type { FunctionResult } from '@asmlift/bench-schema';
import { READER_WORDS, VARIATION_DEFINITIONS, VARIATION_KIND_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { VARIATION_KINDS } from '@asmlift/core/variation-tokens';
import { useMemo, useState } from 'react';

import { variationHref } from '../lib/explorer-url';
import {
  type LevelStats,
  type VariationStats,
  catalogue,
  compactCount,
  fanCoverage,
  levelLine,
  levelStats,
  levelToolchains,
  plural,
  priced,
  variationLevels,
  variationStats,
} from '../lib/fan';
import { VARIATION_KIND_COLOR, levelMarker } from '../theme';
import { type LevelSeries, VariationCostGain } from './charts/VariationCostGain';
import { type LevelPrices, VariationPricePerWin, dearestFirst } from './charts/VariationPricePerWin';
import { InlineCode } from './ui/InlineCode';
import { NotWaste } from './ui/NotWaste';
import { Panel } from './ui/Section';
import { followInPlace } from './ui/follow-in-place';

function Glossary() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <h3 className="text-[11px] uppercase tracking-wide text-slate-500">Words</h3>
        <dl className="mt-2 space-y-2 text-xs">
          {READER_WORDS.map((w) => (
            <div key={w.word}>
              <dt className="font-medium capitalize text-slate-200">{w.word}</dt>
              <dd className="mt-0.5 leading-relaxed text-slate-400">
                <InlineCode text={w.meaning} />
                {w.command && (
                  <span className="text-slate-500">
                    {' '}
                    <InlineCode text={w.command} />
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <h3 className="text-[11px] uppercase tracking-wide text-slate-500">Kinds of variation</h3>
        <dl className="mt-2 space-y-2 text-xs">
          {VARIATION_KINDS.map((k) => (
            <div key={k}>
              <dt className="flex items-center gap-2 font-medium text-slate-200">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: VARIATION_KIND_COLOR[k] }} />
                {VARIATION_KIND_DEFINITIONS[k].title}
              </dt>
              <dd className="mt-0.5 leading-relaxed text-slate-400">
                <InlineCode text={VARIATION_KIND_DEFINITIONS[k].meaning} />{' '}
                <span className="text-slate-500">
                  e.g.{' '}
                  {VARIATION_KIND_DEFINITIONS[k].examples.map((ex, i) => (
                    <span key={ex}>
                      {i > 0 && ', '}
                      <span className="whitespace-nowrap font-mono text-slate-400">{ex}</span>
                    </span>
                  ))}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** The price chart opens on the dearest wins; the rest are one click away. */
const PRICE_BARS = 15;

function Charts({
  levels,
  coverage,
  hash,
  onOpenVariation,
}: {
  /** the counted rows, partitioned by optimisation level (`levelStats`) */
  levels: LevelStats[];
  /** every counted row, and the candidates in their fans (`fanCoverage`) */
  coverage: { rows: number; candidates: number };
  hash: string;
  onOpenVariation: (name: string) => void;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [allPrices, setAllPrices] = useState(false);
  // A level's marker is fixed by its rank among every level, so hiding one never reshapes another.
  const shown = useMemo(
    () =>
      levels
        .map((l, rank) => ({ ...l, marker: levelMarker(rank), ...priced(l.stats) }))
        .filter((l) => !hidden.has(l.level)),
    [levels, hidden],
  );
  const bubbles = useMemo(
    (): LevelSeries[] =>
      shown.map((l) => ({ level: l.level, marker: l.marker, variations: [...l.won, ...l.neverWon] })),
    [shown],
  );
  const prices = useMemo((): LevelPrices[] => shown.map((l) => ({ level: l.level, won: l.won })), [shown]);
  const names = useMemo(() => dearestFirst(prices), [prices]);
  const bars = useMemo(() => (allPrices ? names : names.slice(0, PRICE_BARS)), [names, allPrices]);
  const { rows, candidates } = coverage;
  const heading = (
    <h2 className="text-base font-semibold text-slate-100">What each variation cost, and what it returned</h2>
  );

  // A chart frame with nothing plotted looks like a live chart that failed, so an artifact with no
  // counted fan gets a sentence instead.
  if (rows === 0) {
    return (
      <div className="space-y-1">
        {heading}
        <p className="max-w-3xl text-xs leading-relaxed text-slate-500">
          No fan in this artifact was counted, so there is nothing to price.
        </p>
      </div>
    );
  }

  const toggle = (level: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(level)) {
        next.add(level);
      }
      return next;
    });

  return (
    <div className="space-y-4">
      <div>
        {heading}
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
          Over the {rows.toLocaleString()} rows whose fan was counted: {candidates.toLocaleString()} candidates. A
          candidate counts once under every variation it carries, so the counts overlap and do not add up to the fan.
          Each optimisation level is priced over its own rows: a variation that wins at one level can cost the same and
          never win at another, and a level&apos;s price never mixes in another level&apos;s wins.
        </p>
      </div>
      <NotWaste />
      <div role="group" aria-label="optimisation levels" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">Levels drawn</span>
        {levels.map((l, rank) => {
          const on = !hidden.has(l.level);
          const last = on && shown.length === 1;
          return (
            <button
              key={l.level}
              aria-pressed={on}
              disabled={last}
              title={last ? 'at least one level stays drawn' : undefined}
              onClick={() => toggle(l.level)}
              className={`rounded-md border px-2 py-1 ${
                on
                  ? 'border-teal-600 bg-teal-900/40 text-teal-200'
                  : 'border-slate-700 text-slate-500 hover:bg-slate-800 hover:text-slate-300'
              } disabled:cursor-default`}
            >
              <span className="font-mono">
                {levelMarker(rank).glyph} {l.level}
              </span>{' '}
              <span className="text-slate-400">
                · {plural(l.coverage.rows, 'row')} · {levelToolchains(l)}
              </span>
            </button>
          );
        })}
      </div>
      <Panel
        title="Cost against gain"
        subtitle="One bubble per variation at each level drawn, its shape the level. Across: candidates that carried it. Up: the share of that level's rows whose fan carried it that won with it. Area: those rows, with a minimum size so every bubble can be clicked. Click a bubble for its definition."
      >
        <VariationCostGain series={bubbles} onPointClick={onOpenVariation} />
      </Panel>
      <Panel
        title="Price per win"
        subtitle="Candidates carried per win at each level drawn, dearest first: bar length is the price. Click a bar for its definition."
      >
        <VariationPricePerWin series={prices} names={bars} onBarClick={onOpenVariation} />
        {names.length > PRICE_BARS && (
          <button
            onClick={() => setAllPrices((v) => !v)}
            className="mt-2 rounded-md px-2 py-1 text-xs text-teal-400 hover:bg-slate-800 hover:text-teal-300"
          >
            {allPrices ? `Show the ${PRICE_BARS} dearest` : `Show all ${names.length}`}
          </button>
        )}
        {shown.some((l) => l.neverWon.length > 0) && (
          <div className="mt-3 border-t border-slate-800 pt-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Never won, so no price</div>
            {shown
              .filter((l) => l.neverWon.length > 0)
              .map((l) => (
                <div key={l.level} className="mt-2 flex flex-wrap items-baseline gap-1.5">
                  <span className="mr-1 whitespace-nowrap font-mono text-[11px] text-slate-400">
                    {l.marker.glyph} {l.level}
                  </span>
                  {l.neverWon.map((s) => (
                    <a
                      key={s.name}
                      href={variationHref(s.name, hash)}
                      onClick={(e) => followInPlace(e, () => onOpenVariation(s.name))}
                      className="whitespace-nowrap rounded bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-300 hover:bg-teal-900/60 hover:text-teal-200"
                    >
                      {s.name}{' '}
                      <span className="text-slate-500">
                        · {compactCount(s.candidates)} {s.candidates === 1 ? 'candidate' : 'candidates'}
                      </span>
                    </a>
                  ))}
                </div>
              ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function CatalogueEntry({
  s,
  levels,
  max,
  hash,
  onOpenVariation,
}: {
  s: VariationStats;
  /** the variation's totals at each level whose fans carried it */
  levels: { level: string; s: VariationStats }[];
  max: number;
  hash: string;
  onOpenVariation: (name: string) => void;
}) {
  const def = VARIATION_DEFINITIONS[s.name];
  return (
    <a
      href={variationHref(s.name, hash)}
      onClick={(e) => followInPlace(e, () => onOpenVariation(s.name))}
      className="flex flex-col gap-2 border-t border-slate-800 px-4 py-3 first:border-t-0 hover:bg-slate-800/40 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="text-sm font-medium text-slate-100">
            <InlineCode text={def.title} />
          </span>
          <span className="whitespace-nowrap font-mono text-[11px] text-slate-500">{s.name}</span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-400 first-letter:uppercase">
          <InlineCode text={def.summary} />
        </p>
        {levels.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-slate-500">
            {levels.map((l) => (
              <li key={l.level}>{levelLine(l.level, l.s)}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid w-full shrink-0 grid-cols-4 gap-2 text-right sm:w-80">
        <div>
          <div className="font-mono text-sm text-slate-100">{compactCount(s.winners)}</div>
          <div className="text-[10px] text-slate-500">winners</div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className="ml-auto h-full rounded-full"
              style={{
                width: `${max === 0 ? 0 : Math.max(s.winners ? 3 : 0, (s.winners / max) * 100)}%`,
                backgroundColor: VARIATION_KIND_COLOR[s.kind],
              }}
            />
          </div>
        </div>
        <div>
          <div className="font-mono text-sm text-slate-300">{compactCount(s.rows)}</div>
          <div className="text-[10px] text-slate-500">rows carried</div>
        </div>
        <div>
          <div className="font-mono text-sm text-slate-300">{compactCount(s.candidates)}</div>
          <div className="text-[10px] text-slate-500">candidates</div>
        </div>
        <div>
          <div className="font-mono text-sm text-slate-300">{s.toolchains}</div>
          <div className="text-[10px] text-slate-500">toolchains</div>
        </div>
      </div>
    </a>
  );
}

export function FanExplorer({
  rows,
  hash,
  onOpenVariation,
}: {
  rows: readonly FunctionResult[];
  /** the live fragment, so an entry's link keeps the reader's view */
  hash: string;
  onOpenVariation: (name: string) => void;
}) {
  const stats = useMemo(() => variationStats(rows), [rows]);
  const groups = useMemo(() => catalogue(stats), [stats]);
  const levels = useMemo(() => levelStats(rows), [rows]);
  const coverage = useMemo(() => fanCoverage(rows), [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-100">The fan, by variation</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
          Assembly leaves some choices open, such as a signedness, a branch sense or where a value lives. asmlift does
          not guess them: it writes the function in each way it knows, compiles each candidate, and publishes the one
          that scores best. Each entry below is one variation. A fan&apos;s size says nothing about its outcome, and a
          few rows hold most of the candidates.
        </p>
      </div>

      <Glossary />

      <div className="space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Every variation</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">
            Grouped by kind, ranked by winners. Rows and candidates count the fans that carried the variation, won or
            lost; winners are those rows whose winner carries it. Under each, one line per optimisation level, counted
            over that level&apos;s rows alone. Where a variation changes nothing, its candidate repeats an earlier
            source and is not enumerated. Click an entry for its definition and its rows.
          </p>
        </div>
        {groups.map((g) => (
          <section key={g.kind}>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className="h-2 w-2 self-center rounded-full"
                style={{ backgroundColor: VARIATION_KIND_COLOR[g.kind] }}
              />
              <h3 className="text-sm font-semibold text-slate-200">{VARIATION_KIND_DEFINITIONS[g.kind].title}</h3>
              <span className="text-xs text-slate-500">
                {g.variations.length} variation{g.variations.length === 1 ? '' : 's'} ·{' '}
                <InlineCode text={VARIATION_KIND_DEFINITIONS[g.kind].meaning} />
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-800">
              {g.variations.map((s) => (
                <CatalogueEntry
                  key={s.name}
                  s={s}
                  levels={variationLevels(levels, s.name)}
                  max={g.variations[0].winners}
                  hash={hash}
                  onOpenVariation={onOpenVariation}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      <Charts levels={levels} coverage={coverage} hash={hash} onOpenVariation={onOpenVariation} />
    </div>
  );
}
