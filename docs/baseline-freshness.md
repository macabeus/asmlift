# The baseline is re-derived, never inherited

The Phase 0 freshness check both `/match-function` and `/attribute-function` open a round with, and
the only place it is written down. **Both commands point here; edit this file, not a copy inside a
prompt.** The last time a shared command lived in two prompts they drifted and a round published a
number comparable to nothing (PR #79).

## 1. Any row number written into a brief is a HINT with a timestamp

This file, a mining report, an orchestrator's hand-off, a memory note — none of them is a fact.
Briefs are written before a round starts and PRs merge while it runs. Five probe rounds in a row
launched detached at a commit three PRs stale and quoted its numbers; two of them mis-sized their
gap because of it (one reported −29 and the build delivered −13; one reported the real rows going
+4 _worse_ and the build delivered −22). One mining brief said a row was at 196 while the committed
artifact said 171.

## 2. Read the committed artifact — one second, no bench, no checkout

Substitute the symbol for `<SYM>` yourself. Do not leave it empty and do not wire it to an unset
`$1`: an empty pattern matches **all 1035 rows** and prints a plausible-looking table, which is the
one failure this file exists to prevent.

```sh
git fetch origin
git show origin/main:apps/benchmark/results/results.json \
  | jq -r --arg sym '<SYM>' '
      if $sym == "" then error("pass a symbol") else . end
      | .meta.generatedAt as $t
      | .results[] | select(.sym | contains($sym))
      | "\(.id)  asmlift=\(.asmlift.outcome) \(.asmlift.score // "-")/\(.asmlift.maxScore // "-")"
      + "  m2c=\(.m2c.outcome) \(.m2c.score // "-")/\(.m2c.maxScore // "-")"
      + "  [artifact \($t)]"'
```

`contains` is a substring test on purpose — it is the same matcher `bench run --only` uses
(`x.sym.includes(filter.only)` in `apps/benchmark/src/cases/real.ts`), so the two agree on what one
typed symbol selects. `test` would be a regex and a second matcher for the same string.

`-` in a score means the row has no score (`declined`, `noncompile`) — that is normal, and today
`af:_MtxF_to_Mtx:ido7.1 declined -/-` is one of them. A **`null`** would mean the schema moved
under this snippet: fix the snippet here before you quote anything it printed.

**Empty output is an answer, not a failure**: that symbol has no benchmark row, so it is measured
outside the harness (the ranked repro) or you mistyped it. Confirm which before you go on —
`git show origin/main:apps/benchmark/results/results.json | jq -r '.results[].sym' | grep -i <part>`.
`LoadBGTilemapData` is the standing example of a real target with no row.

## 3. Which number wins

**Against a number you were handed, the artifact wins** — unless a commit that can move a row
landed on main after it. Ask that; do not estimate it:

```sh
git log --oneline \
  $(git log -1 --format=%H origin/main -- apps/benchmark/results/results.json)..origin/main \
  -- packages/core/src packages/cli/src packages/toolchains/src apps/benchmark/dataset
```

Empty ⇒ the artifact is current and it wins; say in your first user-facing message which brief was
stale and by how much. Non-empty ⇒ the artifact predates those commits, so neither number is the
fact: re-measure the row with `bench run` and name the commits you re-measured across.

Those four paths are the `measures` set from `scripts/check-artifact-provenance.sh` — the
decompiler, the ranking and scoring it is graded by, the compilers, and the inputs. Read them from
that script if you touch this, and **write them out literally**: this repo's shell is zsh, which
does not word-split `$VAR`, so a pathspec built in a variable becomes one path that matches nothing
and the command silently prints "empty" — the answer that means "go ahead".

Against your own `bench run`, **trust the run**. Do not try to date the artifact by
`meta.asmlift.commit`: main squash-merges, so that sha is a branch commit main does not contain
(`check-artifact-provenance.sh` says so in as many words), it is unresolvable once the merged
branch is pruned, and a range against it is a fork-point range, not "since the artifact". The
handle that is on main is the artifact file's own commit, which the command above uses.

## 4. Measure from a fresh base

Create the round's worktree from a just-fetched `origin/main`, then install — a fresh worktree has
no `node_modules`:

```sh
git fetch origin && git worktree add <dir> -b <branch> origin/main && (cd <dir> && pnpm install)
```

Then wire the harness (the parallel-worktree memory note). `bench run`'s preflight is what tells you
it is wired: it refuses a dirty tree and probes the host `cpp` at second 0, so an unwired worktree
fails loudly instead of turning 44 matches into `noncompile` and reporting exit 0.

Re-run the `git log` in §3 with `HEAD..origin/main` instead of the artifact range whenever you are
about to take a before/after pair. Non-empty ⇒ `git fetch origin && git rebase origin/main` first; a
delta measured against a base that has since moved is a number about nothing. Empty ⇒ the base is
fine however old the worktree is. Age is not the question — an eight-hour worktree behind only doc
commits needs nothing, and a twenty-minute one behind a decompiler change needs the rebase.

**Rebase before you regenerate the artifact, never after.** The regenerated artifact is the last
commit on the branch, and rebasing past it both rewrites the commit it names (verdict 2 in
`check-artifact-provenance.sh`) and hands you a conflict in a 24 MB JSON file with no merge driver.
