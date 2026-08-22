# Saved workflows

Multi-agent workflows worth re-running. Invoke by name — `Workflow({name: "meta-optimizer-loop"})`
— optionally with `args`.

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
per-row diff of the regenerated `results.json` against `origin/main`'s, comparing
`asmlift.{outcome,score,candidateLabel,source}` and `m2c.{outcome,score,source}`. Every row
identical, or it does not ship. The reviewer re-proves this rather than trusting the implementer —
a "harmless" speedup that silently moved one row would poison every measurement in the project.

**`meta-optimizer-ledger.md` is load-bearing.** It records what has already shipped, which harness
traps are already fixed, and which items are known-open. The supervisor reads it instead of
re-deriving from the whole transcript corpus, which otherwise grows without bound and crowds out the
analysis. **Keep it current** — each iteration returns `ledger_additions` for exactly this.

Shipped in its first four iterations: a canonical ranked-repro command (`docs/ranked-repro.md`),
skipped rows made visible on the tier line, `scripts/check-artifact-provenance.sh` + its CI job, a
compile pool for the ranked run (36m10s → 21m32s at `--jobs 6`), a liveness pulse, and an
empty-filter guard.
