#!/bin/sh
# A vitest run that is a GATE: exit 0 only when every collected test file passed.
#
#   sh scripts/gate-vitest.sh [vitest args…]        e.g.  --config vitest.matching.config.ts
#
# vitest's own exit status is not that, in either direction:
#
#   - it exits 0 on a PARTIAL run. `test:matching` skips 12 of its files when the external drive
#     holding the mwcc/kmc/gcc272 images is detached, and reports them as skipped, not failed.
#     Three PRs have published such a run as their gate.
#   - it exits 1 on a GREEN run. Under load, a worker misses vitest's 60 s worker↔main RPC
#     deadline and the run ends `Errors  1 error` (`Timeout calling "onTaskUpdate"`), with every
#     test passed. A reader who learned to ignore that learns to ignore a real unhandled error.
#
# So this reads the summary instead: `Test Files  N passed (M)` with N == M, no `failed`, no
# `skipped`, AND exit 0. Anything else fails, and the verdict line says which. An `Errors` line is
# named in the verdict either way; it fails the gate through the exit status, so a config that
# chose `dangerouslyIgnoreUnhandledErrors` (vitest.matching.config.ts, for the same timeout from
# its own serial compiles) keeps that choice.
#
# WORKERS. The default is 3 (`VITEST_MAX_WORKERS` overrides; an explicit `--maxWorkers` in the args
# wins). vitest's own default is one per core minus one — 9 on a 10-core machine — and the RPC
# timeout above is what that costs when two rounds' gates and a bench share the machine. Measured
# 2026-09-28 on this 10-core machine, the root config back to back: default workers 215 s, ending
# with `Errors  1 error` (the RPC timeout) at a load average of ~30; `--maxWorkers=3` 127 s, no error.
# Fewer workers was the FASTER run, not only the quieter one.
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
n=$(printf '%s\n' "$files" | sed -nE 's/^Test Files +([0-9]+) passed \(([0-9]+)\)$/\1/p')
m=$(printf '%s\n' "$files" | sed -nE 's/^Test Files +([0-9]+) passed \(([0-9]+)\)$/\2/p')
[ -n "$n" ] && [ "$n" = "$m" ] || fail "passed files do not equal collected files"
if [ "$status" != 0 ]; then
  [ -z "$errors" ] || fail "$errors, and vitest exited $status — a load-timeout error is a re-run, never a pass"
  fail "vitest exited $status"
fi
echo "gate: PASS — $what: $files; $tests${errors:+; $errors, ignored by this config}"
