#!/bin/sh
# Block until a pull request's CI has an answer, and say what the PR is waiting on.
#
# Over one 18-hour working session, 13 of the 29 human turns were "is it stuck / the CI is green /
# the PR is already merged" — six of them about PR state the loop had no mechanical way to learn,
# and one an explicit complaint about waiting on a PR that had already merged. The prompts end at
# "push the branch and open the PR"; this is the line after that.
#
#   scripts/pr-wait.sh 82                  # wait for checks, then report what is missing
#   scripts/pr-wait.sh 82 --until-merged   # …and keep waiting until it is merged or closed
#   scripts/pr-wait.sh 82 --timeout 900    # give up after 15 min (default 3600s) — the WHOLE run
#
# Exit codes — each one is an ANSWER, so a caller never has to ask a human:
#   0  merged
#   1  a check failed (the failing checks are printed)
#   2  timed out — still pending, nothing decided
#   3  checks are green and the PR is still open: nothing is missing, it is ready to merge
#   4  closed without merging
#   64 usage / no such PR
#
# Waits on the PR's REAL state, never on a process pattern: both phases ask GitHub what the PR is
# doing. A `pgrep -f` wait whose pattern matches the waiting shell deadlocks forever, and cost this
# project eight hours once. Every wait here is bounded by --timeout, for the same reason: a queued
# workflow with no free runner is otherwise indistinguishable from a hang, and re-enters exactly
# the deadlock this script replaces.
set -eu

usage() {
  echo "usage: scripts/pr-wait.sh <pr-number> [--until-merged] [--timeout <seconds>] [--interval <seconds>]" >&2
  exit 64
}

PR=""
UNTIL_MERGED=0
TIMEOUT=3600
INTERVAL=15
while [ $# -gt 0 ]; do
  case "$1" in
    --until-merged) UNTIL_MERGED=1 ;;
    --timeout)
      shift
      [ $# -gt 0 ] || usage
      TIMEOUT="$1"
      ;;
    --interval)
      shift
      [ $# -gt 0 ] || usage
      INTERVAL="$1"
      ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [ -z "$PR" ] || usage
      PR="$1"
      ;;
  esac
  shift
done
case "$PR" in
  '' | *[!0-9]*) usage ;;
esac
command -v gh >/dev/null 2>&1 || {
  echo "pr-wait: gh is not installed — this needs the GitHub CLI" >&2
  exit 64
}

say() { echo "pr-wait #$PR: $*"; }

# One JSON read of the PR's own state. Kept in one place so every phase reads the same fields.
state() { gh pr view "$PR" --json state,mergeStateStatus --jq '.state + " " + .mergeStateStatus'; }

# The same read, but a transient API error is NOT an answer. Under `set -e` a bare `S=$(state)`
# exits the script with gh's own status — which is 1, this script's code for A CHECK FAILED — so a
# single network blip sent the caller hunting a red build that does not exist. UNKNOWN matches
# neither MERGED nor CLOSED, so the poll just keeps waiting and the deadline decides.
state_or_unknown() { state 2>/dev/null || echo "UNKNOWN transient-api-error"; }

# One deadline for the whole run, so no phase can outlive --timeout.
DEADLINE=$(($(date +%s) + TIMEOUT))
expired() { [ "$(date +%s)" -ge "$DEADLINE" ]; }

if ! S=$(state 2>&1); then
  echo "pr-wait: cannot read PR #$PR: $S" >&2
  exit 64
fi
say "$S"

# Already decided before anything blocks — the exact case the human kept having to point out.
case "$S" in
  MERGED*)
    say "already merged; nothing to wait for"
    exit 0
    ;;
  CLOSED*)
    say "closed without merging"
    exit 4
    ;;
esac

# Phase 1 — the checks, polled on our own clock rather than inside `gh … --watch`. `--watch` has
# no timeout of its own (its --interval is just how often it re-asks), so a queued or stuck job
# blocks it forever; this loop asks the same question at the same rate and can stop. gh's exit
# codes ARE the three answers: 0 all complete and passing, 8 still pending, anything else a
# failure.
say "watching checks…"
CHECKS=0
PENDING=0
while :; do
  CHECKS=0
  gh pr checks "$PR" >/dev/null 2>&1 || CHECKS=$?
  [ "$CHECKS" -eq 8 ] || break
  # 8 also covers "no workflow has reported yet", which is what a PR opened seconds ago looks
  # like — the single most likely first call. Waiting it out is the answer the caller asked for.
  if [ "$PENDING" -eq 0 ]; then
    say "checks pending…"
  fi
  PENDING=$((PENDING + 1))
  if expired; then
    say "checks still pending after ${TIMEOUT}s — giving up, nothing decided"
    exit 2
  fi
  sleep "$INTERVAL"
done
gh pr checks "$PR" || true # the table itself, for the caller's log
if [ "$CHECKS" -ne 0 ]; then
  say "a check FAILED — fix it before asking anyone about merging"
  exit 1
fi
say "checks are green"

# Phase 2 — the merge. Without --until-merged, green checks is the answer: report the merge state
# and stop, so the caller can act instead of blocking on a human to press a button.
if [ "$UNTIL_MERGED" -eq 0 ]; then
  say "$(state_or_unknown) — checks green, PR open: nothing is missing, it is ready to merge"
  exit 3
fi

LAST=""
while :; do
  S=$(state_or_unknown)
  [ "$S" = "$LAST" ] || say "$S"
  LAST="$S"
  case "$S" in
    MERGED*)
      say "merged"
      exit 0
      ;;
    CLOSED*)
      say "closed without merging"
      exit 4
      ;;
  esac
  if expired; then
    say "still $S after ${TIMEOUT}s — giving up, nothing decided"
    exit 2
  fi
  sleep "$INTERVAL"
done
