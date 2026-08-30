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

## The cache state is part of the number

asmlift can serve a candidate object a previous run already compiled, instead of compiling it
again (`packages/cli/src/candcache.ts`). **It is OFF unless `ASMLIFT_CANDCACHE` says otherwise**,
and it changes a run's WALL by several times while changing nothing a run computes. So every wall
quoted from now on has to say which state it was measured in, in the same breath as the command:

| `ASMLIFT_CANDCACHE`              | what the run does                                                      | when to use it                                                              |
| -------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| unset, `0`, `off`, `false`, `no` | compiles every candidate; touches no disk                              | **the default, and what a published wall should be measured with**          |
| `1` / `on` / `true` / `yes`      | serves any candidate this toolchain already compiled                   | the base-run/lever-run pair inside one round, and the gate ladder's repeats |
| `verify` (any capitalisation)    | compiles every candidate AND audits the store against it, loudly       | after any change to the cache, or when a stored answer is suspect           |
| anything else                    | **OFF, with `[candcache] REFUSED reason=unrecognised-mode` on stderr** | never on purpose — the parse is closed so a typo cannot silently SERVE      |

`ASMLIFT_BENCH_CACHE=0` turns this cache off too: "bypass the benchmark's caches" has to mean all
of them, or bisecting a suspect row still reads candidate objects off disk.

- **COLD or WARM is a property of the STORE, not of the flag.** The first `ASMLIFT_CANDCACHE=1`
  run after a toolchain change, a flag change, or a change to the harness code that shapes the
  compiler's input is COLD by construction — the namespace moved and nothing in the store answers
  to it. Say `cold` or `warm`, not just `on`. The store lives at `ASMLIFT_CANDCACHE_DIR`
  (default `$TMPDIR/asmlift-candcache`); deleting it makes the next run cold.
- **Never compare a warm wall against a cold one and call the difference a code change.** This is
  the same rule as "never compare numbers made with different flag sets", and it is easier to
  break because nothing on the command line says which state you were in. The run itself does:
  with the cache on, an `asmlift: [candcache]` line prints next to `[ranked]` with the mode and
  the hit/miss/stored counts. **Paste it whenever you paste a wall.**
- **The cache is a throughput lever and never a result lever.** The `[score]` lines, the winner
  and the stdout are identical in all three states by construction — a cache miss is
  indistinguishable in RESULT from no cache at all. If a `[score]` line moves between a cold run
  and a warm one, the cache is wrong; run the `diff` below, then re-run with `ASMLIFT_CANDCACHE=0`
  and report it.
- **On a PROJECT's own `decomp.yaml` command, the cache does nothing unless the project asks.**
  It stays off until `tools.asmlift.cacheInputs` lists the files and directories that command
  reads (an empty list is a declaration too — "nothing my template does not already name"). The
  declaration is the contract: a namespace can only measure inputs it can name, and an input
  reached through a directory is nameable only there. The cache also refuses, out loud, when the
  compile is not a pure function of its input — `[candcache] REFUSED label=command
reason=object-is-not-a-pure-function-of-its-input` is what `ido7.1` gets, because it writes the
  absolute path of its input `.c` into the object.
- **An INCOMPLETE declaration is a silent stale object, and nothing verifies it for you.** The
  declaration is a promise, not a proof: `cacheInputs: []` on a template that reaches a file
  through a script serves the stale object for that file, measured. List every file and directory
  the command reads, including anything a wrapper script of yours opens. The one shape asmlift
  checks by itself is the SHAPE of the declaration — a scalar where a list was meant (`cacheInputs:
gen`) is now a loud load error, because a string iterates per character and used to turn the
  cache on having measured nothing at all. If in doubt, leave the key out: no key, no cache.
- **The store is bounded, but only between runs.** `ASMLIFT_CANDCACHE_MAX_MB` (default 4096)
  counts the distinct object bytes plus one allocation block per stored key — 77% of a warm store
  is negative entries, which weigh nothing logically and cost a block each. It is enforced ONCE per
  process, at the first namespace resolution and before any candidate compiles: whole namespaces no
  live process holds go first, then the oldest-written keys of the namespace this run is about to
  use. A namespace another process holds is never touched, so under `pnpm bench run`'s 8–16 shards
  the second shard onward prunes nothing. `rm -rf "$TMPDIR/asmlift-candcache"` is the reliable
  reset, and it is also how you make the next run cold on purpose.
- **`verify` audits the OUTCOME, not only the bytes.** A stored object whose TU no longer compiles,
  and a stored rejection whose TU now does, are both mismatches — the second is the one that
  silently drops a spelling from a row's fan, and it is 77% of what a warm store serves. Any
  mismatch fails the run (nonzero exit) and is written to `MISMATCHES.log` in the store.

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
  asmlift: [ranked] 20608 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, best <label>: 531 [asmlift source 7362050]
  ```

  A score from a run that dropped candidates is not comparable to one that dropped none — and
  "0 dropped" is now something the run SAYS. It used to be spelled as an absent line, so a clean
  run, a truncated log and a killed run left identical evidence.

  `synthesized` counts the declarations asmlift wrote for the winning candidate because no symbol
  map knew the name — read out of the same asm the score is about, so they cannot lose score, only
  manufacture agreement. A non-zero count means the artifact is that declaration block plus the
  source; the block itself is printed on the `asmlift: [declared]` lines just above.

  **WITHHELD is a third count and a different fact.** `dropped` means the scorer refused a
  spelling; `withheld` means one compiled, scored, and was refused PUBLICATION because it is
  proof-gated (`Candidate.matchOnly` — a spelling whose semantics no gate over the C can settle, so
  only a byte-exact score licenses it). Without the count, `candidates scored` silently
  under-reports the fan. On the LBG command below it is 0, because `/unreduce` declines there.

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
