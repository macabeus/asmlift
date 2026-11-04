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
#     "onTaskUpdate"`) with every test passed. vitest.worker-yield.ts bounds that hold to one test's
#     own synchronous span; a test whose span alone passes the deadline still does it.
#
# So this reads the summary: `Test Files  N passed (M)` with N == M and no `failed` or `todo` there
# or on the `Tests` line, AND exit 0. The verdict line says which condition failed. An `Errors` line
# fails the gate through the exit status, so a config that chose `dangerouslyIgnoreUnhandledErrors`
# (vitest.matching.config.ts) keeps that choice, and an error is named in the verdict either way.
#
# SKIPS. A skip is a gate that did not run — a shell without the toolchain env skips single tests,
# not whole files — so a skip still fails this gate unless scripts/gate-skips.ts EXPECTS it: an
# entry there names the test and the host condition that skips it (not macOS, no GCC 15
# preprocessor, GCC 2.7.2 native rather than in Docker, …), and scripts/gate-skips-check.ts asks
# this host that condition with the test file's own probe. It reads vitest's JSON report, which
# this run writes beside the default reporter, and FAILs on a skip no entry lists, on a listed skip
# whose condition does not hold here, and on a stale entry (its condition holds here, but its test
# ran or is gone). A skipped file counts toward N only through that check. The PASS line says how
# many skips it accepted.
#
# WORKERS. 3 by default (`VITEST_MAX_WORKERS` overrides; an explicit `--maxWorkers` in the args
# wins) — docs/bench-cost.md §1 has what the root suite costs at that and at vitest's default.
#
# MEMORY. The admission check is not here: it is a globalSetup of both vitest configs
# (vitest.memory-admission.ts), so it prices every way vitest starts — this gate, `pnpm test:offline`,
# a one-file `pnpm exec vitest run` — and records the admitted run under vitest's own pid, which
# lives exactly as long as the job. A refusal there starts no test; this gate then exits 2 with
# the check's numbers above, as it does for any run that did not start.
set -u

log=$(mktemp "${TMPDIR:-/tmp}/gate-vitest.XXXXXX") || exit 2
json="$log.json"
trap 'rm -f "$log" "$json"' EXIT

workers=--maxWorkers="${VITEST_MAX_WORKERS:-3}"
for a in "$@"; do
  case $a in --maxWorkers | --maxWorkers=*) workers= ;; esac
done

# the pipe's status is tee's, so vitest's is carried out through a file
status_file="$log.status"
{
  pnpm exec vitest run ${workers:+"$workers"} --reporter=default --reporter=json --outputFile.json="$json" "$@" 2>&1
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

if [ -z "$files" ] && printf '%s\n' "$plain" | grep -q '\[memory admission\]'; then
  echo "gate: FAIL — $what: not started, refused by the memory admission check above" >&2
  exit 2
fi
[ -n "$files" ] || fail "no 'Test Files' summary line, so the run did not finish (exit $status)"
case $files in *failed* | *todo*) fail "not every collected file passed" ;; esac
case $tests in *failed* | *todo*) fail "not every collected test passed" ;; esac
# `N passed (M)`, or `N passed | K skipped (M)` — the K files are judged by the skip check below
summary='^Test Files +([0-9]+) passed( \| ([0-9]+) skipped)? \(([0-9]+)\)$'
n=$(printf '%s\n' "$files" | sed -nE "s/$summary/\\1/p")
k=$(printf '%s\n' "$files" | sed -nE "s/$summary/\\3/p")
m=$(printf '%s\n' "$files" | sed -nE "s/$summary/\\4/p")
[ -n "$n" ] && [ "$((n + ${k:-0}))" = "$m" ] || fail "passed files do not equal collected files"
[ -s "$json" ] || fail "vitest wrote no JSON report, so its skips cannot be checked"
skips=$(pnpm exec tsx "$(dirname "$0")/gate-skips-check.ts" "$json" 2>&1) || {
  printf '%s\n' "$skips" >&2
  fail "a skip this host does not expect — a skip is a gate that did not run (scripts/gate-skips.ts)"
}
skips=$(printf '%s\n' "$skips" | tail -1 | sed 's/^gate-skips: //')
if [ "$status" != 0 ]; then
  [ -z "$errors" ] || fail "$errors, and vitest exited $status — a load-timeout error is a re-run, never a pass"
  fail "vitest exited $status"
fi
echo "gate: PASS — $what: $files; $tests; $skips${errors:+; $errors, ignored by this config}"
