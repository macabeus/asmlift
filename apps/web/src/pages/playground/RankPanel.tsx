// asmlift webapp — ranking UI. Two views over the same Ranking state:
//  • RankBadge — a one-line strip above the Source view: the best candidate's verdict (byte-exact
//    at objdiff score 0, or the closest score). Only ever reflects the CURRENT input (the H1
//    guard in useRanking).
//  • RankCandidates — the Pipeline tab's final card: every scored candidate with its objdiff
//    score, best first.
import type { Ranking } from './useRanking';

/** The verdict strip shown above the emitted Source. Null when ranking is off (non-agbcc target
 *  or C++/Pascal backend) — those keep the plain decompile with no badge. */
export function RankBadge({ ranking }: { ranking: Ranking }) {
  if (ranking.status === 'off') {
    return null;
  }

  const base = 'rounded-md px-2.5 py-1 text-[11px] font-medium';
  if (ranking.status === 'loading') {
    return (
      <div className={`${base} border border-slate-700 bg-slate-900/60 text-slate-400`}>
        scoring candidates with agbcc + objdiff…
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
  return best.score.score === 0 ? (
    <div className={`${base} border border-emerald-800 bg-emerald-950/40 text-emerald-300`}>
      ✓ byte-exact match — objdiff score 0 <span className="text-emerald-500/80">({best.label})</span>
    </div>
  ) : (
    <div className={`${base} border border-amber-900/60 bg-amber-950/30 text-amber-300`}>
      closest candidate — objdiff score {best.score.score} <span className="text-amber-500/80">({best.label})</span>
    </div>
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
    return <p className="pt-1 text-[11px] italic text-slate-500">scoring candidates with agbcc + objdiff…</p>;
  }
  if (ranking.status === 'error') {
    return (
      <div className="mt-1 rounded-md border border-amber-900/60 bg-amber-950/30 p-2.5 text-[11px] leading-relaxed text-amber-300">
        <p className="font-semibold">ranking declined</p>
        <p className="font-mono text-amber-200/90">{ranking.error}</p>
      </div>
    );
  }

  const { candidates, best } = ranking.result;
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
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Score 0 = byte-exact. The differ is the fitness function: signedness and branch-sense are genuinely ambiguous
        from asm, so each spelling is compiled and scored, not guessed.
      </p>
    </div>
  );
}
