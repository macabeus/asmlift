# The ranked repro

The one invocation both `/match-function` and `/attribute-function` measure a real-project row
with, and the only place its flags are written down. **Both commands point here; edit this file,
not a copy inside a prompt.** The last time the same command was described in two prompts they
drifted, and a round published `557/578` against a `547` baseline — three numbers produced by
three different commands (PR #79).

## The command

```sh
cd <repo> && pnpm --filter @asmlift/cli build     # rebuild the loader; see below

cd <project checkout>            # e.g. apps/benchmark/checkouts/klonoa-empire-of-dreams
node <repo>/packages/cli/dist/asmlift.mjs <asm/nonmatchings/…/Fn.s> \
  --config decomp.yaml \
  --score-against <build/…/tu.o> \
  --proto '{"<callee>":{"params":N}}' \
  --jobs 6 --progress
```

Run it from the project checkout and redirect stderr to a file — the `[score]` and `[progress]`
lines are stderr, and they are the whole record. From a git worktree, export the harness's
toolchain overrides first (`ASMLIFT_AGBCC` and the rest): a worktree's repo root is not the
workspace, so without them the sibling checkouts do not resolve and the run measures nothing.

## The loader is part of the number

Two loaders run the same sources. `npx tsx packages/cli/src/main.ts` reads and transforms every
file on every run, and its transform wraps every arrow function in esbuild's `--keep-names` shim,
which the enumerator's per-candidate closures then pay for on every candidate.
`packages/cli/dist/asmlift.mjs` is those same sources bundled once without it, and it is what the
command above runs. Both produce the same candidates and the same scores; the `[score]` diff below
is the check, and it is cheap.

Measured back to back on the LoadBGTilemapData command below — one machine, other work running on
it, `--jobs 6`, 26880 candidates: **620s under tsx against 484s bundled**, of which the ENUMERATION
(the only phase a loader touches — the candidate compiles are subprocesses) was **207s against
118s**. Both printed the same `[ranked]` line, the same 26880 `[score]` lines and the same stdout
byte for byte. The ratio is the machine's, not the code's: re-time on your own log.

**A bundle is only as fresh as its last build, and `dist/` is gitignored** — nothing rebuilds it for
you, nothing commits it, and an old one runs exactly as happily as a new one. So rebuild before any
run you intend to quote, and read the stamp: the build BAKES the tree it was built from into the
bundle, and the run compares that bake against the checkout it is standing in. A bundle that no
longer matches says `STALE BUNDLE` on the line you are pasting, instead of naming a commit whose
code it is not running.

The comparison is on `packages/` CONTENT, not on the commit: docs and the regenerated benchmark
artifact are committed constantly and change nothing a ranked run computes, so a commit that leaves
`packages/` alone is not staleness and does not warn. CONTENT means the bytes — the check hashes
every tracked-or-untracked file under `packages/` — so re-editing a file the tree was ALREADY
carrying dirty is staleness like any other. That is the state a perf round runs in, and a check that
stopped at the list of dirty paths would have called such a bundle current.

## The flags are part of the number

- **`--proto`, whenever a callee's arity matters.** A callee still written in assembly carries no
  DWARF signature, so asmlift has to guess its arity and guesses wrong. `LoadBGTilemapData`
  without `--proto '{"thunk_HeapFree":{"params":1}}'` scores **578** where the round's baseline is
  **547** — a plausible number that is comparable to nothing. Pass the table inline, as above; a
  path to a file holding the same JSON is accepted too, but a scratch file is one more thing that
  drifts between rounds, and two of them carrying different tables is how the `557/578/547` above
  happened.
- **`--jobs 6 --progress`.** The candidate compiles dominate a ranked run and pool cleanly.
  Two LBG runs launched together measured **36m10s serial against 21m32s at `--jobs 6`** (20608
  candidates, 0 dropped, identical winner) — but that machine was also running two full benches
  and both test suites, and a quieter pair measured **31m55s against 11m16s**. The ratio is the
  machine's, not the code's: re-time on your own log and quote that, never these. The
  `asmlift: [progress]` lines are what make a later claim about the run checkable from its log.

- **`--progress` also prints WHERE the time went**, as one `asmlift: [phase]` line from the run's own
  clock (`packages/cli/src/phase.ts`) — so a per-phase claim comes from the log everyone already
  pastes, not from a rig outside the tree that the next round has to rebuild:

  ```
  asmlift: [phase] wall 259.4s · enumerate 19.9s (1 call) · compile 1257.3s over 6 workers
    (26880 calls) · score 163.7s (26880 calls) · rank 2.5s (1 call) · main-thread idle+other 73.3s
  ```

  Two denominators, answering different questions. `compile` is summed ACROSS workers, so
  `compile / wall` is the pool's average parallelism — **4.85 of 6** above, which is what says
  whether more `--jobs` would buy anything. The MAIN THREAD's budget is `enumerate + score + rank`
  = 186.1s of the 259.4s wall, of which scoring is 88%; the remaining `idle+other` is the main
  thread waiting on subprocesses. Of the work charged at all (1443.4s), the compiles are **87%**.

  Both figures move with the machine, and by a lot. The same command on the same commit, sharing
  the box with a full `pnpm bench run`, read `wall 426.3s · compile 2175.1s · score 211.2s` —
  same 26880 candidates, same 0 dropped, same 395, same winner. Only the shares travel; re-time on
  your own log, and say what else the machine was doing.

  `idle+other` is the wall minus the work that HELD the main thread, which is not a fixed list of
  phases: at `--jobs 1` the compiles run on the main thread and come out of it, at `--jobs n` they
  are subprocess awaits and do not. So the residual means "waiting on subprocesses, plus whatever
  this clock does not name" in both, and the parts never sum past the wall.

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

  **The candidate COUNT belongs to the tree, not to the function.** Every axis admitted multiplies
  it, so the counts quoted in the anecdotes above are each an A/B against themselves and none of
  them is a figure to reproduce. Quote your own `[ranked]` line.

- **The tree is part of the number too, and it is on that same line.** `[asmlift source <commit>]`
  names the asmlift sources the run actually executed. A reviewer's run of the command above
  returned **455** against a twice-reproduced **419** with a spotless log — another session had
  written `packages/core/src/target.ts` inside that read-only worktree at the minute it launched and
  restored it before it finished, so `git status` was clean on both sides of the run. Rounds run in
  parallel worktrees other agents write to. **If the stamp is not a bare commit, the number is not
  comparable to anything; fix what it names and re-run.** A bare commit is not a proof of the
  converse: the tree is sampled at the run's two ends, so an edit that lands and is reverted
  strictly between them leaves no mark. The window is the run's length rather than unbounded.

  | stamp                                            | what it says                                                                                                    |
  | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
  | `asmlift source af59b99`                         | the commit whose `packages/` produced this score. Quotable.                                                     |
  | `asmlift source af59b99+dirty`                   | uncommitted changes under `packages/`; nobody else can reproduce it                                             |
  | `asmlift source af59b99, CHANGED DURING THE RUN` | the sources moved between the run's start and its end — a tsx run can load a file from either side of that edit |
  | `asmlift source af59b99, STALE BUNDLE: …`        | the bundle ran `af59b99`'s code, and the checkout no longer holds it. Rebuild, re-run                           |
  | `asmlift source unversioned`                     | not run out of an asmlift checkout at all (an installed package), so nothing here can name the sources          |

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
