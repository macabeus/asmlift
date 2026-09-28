#!/bin/sh
# A vitest run that is a GATE: exit 0 only when every collected test file and test passed.
#
#   sh scripts/gate-vitest.sh [vitest args…]        e.g.  --config vitest.matching.config.ts
#
# vitest's own exit status is not that, in either direction:
#
#   - it exits 0 on a PARTIAL run: a suite whose toolchain, Docker image or checkout is missing
#     skips, and a skip is reported as skipped, not failed.
#   - it exits 1 on a GREEN run: a worker that holds its thread in synchronous work past vitest's
#     60 s worker↔main RPC deadline ends the run `Errors  1 error` (`Timeout calling
#     "onTaskUpdate"`) with every test passed. Load stretches the root suite's longest single tests
#     past that deadline at any worker count; fewer workers make it rarer.
#
# So this reads the summary: `Test Files  N passed (M)` with N == M and no `failed`, `skipped` or
# `todo` there or on the `Tests` line — a shell without the toolchain env skips single tests, not
# whole files — AND exit 0. The verdict line says which condition failed. An `Errors` line fails the
# gate through the exit status, so a config that chose `dangerouslyIgnoreUnhandledErrors`
# (vitest.matching.config.ts) keeps that choice, and an error is named in the verdict either way.
#
# WORKERS. 3 by default (`VITEST_MAX_WORKERS` overrides; an explicit `--maxWorkers` in the args
# wins) — docs/bench-cost.md §1 has what the root suite costs at that and at vitest's default.
set -u

log=$(mktemp "${TMPDIR:-/tmp}/gate-vitest.XXXXXX") || exit 2
trap 'rm -f "$log"' EXIT

workers=--maxWorkers="${VITEST_MAX_WORKERS:-3}"
for a in "$@"; do
  case $a in --maxWorkers | --maxWorkers=*) workers= ;; esac
done

# the pipe's status is tee's, so vitest's is carried out through a file
status_file="$log.status"
{
  pnpm exec vitest run ${workers:+"$workers"} "$@" 2>&1
  echo $? >"$status_file"
} | tee "$log"
status=$(cat "$status_file" 2>/dev/null || echo 2)
rm -f "$status_file"

# vitest colours its summary even through a pipe when FORCE_COLOR is set
plain=$(sed 's/\x1b\[[0-9;]*m//g' "$log")
files=$(printf '%s\n' "$plain" | grep -E '^ *Test Files ' | tail -1 | sed 's/^ *//')
tests=$(printf '%s\n' "$plain" | grep -E '^ *Tests ' | tail -1 | sed 's/^ *//')
errors=$(printf '%s\n' "$plain" | grep -E '^ *Errors ' | tail -1 | sed 's/^ *//')

what="vitest run $*"
fail() {
  echo "gate: FAIL — $what: $1${files:+ ($files${tests:+; $tests})}" >&2
  exit 1
}

[ -n "$files" ] || fail "no 'Test Files' summary line, so the run did not finish (exit $status)"
case $files in *failed* | *skipped* | *todo*) fail "not every collected file passed" ;; esac
case $tests in *failed* | *skipped* | *todo*) fail "not every collected test passed — a skip is a gate that did not run" ;; esac
n=$(printf '%s\n' "$files" | sed -nE 's/^Test Files +([0-9]+) passed \(([0-9]+)\)$/\1/p')
m=$(printf '%s\n' "$files" | sed -nE 's/^Test Files +([0-9]+) passed \(([0-9]+)\)$/\2/p')
[ -n "$n" ] && [ "$n" = "$m" ] || fail "passed files do not equal collected files"
if [ "$status" != 0 ]; then
  [ -z "$errors" ] || fail "$errors, and vitest exited $status — a load-timeout error is a re-run, never a pass"
  fail "vitest exited $status"
fi
echo "gate: PASS — $what: $files; $tests${errors:+; $errors, ignored by this config}"
