// The function detail's account of the row's fan: the spelling that won, as the variations its
// winner carries grouped by kind, and the variations the fan carried that the winner does not. Every
// variation links to its drawer over the reader's view, so closing the drawer returns to this row.
//
// A plain function of its props (the chips' hover cards measure only once hovered), so it renders
// without a DOM.
import type { FunctionResult } from '@asmlift/bench-schema';
import { VARIATION_DEFINITIONS, VARIATION_KIND_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { type VariationKind, type VariationTally, joinVariations } from '@asmlift/core/variation-tokens';
import { useMemo } from 'react';

import { consideredButLost, winningSpelling } from '../lib/fan';
import { plainText } from '../lib/variation-text';
import { VARIATION_KIND_COLOR } from '../theme';
import { VariationChip } from './ui/Badge';
import { InlineCode } from './ui/InlineCode';
import { NotWaste } from './ui/NotWaste';

function KindHeading({ kind }: { kind: VariationKind }) {
  return (
    <div
      className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500"
      title={plainText(VARIATION_KIND_DEFINITIONS[kind].meaning)}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: VARIATION_KIND_COLOR[kind] }} />
      {VARIATION_KIND_DEFINITIONS[kind].title}
    </div>
  );
}

/** `50 candidates · 25 dropped`: how many of the fan's candidates carried a variation, the refused
 *  part of them, and the part a stillborn fan never compiled. */
function tallyText(t: VariationTally): string {
  const parts = [`${t.candidates.toLocaleString()} candidate${t.candidates === 1 ? '' : 's'}`];
  if (t.dropped) {
    parts.push(`${t.dropped.toLocaleString()} dropped`);
  }
  if (t.withheld) {
    parts.push(`${t.withheld.toLocaleString()} withheld`);
  }
  if (t.notCompiled) {
    parts.push(`${t.notCompiled.toLocaleString()} not compiled`);
  }
  return parts.join(' · ');
}

/** A variation's chip, its definition and its tally, as one list entry: side by side from `sm`, the
 *  chip above the rest on a phone so the text keeps the width. */
const ENTRY = 'flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3';

export function WinningSpelling({
  fn,
  hash,
  onOpenVariation,
}: {
  fn: FunctionResult;
  /** the live fragment, so a variation's link keeps this row's detail open under its drawer */
  hash: string;
  onOpenVariation: (name: string) => void;
}) {
  const spelling = useMemo(() => winningSpelling(fn), [fn]);
  const lost = useMemo(() => consideredButLost(fn), [fn]);
  const fan = fn.asmlift.fanSize;

  // A row whose fan was not counted (it never ranked, or its scorer died) has neither a winner nor a fan.
  if (!fn.asmlift.fanVariations || fan === undefined) {
    return null;
  }
  const lostCount = lost.reduce((n, g) => n + g.items.length, 0);
  const candidates = `${fan.toLocaleString()} candidate${fan === 1 ? '' : 's'}`;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 sm:p-4">
      {spelling.length > 0 ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold text-slate-100">The winning spelling</h3>
            <span className="text-xs text-slate-500">chosen from {candidates}</span>
          </div>
          <p className="mt-1 break-all font-mono text-xs text-slate-400">
            {joinVariations(fn.asmlift.winnerVariations ?? [])}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            The variations the published candidate carries, by kind. Hover one for its definition; click it for its
            entry in the Fan Explorer.
          </p>
          <div className="mt-3 space-y-3">
            {spelling.map((g) => (
              <div key={g.kind}>
                <KindHeading kind={g.kind} />
                <ul className="mt-1.5 space-y-2">
                  {g.items.map((p, i) => {
                    const def = VARIATION_DEFINITIONS[p.name];
                    return (
                      <li key={`${p.part}-${i}`} className={ENTRY}>
                        <span className="shrink-0 sm:w-44">
                          <VariationChip part={p.part} hash={hash} onOpen={onOpenVariation} />
                        </span>
                        <span className="min-w-0 flex-1 text-xs leading-relaxed text-slate-400">
                          <span className="text-slate-200">
                            <InlineCode text={def.title} />
                          </span>
                          {' — '}
                          <InlineCode text={def.summary} />
                        </span>
                        <span
                          className="shrink-0 font-mono text-[11px] text-slate-500"
                          title={`${tallyText(p.tally)} of the ${fan.toLocaleString()} in this row's fan carried it`}
                        >
                          {p.tally.candidates.toLocaleString()} / {fan.toLocaleString()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold text-slate-100">No winning spelling</h3>
            <span className="text-xs text-slate-500">a fan of {candidates}</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            No candidate won, so every variation this row&apos;s fan carried is listed below as considered and lost.
          </p>
        </>
      )}

      <div className="mt-4 border-t border-slate-700/70 pt-3">
        <h3 className="text-sm font-semibold text-slate-100">Considered and lost</h3>
        {lostCount === 0 ? (
          <p className="mt-1 text-xs text-slate-500">Every variation the fan carried is in the winning spelling.</p>
        ) : (
          <>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {lostCount} variation{lostCount === 1 ? '' : 's'} the fan carried
              {spelling.length > 0 ? ' that the winner does not' : ''}, most candidates first. A candidate counts under
              every variation it carries, so the counts overlap and do not add up to the fan.
            </p>
            <div className="mt-2">
              <NotWaste />
            </div>
            <div className="mt-3 space-y-3">
              {lost.map((g) => (
                <div key={g.kind}>
                  <KindHeading kind={g.kind} />
                  <ul className="mt-1.5 space-y-2">
                    {g.items.map((v) => (
                      <li key={v.name} className={ENTRY}>
                        <span className="shrink-0 sm:w-44">
                          <VariationChip part={v.name} hash={hash} onOpen={onOpenVariation} dim />
                        </span>
                        <span className="min-w-0 flex-1 text-xs text-slate-300">
                          <InlineCode text={VARIATION_DEFINITIONS[v.name].title} />
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-slate-500">{tallyText(v.tally)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
