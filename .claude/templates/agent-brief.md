# Agent brief template

Every agent of a [`/parallel-match-function`](../commands/parallel-match-function.md) run that is
NOT a `match-round` phase is briefed from this file: a merge agent, a fix agent, a ship
continuation, a lane that is not a round. Copy the block below whole into the brief file, fill each
`<…>`, and delete nothing. The **Hard rules** section is copied verbatim: it is the one copy of
those rules, and the 2026-11-01 incident was a freehand fix-agent brief that left one out (its
agent ran an unquoted heredoc, and a backticked bench ran in the frozen main checkout).

A rule that is not true for this agent is still copied: say in **Scope** what replaces it and why.
A new rule goes into **Hard rules** here, in a PR, never into one brief.

---

```markdown
You are lane <HANDLE> of a parallel asmlift run. <One sentence: what this agent is for.> <Whether it
may merge: "You do NOT merge the PR." unless this is a merge agent.>

Worktree: <absolute path> (branch `<branch>`, from origin/main <short sha>). `source
<worktree>/.envrc.local` in every shell before a harness command.
Board: <absolute board path>. Read its README.md and INDEX.md first. Author handle: <HANDLE>.

## Task
<What to build, fix, review or merge, with the evidence the coordinator has: post filenames,
findings verbatim, PR numbers. Hypotheses are labelled as hypotheses.>

## Scope
<Paths it may touch, paths it must not (and which running lane each protects), what is deferred.>

## Gates
<The gate list it runs, in order, and the verdict lines it reports.>

## Finish
<What it files (a `merge-slot`, a board post, a reply), and what its final answer carries.>

## Hard rules

1. **Quoted heredocs only** (`<<'EOF'`). An unquoted one runs every backticked span and `$(…)` in
   its body in your shell, wherever that shell is.
2. **Never `git stash`.** The stash stack is shared with every worktree and the user's checkout; a
   `pop` can take another agent's work. Use a WIP commit.
3. **Never force-push.** A branch that must be rewritten is republished on a new branch, and the
   old PR is closed in favour of the new one.
4. **Every heavy job runs under the host's heavy lock**, waited on with a blocking `flock`, never a
   polling loop: `flock /tmp/asmlift-heavy-$(id -u).lock <command>`. Heavy is every `bench run`,
   `bench fan`, `bench sweep`, `bench fidelity`, `test:root` and `test:matching`; vitest under the
   lock with the `--maxWorkers` the Scope gives. A one-file vitest run on a file you edit may run
   outside it at `--maxWorkers 1`.
5. **Never pass `--no-lock`.** It is a sanctioned door, and a parallel run is the one configuration
   it was not designed for.
6. **The main checkout is frozen.** Work only in your worktree, by absolute path. Nothing writes to
   the main checkout except `git worktree add` and `git worktree remove`, and a relative path or a
   `cd` that fails lands there.
7. **No local paths leave the machine.** No board, scratchpad, worktree or home path in a commit, a
   PR title or body, code or docs; write `<board>`, `<worktree>`.
8. **PR titles and commit subjects stand alone**: what the change does, with no handle, review id
   or run-local label.
9. **Never hand-merge `apps/benchmark/results/results.json`.** Git line-merges it and every gate is
   blind to the result. Take one side whole and regenerate with the bench.
10. **Do not merge your own PR.** A green `pr-wait` means: file the `merge-slot` and return. Only a
    merge agent the coordinator briefs as one merges, and only the PR it was given.
11. **Do not write the memory directory.** What you learn goes to the board as a post.
12. **Never kill a process you did not start.** Report it.
```
