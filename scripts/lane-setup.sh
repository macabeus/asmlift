#!/bin/sh
# A worktree a round can run `bench run` in, in one command:
#
#   sh scripts/lane-setup.sh <worktree> <branch> [--base <ref>] [--env <file>]
#                            [--board <dir> --handle <H> --args <json>]
#
#   1. `git worktree add -b <branch> <worktree> <base>` off a freshly fetched base (origin/main),
#      `<base>` resolved in the MAIN checkout. Refuses a path that exists: a round launched into a
#      live worktree shares it with the round already there.
#   2. links apps/benchmark/{checkouts,toolchains} to the MAIN checkout's copies — `bench setup`
#      materializes gigabytes there, once — so every lane reads the same checkouts, and a
#      `bench setup --build` in one lane rebuilds what the others read. .gitignore matches both
#      as symlinks.
#   3. writes <worktree>/.envrc.local: `--env <file>` copied verbatim; otherwise every `ASMLIFT_*`
#      exported in THIS shell, plus the directories this shell resolves node, pnpm and `cpp` from
#      — `cpp` because a login shell puts Apple clang's first, and Apple's ignores `-o` (round
#      protocol trap #6). Either way the environment is checked before anything is created: at
#      least one `ASMLIFT_*`, since a worktree's sibling defaults resolve to nothing, and a `cpp`
#      that is not /usr/bin/cpp. Nothing sources the file for you.
#   4. `pnpm install --frozen-lockfile --prefer-offline` in the worktree.
#   5. with `--board`, `--handle` and `--args`: writes the Workflow args to
#      <board>/args/<handle>.json BEFORE the launch. A resume needs the exact args of the run it
#      resumes, and the only other copy is in a context that may not survive.
#
# Prints `lane: ready <worktree>` last; anything else is a failed setup.
set -eu

die() {
  echo "lane: $*" >&2
  exit 2
}

[ $# -ge 2 ] || die "usage: lane-setup.sh <worktree> <branch> [--base <ref>] [--env <file>] [--board <dir> --handle <H> --args <json>]"
wt=$1
branch=$2
shift 2
base=origin/main
env_file=
board=
handle=
args=
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 needs a value"
  case $1 in
    --base) base=$2 ;;
    --env) env_file=$2 ;;
    --board) board=$2 ;;
    --handle) handle=$2 ;;
    --args) args=$2 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done
if [ -n "$board$handle$args" ] && { [ -z "$board" ] || [ -z "$handle" ] || [ -z "$args" ]; }; then
  die "--board, --handle and --args go together: a saved args file needs all three"
fi
[ -z "$env_file" ] || [ -f "$env_file" ] || die "--env $env_file does not exist"
[ ! -e "$wt" ] || die "$wt already exists — never launch into a worktree that may be live; pick a new path"
case $wt in /*) ;; *) die "give <worktree> as an absolute path: the round is briefed with it verbatim" ;; esac
# The environment the lane will run in: this shell's, or the one `--env` produces when sourced into
# an otherwise empty one — a lane's shells do not inherit this one's.
if [ -n "$env_file" ]; then
  lane_env() { env -i HOME="$HOME" PATH=/usr/bin:/bin sh -c '. "$1" && shift && exec "$@"' sh "$env_file" "$@"; }
else
  lane_env() { "$@"; }
fi
vars=$(lane_env env | grep -E '^ASMLIFT_[A-Z0-9_]+=' | sort || true)
[ -n "$vars" ] || die "no ASMLIFT_* in ${env_file:-this shell}; a worktree's sibling defaults resolve to nothing (round protocol trap #6)"
[ "$(lane_env sh -c 'command -v cpp')" != /usr/bin/cpp ] || die "\`cpp\` resolves to Apple clang's /usr/bin/cpp in ${env_file:-this shell} — put the shim first (round protocol trap #6)"

main=$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")

# 1. the worktree, off a fresh base
case $base in origin/*) git -C "$main" fetch -q origin "${base#origin/}" ;; esac
git -C "$main" worktree add -q -b "$branch" "$wt" "$base"
echo "lane: worktree $wt on $branch from $base ($(git -C "$wt" rev-parse --short HEAD))"

# 2. the bench-owned trees, shared
for d in checkouts toolchains; do
  if [ -d "$main/apps/benchmark/$d" ]; then
    ln -s "$main/apps/benchmark/$d" "$wt/apps/benchmark/$d"
  else
    echo "lane: WARNING $main/apps/benchmark/$d does not exist — run \`pnpm bench setup\` in the main checkout, or the real tier has nothing to build" >&2
  fi
done
[ -z "$(git -C "$wt" status --porcelain)" ] || die "the new worktree is not clean after linking: $(git -C "$wt" status --porcelain | head -3)"

# 3. the environment
if [ -n "$env_file" ]; then
  cp "$env_file" "$wt/.envrc.local"
else
  path=$(for t in cpp node pnpm; do dirname "$(command -v "$t")"; done | awk '!seen[$0]++' | paste -sd: -)
  {
    echo "# Written by scripts/lane-setup.sh. \`source .envrc.local\` in EVERY shell before a harness command."
    echo "export PATH=\"$path:\$PATH\""
    printf '%s\n' "$vars" | while IFS= read -r kv; do
      printf 'export %s=%s\n' "${kv%%=*}" "'$(printf '%s' "${kv#*=}" | sed "s/'/'\\\\''/g")'"
    done
  } >"$wt/.envrc.local"
fi
echo "lane: .envrc.local has $(grep -c '^export ASMLIFT_' "$wt/.envrc.local") ASMLIFT_* export(s)"

# 4. dependencies
(cd "$wt" && pnpm install --frozen-lockfile --prefer-offline --silent)

# 5. the args a resume needs
if [ -n "$board" ]; then
  mkdir -p "$board/args"
  printf '%s\n' "$args" >"$board/args/$handle.json"
  echo "lane: workflow args saved to $board/args/$handle.json"
fi

echo "lane: ready $wt"
