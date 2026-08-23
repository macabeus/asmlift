# Meta-optimisation ledger — what is ALREADY shipped or already ruled out
# The supervisor reads THIS instead of re-deriving from the full transcript corpus.

## Shipped and merged (do not re-report, do not re-implement)

- **#79** canonical LBG repro command in `match-function.md`; skipped rows totalled on the tier
  line; `scripts/check-artifact-provenance.sh` + a PR-only CI job.
- **#81** the headline re-measured; the second adversarial wave re-briefed; an unmeasured asmlift
  claim actually run. (`.claude/commands/` only.)
- **#82** the ranked run gets a **compile pool** (measured **36m10s serial → 21m32s at `--jobs 6`**,
  20608 candidates, 0 dropped, identical winner; scaling 2.00x/3.44x/4.44x/4.86x at p2/p4/p6/p8),
  a **liveness pulse** (the serial ranked run had written 0 bytes for 36 minutes), and a
  neutrality command for this loop.
- **#84** the provenance check survives a rebase; an empty `--only` filter stops reporting a green
  tick; the ranked repro gets one home.
- **#86** one queue for both tier fans; the ranked run's counts as an `asmlift: [ranked]` line;
  `scripts/pr-wait.sh` (the loop's mechanical answer to "is CI green / did it merge"); **`--proto`
  accepts INLINE JSON as well as a path** (`packages/cli/src/main.ts`), so
  `docs/ranked-repro.md`'s canonical command runs verbatim — iteration 2 re-derived this as a
  live defect because the ledger stopped at #84.
- **#87** `bench diff` exits **2** ("nothing was compared") when `results.json` still carries the
  base's `meta.generatedAt`, and prints base sha + fresh stamp — the loop's hard invariant was
  satisfiable in 0.9s on a clean tree, having run nothing, and that green line is what #86's body
  published as its proof; `eslint.config.mjs` ignores `research/**` and
  `apps/benchmark/checkouts/**`, so `pnpm lint` stops being permanently red locally (678→355 files,
  3 errors→0, verdict byte-identical to `eslint apps packages`) and BOTH prompts now say
  `pnpm lint` — the `npx eslint apps packages` house rule is retired; `pr-wait.sh` phase 1 reads
  `gh pr checks --json bucket` instead of gh's exit code, so a network blip / expired token / "no
  checks reported" is exit 2 ("nothing decided") not exit 1 ("a check FAILED"), guarded forever by
  `scripts/pr-wait-selftest.sh` in CI.

## Harness traps already found and fixed — never re-report

1. Sibling checkouts resolve from the repo root, which in a worktree is `/private/tmp` → rows
   silently SKIP. Fixed by `/tmp/wt-env.sh` + asserting 0 SKIPs.
2. `apps/benchmark/{checkouts,toolchains}/` are gitignored → absent from a worktree. Symlinked.
3. Those symlinks stamp `meta.asmlift.dirty: true`. Fixed via `.git/info/exclude`.
4. `pgrep -f` waits matching the waiting shell → deadlock (cost 8 hours once).
5. The LBG repro needs `--proto '{"thunk_HeapFree":{"params":1}}'` — worth 60 points.
6. `pnpm bench regression` is weak once a branch commits artifacts; the real check is a per-row
   diff against `origin/main`'s `results.json`.
7. Diffing the two `.s` TEXTS instead of objdiff's rendering produced 145 bogus rows once;
   alignment padding rendered as `lsl rN,#0` vs `.hword 0` produced 8 more.
8. A full `pnpm bench run` is **~5 minutes**, not ~30. The expensive thing is the ranked LBG run.
9. Rebasing a capability branch conflicts in the three generated artifacts and usually nothing
   else — never hand-merge `results.json`; discard both sides and regenerate.

## Known-open, already named — report only with NEW evidence or a concrete fix

- **Machine-wide job budget.** Every track gets a flat `--jobs`, on a 10-core box running 4-6
  workflows; the pool delivered **1.68x of its achievable 2.83x** under self-inflicted contention.
- **39% of agent Bash wall-clock is spent blocking on jobs the agent itself backgrounded.**
- `onLeverError` is wired nowhere in the CLI or benchmark, so a lever that always throws is
  invisible there.
- `regression` and `stale-check` read the same committed artifact through the same
  `readCommitted` and have the SAME vacuity #87 closed in `diff`; only `diff` is guarded.
- `scripts/check-artifact-provenance.sh` reports "UNKNOWN, not checked" in exactly the
  do-nothing case (artifact blob identical to the base's) — it cannot tell "published no numbers
  of its own" from "ran nothing".
