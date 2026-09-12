# The baseline is re-derived, never inherited

The Phase 0 freshness check every round opens with, and the only place it is written down. **The
briefs point here; edit this file, not a copy inside a prompt.** A repro rule that lived in only one
of the two briefs is how a round published a score against a baseline measured with different flags
(#76, diagnosed in #79).

## 1. Any row number written into a brief is a HINT with a timestamp

This file, a mining report, an orchestrator's hand-off, a memory note — none of them is a fact.
Briefs are written before a round starts and PRs merge while it runs. Five parallel probes ran in
worktrees pinned before #164, which merged 16 minutes after they started; every headline they
reported was a delta on a base no consumer ever stood on, and each of the four rounds that consumed
them opened by refuting the number it was handed — a −29 re-measured as −13, a 241 base that was 174
on main. One mining brief said a row was at 196 while the committed artifact said 171.

## 2. Read the committed artifact — one command, no bench

```sh
git fetch origin && pnpm bench baseline <the symbol>
```

It prints the row as the published benchmark has it, and then whether that is still the answer — for
example, on the day this was written:

```
kleod:CountCollectedGems:agbcc  asmlift=nonmatch 171/387  m2c=noncompile -/-
baseline: 1 row(s) from the artifact generated <timestamp>, as committed on origin/main
baseline: CURRENT — nothing since <sha> changes what it measures, so these numbers beat any you were handed.
```

Read `N/M` whole and quote it whole — never the `N` alone; the denominator moves. A `-` means the
row has no score (`declined`, `noncompile`), which is normal.

The argument is a substring of the symbol — the same matcher `bench run --only` uses, so the two
agree about what one typed name selects — or a whole `project:sym:toolchain` row id, so pasting
back what this printed works. `--base <ref>` reads some other ref's artifact; the default is
`origin/main`, because a branch that has already committed an artifact would otherwise be asking
about itself.

**Every way of getting no row is an error here, not an empty answer.** Exit 1 says the symbol has
no benchmark row, which means it is measured outside the harness (the ranked repro — the standing
example is `LoadBGTilemapData`) or you mistyped it, and it offers the case-insensitive near-misses.
Exit 2 is a bad invocation, or a ref this checkout cannot read, and says which. **Do not answer this
question with a `git show … | jq` one-liner instead.** In a pipeline the exit status is jq's, so an
unfetched ref, an unsubstituted placeholder and a pasted row id all print nothing and succeed — and
"empty" is the output a reader takes as "go ahead".

## 3. Which number wins

**Against a number you were handed, the artifact wins** — unless a commit that can move a row
landed on main after it. `bench baseline` asks that in the same breath as it prints the row, so
there is nothing extra to run and nothing to remember; what it says:

- `CURRENT` ⇒ the committed number is the fact. Say in your first user-facing message which brief
  was stale and by how much.
- `NOT CURRENT` ⇒ commits that decide a measurement landed after the artifact, so neither number is
  the fact: re-measure the row with `bench run` and name the commits you re-measured across.
- `note — … the harness around the decompiler` ⇒ commits in `apps/benchmark/src` and nothing
  narrower. Not disqualifying — `check-artifact-provenance.sh` reports these rather than failing
  them, and says why — but they can still move a row, so name them if your delta is small.

**The verdict is about `origin/main`, never about YOU.** `commitsSinceArtifact` (in
`apps/benchmark/src/report/baseline.ts`) computes `git log <the artifact's own commit>..<base>` over
`SCORING_PATHS`. It reads no `HEAD`, no index and no working tree, so a branch that has already
COMMITTED its capability — a remediation agent, a wave-2 reviewer, any continuation — still gets
`CURRENT`, and that word then means _the published number is still the published number_, not _it is
still your number_. Measured 2026-09-12 at `3a4fd60f`: with a scoring-path file dirty in the
worktree, `pnpm bench baseline CountCollectedGems` printed `CURRENT — nothing since 8599234d changes
what it measures` unchanged. So there is a **fourth** case in which the round runs the row:

- `git diff --name-only origin/main...HEAD -- $(scoring paths)` or `git status --porcelain` is
  non-empty for a scoring path ⇒ the artifact answers about main, not about your tree. Re-measure
  the row on your own branch before you quote it as yours.

The two path lists behind that split are `paths` and `measures` in
`scripts/check-artifact-provenance.sh`, exported to TypeScript as `MEASURED_PATHS` and
`SCORING_PATHS` and held equal to the script by `apps/benchmark/test/fidelity-provenance.test.ts`.
**Do not hand-copy either list into a prompt, a doc or a shell one-liner.** Two copies drift and the
drift is only ever found by a gate that should have fired; and in this repo's shell (zsh, which does
not word-split `$VAR`) a pathspec built in a variable silently collapses to one path that matches
nothing, printing the empty output that means "go ahead".

Against your own `bench run`, **trust the run**. And do not try to date the artifact by
`meta.asmlift.commit`: main squash-merges, so that sha is a branch commit main does not contain, it
is unresolvable once the merged branch is pruned, and a range against it is a fork-point range, not
"since the artifact". The handle that is on main is the artifact file's own commit, which is what
`bench baseline` reports.

## 4. Measure from a fresh base

Create the round's worktree from a just-fetched `origin/main`, then install — a fresh worktree has
no `node_modules`:

```sh
git fetch origin && git worktree add <dir> -b <branch> origin/main && (cd <dir> && pnpm install)
```

Then give it the projects the real tier compiles. `pnpm bench setup` materializes the bench-owned
checkouts (`apps/benchmark/checkouts/`) by itself; a checkout you already have is picked up by
pointing `ASMLIFT_PROJ_<PROJECT>` at it, or as a sibling of the workspace — in that precedence, which
`apps/benchmark/src/cases/manifests.ts` owns. Everything else local goes in
`.local/` or `.envrc.local` — both gitignored, and both exist because **an untracked file makes a
run stamp itself dirty and `bench:merge` refuses the tier**, which has cost ~2,350 s twice.

`bench run`'s preflight catches half of that at second 0, and the other half is yours:

- it probes the host `cpp` on any run that touches the real tier, scoped or not — the trap that
  turned 44 rows into `noncompile` while the run reported `✓` and exit 0;
- it refuses a dirty tree only on a run that **rewrites a tier file whole**. A scoped `--only` run
  is deliberately not refused — it is the dev loop and it is meant to run dirty — so before the run
  whose numbers you will publish, read `git status --porcelain` yourself.

Before you take a before/after pair, check the base has not moved under you:

```sh
git fetch origin && git log --oneline HEAD..origin/main
```

Empty ⇒ the base is fine however old the worktree is; age is not the question. Non-empty ⇒
`git rebase origin/main` before you measure. Do not triage which of those commits matter: that needs
the path lists this file just told you not to copy, and a rebase of a branch that has not yet
regenerated the artifact costs seconds.

**Rebase before you regenerate the artifact, never after.** The regenerated artifact is the last
commit on the branch, and rebasing past it both rewrites the commit it names (verdict 2 in
`check-artifact-provenance.sh`) and hands you a conflict in a 24 MB JSON file with no merge driver.
