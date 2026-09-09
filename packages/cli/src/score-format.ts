// The one place a score becomes text. A LEAF module by design: it imports nothing, so every
// consumer — this CLI's argv entry point, the benchmark's `bench fan` — reaches the renderer
// without dragging objdiff-wasm (or anything else) in behind it. `main.ts` re-exports it, which is
// where the offline suite reaches it.
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
