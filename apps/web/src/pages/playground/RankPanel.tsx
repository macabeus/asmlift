// asmlift webapp — ranking UI. Three views over the same Ranking state:
//  • RankBadge — a one-line strip above the Source view: the best candidate's verdict (byte-exact
//    at objdiff score 0, or the closest score). Only ever reflects the CURRENT input (the H1
//    guard in useRanking).
//  • RankDeclarations — the block the winning candidate was COMPILED WITH, shown under the badge.
//  • RankCandidates — the Pipeline tab's final card: every scored candidate with its objdiff
//    score, best first, plus the declarations asmlift refused to synthesize.
import { renderDeclarations } from '@asmlift/core/declare';

import { progressBar, progressLabel } from './rank-progress';
import type { RefusedDeclaration } from './score-wasm';
import type { Ranking } from './useRanking';

/** How many of the winning candidate's declarations are HYPOTHESES — names no symbol map knew,
 *  whose type was read out of the same asm the verdict is about (core SymbolRef.synthesized). */
function synthesizedCount(ranking: Ranking): number {
  return ranking.status === 'ok' ? (ranking.result.best.symbolRefs ?? []).filter((r) => r.synthesized).length : 0;
}

const REFUSAL_TEXT: Record<RefusedDeclaration['reason'], string> = {
  'not-an-identifier': 'not a C identifier (a relocation/label name)',
  reserved: 'a name a declaration cannot claim (keyword, prelude typedef, or built-in)',
  'call-target': 'called here — declaring its arity would be a guess, so it stays implicit',
  'self-name': 'the function being decompiled — its own definition declares it',
  'emitter-name': 'a name the emitted C uses for its own locals; every spelling of it was dropped',
};

/** The verdict strip shown above the emitted Source. Null when ranking is off (non-agbcc target
 *  or C++/Pascal backend) — those keep the plain decompile with no badge. */
export function RankBadge({ ranking }: { ranking: Ranking }) {
  if (ranking.status === 'off') {
    return null;
  }

  const base = 'rounded-md px-2.5 py-1 text-[11px] font-medium';
  if (ranking.status === 'loading') {
    // A REAL progressbar, and only as determinate as the run actually is. The candidate total does
    // not exist until `enumerateCandidates` returns — 62.3 s of one measured run — so three of the
    // four phases render with `aria-valuenow` OMITTED, which is the ARIA spelling of
    // indeterminate; an invented 0 would not be. The phase sentence is visible text either way, so
    // this is never LESS informative than the bare div it replaces.
    //
    // No `aria-live`: a ~10 Hz live region is a screen-reader flood. `role="progressbar"` plus
    // `aria-valuetext` is the accessible channel.
    const bar = progressBar(ranking);
    return (
      <div className={`${base} border border-slate-700 bg-slate-900/60 text-slate-400`}>
        <div
          role="progressbar"
          aria-valuetext={bar.label}
          aria-valuemin={bar.determinate ? 0 : undefined}
          aria-valuemax={bar.valueMax}
          aria-valuenow={bar.valueNow}
        >
          <span>{bar.label}</span>
          <div className="mt-1 h-1 overflow-hidden rounded bg-slate-800">
            {bar.determinate ? (
              // `bar.pct` is clamped to 99 while `aria-valuenow` above stays EXACT: the last
              // scoring tick is followed by the sort and a six-figure structured clone, and a full
              // bar over that is the lie a bar most easily tells. The phase then changes to
              // `ranking` and this element falls back to the indeterminate stripe — a visible
              // change of character rather than a bar sitting full.
              <div
                className="h-full rounded bg-teal-500 transition-[width] duration-200"
                style={{ width: `${bar.pct}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-pulse rounded bg-slate-600" />
            )}
          </div>
        </div>
      </div>
    );
  }
  if (ranking.status === 'error') {
    return (
      <div className={`${base} border border-amber-900/60 bg-amber-950/30 text-amber-300`} title={ranking.error}>
        ranking unavailable — {ranking.error}
      </div>
    );
  }
  const best = ranking.result.best;
  // The verdict is about the TRANSLATION UNIT, not the source alone: where a declaration was
  // synthesized, the block below it is part of what compiled to these bytes, and it was fitted to
  // this very asm. Saying "byte-exact" without saying that is the silent half of a wrong answer.
  const assumed = synthesizedCount(ranking);
  return best.score.score === 0 ? (
    <div className={`${base} border border-emerald-800 bg-emerald-950/40 text-emerald-300`}>
      ✓ byte-exact match — objdiff score 0 <span className="text-emerald-500/80">({best.label})</span>
      {assumed > 0 && (
        <span className="text-emerald-500/80">
          {' '}
          · with {assumed} synthesized declaration{assumed > 1 ? 's' : ''}
        </span>
      )}
    </div>
  ) : (
    <div className={`${base} border border-amber-900/60 bg-amber-950/30 text-amber-300`}>
      closest candidate — objdiff score {best.score.score} <span className="text-amber-500/80">({best.label})</span>
    </div>
  );
}

/** The declaration block the winning candidate was COMPILED WITH, under the verdict strip.
 *
 *  Without it the Source view is half of what was scored: agbcc-wasm compiles candidates with no
 *  project headers, so every global the source names is declared here. Where a declaration is
 *  SYNTHESIZED its width and signedness came out of the pasted asm itself — the same bytes the
 *  verdict is about — so it cannot lose score, and hiding it would turn a hypothesis into a
 *  claim. Shown, it is the assumption the user checks against their own headers. */
export function RankDeclarations({ ranking }: { ranking: Ranking }) {
  if (ranking.status !== 'ok') {
    return null;
  }
  const refs = ranking.result.best.symbolRefs ?? [];
  if (refs.length === 0) {
    return null;
  }
  const assumed = refs.filter((r) => r.synthesized).length;
  return (
    <details className="rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[11px]" open>
      <summary className="cursor-pointer text-slate-400">
        compiled with {refs.length} declaration{refs.length > 1 ? 's' : ''}
        {assumed > 0 && (
          <span className="text-amber-400/90">
            {' '}
            — {assumed} synthesized from this asm (no symbol map knows {assumed > 1 ? 'those names' : 'that name'});
            check {assumed > 1 ? 'them' : 'it'} against your headers
          </span>
        )}
      </summary>
      <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed text-slate-300">
        {renderDeclarations(refs).trimEnd()}
      </pre>
    </details>
  );
}

/** The Pipeline tab's ranked-candidates card. */
export function RankCandidates({ ranking }: { ranking: Ranking }) {
  if (ranking.status === 'off') {
    // Non-agbcc target: ranking genuinely needs the (Docker/proprietary) toolchains — keep the
    // honest disclaimer the browser could not get past for MIPS/PPC.
    return (
      <p className="pt-1 text-[11px] italic leading-relaxed text-slate-500">
        This is the process view. Ranked candidates are scored in-browser for the GBA/agbcc target (agbcc + objdiff
        compiled to WebAssembly); the MIPS/PPC targets need the real compiler toolchains, so their ranking lives in the
        CLI/benchmark reports.
      </p>
    );
  }
  if (ranking.status === 'loading') {
    // The SAME sentence the badge shows, from the same helper — two views that spell the phase
    // themselves are two views that come to disagree about one run.
    return <p className="pt-1 text-[11px] italic text-slate-500">{progressLabel(ranking)}</p>;
  }
  if (ranking.status === 'error') {
    return (
      <div className="mt-1 rounded-md border border-amber-900/60 bg-amber-950/30 p-2.5 text-[11px] leading-relaxed text-amber-300">
        <p className="font-semibold">ranking declined</p>
        <p className="font-mono text-amber-200/90">{ranking.error}</p>
      </div>
    );
  }

  const { candidates, best, dropped, withheld, refused } = ranking.result;
  return (
    <div className="mt-1 rounded-lg border border-slate-700 bg-slate-900/70 p-2.5">
      <p className="mb-2 text-xs font-semibold text-slate-200">
        Ranked candidates <span className="font-normal text-slate-500">— agbcc + objdiff, in your browser</span>
      </p>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
            <th className="pb-1 font-medium">candidate (variant tried)</th>
            <th className="pb-1 pl-2 font-medium">objdiff score</th>
            <th className="pb-1 pl-2 font-medium">matched instrs</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {candidates.map((c) => {
            const isBest = c === best;
            const exact = c.score.score === 0;
            return (
              <tr key={c.label} className={isBest ? 'text-slate-100' : 'text-slate-400'}>
                <td className="py-0.5">
                  {isBest && (
                    <span className="mr-1 text-teal-400" title="best (lowest score)">
                      ★
                    </span>
                  )}
                  {c.label}
                </td>
                <td className={`py-0.5 pl-2 ${exact ? 'text-emerald-400' : ''}`}>
                  {c.score.score}
                  {exact && ' ✓'}
                </td>
                <td className="py-0.5 pl-2 text-slate-500">
                  {c.score.matching}/{c.score.rows}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(withheld.length > 0 || dropped.length > 0) && (
        <p className="mt-2 text-[10px] leading-relaxed text-amber-400/80">
          {withheld.length > 0 &&
            `${withheld.length} spelling(s) withheld — built and scored, but publication needs a
            byte-exact score. `}
          {dropped.length > 0 && `${dropped.length} spelling(s) failed to build.`}
        </p>
      )}
      {/* A name asmlift REFUSED to declare and one it never saw fail identically ("`x' undeclared"),
          and only the first is asmlift's own decision — so the refusals are named here rather than
          left for the user to attribute. The heading says UNDECLARED and nothing about compiling:
          two of these reasons leave a candidate that builds anyway (an implicit call, a local that
          shadows the name), and one of them leaves no candidate at all. */}
      {refused.length > 0 && (
        <div className="mt-2 text-[10px] leading-relaxed text-amber-400/80">
          <p>{refused.length} symbol(s) left UNDECLARED on purpose:</p>
          <ul className="mt-0.5 space-y-0.5 font-mono">
            {refused.map((r) => (
              <li key={`${r.name}:${r.reason}`}>
                {r.name} — {REFUSAL_TEXT[r.reason]}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Score 0 = byte-exact. The differ is the fitness function: signedness and branch-sense are genuinely ambiguous
        from asm, so each spelling is compiled and scored, not guessed.
      </p>
    </div>
  );
}
