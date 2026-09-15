// What one variation MEANS, in the same right-side drawer FeatureDetail uses: its definition and
// example from `@asmlift/core/variation-definitions`, its numbers over the benchmark, and every row
// it touched, each with the winner's variations and this one lit inside them.
//
// Split in two so the body renders without a DOM: the shell owns the overlay behaviour (scroll lock,
// Escape), which needs `window`; the body is a plain function of its props.
import type { FunctionResult } from '@asmlift/bench-schema';
import { shellJoinFlags } from '@asmlift/core/codegen-flags';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  EXAMPLE_COMPILER_NAMES,
  EXAMPLE_COMPILER_TOOLCHAINS,
  type ExampleCompiler,
  type OfferedWhen,
  TARGET_BEHAVIOR_READINGS,
  VARIATION_DEFINITIONS,
  VARIATION_KIND_DEFINITIONS,
} from '@asmlift/core/variation-definitions';
import { readerRules } from '@asmlift/core/variation-gates';
import {
  type GatingBehavior,
  type TargetGate,
  type VariationName,
  variationToken,
} from '@asmlift/core/variation-tokens';
import { useMemo } from 'react';

import { CodeBlock } from '../../../shared/components/CodeBlock';
import { Pill } from '../../../shared/components/Pill';
import { useOverlay } from '../../../shared/utils/overlay';
import { unitForDisplay } from '../lib/example-unit';
import { rowHref, variationHref } from '../lib/explorer-url';
import {
  type VariationStats,
  fanLevel,
  levelStats,
  pricePerWin,
  rowsFor,
  variationLevels,
  variationStats,
  winRate,
} from '../lib/fan';
import { plainText } from '../lib/variation-text';
import { TOOLCHAIN_LABEL, VARIATION_KIND_COLOR } from '../theme';
import { OutcomeBadge } from './ui/Badge';
import { InlineCode } from './ui/InlineCode';
import { NotWaste } from './ui/NotWaste';
import { followInPlace } from './ui/follow-in-place';

const CODE_PRE = 'rounded-md bg-slate-950/70 p-3 text-[12px] leading-relaxed text-slate-200';

/** The flags an example's two objects are compiled at: its toolchain's canonical flags. */
const exampleFlags = (compiler: ExampleCompiler) =>
  shellJoinFlags(TOOLCHAIN_TARGETS[EXAMPLE_COMPILER_TOOLCHAINS[compiler]].canonicalFlags);

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
      <div className="scroll-slim w-full max-w-2xl overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl">
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
          <div className="flex items-start justify-between gap-4 px-6 py-4">
            <p className="py-1 text-sm text-slate-300">
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
  const levels = useMemo(() => variationLevels(levelStats(rows), name), [rows, name]);

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
            <Pill tint={VARIATION_KIND_COLOR[kind]} dot title={plainText(VARIATION_KIND_DEFINITIONS[kind].meaning)}>
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
          {/* Stacked, as FeatureDetail's are: a one-line example side by side is cut at half width. */}
          <div className="space-y-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">without it</div>
              <CodeBlock code={def.example.before} language="c" className={CODE_PRE} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-teal-500">with {name}</div>
              <CodeBlock code={def.example.after} language="c" className={CODE_PRE} />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Compiled with {EXAMPLE_COMPILER_NAMES[def.example.compiler]} at its canonical flags{' '}
            <code className="font-mono text-slate-400">{exampleFlags(def.example.compiler)}</code> in the unit below,
            the two are different objects.
          </p>
          {def.example.note && (
            <p className="text-xs leading-relaxed text-slate-500">
              <InlineCode text={def.example.note} />
            </p>
          )}
          {/* The context that makes the two differ (a loop, register pressure, a declaration) is in the
              unit, so the reader can compile exactly what the matching suite compiles. */}
          <details>
            <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">The compiled unit</summary>
            <CodeBlock code={unitForDisplay(def.example.unit)} language="c" className={`mt-2 ${CODE_PRE}`} />
          </details>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
          <Caption>Offered when</Caption>
          <Offer offer={def.offeredWhen} target={variationToken(name).target} />
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
          </dl>
          {levels.length > 0 && <LevelTable levels={levels} />}
          {stats.candidates > 0 && <NotWaste />}
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
                  title={plainText(VARIATION_DEFINITIONS[s].summary)}
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

/** A list of rules longer than this starts folded: some passes carry twenty. */
const OPEN_RULES = 6;

/** When enumeration offers the variation, in the order a reader asks: the condition, the target it
 *  needs, the rules that can still refuse it (each table's own `why`), and where that is decided. */
function Offer({ offer, target }: { offer: OfferedWhen; target?: TargetGate<GatingBehavior> }) {
  const rules = offer === 'always' ? [] : readerRules(offer.gates ?? []);
  return (
    <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-slate-300">
      <p>
        {offer === 'always' ? (
          'On every function.'
        ) : 'judges' in offer ? (
          <>
            For <InlineCode text={offer.judges} />, unless{' '}
            {rules.length === 1 ? 'the rule' : `one of the ${rules.length} rules`} below refuses it.
          </>
        ) : (
          <InlineCode text={offer.when} />
        )}
      </p>
      {target && <TargetLine gate={target} />}
      {rules.length > 0 && (
        <details open={rules.length <= OPEN_RULES}>
          <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">
            The {rules.length} rules that can still refuse it
          </summary>
          <ul className="mt-2 space-y-1.5">
            {rules.map((r) => (
              <li
                key={`${r.id} ${r.why}`}
                title={r.id}
                className="flex items-baseline gap-2 text-[13px] text-slate-400"
              >
                <span
                  className={`shrink-0 rounded px-1.5 text-[10px] uppercase tracking-wide ${
                    r.sound ? 'bg-rose-950/60 text-rose-300' : 'bg-slate-800 text-slate-400'
                  }`}
                  title={
                    r.sound
                      ? 'without this rule some candidate would be wrong'
                      : 'a guess about codegen; the scorer still decides'
                  }
                >
                  {r.sound ? 'required' : 'heuristic'}
                </span>
                <span className="first-letter:uppercase">
                  <InlineCode text={r.why} />
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {offer !== 'always' && 'decidedBy' in offer && (
        <p className="text-xs text-slate-500">
          Decided by <code className="font-mono text-slate-400">{offer.decidedBy.symbol}</code> in{' '}
          <code className="font-mono text-slate-400">{offer.decidedBy.file}</code>
        </p>
      )}
    </div>
  );
}

/** The target gate as a sentence: "Only on…" when the compiler must declare the behavior, "Not on…"
 *  when it must not, with the variation whose company lifts it. */
function TargetLine({ gate }: { gate: TargetGate<GatingBehavior> }) {
  return (
    <p>
      {gate.declared ? 'Only' : 'Not'} on a target whose compiler {TARGET_BEHAVIOR_READINGS[gate.behavior].reads}
      {gate.unlessWith && (
        <>
          , unless together with <code className="font-mono text-slate-200">{gate.unlessWith}</code>
        </>
      )}
      .
    </p>
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

/** The variation at each optimisation level whose fans carried it, each level counted over its own rows,
 *  so a level's win rate and price per win never mix in another level's cost or wins. */
function LevelTable({ levels }: { levels: { level: string; s: VariationStats }[] }) {
  return (
    <div className="scroll-slim overflow-x-auto">
      <table className="w-full text-right text-xs">
        <caption className="pb-1.5 text-left text-[11px] text-slate-500">
          Per optimisation level, each counted over its own rows
        </caption>
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-slate-500">
            <th className="py-1 pr-3 text-left font-medium">Level</th>
            <th className="px-2 py-1 font-medium">Rows</th>
            <th className="px-2 py-1 font-medium">Toolchains</th>
            <th className="px-2 py-1 font-medium">Winners</th>
            <th className="px-2 py-1 font-medium">Candidates</th>
            <th className="px-2 py-1 font-medium">Win rate</th>
            <th className="py-1 pl-2 font-medium">Per win</th>
          </tr>
        </thead>
        <tbody className="font-mono text-slate-200">
          {levels.map(({ level, s }) => {
            const rate = winRate(s);
            const price = pricePerWin(s);
            return (
              <tr key={level} className="border-t border-slate-800">
                <td className="py-1 pr-3 text-left">{level}</td>
                <td className="px-2 py-1">{s.rows.toLocaleString()}</td>
                <td className="px-2 py-1">{s.toolchains}</td>
                <td className="px-2 py-1">{s.winners.toLocaleString()}</td>
                <td className="px-2 py-1">{s.candidates.toLocaleString()}</td>
                <td className="px-2 py-1">{rate === null ? '—' : `${Math.round(rate * 100)}%`}</td>
                <td className="py-1 pl-2">{price === null ? 'no win' : Math.round(price).toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The row list's columns from `sm` up. Below it a row is two lines: the function, its outcome and its
 *  candidates, then the winner's variations across the whole width. */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto_auto] sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_3.5rem_minmax(0,3fr)]';

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
        <div className="scroll-slim mt-2 max-h-96 overflow-y-auto rounded-lg border border-slate-800 text-sm">
          <div
            className={`${ROW_GRID} sticky top-0 z-10 hidden gap-x-3 bg-slate-900/95 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 sm:grid`}
          >
            <div>Function</div>
            <div>Toolchain · level</div>
            <div>asmlift</div>
            <div className="text-right" title="candidates in this row's fan carrying it">
              Cand.
            </div>
            <div>Winner&apos;s variations</div>
          </div>
          {rows.map(({ row, tally, winner }) => (
            <div
              key={row.id}
              className={`${ROW_GRID} items-center gap-x-3 gap-y-1 border-t border-slate-800/70 px-3 py-1.5 hover:bg-slate-800/40`}
            >
              <div className="truncate font-mono text-xs">
                <a
                  href={rowHref(row.id, hash)}
                  title={row.id}
                  className="text-slate-100 hover:text-teal-300 hover:underline"
                >
                  {row.sym}
                </a>
                <span className="text-[11px] text-slate-500 sm:hidden">
                  {' '}
                  · {row.toolchain} · {fanLevel(row)}
                </span>
              </div>
              <div
                className="hidden truncate text-[11px] text-slate-400 sm:block"
                title={TOOLCHAIN_LABEL[row.toolchain]}
              >
                {row.toolchain} · {fanLevel(row)}
              </div>
              <div className="whitespace-nowrap">
                <OutcomeBadge outcome={row.asmlift.outcome} />
              </div>
              <div
                className="text-right font-mono text-xs text-slate-300"
                title={
                  tally.dropped || tally.withheld
                    ? `${tally.dropped ?? 0} dropped · ${tally.withheld ?? 0} withheld`
                    : undefined
                }
              >
                {tally.candidates.toLocaleString()}
              </div>
              {/* THIS variation lit inside the winner's variations: the column answers where it sits in
                  the spelling that won, or shows it absent from it. A name never breaks inside itself
                  (`setup-args`); a line may break only after a `/`. */}
              <div className="col-span-full font-mono text-[11px] leading-relaxed sm:col-span-1" data-name={name}>
                {winner.length === 0 ? (
                  <span className="text-slate-600">no winner</span>
                ) : (
                  winner.map((p, i) => (
                    <span key={`${p.part}-${i}`}>
                      <span className="whitespace-nowrap">
                        <span className={p.lit ? 'font-semibold text-teal-300' : 'text-slate-500'}>{p.part}</span>
                        {i < winner.length - 1 && <span className="text-slate-700">/</span>}
                      </span>
                      <wbr />
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
