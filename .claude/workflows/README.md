# Saved workflows

Multi-agent workflows worth re-running. Invoke by name — `Workflow({name: "meta-optimizer-loop"})`
— optionally with `args`.

## `match-round`

One [`/match-function`](../commands/match-function.md) round, run as phased agents rather than as one
agent. [`/parallel-match-function`](../commands/parallel-match-function.md) launches one per lane:
`Workflow({name: "match-round", args: {target, handle, worktree, branch, board, note}})`.

1. **Diagnose** — Phases 0–2. Ends the round early when there is nothing to build (a correct
   decline, an unmatchable quirk, a harness problem); the Ship agent then ships only the evidence.
2. **Implement** — Phases 3–4: atomic commits and the full-bench zero-flip gate.
3. **Adversarial** — Phase 5's breaker and architect as two separate agents, in waves. A wave whose
   remediation changed code is followed by another, up to three; each carries the triage ledger of
   the waves before it.
4. **Remediate** — reproduces every finding, fixes the confirmed ones as commits, records a reason for
   each one it declines.
5. **Ship** — Phases 6–7 up to a green `pr-wait`, then a `merge-slot` message on the board. It never
   merges.

What each phase does is the command file's; every agent reads it from the lane's worktree, and the
rules a parallel run adds are the list in `parallel-match-function.md` Phase 1. The script holds
only the order and the hand-offs.

## `meta-optimizer-loop`

Supervises the rounds that are running (`/match-function`, `/attribute-function`) and improves the
*loop itself*: the command prompts, the harness ergonomics, and the wall-clock of the expensive
paths. Three agents per iteration, looped:

1. **Supervise** — read the ledger, then only what is new since the last iteration. Produces at
   most four evidenced findings; an empty list is a valid result.
2. **Implement** — *challenges* each finding first (verify the cited evidence, ask whether the
   proposal would really have prevented the failure, weigh the churn), builds only the survivors,
   proves output-neutrality mechanically, opens a PR. No PR if nothing survives.
3. **Review** — audits scope, **re-proves neutrality independently**, re-runs every gate, applies
   fixes itself, and merges on green.

`args: {since: "<sha>"}` starts the incremental window at a specific commit.

**The hard invariant** is that nothing it ships may change a measurement: a full bench run, then a
per-row diff of the regenerated `results.json` against `origin/main`'s (`pnpm bench diff --base
origin/main`), comparing every field `report/diff.ts`'s `FIELDS` watches — read the list there, it
is wider than the score. Every row identical, or it does not ship. The reviewer re-proves this
rather than trusting the implementer —
a "harmless" speedup that silently moved one row would poison every measurement in the project.

**`meta-optimizer-ledger.md` is load-bearing.** It records what has already shipped, which harness
traps are already fixed, and which items are known-open. The supervisor reads it instead of
re-deriving from the whole transcript corpus, which otherwise grows without bound and crowds out the
analysis. **Keep it current** — each iteration returns `ledger_additions` for exactly this.

Shipped in its first four iterations: a canonical ranked-repro command (`docs/ranked-repro.md`),
skipped rows made visible on the tier line, `scripts/check-artifact-provenance.sh` + its CI job, a
compile pool for the ranked run (36m10s → 21m32s at `--jobs 6`), a liveness pulse, and an
empty-filter guard.
