#!/bin/sh
# Compare one job's measured peak with the lane's memory budget. REPORT ONLY: nothing is refused.
#
#   sh scripts/heap-check.sh <`/usr/bin/time -v` log | peak in bytes>
#
# A bench shard runs on node's default V8 heap. When one row's enumeration outgrows it, the shard
# dies with `JavaScript heap out of memory`, the row is lost from the tier ("neither measured nor
# skipped"), and `--resume` dies the same way — while the row passes when run alone, so a scoped
# rerun hides it. The fan count does not show this cost; only the row's peak does. So measure it
# (`/usr/bin/time -v pnpm bench fan <row> --enumerate`, docs/bench-cost.md §5) and hand the log here.
#
# The budget is what scripts/lane-setup.sh recorded in the lane's .envrc.local:
#   ASMLIFT_LANE_HEAP_LIMIT_BYTES  node's heap_size_limit in the lane's environment
#   ASMLIFT_LANE_MEM_TOTAL_BYTES   the host's RAM
# Unset (a lane set up another way), the heap limit is read from `node` on PATH now.
#
# Verdicts, on stdout: OK under 90% of the heap limit; NEAR from 90%; OVER at or past it.
# Exit 0 for OK and NEAR, 1 for OVER, 2 for a usage error. The figure compared is the maximum
# resident set of the largest process, which `time -v` reports; it over-reads the heap (code and
# buffers count too), so OVER says "measure this before a full bench", not "this will die".
set -eu
export LC_ALL=C

die() {
  echo "heap-check: $*" >&2
  exit 2
}
[ $# -eq 1 ] || die "usage: heap-check.sh <time -v log | bytes>"
case $1 in
  *[!0-9]* | '')
    [ -r "$1" ] || die "$1 is neither a byte count nor a readable log"
    kb=$(sed -n 's/^[[:space:]]*Maximum resident set size (kbytes): *\([0-9][0-9]*\).*/\1/p' "$1" | tail -1)
    [ -n "$kb" ] || die "$1 has no 'Maximum resident set size' line: run the job under /usr/bin/time -v"
    peak=$((kb * 1024))
    ;;
  *) peak=$1 ;;
esac
limit=${ASMLIFT_LANE_HEAP_LIMIT_BYTES:-}
src="the lane's .envrc.local"
if [ -z "$limit" ]; then
  limit=$(node -e 'process.stdout.write(String(require("v8").getHeapStatistics().heap_size_limit))' 2>/dev/null) ||
    die "ASMLIFT_LANE_HEAP_LIMIT_BYTES is unset and node cannot be run to read the limit"
  src="node on PATH, now (source the lane's .envrc.local to read its recorded budget)"
fi
awk -v p="$peak" -v l="$limit" -v t="${ASMLIFT_LANE_MEM_TOTAL_BYTES:-}" -v src="$src" 'BEGIN {
  pct = 100 * p / l
  v = pct >= 100 ? "OVER" : pct >= 90 ? "NEAR" : "OK"
  printf "heap-check: %s peak %.2f GB = %.0f%% of the %.2f GB heap limit (from %s)", v, p / 1e9, pct, l / 1e9, src
  if (t != "") printf "; host RAM %.2f GB", t / 1e9
  printf "\n"
  if (v == "OVER") print "heap-check: a shard running this row can die of heap exhaustion: compare with origin/main before a full bench"
  exit v == "OVER" ? 1 : 0
}'
