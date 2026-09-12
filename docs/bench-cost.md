# What the benchmark commands cost

The one place the cost table lives. **`/match-function` and `/attribute-function` link here; edit
this file, not a copy inside a prompt.** Both prompts carried the same 81 lines verbatim until
2026-09-12, and the figures in them were four months' worth of stale — `~1800 s` for a run that
takes ~2,040, and `real 1618 s` for a tier that takes 1,880.

**Every figure below carries the date it was measured and the command that produced it.** A cost
table that cannot go stale silently is worth more than an accurate one that can. If you re-measure
one, move its date; if you cannot, delete the row rather than let it read as current.

## 1. The table

Measured on this machine on **2026-09-12**, at `8599234d`, alone (no neighbour bench, no ranked
run). Corpus: 1,062 rows — 810 synthetic + 252 real.

| command                                  | cost                                                                                             | what produced it                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm bench run` (all tiers)             | **~2,040 s ≈ 34 min** warm                                                                       | the two tier lines of the 2026-09-12 ship run: `✓ synthetic: 810 results in 161.3s`, `✓ real: 252 results in 1879.5s`                                                                                                                                                                                                                                                                       |
| `pnpm bench run --tier synthetic`        | **~161 s**                                                                                       | same run, 2026-09-12                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm bench run --tier real`             | **~1,880 s** warm; **2,100–5,700 s** cold or contended                                           | same run, 2026-09-12; the wide end from this repo's own run logs of 2026-09-05 (3,970 s), 2026-09-07 (5,720 s) and 2026-09-08 (2,941 s)                                                                                                                                                                                                                                                     |
| `pnpm bench run --tier <t> --only <sym>` | **the row's own price**: 2.8 s on the cheapest real row, ~1,900 s on the most expensive — see §3 | `time pnpm bench run --tier real --only ReadUnalignedU32` → 2.8 s, 2026-09-12                                                                                                                                                                                                                                                                                                               |
| `pnpm bench baseline <sym>`              | **~2.6 s**, no bench at all                                                                      | `time pnpm bench baseline CountCollectedGems`, 2026-09-12                                                                                                                                                                                                                                                                                                                                   |
| `pnpm bench fan <row> --enumerate`       | **~115 candidates/s**                                                                            | 9,192 candidates in 80.2 s on `kleod:CountCollectedGems:agbcc`, 2026-09-12                                                                                                                                                                                                                                                                                                                  |
| `pnpm bench fan <row>` (scored)          | **60 ms/candidate** synthetic, **85 ms** real, candidate cache OFF                               | `SCORE_SECONDS_PER_CANDIDATE` in `apps/benchmark/src/run/fan.ts`, re-read at `8599234d` on 2026-09-12; its docstring carries the three cold runs behind the two constants. A WARM run is several times cheaper per candidate (the same artifact's `rankSeconds` medians are 40 ms synthetic / 35 ms real), so this over-prices the scored path — which is the right way round for a refusal |
| `pnpm bench gates --pass <pass>`         | **~29 s**                                                                                        | `time pnpm bench gates --pass unmerge` → 29.3 s over 309 rows, 2026-09-12                                                                                                                                                                                                                                                                                                                   |
| `npx vitest run` (root config)           | **~34 s** — 231 files, 4,212 tests (2 skipped); both counts grow as tests are added              | `npx vitest run` on this branch, 2026-09-12. The pre-remediation row said 230 / 4,199, which was neither state's count: the branch adding the sentence invalidated it in the same commit                                                                                                                                                                                                     |
| `pnpm test:matching`                     | **~67 s** — 42 files, 394 tests, 0 skipped                                                       | `/usr/bin/time -p pnpm test:matching`, 2026-09-12                                                                                                                                                                                                                                                                                                                                           |
| `scripts/check-artifact-provenance.sh`   | under a second                                                                                   | 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                  |
| a ranked run at LoadBGTilemapData scale  | **1,500–8,000 s**, and HARD-RULE forbidden — do not start one                                    | historical figure, NOT re-measured 2026-09-12; `bench fan --enumerate` prices merely LISTING that fan at ~33 min from the rate above                                                                                                                                                                                                                                                        |
| `pnpm bench fan <huge row>`, REFUSED     | **the whole enumeration** — ~33 min at LBG scale, and only then the refusal                      | `FAN_SCORE_LIMIT` is tested on `cands.length` at `apps/benchmark/src/run/fan.ts:914`, i.e. after the pre-count enumeration; read at `3a4fd60f` on 2026-09-12. The 2,000 guard bounds what gets COMPILED, never what gets enumerated, so it is not a cheap shield                                                                                                                              |

## 2. The real tier is growing, and nothing else is

Full runs of the real tier, minimum wall per day, over the window in which the tier has held the
**same 252 rows** (read out of this project's own run logs on 2026-09-12):

```
2026-08-26   433.7 s      2026-09-03  1430.9 s      2026-09-08  2941.2 s
2026-08-29   729.6 s      2026-09-05  1653.6 s      2026-09-11  1870.8 s
2026-08-31  1124.1 s      2026-09-06  1541.0 s      2026-09-12  1879.5 s
```

**4.3× in 17 days on an unchanged row count.** The synthetic tier over the same window went from
642 rows / 192.8 s to 810 rows / 161.3 s — 26% more rows for 16% _less_ wall. So the growth is the
real tier's candidate fan, and a cost figure for it older than about a week is fiction. Everything
else in §1 ages slowly.

This is also why the cheap questions in §3 matter more each month, not less.

## 3. Answer the cost question without running a bench

Since #192 the committed artifact records, per row, `candidateCount` and `rankSeconds`. Three
readers, none of which compiles anything:

- **`pnpm bench baseline <sym>`** prints the row as published _plus its price_:

  ```
  kleod:CountCollectedGems:agbcc  asmlift=match 0/344  m2c=noncompile -/-  fan=9192 rank=142.6s
  ```

  That `rank=` IS what `--only` on that row will cost you, up to target build and process start.
  Use it before you launch a scoped run, not after.

- **`pnpm bench fan <row> --base <ref>`** prints this tree's enumeration against the count that
  ref's artifact recorded — the fan multiplier, for an enumeration rather than a bench run.
- **`pnpm bench diff --base <ref>`** prints a FAN section and a COST section beside the verdict.
  Both are informational: neither moves an exit code.

Summed out of the committed artifact of 2026-09-12: the ranked pass alone is **2,668 s over 155
real rows** and **354 s over 673 synthetic rows**; wall clock is lower because eight shards run in
parallel. The single row `kleod:ProcessInputAndUpdateEntities:agbcc` is 1,840 s of that real
total — **69% of the tier in one row.**

## 4. How many full runs a round gets

**A full `pnpm bench run` runs ONCE at the zero-flip gate, plus ONCE MORE after the final rebase**
— the second is not a re-measurement you chose, it is the artifact being regenerated at the commit
that will be HEAD (`scripts/check-artifact-provenance.sh` verdicts 1 and 3).

Two roundings of that, both checkable rather than judged:

- **A round whose base did not move runs it once.** `git fetch origin && git log --oneline
HEAD..origin/main` empty ⇒ there is no rebase, so there is no second run.
- **A round that touches no measured path runs it ZERO times.** The measured paths are
  `MEASURED_PATHS` in `apps/benchmark/src/provenance.ts` (`packages/{core,cli,toolchains}/src`,
  `apps/benchmark/{src,dataset}`) — `docs/`, `.claude/`, `apps/benchmark/test`, `apps/web` and
  `scripts/` are all outside it. Such a branch publishes no numbers of its own, and the provenance
  check says so rather than failing:

  ```
  $ scripts/check-artifact-provenance.sh origin/main
  provenance: artifact stamp e99a8e9 is not an ancestor of HEAD, and the artifact
  is byte-identical to the base's — this branch publishes no numbers of its own. UNKNOWN, not checked.
  exit 0                                                        (measured 2026-09-12)
  ```

  Do not hand-copy that path list into a prompt or a shell one-liner — two copies drift, and in
  this repo's shell a pathspec built in a variable collapses to one path that matches nothing and
  prints the empty output a reader takes as "go ahead".

Everything else uses the scoped forms: the synthetic tier for a broad sanity check, `--only` for
the rows a change can reach. This is not a style note. One round ran the full bench **eleven
times**, four of them inside a single remediation agent, and spent about four and a half hours on
nine runs the scoped forms answer in minutes. The real tier is ~92% of the cost and is dominated by
asmlift's own enumeration, which is the thing under test and therefore uncacheable — so the saving
comes from not repeating it, never from making it faster.

If you believe a further full run is genuinely needed, run it and **say in your report why** — a
stated reason is fine, a silent extra half hour is not.

## 5. Start the long command, then keep working

A full bench and a ranked run are pure waiting. Launch one in the BACKGROUND at the start of a
phase whose other work does not depend on its answer, and read the log at the end.

**Wait on a condition that tells "finished" from "stopped moving".** The marker alone is not that:
a killed run writes no marker and a wedged one writes no marker either, so a bare `until grep -q`
waits forever on both. Poll for the marker AND for the log growing, under a stated upper bound:

```sh
LOG=/tmp/<round>-bench.log
( pnpm bench run > "$LOG" 2>&1; echo "EXIT=$?" >> "$LOG" ) &
… meanwhile: read the diff, grep the corpus, draft the report — READ-ONLY work only …

prev=0; still=0; waited=0
until grep -q 'EXIT=' "$LOG"; do
  sleep 60; waited=$((waited + 60))
  now=$(wc -c < "$LOG")
  if [ "$now" -eq "$prev" ]; then still=$((still + 60)); else still=0; prev=$now; fi
  # 2400 s of no growth is ~30% over the longest single row this corpus has (1,880 s) —
  # below that, a static log is normal, not a hang. Raise it, never lower it, as that row grows.
  [ "$still" -ge 2400 ] && { echo "NO GROWTH ${still}s — investigate, do NOT kill yet"; break; }
  [ "$waited" -ge 9000 ] && { echo "OVER BUDGET ${waited}s"; break; }
done
```

**A log that stopped growing is almost certainly `kleod:ProcessInputAndUpdateEntities:agbcc`** —
one row, ~1,840 s of ranked pass, alone on one shard while the other seven sit finished. That is
this corpus's normal long-pole signature, not a hang. **Never kill a bench you have not proven
hung.** A supervisor once killed a healthy gate run on exactly this signature and lost ~44 minutes.

**Never wait on `pgrep -f "<pattern>"` when the pattern also matches your own waiting shell** —
five waiter shells once deadlocked on each other for eight hours doing exactly that, long after
the jobs they watched had finished. `grep '[b]ench/src/cli\.ts'` does not match
`apps/benchmark/src/cli.ts` either: the process to look for is the `tsx …/apps/benchmark/src/cli.ts
run …` parent, and its shard children are `… run --serial --tier <t> --shard i/N`.

### What you may keep working ON

**Read-only work.** `provenance.ts` samples git DURING the run and the sample is STICKY, so ONE
edit — a comment audit, a `pnpm format`, an editor save, anywhere but the benchmark's own
regenerated artifacts — stamps the whole run dirty and `bench:merge` throws the numbers away
~34 minutes later. A round lost **2,420 s** to exactly that, auditing its comments beside its own
gate bench.

So a run in flight records itself in `/tmp/asmlift-bench-running-<uid>/<pid>.json`. **Run
`pnpm bench in-flight` before any phase that EDITS the tree, and read its exit code: 1 means a run
is measuring this worktree — wait for its `EXIT=` line — and 0 means the tree is yours.** (There is
no `--all`; it answers for this worktree only. A neighbour's bench cannot be dirtied by an edit
here, which is why.)

**The unit suites are NOT read-only beside a bench**, and two of them for different reasons:
`packages/cli/test/offline/provenance.test.ts` writes an untracked `__provenance-probe__/` into
`packages/` for the length of one test — it has to, it is asserting that the sampler can tell three
dirty states apart — and a bench that samples inside that window is stamped dirty for good; and
`apps/benchmark/test/preflight.test.ts` reads the LIVE lock register and fails while any bench
runs. Run the suites before the bench or after it, not beside it.

**If you edit anyway, the run says so within ~2 s** — `[provenance] THE TREE WENT DIRTY MID-RUN`,
on the run's own stderr, once, naming the paths. That line means the run is already lost: the
sample is sticky and reverting does not undo it. Stop it, revert or commit, start it again.

### Stopping one

**`kill -TERM` does not stop a `bench run`** — measured: one sent SIGTERM 6 s in ran all 291 cases
and REWROTE `results/synthetic.json` before exiting 143. A run is blocked in `spawnSync` for every
case, so no signal handler can run until it is done, and `lock.ts` has no handlers by design for
the same reason.

`kill -9` is the stop that works on the parent — **and it orphans the shards.** They are ordinary
`spawn`ed `tsx` children (`orchestrate.ts`), so killing the parent leaves up to eight of them
compiling at PPID 1. So:

1. `kill -9 <parent pid>`;
2. kill the shard children too — they carry `--shard i/N` in their command line;
3. **verify with `ps`**, and exclude your own grep pipeline from what you read.

The record the killed run strands names a dead pid, so it reads STALE — that blocks nothing, and
the next run sweeps it.

### Two full benches must never overlap on this machine

It has 10 cores, the run fans 8 shards, and a ranked run takes `--jobs 6`; a bench measured
**2,704 s against a neighbour versus ~1,880 s solo**. Worse than slow: a shard killed by a
neighbour writes a partial tier with **no error line**, and `grep -c SKIP` reads 0 either way — so
always read the `✓`/`✗` tier line.

**`bench run` enforces this.** The register is machine-wide, so a second FULL bench is refused
while one is running in ANY worktree, and a second run in THIS worktree is refused when it writes a
tier file the live one is writing. It REFUSES rather than queueing: wait on the register until no
record names a live pid. What is still allowed is the scoped dev loop — a `--tier synthetic --only
<sym>` probe beside a background `--tier real`, here or beside a neighbour's full bench — because a
3 s probe is not what fans 8 shards.

If you have a real reason to measure anyway, `--no-lock` says so out loud and leaves every other
record alone; **never `rm` a record you did not write**, which is the one move that silently
unprotects someone else's run.
