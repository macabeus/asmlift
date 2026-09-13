// The one place a score becomes text, and the one place the `[ranked]` line a round is told to
// paste is spelled. Its consumers today are this CLI's argv entry point and the benchmark's
// `bench fan`; `main.ts` re-exports `scoreOf`, which is where the offline suite reaches it.
//
// It imports nothing, and that leafness buys nothing today: both consumers already pull `./score`
// (and objdiff-wasm behind it). What this module owns is the SPELLING — the same line rendered by
// two commands — and that is the property to preserve when adding to it.
/** A score as `<score>/<rows>` — the numerator over the denominator it was measured against.
 *
 *  THE ONE RENDERER FOR EVERY SCORE ANY asmlift COMMAND PRINTS: the CLI's `[score]` table, the
 *  `[ranked]` line's `best …`, the `[withheld]` line, the `[progress]` line — and the benchmark's
 *  `bench fan`, which prints those same four for one row. A reader comparing two runs cannot be
 *  asked to know which lines carry a denominator, and the harness is where two runs get compared.
 *
 *  `rows` is objdiff's total row count for THIS candidate's alignment against the target, so it is
 *  a property of the candidate and not of the target: a different spelling aligns differently and
 *  is scored on a different scale. Two runs' `[score]` lines are the project's standard
 *  before/after comparison (docs/ranked-repro.md), and printing the numerator alone makes that
 *  comparison read as a subtraction on a fixed scale. It is not one — `kleod:CountCollectedGems`
 *  went 290/404 → 171/387 across two committed artifacts, 17 points of which were the scale, and
 *  an attribution round was spent explaining the difference.
 *
 *  Both fields are OPTIONAL, and each absence means one thing. No `rows`: the scorer that produced
 *  this score supplied none (core rank.ts's `WithheldCandidate` types it optional for exactly
 *  that), so the numerator prints alone rather than against an invented denominator — never a `0`,
 *  which would read as a real scale. No `match`: the caller does not know, so nothing is claimed. */
export function scoreOf(s: { score: number; rows?: number; match?: boolean }): string {
  return `${s.score}${s.rows === undefined ? '' : `/${s.rows}`}${s.match === true ? ' (match)' : ''}`;
}

/** THE `[ranked]` LINE — the one line docs/ranked-repro.md and `.claude/commands/*` tell a round to
 *  paste as the measurement every later claim is compared against. It lives here, beside `scoreOf`
 *  and in the same leaf module, because it now has TWO producers: the CLI's own ranked run
 *  (`main.ts`) and the benchmark's `bench fan`, which re-enters the harness's ranked call for one
 *  row. Two fields on it are not counts of the fan but claims about what the score RESTS ON, and
 *  they are the ones a hand-spelling drops:
 *
 *  - `synthesized` — how many of the winner's declarations asmlift invented from the target's own
 *    asm. Such a declaration is fitted to the bytes it is scored against: it cannot lose score,
 *    only manufacture agreement, so a `(match)` that depends on one has to say so on the line that
 *    gets pasted, or the line becomes publishable proof of a match nobody can check.
 *  - `[stamp]` — WHICH TREE produced the number. A run against different sources is otherwise
 *    indistinguishable from a clean one (provenance.ts), and a stamp anywhere but on the pasted
 *    line is a stamp nobody pastes.
 *
 *  Structural parameter types, not the CLI's `RankedResult`: the benchmark assembles the same six
 *  fields from its own row and its own stamp, and neither caller should have to build a
 *  `RankedResult` to render one line. No trailing newline — the caller owns line separation. */
export function rankedSummaryLine(a: {
  scored: number;
  dropped: number;
  withheld: number;
  synthesized: number;
  best: { label: string; score: { score: number; rows?: number; match?: boolean } };
  stamp: string;
}): string {
  return (
    `asmlift: [ranked] ${a.scored} candidate(s) scored, ${a.dropped} dropped, ` +
    `${a.withheld} withheld, ${a.synthesized} synthesized, ` +
    `best ${a.best.label}: ${scoreOf(a.best.score)} ` +
    `[${a.stamp}]`
  );
}
