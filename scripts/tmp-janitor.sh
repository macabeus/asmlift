#!/bin/sh
# Sweep the harness's leaked scratch directories.
#
# Every compile the CLI, the benchmark and the toolchains do used to mkdtemp a directory and
# never remove it: one per CANDIDATE, so a ranked run over 20k candidates left 20k behind and a
# full bench run left one per candidate compile. The compile seams now reuse ONE directory per
# worker (packages/cli/src/compile-command.ts, apps/benchmark/src/compile/util.ts `scratchSlot`),
# but @asmlift/toolchains still leaks, and the directories already on disk stay until something
# removes them — this is that something.
#
# DRY RUN by default: prints what it would remove. Pass --apply to actually remove.
#
#   scripts/tmp-janitor.sh                 # count what is sweepable, remove nothing
#   scripts/tmp-janitor.sh --apply         # remove it
#   scripts/tmp-janitor.sh --apply --hours 1
#
# Only directories whose name starts with one of the harness's own mkdtemp prefixes are ever
# touched, only directly inside a temp root, and only when older than --hours (default 6) — a
# run in flight owns a scratch dir, and this must never delete out from under it.
#
# `bench-real-*` is deliberately NOT in the list: those are the CONTENT-KEYED reference builds
# (apps/benchmark/src/compile/util.ts `contentDir`), a cache keyed by TU sha, not a leak.
set -eu

APPLY=0
HOURS=6
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --hours) HOURS="$2"; shift ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

PREFIXES='asmlift-usercc- asmlift-score- asmlift-ref- asmlift-target- asmlift-mips-score- asmlift-mips-pas- bench-cand- bench-vendor- bench-m2c- bench-fidelity-'
MINUTES=$((HOURS * 60))
ROOTS="${TMPDIR:-/tmp} /tmp"

total=0
for root in $ROOTS; do
  [ -d "$root" ] || continue
  for p in $PREFIXES; do
    # -mmin bounds the sweep by age; -maxdepth 1 keeps it to the temp root itself. `-print` is
    # counted rather than listed: there can be a million of them.
    n=$(find "$root" -maxdepth 1 -name "$p*" -mmin +"$MINUTES" -print 2>/dev/null | wc -l | tr -d ' ')
    [ "$n" -eq 0 ] && continue
    total=$((total + n))
    if [ "$APPLY" -eq 1 ]; then
      find "$root" -maxdepth 1 -name "$p*" -mmin +"$MINUTES" -exec rm -rf {} + 2>/dev/null || true
      echo "removed  $n	$root/$p*"
    else
      echo "would remove  $n	$root/$p*"
    fi
  done
done

if [ "$APPLY" -eq 1 ]; then
  echo "swept $total directories older than ${HOURS}h"
else
  echo "$total directories older than ${HOURS}h are sweepable — re-run with --apply to remove them"
fi
