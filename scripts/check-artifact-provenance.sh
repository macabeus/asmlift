#!/bin/sh
# Is the committed benchmark artifact newer than the code it measures?
#
# `apps/benchmark/results/results.json` stamps the commit it was generated at
# (`meta.asmlift.commit`). Every number a PR publishes — the totals in its body, the rows the
# site renders, what `bench regression` compares against — comes from that file, so a branch
# that regenerates it and then keeps changing the decompiler is publishing numbers a rule
# version that no longer exists produced. Four adversarial findings across the last two rounds
# were this, on two branches — reviewer time spent on repo hygiene because nothing mechanical
# looks.
#
# Three verdicts, in the order they are checked:
#
#   1. AHEAD-OF-STAMP. Commits THIS BRANCH adds after the stamp that touch code the artifact
#      measures. Commits the base branch gained meanwhile are not this branch's problem, so every
#      base ref given is excluded — pass the base BRANCH, not only the sha a webhook payload
#      froze: that sha goes stale while the PR is open, while the merge ref CI checks out is
#      rebuilt against the base's moving tip, so excluding only the sha reports someone else's
#      merged round as a commit this branch added. Merge commits are skipped for the same reason:
#      the one GitHub synthesizes for `refs/pull/N/merge` is TREESAME to neither side once both
#      touched these paths, and it is not a change this branch made.
#
#   2. UNVERIFIABLE STAMP. A stamp that is not in this repo's history used to be UNKNOWN, full
#      stop — but that lets a rebase switch the whole check off: rebasing after regenerating
#      rewrites the commit the artifact names while the artifact keeps naming the old sha, and
#      after a force-push that sha is not on the remote at all. So the two cases are separated by
#      the artifact BLOB. Identical to a base's ⇒ the branch published no numbers of its own and
#      the stamp is the base's business (main squash-merges, so main's own stamp is always
#      unreachable) ⇒ UNKNOWN. Different from every base's ⇒ this branch published numbers whose
#      provenance nothing can check ⇒ regenerate after the final rebase.
#
#   3. BEHIND THE BASE. The within-branch check is blind to the base moving UNDER the artifact:
#      rebase onto a main that gained a decompiler change and the artifact commit now sits on top
#      of it while still holding numbers measured without it. So a branch publishing its own
#      artifact must have generated it on a tree that already contained the base. Only the paths
#      that decide a measurement are a failure here; a base change to the harness around them is
#      reported and not failed — see `measures` below for which is which, and why.
#
# usage: scripts/check-artifact-provenance.sh [base-ref…]      (default: origin/main)
set -eu

[ $# -gt 0 ] || set -- origin/main

# the paths below are repo-relative, and a run from a subdirectory would find no artifact and
# report success — the one answer a fail-loud check must never invent
top=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "provenance: not a git checkout — UNKNOWN, not checked"
  exit 0
}
cd "$top"

artifact=apps/benchmark/results/results.json

# what the artifact measures — a commit touching any of these invalidates it
# (`packages/bench-schema` is deliberately absent: it defines the vocabulary the site RENDERS,
#  and editing a definition's text moves no row.)
paths='packages/core/src packages/cli/src packages/toolchains/src apps/benchmark/src apps/benchmark/dataset'
# the subset that decides a measurement: the decompiler, the ranking and scoring it is graded by,
# the compilers it is driven through, and the inputs. `packages/cli/src` is in this list and not
# the remainder — `eval/asmlift.ts` imports `decompileRanked` from `@asmlift/cli/rank` and
# `compile/real.ts` imports `scoreObjects` from `@asmlift/cli/score`, so that package picks the
# winning candidate and computes the score of every row; #69, a round that moved rows, changed
# `packages/cli/src/objdiff.ts`. Calling it "the harness around the decompiler" made verdict 3
# exit 0 on a base commit to the ranker — the exact false pass verdict 3 exists to prevent.
#
# The remainder is `apps/benchmark/src`, where a BASE change is reported rather than failed. Not
# because it is provably row-neutral — it is not — but because of what lands there: in this
# repo's whole history exactly two commits touched it without also touching one of the paths
# below, and both came from a meta round whose own gate is a full `bench run` diffed per row
# against the base. The note is how a reviewer sees one anyway.
measures='packages/core/src packages/cli/src packages/toolchains/src apps/benchmark/dataset'

[ -f "$artifact" ] || { echo "provenance: no $artifact — nothing to check"; exit 0; }

stamp=$(sed -n 's/.*"commit": "\([0-9a-f]\{40\}\)".*/\1/p' "$artifact" | head -1)
[ -n "$stamp" ] || { echo "provenance: $artifact carries no meta.asmlift.commit — UNKNOWN"; exit 0; }

# a ref the checkout does not have is not an error: CI passes both spellings of the base and
# takes whichever exists, and only "none of them" is unknowable. Resolved and printed before the
# verdict, because a check whose failure mode is a silent no-op should always say what it compared
# against — a run that quietly fell back to the frozen sha looks identical to a correct one.
bases=''
for ref in "$@"; do
  if git rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1; then
    bases="$bases $ref"
  fi
done
[ -n "$bases" ] || {
  echo "provenance: no base ref among '$*' is in this checkout — UNKNOWN, not checked"
  exit 0
}
echo "provenance: base(s) excluded:$bases"

# Does this branch publish an artifact of its own? Compared by blob, not by commit, because that
# is the only question the stamp's reachability cannot answer after a rebase. Hashed from the file
# ON DISK, not `HEAD:$artifact`, so it is the same bytes the stamp above was read from: an agent
# who regenerates and runs this before committing would otherwise be told its artifact is the
# base's — and skip verdicts 2 and 3 on the numbers it is about to publish. In CI the two are the
# same file.
own=yes
head_blob=$(git hash-object "$artifact" 2>/dev/null || true)
for ref in $bases; do
  base_blob=$(git rev-parse --verify --quiet "$ref:$artifact" || true)
  if [ -n "$head_blob" ] && [ "$head_blob" = "$base_blob" ]; then
    own=no
  fi
done

if ! git cat-file -e "$stamp^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$stamp" HEAD 2>/dev/null; then
  if [ "$own" = no ]; then
    echo "provenance: artifact stamp $(echo "$stamp" | cut -c1-7) is not an ancestor of HEAD, and the artifact"
    echo "is byte-identical to the base's — this branch publishes no numbers of its own. UNKNOWN, not checked."
    exit 0
  fi
  echo "provenance: FAIL — this branch publishes its own artifact, and the commit it says it was"
  echo "generated at ($(echo "$stamp" | cut -c1-7)) is not in this history. Regenerating and THEN rebasing"
  echo "rewrites that commit, which leaves nothing able to check what the numbers measured."
  echo
  echo "Regenerate it (pnpm bench run && pnpm bench merge) as the LAST commit on the branch."
  exit 1
fi

after=$(git log --no-merges --oneline HEAD --not "$stamp" $bases -- $paths)

if [ -n "$after" ]; then
  echo "provenance: FAIL — the artifact was generated at $(echo "$stamp" | cut -c1-7), and this branch"
  echo "adds $(printf '%s\n' "$after" | wc -l | tr -d ' ') later commit(s) touching what it measures:"
  printf '%s\n' "$after" | sed 's/^/  /'
  echo
  echo "Regenerate it (pnpm bench run && pnpm bench merge) as the LAST commit on the branch."
  exit 1
fi

if [ "$own" = yes ]; then
  # Base commits the stamp does not contain. Both spellings of the base list the same commits, so
  # dedupe while keeping git's newest-first order.
  behind=$(for ref in $bases; do
    git log --no-merges --oneline "$ref" --not "$stamp" -- $measures
  done | awk 'NF && !seen[$0]++')
  if [ -n "$behind" ]; then
    echo "provenance: FAIL — the artifact was generated at $(echo "$stamp" | cut -c1-7), which predates"
    echo "$(printf '%s\n' "$behind" | wc -l | tr -d ' ') base commit(s) that change what it measures:"
    printf '%s\n' "$behind" | sed 's/^/  /'
    echo
    echo "These numbers were measured without them, so a per-row diff against the base credits their"
    echo "effect to this branch. Rebase onto the base, then regenerate (pnpm bench run && pnpm bench"
    echo "merge) as the LAST commit."
    exit 1
  fi
  harness=$(for ref in $bases; do
    git log --no-merges --oneline "$ref" --not "$stamp" -- $paths
  done | awk 'NF && !seen[$0]++')
  if [ -n "$harness" ]; then
    echo "provenance: note — $(printf '%s\n' "$harness" | wc -l | tr -d ' ') base commit(s) after the stamp touch the harness around the"
    echo "decompiler, not the decompiler itself. Not a failure; listed because a per-row diff against"
    echo "the base would attribute anything they moved to this branch:"
    printf '%s\n' "$harness" | sed 's/^/  /'
  fi
fi

echo "provenance: OK — no commit after $(echo "$stamp" | cut -c1-7) touches what the artifact measures"
