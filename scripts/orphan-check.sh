#!/bin/sh
# List processes old enough to be orphans that are still working in an asmlift tree. REPORT ONLY:
# this script never signals, renices or kills anything, and neither should its caller.
#
#   sh scripts/orphan-check.sh [--repo <checkout>] [--root <dir>]... [--hours <n>] [--table <file>]
#
# Why it exists: a `python3 -` left behind by a killed task spun one core for eight days, under
# every bench of a parallel run, and nothing looked. Each such process is sane when it starts;
# what makes it an orphan is only that it outlived whoever started it, so the test is age plus
# where it works.
#
# A process is reported when it is older than --hours (default 24) and its cwd or one of its
# open files lies under a ROOT:
#   - the main checkout of --repo (default: the repository the current directory is in) and every
#     worktree `git worktree list` names;
#   - any sibling of the main checkout whose name starts with `<its name>-` (lane worktrees), even
#     one that no longer exists — a killed lane's orphan keeps the cwd of a worktree since removed,
#     which Linux shows as `<path> (deleted)`;
#   - the Claude Code scratchpads of this project, `<tmp>/claude-<uid>/<checkout path, / as ->`;
#   - every --root given (the run's board, a scratchpad elsewhere).
# The caller's own ancestors are skipped: the session that runs the pass check is itself days old
# and works in the main checkout.
#
# Exit status: 0 nothing found; 1 orphans found and listed; 3 cannot check on this host (said why).
# A parallel run's pass check treats 1 and 3 as WARNINGS (see "The pass check" in
# .claude/commands/parallel-match-function.md for why it must not fail on them).
#
# Linux reads /proc. macOS (any host without /proc) reads `ps` and `lsof`; without lsof it cannot
# see a process's cwd and says so. --table replaces the scan with a prepared process table, one
# process per line: `pid<TAB>age seconds<TAB>cwd<TAB>open files joined by |<TAB>command line<TAB>tty`
# (tty optional). That is how the tests fake a week-old process without waiting a day for one.
#
# Each report names the process's controlling terminal: `tty=none` is a detached process (a
# killed task's leftover is one), `tty=pts/N` an interactive shell or session someone may still
# be using. The check cannot tell which of those is an orphan; the user can.
set -eu
export LC_ALL=C

hours=24
repo=
roots_extra=
table=
die() {
  echo "orphan-check: $*" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 needs a value"
  case $1 in
    --repo) repo=$2 ;;
    --root) roots_extra="$roots_extra$2
" ;;
    --hours) hours=$2 ;;
    --table) table=$2 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done
case $hours in '' | *[!0-9]*) die "--hours takes a whole number" ;; esac
min_age=$((hours * 3600))

tab=$(printf '\t')
tmp=$(mktemp -d "${TMPDIR:-/tmp}/orphan-check.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

# ── roots ──────────────────────────────────────────────────────────────────────────────────────
# One per line, `=<dir>` for "this directory or under it", `^<prefix>` for "any path starting so".
{
  common=$(git -C "${repo:-.}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$common" ]; then
    main=$(dirname "$common")
    echo "=$main"
    echo "^$main-"
    git -C "$main" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree /=/p'
    slug=$(printf '%s' "$main" | tr / -)
    for t in /tmp "${TMPDIR:-/tmp}"; do echo "=${t%/}/claude-$(id -u)/$slug"; done
  elif [ -n "$repo" ]; then
    die "--repo $repo is not a git checkout"
  fi
  printf '%s' "$roots_extra" | sed -n 's/^\(.\)/=\1/p'
} | awk 'NF && !seen[$0]++' >"$tmp/roots"
[ -s "$tmp/roots" ] || die "no roots: run inside an asmlift checkout, or pass --repo or --root"

# ── the process table ──────────────────────────────────────────────────────────────────────────
# Same columns as --table, only for processes past the age bar (cwd and fds are read only
# for those, so a host with thousands of fds is not walked whole).
etime_s() { # [[dd-]hh:]mm:ss -> seconds
  awk -v e="$1" 'BEGIN { d = 0; if (index(e, "-")) { split(e, a, "-"); d = a[1]; e = a[2] }
    n = split(e, t, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + t[i]; print d * 86400 + s }'
}
ancestors() { # pid, then every parent up to init
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    echo "$p"
    if [ -r "/proc/$p/stat" ]; then
      p=$(sed 's/.*) //' "/proc/$p/stat" | cut -d' ' -f2)
    else
      p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    fi
  done
}
proc_row() { # pid age tty -> one table row, or nothing when the process cannot be read
  if [ "$mode" = proc ]; then
    cwd=$(readlink "/proc/$1/cwd" 2>/dev/null) || return 0
    files=$(for f in "/proc/$1/fd/"*; do readlink "$f" 2>/dev/null || true; done | grep '^/' | paste -sd'|' - || true)
    cmd=$(tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | sed 's/ $//') || cmd=
  else
    cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    [ -n "$cwd" ] || return 0
    files=$(lsof -p "$1" -Fn 2>/dev/null | sed -n 's/^n\(\/.*\)/\1/p' | paste -sd'|' - || true)
    cmd=$(ps -o command= -p "$1" 2>/dev/null || true)
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$cwd" "$files" "$cmd" "${3:-?}"
}

if [ -n "$table" ]; then
  [ -r "$table" ] || die "--table $table cannot be read"
  cp "$table" "$tmp/table"
  : >"$tmp/skip"
else
  if [ -d /proc/self/fd ] && [ -r /proc/self/stat ]; then
    mode=proc
  elif command -v lsof >/dev/null 2>&1; then
    mode=lsof
  else
    echo "orphan-check: CANNOT CHECK on $(uname -s): no /proc and no lsof, so no process's cwd can be read"
    exit 3
  fi
  # The apparatus first: a reader that cannot see THIS shell's cwd sees nobody's, and would report
  # a clean host. (/proc/$$ is this shell; under lsof, $$ is too.)
  self=$(proc_row $$ 0 ? | cut -f3)
  if [ "$self" != "$(pwd -P)" ]; then
    echo "orphan-check: CANNOT CHECK: the $mode reader saw this shell's cwd as '${self:-nothing}', not '$(pwd -P)'"
    exit 3
  fi
  ancestors >"$tmp/skip"
  ps -A -o pid= -o etime= -o tty= 2>/dev/null | while read -r pid et tty; do
    age=$(etime_s "$et")
    [ "$age" -ge "$min_age" ] || continue
    grep -qx "$pid" "$tmp/skip" && continue
    proc_row "$pid" "$age" "$tty"
  done >"$tmp/table"
fi

# ── match ──────────────────────────────────────────────────────────────────────────────────────
found=$(awk -F"$tab" -v min="$min_age" -v rootsf="$tmp/roots" -v skipf="$tmp/skip" '
  BEGIN {
    while ((getline r < rootsf) > 0) roots[++nr] = r
    while ((getline s < skipf) > 0) skip[s] = 1
  }
  function under(p,   i, k, d) {
    sub(/ \(deleted\)$/, "", p)
    for (i = 1; i <= nr; i++) {
      k = substr(roots[i], 1, 1); d = substr(roots[i], 2)
      if (k == "^" && index(p, d) == 1) return 1
      if (k == "=" && (p == d || index(p, d "/") == 1)) return 1
    }
    return 0
  }
  function age(s) { return sprintf("%dd%02dh", int(s / 86400), int((s % 86400) / 3600)) }
  ($1 in skip) || $2 < min { next }
  {
    why = ""
    if (under($3)) why = "cwd"
    else { n = split($4, f, "|"); for (i = 1; i <= n; i++) if (under(f[i])) { why = "file " f[i]; break } }
    t = ($6 == "" || $6 == "?" || $6 == "??") ? "none" : $6
    if (why != "") printf "orphan-check: ORPHAN pid=%s age=%s tty=%s cwd=%s via=%s cmd=%s\n", $1, age($2), t, $3, why, substr($5, 1, 400)
  }' "$tmp/table")

nroots=$(wc -l <"$tmp/roots" | tr -d ' ')
if [ -n "$found" ]; then
  printf '%s\n' "$found"
  echo "orphan-check: $(printf '%s\n' "$found" | wc -l | tr -d ' ') process(es) older than ${hours}h working under $nroots root(s). Nothing was killed: report each to the user, who decides."
  exit 1
fi
echo "orphan-check: OK (no process older than ${hours}h works under $nroots root(s))"
