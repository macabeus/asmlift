#!/bin/sh
# Offline self-test for scripts/pr-wait.sh's EXIT CONTRACT.
#
# The whole point of that script is that its exit code is an answer a caller can act on without
# asking a human — so the one thing that must never rot is which situation produces which code.
# The situations it has to tell apart are all things `gh` reports the same way (exit 1, nothing on
# stdout): a failing check, a dead network, an expired token, and the "no checks reported" a PR
# answers with for the first seconds of its life. Reading the exit status alone made all four a
# red build, which is exactly the false red the script exists to remove.
#
# So gh is stubbed and each situation replayed. No network, no repo state, about a second.
#
#   sh scripts/pr-wait-selftest.sh
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
target="$here/pr-wait.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pr-wait-selftest.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

# The stub. `pr view` always says the PR is open, so every case below is decided by the checks
# alone; `pr checks` replays one situation per $GH_STUB. The two spellings matter: the script asks
# for `--json bucket` to get a verdict, and asks again bare to print the table for the log.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/bin/sh
case "$2" in
  view) echo "OPEN CLEAN"; exit 0 ;;
  checks)
    case "$GH_STUB" in
      neterr)   echo "error connecting to api.github.com" >&2; exit 1 ;;
      autherr)  echo "gh: authentication token expired" >&2; exit 4 ;;
      nochecks) echo "no checks reported on the 'x' branch" >&2; exit 1 ;;
      pending)  case "$*" in *--json*) printf 'pass\npending\n' ;; *) echo "ci	pending	-	link" ;; esac; exit 8 ;;
      failing)  case "$*" in *--json*) printf 'pass\nfail\n' ;; *) echo "ci	fail	1m	link" ;; esac; exit 1 ;;
      cancelled) case "$*" in *--json*) printf 'pass\ncancel\n' ;; *) echo "ci	cancel	1m	link" ;; esac; exit 1 ;;
      skipped)  case "$*" in *--json*) printf 'pass\nskipping\n' ;; *) echo "ci	skipping	-	link" ;; esac; exit 0 ;;
      green)    case "$*" in *--json*) printf 'pass\npass\n' ;; *) echo "ci	pass	1m	link" ;; esac; exit 0 ;;
      *) echo "stub: unknown GH_STUB=$GH_STUB" >&2; exit 127 ;;
    esac ;;
esac
STUB
chmod +x "$tmp/bin/gh"

fails=0
expect() { # <situation> <expected exit> <why>
  out=$(PATH="$tmp/bin:$PATH" GH_STUB="$1" sh "$target" 999 --timeout 1 --interval 1 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$2" ]; then
    echo "ok   $1 → $rc   ($3)"
  else
    fails=$((fails + 1))
    echo "FAIL $1 → $rc, expected $2   ($3)"
    printf '%s\n' "$out" | sed 's/^/       /'
  fi
}

# 1 is reserved for a verdict GitHub actually gave; everything gh could not answer is 2.
expect green 3 "green and open: nothing missing, ready to merge"
expect skipped 3 "a skipped check is not a failed one"
expect failing 1 "a check GitHub reported as failed"
expect cancelled 1 "a cancelled check is not green either"
expect pending 2 "still running at the deadline — nothing decided"
expect neterr 2 "unreachable API is not a red build"
expect autherr 2 "an expired token is not a red build"
expect nochecks 2 "no workflow has registered yet — the first call on a new PR"

[ "$fails" -eq 0 ] || { echo "pr-wait-selftest: $fails case(s) failed"; exit 1; }
echo "pr-wait-selftest: all cases hold"
