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
# The two deadlines are pinned here too: --timeout bounds a wait GitHub is answering, and
# --unknown-timeout bounds one where it is not. Those cases assert the MESSAGE, not just the exit
# code — both give up with 2, and a bug that let the silence budget cut short a healthy pending
# wait would be invisible on the code alone.
#
# So gh is stubbed and each situation replayed. No network, no repo state, ~8s (measured 7.8-8.2s
# over three runs here; the four cases that wait out a deadline are what it spends).
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
expect() { # <situation> <expected exit> <why> [flags] [output must contain]
  flags=${4:-"--timeout 1 --interval 1"}
  # shellcheck disable=SC2086 # $flags is a deliberate argument list
  out=$(PATH="$tmp/bin:$PATH" GH_STUB="$1" sh "$target" 999 $flags 2>&1) && rc=0 || rc=$?
  bad=""
  [ "$rc" -eq "$2" ] || bad="exit $rc, expected $2"
  if [ -n "${5:-}" ] && ! printf '%s\n' "$out" | grep -q -- "$5"; then
    bad="${bad:+$bad; }said nothing matching '$5'"
  fi
  if [ -z "$bad" ]; then
    echo "ok   $1 → $rc   ($3)"
  else
    fails=$((fails + 1))
    echo "FAIL $1: $bad   ($3)"
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

# The two deadlines are separate budgets. The prompts call this script with neither flag, so the
# silence budget is the only thing standing between an expired token and an hour of a blocked
# caller — and it must not shorten a wait GitHub is actually answering.
expect neterr 2 "silence gives up on its OWN budget, not the whole --timeout" \
  "--timeout 600 --interval 1 --unknown-timeout 1" "no check verdict at ALL for 1s"
expect pending 2 "a pending check is an ANSWER: the silence budget must not cut it short" \
  "--timeout 2 --interval 1 --unknown-timeout 1" "no check verdict after 2s"

[ "$fails" -eq 0 ] || { echo "pr-wait-selftest: $fails case(s) failed"; exit 1; }
echo "pr-wait-selftest: all cases hold"
