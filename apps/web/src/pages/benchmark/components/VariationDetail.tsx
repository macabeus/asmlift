// What one variation MEANS, in the same right-side drawer FeatureDetail uses: its definition and
// example from `@asmlift/core/variation-definitions`, its numbers over the benchmark, and every row
// it touched, each with the winner's variations and this one lit inside them.
//
// Split in two so the body renders without a DOM: the shell owns the overlay behaviour (scroll lock,
// Escape), which needs `window`; the body is a plain function of its props.
import type { FunctionResult } from '@asmlift/bench-schema';
import { VARIATION_DEFINITIONS, VARIATION_KIND_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { type VariationName, variationToken } from '@asmlift/core/variation-tokens';
import { useMemo } from 'react';

import { CodeBlock } from '../../../shared/components/CodeBlock';
import { Pill } from '../../../shared/components/Pill';
import { useOverlay } from '../../../shared/utils/overlay';
import { rowHref, variationHref } from '../lib/explorer-url';
import { pricePerWin, rowsFor, variationStats, winRate } from '../lib/fan';
import { TOOLCHAIN_LABEL, VARIATION_KIND_COLOR } from '../theme';
import { OutcomeBadge } from './ui/Badge';
import { InlineCode } from './ui/InlineCode';
import { NotWaste } from './ui/NotWaste';
import { followInPlace } from './ui/follow-in-place';

const CODE_PRE = 'rounded-md bg-slate-950/70 p-3 text-[12px] leading-relaxed text-slate-200';

function isVariationName(name: string): name is VariationName {
  return Object.hasOwn(VARIATION_DEFINITIONS, name);
}

export function VariationDetail({
  name,
  rows,
  hash,
  onClose,
  onOpenVariation,
}: {
  name: string;
  rows: readonly FunctionResult[];
  /** the live fragment, so a see-also link keeps the reader's view */
  hash: string;
  onClose: () => void;
  /** follow a see-also link — swaps the drawer's subject without closing it */
  onOpenVariation: (name: string) => void;
}) {
  useOverlay(onClose);

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="scroll-slim w-full max-w-3xl overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl">
        {isVariationName(name) ? (
          <VariationDetailBody
            name={name}
            rows={rows}
            hash={hash}
            onClose={onClose}
            onOpenVariation={onOpenVariation}
          />
        ) : (
          // Only reachable from a hand-edited URL: every published name is registered and defined.
          <div className="p-6">
            <p className="text-sm text-slate-300">
              No variation is called <code className="font-mono text-slate-100">{name}</code>.
            </p>
            <CloseButton onClose={onClose} />
          </div>
        )}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      className="shrink-0 rounded-md px-3 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
    >
      Close ✕
    </button>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wide text-slate-500">{children}</div>;
}

export function VariationDetailBody({
  name,
  rows,
  hash,
  onClose,
  onOpenVariation,
}: {
  name: VariationName;
  rows: readonly FunctionResult[];
  hash: string;
  onClose: () => void;
  onOpenVariation: (name: string) => void;
}) {
  const def = VARIATION_DEFINITIONS[name];
  const kind = variationToken(name).variationKind;
  const stats = useMemo(() => variationStats(rows).get(name)!, [rows, name]);
  const touched = useMemo(() => rowsFor(rows, name), [rows, name]);
  const rate = winRate(stats);
  const price = pricePerWin(stats);

  return (
    <>
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-700 bg-slate-900/95 px-6 py-4 backdrop-blur-sm">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold text-white">
              <InlineCode text={def.title} />
            </h2>
            <Pill mono size="xs">
              {name}
            </Pill>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <Pill
              tint={VARIATION_KIND_COLOR[kind]}
              dot
              title={VARIATION_KIND_DEFINITIONS[kind].meaning.replace(/`/g, '')}
            >
              {VARIATION_KIND_DEFINITIONS[kind].title}
            </Pill>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <div className="space-y-5 p-6">
        {/* Summaries are lowercase fragments, to read as a clause in the catalogue; here one opens a
            paragraph. */}
        <p className="text-sm leading-relaxed text-slate-200 first-letter:uppercase">
          <InlineCode text={def.summary} />
        </p>
        <p className="text-sm leading-relaxed text-slate-400">
          <InlineCode text={def.detail} />
        </p>

        {def.compilerBehavior && (
          <div>
            <Caption>Why the compiler cares</Caption>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
              <InlineCode text={def.compilerBehavior} />
            </p>
          </div>
        )}

        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">without it</div>
              <CodeBlock code={def.example.before} language="c" className={CODE_PRE} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-teal-500">with {name}</div>
              <CodeBlock code={def.example.after} language="c" className={CODE_PRE} />
            </div>
          </div>
          {def.example.note && (
            <p className="text-xs leading-relaxed text-slate-500">
              <InlineCode text={def.example.note} />
            </p>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
          <Caption>Offered when</Caption>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
            <InlineCode text={def.offeredWhen} />
          </p>
          {def.subject && (
            <>
              <div className="mt-3">
                <Caption>Its subject</Caption>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
                <InlineCode text={def.subject.meaning} />
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {def.subject.examples.map((ex) => (
                  <Pill key={ex} mono size="xs">
                    {ex}
                  </Pill>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-4">
          <Caption>In this benchmark</Caption>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
            <Figure label="winners" value={stats.winners} />
            <Figure label="rows whose fan carried it" value={stats.rows} />
            <Figure
              label="candidates carried"
              value={stats.candidates}
              hint={
                stats.dropped || stats.withheld
                  ? `${stats.dropped.toLocaleString()} dropped · ${stats.withheld.toLocaleString()} withheld`
                  : undefined
              }
            />
            <Figure label="toolchains" value={stats.toolchains} />
            <Figure label="win rate" value={rate === null ? null : `${Math.round(rate * 100)}%`} />
            <Figure
              label="candidates per win"
              value={price === null ? (stats.rows > 0 ? 'no win' : null) : Math.round(price)}
            />
          </dl>
          <NotWaste />
        </div>

        <RowTable name={name} rows={touched} hash={hash} />

        <p className="text-xs text-slate-500">
          Implemented in <code className="font-mono text-slate-400">{def.implementedIn}</code>
        </p>

        {def.seeAlso && def.seeAlso.length > 0 && (
          <div>
            <Caption>See also</Caption>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {def.seeAlso.map((s) => (
                <a
                  key={s}
                  href={variationHref(s, hash)}
                  onClick={(e) => followInPlace(e, () => onOpenVariation(s))}
                  title={VARIATION_DEFINITIONS[s].summary.replace(/`/g, '')}
                  className="rounded bg-slate-800 px-2 py-1 font-mono text-[11px] text-slate-300 hover:bg-teal-900/60 hover:text-teal-200"
                >
                  {s}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Figure({ label, value, hint }: { label: string; value: number | string | null; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="font-mono text-base text-white" title={value === null ? 'no fan carried it' : hint}>
        {value === null ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
      </dd>
      {hint && <dd className="text-[11px] text-slate-500">{hint}</dd>}
    </div>
  );
}

/** Every row whose fan carried the variation. Winners first. */
function RowTable({ name, rows, hash }: { name: VariationName; rows: ReturnType<typeof rowsFor>; hash: string }) {
  const won = rows.filter((r) => r.won).length;
  return (
    <div>
      <Caption>
        Rows — {won} won with it, {rows.length - won} considered it and lost
      </Caption>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No row in this benchmark carried it.</p>
      ) : (
        <div className="scroll-slim mt-2 max-h-96 overflow-auto rounded-lg border border-slate-800">
          {/* FIXED layout with declared widths: the symbol is the one unbounded column, and left to
              itself it pushes the winner's variations off the edge. It truncates instead. */}
          <table className="w-full min-w-[36rem] table-fixed border-collapse text-sm">
            <thead className="sticky top-0 bg-slate-900/95 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-[28%] px-3 py-1.5 text-left font-medium">Function</th>
                <th className="w-[16%] px-3 py-1.5 text-left font-medium">Toolchain</th>
                <th className="w-[16%] px-3 py-1.5 text-left font-medium">asmlift</th>
                <th
                  className="w-[10%] px-3 py-1.5 text-right font-medium"
                  title="candidates in this row's fan carrying it"
                >
                  Cand.
                </th>
                <th className="w-[30%] px-3 py-1.5 text-left font-medium">Winner&apos;s variations</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, tally, winner }) => (
                <tr key={row.id} className="border-t border-slate-800/70 hover:bg-slate-800/40">
                  <td className="truncate px-3 py-1.5 font-mono text-xs">
                    <a
                      href={rowHref(row.id, hash)}
                      title={row.id}
                      className="text-slate-100 hover:text-teal-300 hover:underline"
                    >
                      {row.sym}
                    </a>
                  </td>
                  <td
                    className="truncate px-3 py-1.5 text-[11px] text-slate-400"
                    title={TOOLCHAIN_LABEL[row.toolchain]}
                  >
                    {row.toolchain}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <OutcomeBadge outcome={row.asmlift.outcome} />
                  </td>
                  <td
                    className="px-3 py-1.5 text-right font-mono text-xs text-slate-300"
                    title={
                      tally.dropped || tally.withheld
                        ? `${tally.dropped ?? 0} dropped · ${tally.withheld ?? 0} withheld`
                        : undefined
                    }
                  >
                    {tally.candidates.toLocaleString()}
                  </td>
                  {/* THIS variation lit inside the winner's variations: the column answers where it
                      sits in the spelling that won, or shows it absent from it. */}
                  <td className="px-3 py-1.5 font-mono text-[11px] leading-relaxed" data-name={name}>
                    {winner.length === 0 ? (
                      <span className="text-slate-600">no winner</span>
                    ) : (
                      winner.map((p, i) => (
                        <span key={`${p.part}-${i}`}>
                          {i > 0 && <span className="text-slate-700">/</span>}
                          <span className={p.lit ? 'font-semibold text-teal-300' : 'text-slate-500'}>{p.part}</span>
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
