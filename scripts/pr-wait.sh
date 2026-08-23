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
# Two deadlines, because "GitHub says the checks are still running" and "GitHub is not answering
# at all" are not the same wait. --timeout bounds the whole run and has to be generous: a queued
# workflow with no free runner is a legitimate hour. --unknown-timeout (default 180s) bounds only
# the state where no verdict has come back AT ALL — an expired token, a dead network, or a PR
# whose workflows never register. Nothing is being learned in that state, so waiting out the full
# --timeout there just blocks the caller for an hour to reach the same "nothing decided".
#
# Exit codes — each one is an ANSWER, so a caller never has to ask a human:
#   0  merged
#   1  a check GitHub reported as failed or cancelled (the check table is printed)
#   2  nothing decided: still pending at --timeout, or no verdict at all for --unknown-timeout
#   3  checks are green and the PR is still open: nothing is missing, it is ready to merge
#   4  closed without merging
#   64 usage / no such PR
#
# Exit 1 is reserved for a verdict GitHub actually gave. `gh` cannot supply that on its own: it
# documents exit 8 for "checks pending" and 0 for all-green, but everything else is exit 1, "a
# command fails for any reason" (`gh help exit-codes`) — a failing check, a network error, an
# expired token and "no checks reported on this branch" are one code. So the buckets are read, not
# the exit status, and an answer that did not arrive is UNKNOWN and keeps waiting.
#
# Waits on the PR's REAL state, never on a process pattern: both phases ask GitHub what the PR is
# doing. A `pgrep -f` wait whose pattern matches the waiting shell deadlocks forever, and cost this
# project eight hours once. Every wait here is bounded by --timeout, for the same reason: a queued
# workflow with no free runner is otherwise indistinguishable from a hang, and re-enters exactly
# the deadlock this script replaces.
set -eu

usage() {
  echo "usage: scripts/pr-wait.sh <pr-number> [--until-merged] [--timeout <seconds>] [--interval <seconds>] [--unknown-timeout <seconds>]" >&2
  exit 64
}

PR=""
UNTIL_MERGED=0
TIMEOUT=3600
INTERVAL=15
UNKNOWN_TIMEOUT=180
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
    --unknown-timeout)
      shift
      [ $# -gt 0 ] || usage
      UNKNOWN_TIMEOUT="$1"
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
# blocks it forever; this loop asks the same question at the same rate and can stop.
#
# It asks for the BUCKETS (`pass`/`fail`/`pending`/`skipping`/`cancel`, gh's own categorisation of
# each check's state) instead of reading gh's exit status, because the status cannot tell a red
# build from an unreachable API: reading exit 1 as "a check failed" turns a network blip, an
# expired token, or the "no checks reported" a freshly-opened PR answers with — the single most
# likely FIRST call — into the false red this script exists to remove. Phase 2 already refuses to
# read a transient error as an answer (`state_or_unknown`); this is the same discipline, one phase
# earlier. No buckets came back ⇒ nothing is known ⇒ keep waiting, and let the deadline decide.
ERRFILE=$(mktemp "${TMPDIR:-/tmp}/pr-wait.XXXXXX")
trap 'rm -f "$ERRFILE"' EXIT INT TERM

say "watching checks…"
VERDICT=""
SAID=""
# Set on the first poll that comes back with nothing, cleared the moment one comes back with
# something: the budget is for a run of silence, not for the total.
UNKNOWN_DEADLINE=""
while :; do
  # `--jq` is gh's own, so this needs no jq on PATH. Failure leaves BUCKETS empty, which is the
  # UNKNOWN branch below — never a verdict.
  BUCKETS=$(gh pr checks "$PR" --json bucket --jq '.[].bucket' 2>"$ERRFILE") || true
  if [ -n "$BUCKETS" ]; then
    UNKNOWN_DEADLINE="" # GitHub is answering again; only --timeout bounds us now
    case "$BUCKETS" in
      *fail*) VERDICT=failed ;;
      *pending*) VERDICT="" ;;
      *cancel*) VERDICT=cancelled ;;
      *) VERDICT=green ;;
    esac
    [ -z "$VERDICT" ] || break
    SAY="checks pending…"
  else
    # gh answers "no checks reported on the 'x' branch" exactly as it answers a dead network and
    # an expired token: exit 1, nothing on stdout. None of the three is a failing build, and the
    # first is the normal state of a PR whose workflows have not registered yet.
    SAY="no check verdict yet: $(tr '\n' ' ' < "$ERRFILE" | cut -c1-160 | sed 's/ *$//')"
    [ -n "$UNKNOWN_DEADLINE" ] || UNKNOWN_DEADLINE=$(($(date +%s) + UNKNOWN_TIMEOUT))
  fi
  [ "$SAY" = "$SAID" ] || say "$SAY" # once per distinct reason, not once per poll
  SAID="$SAY"
  # The silence budget, checked before the global one: the prompts call this script with no
  # --timeout at all, so without it an expired token blocks the caller for the full default hour
  # to arrive at exactly the answer the first two polls already had.
  if [ -n "$UNKNOWN_DEADLINE" ] && [ "$(date +%s)" -ge "$UNKNOWN_DEADLINE" ]; then
    say "no check verdict at ALL for ${UNKNOWN_TIMEOUT}s — GitHub is not answering, nothing decided"
    exit 2
  fi
  if expired; then
    say "no check verdict after ${TIMEOUT}s — giving up, nothing decided"
    exit 2
  fi
  sleep "$INTERVAL"
done
gh pr checks "$PR" || true # the table itself, for the caller's log
if [ "$VERDICT" != green ]; then
  say "a check $(echo "$VERDICT" | tr '[:lower:]' '[:upper:]') — fix it before asking anyone about merging"
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
