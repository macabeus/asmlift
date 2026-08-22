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
# Fires on commits THIS BRANCH adds after the stamp that touch code the artifact measures.
# Commits the base branch gained meanwhile are not this branch's problem, so they are excluded.
# A stamp that is not in this repo's history (main squash-merges, so main's own stamp is always
# unreachable) is UNKNOWN, not a failure.
#
# usage: scripts/check-artifact-provenance.sh [base-ref]      (default: origin/main)
set -eu

base=${1:-origin/main}
artifact=apps/benchmark/results/results.json

# what the artifact measures — a commit touching any of these invalidates it
# (`packages/bench-schema` is deliberately absent: it defines the vocabulary the site RENDERS,
#  and editing a definition's text moves no row.)
paths='packages/core/src packages/cli/src packages/toolchains/src apps/benchmark/src apps/benchmark/dataset'

[ -f "$artifact" ] || { echo "provenance: no $artifact — nothing to check"; exit 0; }

stamp=$(sed -n 's/.*"commit": "\([0-9a-f]\{40\}\)".*/\1/p' "$artifact" | head -1)
[ -n "$stamp" ] || { echo "provenance: $artifact carries no meta.asmlift.commit — UNKNOWN"; exit 0; }

if ! git cat-file -e "$stamp^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$stamp" HEAD 2>/dev/null; then
  echo "provenance: artifact stamp $(echo "$stamp" | cut -c1-7) is not an ancestor of HEAD — UNKNOWN, not checked"
  exit 0
fi

git rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
  echo "provenance: base ref '$base' not in this checkout — UNKNOWN, not checked"
  exit 0
}

after=$(git log --oneline HEAD --not "$stamp" "$base" -- $paths)

if [ -n "$after" ]; then
  echo "provenance: FAIL — the artifact was generated at $(echo "$stamp" | cut -c1-7), and this branch"
  echo "adds $(printf '%s\n' "$after" | wc -l | tr -d ' ') later commit(s) touching what it measures:"
  printf '%s\n' "$after" | sed 's/^/  /'
  echo
  echo "Regenerate it (pnpm bench run && pnpm bench merge) as the LAST commit on the branch."
  exit 1
fi

echo "provenance: OK — no commit after $(echo "$stamp" | cut -c1-7) touches what the artifact measures"
