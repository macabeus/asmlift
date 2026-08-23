# The ranked repro

The one invocation both `/match-function` and `/attribute-function` measure a real-project row
with, and the only place its flags are written down. **Both commands point here; edit this file,
not a copy inside a prompt.** The last time the same command was described in two prompts they
drifted, and a round published `557/578` against a `547` baseline — three numbers produced by
three different commands (PR #79).

## The command

```sh
cd <project checkout>            # e.g. apps/benchmark/checkouts/klonoa-empire-of-dreams
npx tsx <repo>/packages/cli/src/main.ts <asm/nonmatchings/…/Fn.s> \
  --config decomp.yaml \
  --score-against <build/…/tu.o> \
  --proto '{"<callee>":{"params":N}}' \
  --jobs 6 --progress
```

Run it from the project checkout and redirect stderr to a file — the `[score]` and `[progress]`
lines are stderr, and they are the whole record. From a git worktree, export the harness's
toolchain overrides first (`ASMLIFT_AGBCC` and the rest): a worktree's repo root is not the
workspace, so without them the sibling checkouts do not resolve and the run measures nothing.

## The flags are part of the number

- **`--proto`, whenever a callee's arity matters.** A callee still written in assembly carries no
  DWARF signature, so asmlift has to guess its arity and guesses wrong. `LoadBGTilemapData`
  without `--proto '{"thunk_HeapFree":{"params":1}}'` scores **578** where the round's baseline is
  **547** — a plausible number that is comparable to nothing. Pass the table inline, as above; a
  path to a file holding the same JSON is accepted too, but a scratch file is one more thing that
  drifts between rounds, and two of them carrying different tables is how the `557/578/547` above
  happened.
- **`--jobs 6 --progress`.** The candidate compiles are ~85% of a ranked run and pool cleanly.
  Two LBG runs launched together measured **36m10s serial against 21m32s at `--jobs 6`** (20608
  candidates, 0 dropped, identical winner) — but that machine was also running two full benches
  and both test suites, and a quieter pair measured **31m55s against 11m16s**. The ratio is the
  machine's, not the code's: re-time on your own log and quote that, never these. The
  `asmlift: [progress]` lines are what make a later claim about the run checkable from its log.
- **`--proto`'s absence is now in the log.** Every run ends with an `asmlift: [proto]` line
  naming the callees whose arity it had to guess (nothing declared them: no `--proto` entry, no
  signature in `tools.asmlift.elf`). On the canonical LBG command that line is absent; without
  `--proto` it reads `1 callee(s) have no declared arity … thunk_HeapFree`, in the same stderr you
  are already pasting. Check the tail of your log before you quote a score.
- Quote the counts by pasting the **`asmlift: [ranked]` line**, the last thing every ranked run
  writes:

  ```
  asmlift: [ranked] 20608 candidate(s) scored, 0 dropped, best <label>: 531 [asmlift source 7362050]
  ```

  A score from a run that dropped candidates is not comparable to one that dropped none — and
  "0 dropped" is now something the run SAYS. It used to be spelled as an absent line, so a clean
  run, a truncated log and a killed run left identical evidence.

- **The tree is part of the number too, and it is on that same line.** `[asmlift source <commit>]`
  is the asmlift checkout the run loaded its code from; `+dirty` means `packages/` had uncommitted
  changes, and `CHANGED DURING THE RUN` means the tree moved between the run's start and its end.
  A reviewer's run of the command above returned **455** against a twice-reproduced **419** with a
  spotless log — another session had written `packages/core/src/target.ts` inside that read-only
  worktree at the minute it launched and restored it before it finished, so `git status` was clean
  on both sides of the run. Rounds run in parallel worktrees other agents write to. If the stamp is
  not a bare commit, the number is not comparable to anything; re-run it. `unversioned` means the
  CLI was not run out of an asmlift checkout at all.

## Comparing two runs

Compare on the `[score]` lines, filtered with a **fixed** string:

```sh
diff <(grep -F '[score]' a.err) <(grep -F '[score]' b.err)
```

`grep '[progress]'` is a bracket **expression** matching any one of `p r o g e s`, so
`grep -v '[progress]'` deletes almost every line including every `[score]` one, and the diff
passes having compared nothing. A neutrality check that filters away what it is comparing is
worse than none.

## Write it down

Whatever you run, paste it verbatim, flags included, into your report. Every later measurement —
each reviewer's, each remediation's, the PR body's — re-runs _that_ command, not one recomposed
from memory.
