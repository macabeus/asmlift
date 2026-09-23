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
run). Corpus: 1,062 rows — 810 synthetic + 252 real. The three `pnpm bench run` rows were re-measured on
**2026-09-23** at `3888734f`, on a corpus of 1,257 rows — 879 synthetic + 378 real. That corpus is
bigger than the one the rest of the table prices, and its real tier is compiled differently: the
stillborn stop hands a compiler far fewer candidates than the 2026-09-19 artifact's 60,011.
So the new wall is not a speed-up of the old figure, and the two must not be read as a ratio.

| command                                  | cost                                                                                                                 | what produced it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm bench run` (all tiers)             | **~262 s ≈ 4.5 min**, over 1,257 rows                                                                                | the two tier lines of the 2026-09-23 run at `3888734f`: `✓ synthetic: 879 results in 189.4s`, `✓ real: 378 results in 182.2s`, 0 SKIPs, `time` wall 4:22.07. Docker up, candidate cache WARM (`hit 620` on the last synthetic shard alone) — and warmth, not load, is what this figure is sensitive to: the 2026-09-21 ship run at `a13dbe60` walled 708 s part-cold over 1,201 rows, and a neighbour's whole-tier run beside a scoped probe came in FASTER than its own uncontended time. Budget the larger number when the cache is cold                                                                                                                                                                                                                   |
| `pnpm bench run --tier synthetic`        | **~189 s** over 879 rows                                                                                             | same run, 2026-09-23; 382 s part-cold at `a13dbe60` on 2026-09-21 over 823 rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm bench run --tier real`             | **~182 s** over 378 rows, with the stillborn stop                                                                    | same run, 2026-09-23; 326 s part-cold at `a13dbe60` on 2026-09-21. Every figure here before the stillborn stop priced a tier that compiled every candidate of every fan — 2,170 s on 2026-09-13 over 252 rows, and 2,941–5,720 s cold or contended in this repo's run logs of 2026-09-05/07/08. That is a different amount of work, not a slower machine                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm bench run --tier <t> --only <sym>` | **the row’s own price**: 3.1 s on the cheapest real row, 161 s on the dearest — see §3                               | `time pnpm bench run --tier real --only sub_0804B254` → 3.1 s, 2026-09-21. The dearest is `kleod:PauseMenuScreenHandler:agbcc`, 161.0 s of `rankSeconds` in the same day’s artifact. The symbol this cell used to name, `ReadUnalignedU32`, is no longer a row of the real tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm bench baseline <sym>`              | **~2.6 s**, no bench at all                                                                                          | `time pnpm bench baseline CountCollectedGems`, 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm bench fan <row> --enumerate`       | **~115 candidates/s**                                                                                                | 9,192 candidates in 80.2 s on `kleod:CountCollectedGems:agbcc`, 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm bench fan <row>` (scored)          | **60 ms/candidate** synthetic, **85 ms** real, candidate cache OFF                                                   | `SCORE_SECONDS_PER_CANDIDATE` in `apps/benchmark/src/run/fan.ts`, re-read at `8599234d` on 2026-09-12; its docstring carries the three cold runs behind the two constants. A WARM run is several times cheaper per candidate (the same artifact's `rankSeconds` medians are 40 ms synthetic / 35 ms real), so this over-prices the scored path — which is the right way round for a refusal                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm bench sweep`                       | **~60 s** warm over all 1,062 rows, both map modes — nothing is compiled; **~177 s** with every target built         | `time pnpm bench sweep` → 59.0 s / 61.8 s / 62.8 s across three runs on two worktrees, 2,124 records, 2026-09-12 (the last of them after the input-digest fields, which cost ~2 s); `ASMLIFT_BENCH_CACHE=0` → 176.9 s, same day. A standalone probe of the same build+lift loop prices it at 28.8 s — that probe is not this command, and this row is the command                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm bench sweep --repeat 2`            | **~124 s** — the determinism gate is two whole-corpus sweeps, the second in reverse order                            | `time pnpm bench sweep --repeat 2` → 2 min 4 s, 0 disagreements over 2,124 records, 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm bench sweep --fan`                 | **~437 s** over the same rows — enumeration is ~120x the lift, which is why it is a flag                             | `time pnpm bench sweep --fan` → 436.8 s, 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm bench sweep --base <ref>`          | **~232 s** whole-corpus lift-only, both sides — and it does NOT get cheaper on the second sweep against the same ref | `time pnpm bench sweep --base 910fd416` → 3 min 52 s (this tree 59.4 s, base tree 170.1 s), 2026-09-12. Re-measured 2026-09-12 on wave 2: `--base HEAD` against a base tree provisioned and swept hours earlier → 234.1 s (base side **173.3 s**), and `--base 5c440d38` including `git worktree add` + `pnpm install` → 231.7 s (base side 169.0 s). This row used to attribute that to "its first target builds are cold"; that is REFUTED — the same base tree sweeping ITSELF is 58.3 s, and on the real tier the base side is 40.0 s against a head side of 35.2 s with not one cache file written. Where the other ~115 s goes on the synthetic tier is not understood; scope the sweep (`--tier real --base-dir` is 75.7 s) rather than budget for it |
| `pnpm bench gates --pass <pass>`         | **~29 s**                                                                                                            | `time pnpm bench gates --pass unmerge` → 29.3 s over 309 rows, 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npx vitest run` (root config)           | **~34 s** — 232 files, 4,266 tests, 0 skipped; both counts grow as tests are added                                   | `npx vitest run` on `tooling/bench-sweep`, 2026-09-12, in a shell that had sourced `/tmp/wt-env.sh`: 33.96 s (re-measured after wave 2 added 12 tests; it read 232 / 4,254 at 36.35 s the commit before). The row before that said 232 / 4,242 at 39 s (this branch's own earlier commit), before that 231 / 4,223 at 33 s and 230 / 4,199 — each branch that adds a test invalidates the row in the same commit, which is why the row is re-measured rather than inherited. Without that `source`, two `candcache-namespace.test.ts` tests SKIP (`skipIf(!HAVE_AGBCC)`), so a run reporting skips means your shell lacks the toolchains, not that the suite shrank                                                                                          |
| `pnpm test:matching`                     | **~67 s** — 42 files, 394 tests, 0 skipped                                                                           | `/usr/bin/time -p pnpm test:matching`, 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scripts/check-artifact-provenance.sh`   | under a second                                                                                                       | 2026-09-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| a ranked run at LoadBGTilemapData scale  | **1,500–8,000 s**, and HARD-RULE forbidden — do not start one                                                        | historical figure, NOT re-measured 2026-09-12; `bench fan --enumerate` prices merely LISTING that fan at ~33 min from the rate above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm bench fan <huge row>`, REFUSED     | **the whole enumeration** — ~33 min at LBG scale, and only then the refusal                                          | `FAN_SCORE_LIMIT` is tested on `cands.length` after the pre-count enumeration (`grep -n "cands.length > FAN_SCORE_LIMIT" apps/benchmark/src/run/fan.ts`); read at `3a4fd60f` on 2026-09-12. The 2,000 guard bounds what gets COMPILED, never what gets enumerated, so it is not a cheap shield                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 2. The real tier is growing, and nothing else is

Full runs of the real tier, minimum wall per day, over the window in which the tier has held the
**same 252 rows** (read out of this project's own run logs on 2026-09-12):

```
2026-08-26   433.7 s      2026-09-03  1430.9 s      2026-09-08  2941.2 s
2026-08-29   729.6 s      2026-09-05  1653.6 s      2026-09-11  1870.8 s
2026-08-31  1124.1 s      2026-09-06  1541.0 s      2026-09-12  1879.5 s
```

**The 42 Animal Crossing rows add about 40 s to a COLD real tier, and about 10 s to a warm one.**
Measured 2026-09-16 at this branch's dataset commit: `pnpm bench run --tier real --project ac-decomp`
→ `✓ real: 42 results in 39.6s` on a machine at load ~13 with nothing built, and `9.5s` on the same
42 rows once their targets are built. The full run the tier is priced by in §2 is the cold figure.
The run before the cold one walled 21.2 s, and the difference is not noise: m2c then failed on 28 of
the rows over a context line, before reading any of their assembly. 34 of the 42 rows DECLINE, and a
declined row enumerates no candidates: its price is one target build plus one asmlift and one m2c
run, ~1-3 s. So a PowerPC row is cheap exactly while asmlift cannot lift it, and this figure will
grow with the capabilities that close those declines, not with the row count.

The window ends at 2026-09-13. That day's stage-1 gate run of the kleod swap walled the real tier
at **1898.1 s** on the same 252 rows. The same day, after the swap, the tier took **2169.1 s** on
252 rows, 42 of them from another decompilation. That second figure is a different corpus, not a
point on this curve.

**4.3× in 17 days on an unchanged row count.** The synthetic tier over the same window went from
642 rows / 192.8 s to 810 rows / 161.3 s — 26% more rows for 16% _less_ wall. So the growth is the
real tier's candidate fan, and a cost figure for it older than about a week is fiction. Everything
else in §1 ages slowly.

This is also why the cheap questions in §3 matter more each month, not less.

## 3. Answer the cost question without running a bench

Since #192 the committed artifact records, per row, `fanSize` and `rankSeconds`. Three
readers, none of which compiles anything:

- **`pnpm bench baseline <sym>`** prints the row as published _plus its price_:

  ```
  kleod:WorldMapScreenCheckNewWorldUnlocked:agbcc  asmlift=nonmatch 106/361  m2c=noncompile -/-  fan=3600 rank=113.0s
  ```

  That `rank=` IS what `--only` on that row will cost you, up to target build and process start.
  Use it before you launch a scoped run, not after. A `noncompile` row may carry
  `fanNotCompiled` — its fan was declared stillborn (core `stillborn.ts`) and only the default and
  one probe per variation were compiled — and prints as `fan=30240 (35 compiled)`: `fanSize` is
  the enumerated count, `fanSize − fanNotCompiled` the compiled one, and the enumeration is the
  only part of `rank=` that scales with the first number.

- **`pnpm bench fan <row> --base <ref>`** prints this tree's enumeration against the count that
  ref's artifact recorded — the fan multiplier, for an enumeration rather than a bench run.
- **`pnpm bench diff --base <ref>`** prints a FAN section and a COST section beside the verdict.
  Both are informational: neither moves an exit code.
- **`pnpm bench sweep --base <ref>`** answers the OTHER cheap question — not "what does this row
  cost" but "which rows does my branch decompile differently from that revision". It re-lifts every
  row in both trees, map-ful and map-less, and compiles nothing.

  **Read the mode you asked for.** Measured 2026-09-12 over the same commit pair (`910fd416` →
  `bd7ad596`, four PRs apart, one of them a real transform): the default lift-only sweep reported
  **0 rows moved** and two head-only records (the row #191 added), while `--fan --tier synthetic`
  on the same pair reported **28 records moved over 14 rows**, fans 1.3x–2.7x. Most of this
  project's variations ADD CANDIDATES, and a new candidate is invisible to the default lift. Lift-only
  answers "did I regress the default spelling"; `--fan` answers "did I change what gets ranked",
  which is the question a match round is asked before it merges a variation.

  `--repeat N` asks the same question of this tree against ITSELF, alternating iteration direction:
  2,124 records x 3 runs, 0 disagreements, 2026-09-12. Five rounds rebuilt that check by hand.

  **Two things it refuses rather than answers, both because a gate is written `bench sweep --base
main && echo clean`.** An empty selection — a typo'd `--only`/`--project`/`--asm-dir` — exits 2
  instead of reporting 0 moved. And a row it could not lift HERE (its toolchain unavailable in this
  shell, or its target unbuildable) exits 2 naming the count: with `ASMLIFT_AGBCC` unset, the
  command used to report 618 of 1,620 synthetic records as "identical" and exit 0. On a wired
  machine the whole corpus sweeps with **0 of 2,124** records unmeasured, so the refusal costs a
  correct setup nothing; `--allow-unmeasured` is for a machine that genuinely lacks a toolchain.

  **How far back `--base` reaches: `85f81116` (2026-09-09).** The driver loads nine harness modules
  out of the tree under test, and the newest of them by creation date is
  `apps/benchmark/src/asm-scrub.ts`. An older base is refused by name before the head sweep is paid
  for (**0.5 s** against `2bb1cde6`, once the floor check was moved ahead of the base tree's
  `pnpm install` — it was 2.8 s behind it); what the check cannot see is a module that still exists
  with a changed signature, which is why each record also carries a digest of the OPTIONS it was
  lifted with. That digest was itself blind to every `Map` until wave 2 — so the two options
  carrying the real tier's vendored input (`symbols`, `asmData`) digested the same whatever was in
  them. Renaming all 1,784 symbols in the vendored `kleod` map and no line of `packages/` now moves
  `opts` on **42 of 42** harness records (17 of them with the emitted C unchanged); before the fix
  25 of them read `src`/`len` ALONE, which is a dataset edit reported as a decompiler change.

  **`--fan` refuses when the committed artifact prices none of the rows it selected.** The size
  guard reads `fanSize` off `results.json`, so an artifact that parses and prices nothing —
  `results: []` from a shard that wrote no rows, a schema move under `asmlift.fanSize`, or a
  whole-corpus artifact with no row of the project you selected — bounds nothing, and used to turn
  the guard off with no output at all (still enumerating the 77,760-candidate row at 25 s, against
  0.9 s to refuse). A row the artifact genuinely does not carry (one your branch adds) is refused
  for the same reason; `--force` enumerates anyway.

Summed out of the committed artifact of **2026-09-23**, this branch's: the ranked pass alone is
**1,068 s over 186 real rows** and **1,167 s over 743 synthetic rows**; wall clock was 355.6 s and
451.3 s, and **546.3 s end to end** because the tiers overlap — 355.6 + 451.3 is 806.9, which is
not the wall time and never was. The dearest single row is **142 s** on
`kleod:PauseMenuScreenHandler:agbcc`, **13% of the tier** on its own — which is the figure to
reach for when a scoped run looks cheap.

THE TWO TIERS MOVED IN OPPOSITE DIRECTIONS against the entry below (real 1,371 → 1,068 s,
synthetic 915 → 1,167 s), which is what a shared machine looks like rather than anything a branch
did: `bench diff --base 87b49c74` reports the fan **unmoved at 67,415 (1.00×)** over 928
comparable rows, and one asmlift outcome changed in the whole corpus. Read each sum against its
own wall-clock line.

ONE COST ENTRY IN THAT DIFF IS NOT A COST AT ALL, and it is worth knowing before somebody reads it
as a regression. `pokeemerald:DoForcedMovement:agbcc` went 131.0 s → 5.5 s (0.04×) and its
`droppedCandidates.length` went 1 → 0, which `bench diff` prints as a field change. The dropped
entry at `87b49c74` carries the error `'arm-none-eabi-cpp' timed out`. A TIMEOUT is machine load,
so that field is nondeterministic on a busy box in both directions — a clean tree can publish a
dropped sibling it did not cause, and a later tree can publish its disappearance as if it had
fixed something.

The ranked sums here are roughly 1.6× the entry above them on a corpus one row larger. That is
MACHINE LOAD, not a change in what the pass does: this run was taken while nothing else competed
for the box, but after a night of eight whole-tier runs, and the per-row rank seconds the artifact
records are wall seconds. Read a sum here against its own wall-clock line, never against another
entry's.

THE CORPUS GREW AND THE RANKED PASS DID NOT. 1,218 → 1,257 rows, and the ranked sum went
**1,457.0 s → 1,353.4 s (0.93×) over the 908 comparable rows**, because that comparison is a
measurement of the machine and the candidate cache, not of the branch: the 39 net new rows ranked
in **3.5 s** between them. The fan is the reading that means something and it is **67,343 → 67,345
(1.00×)**, two records moved — `llshl:agbcc` and `llshr:agbcc`, each 1 → 2, a 64-bit return
spelling that now has a signedness twin. `bench diff --base origin/main` reports **37 field
changes, 40 added, 1 removed** (exit 1) and `bench regression --base origin/main` **2 lost, 1
missing, 0 retired, 40 added, 3 gained, 0 other flips** (exit 1). Every one of those five is
argued: the 2 lost are `llshl`/`llshr` on mwcc, which matched by re-emitting `bl __shl2i` and now
decline; the 1 missing is `ll2i:agbcc`, a cell deleted because `bx lr` scores every answer alike;
the 3 gained are `llshl`/`llshr` on agbcc and the real row `sa3:sa2__sub_80855C0:agbcc`.

The artifact before this one, taken 2026-09-23 at `87b49c74`, read **1,371 s over 186 real rows**
and **915 s over 742 synthetic rows**; wall clock was 332.3 s and 337.5 s, 417.4 s end to end.

The artifact before THAT, taken 2026-09-23 at `3c427cc2`, read **850 s over 185 real
rows** and **608 s over 726 synthetic rows**; wall clock was 194.1 s and 231.6 s, 304.1 s end to
end. THAT TREE WAS BENCHED FIVE TIMES, and the five readings are the cheapest evidence in this file
that the seconds are not the measurement: **1,281 s + 630 s** (491.6 s wall, cold),
**813 s + 477 s** (262.3 s wall, warm), **929 s + 563 s** (318.9 s wall), **1,009 s + 533 s**
(299.8 s wall) and **850 s + 608 s** (304.1 s wall) on a tree whose only change since the fourth is
TWO COMMENT LINES — same corpus, same 1,218 rows, same outcomes bar its own row, and the real sum
spans 1.58× across the five while the synthetic sum spans 1.27× IN THE OPPOSITE DIRECTION between
the last two. That is what a shared machine looks like from inside one tier.

The one before THAT, taken 2026-09-22, read **813 s over 185 real rows** and **477 s over
726 synthetic rows**; wall clock was 174.9 s and 195.6 s, and 262.3 s end to end. THAT TREE WAS BENCHED TWICE AND
THE FIRST RUN IS WHY. It walled
304.5 s and 351.3 s, 491.6 s end to end, and summed 1,281 s and 630 s — the same outcomes, the same
fan, and a 1.58× swing in the real sum, the second run reading the store the first had warmed. It was re-run for a
different reason: the first run's artifact carried two `droppedCandidates` on
`kleod:WorldMapScreenIsValidPath:agbcc` whose error was `Could not read file magic`, objdiff failing
to read an object rather than anything a decompiler emitted. A scoped re-run of that row alone
(61.2 s) gave the same 100/207, the same 1,260-candidate fan and no dropped entry, and the second
whole run carries none on any row — the eleven rows that do carry one all carry a compiler
REJECTING a candidate, which is a decompiler output and not an IO failure. Transient bad magic under
eight parallel shards is worth knowing about before a round spends an afternoon attributing one.
Its `bench diff` against `origin/main` was the same 8 field changes on the same single row as the
entry above; its cost list was entirely faster, six rows over 10 s and 1.5× between 0.32× and
0.61×, outcome, score and fan unmoved on each.

The artifact before THAT one — `origin/main`'s, taken 2026-09-22, which the two entries above are
both measured against — read **1,281 s over 184
real rows** and **630 s over 726 synthetic rows**; wall clock is lower because eight shards run in
parallel — that run walled 264.8 s and 259.0 s, 523.8 s for both tiers together. It is the SECOND
whole run of this tree: the first, taken before the rebase onto `d0a83bb1`, walled 326.0 s and
summed 1,032 s and 758 s. Same tree's outcomes, a 1.24x swing in the real sum and a 0.83x swing in
the synthetic one — another entry for the standing point that the seconds are not the measurement.
`origin/main`'s artifact reads 1,531 s and 669 s over 1,215 rows: `bench diff` against it reports
**378 field changes, 2 added, 0 removed**, 0 lost and 0 gained on an existing row, the fan
**unmoved at 67,306 (1.00×) over 908 comparable rows** with two more rows priced here, and the
ranked pass at **0.81×**. THE FIELD COUNT IS LARGE AND SAYS ALMOST NOTHING, which is the reason
this entry is worth reading: 370 of the 378 are `asmlift.source`, and 368 of those are one
declarator restyle — `u16 * v0;` becomes `u16 *v0;`, because a declaration is a C declarator and
the `*` binds to the name. Normalise the `*`'s placement and those 368 sources are byte-identical
to the base's; the return-type position, which has no declarator, keeps its prefix spelling. The
other eight fields are two rows: seven on `kleod:sub_0804C898:agbcc`, which leaves `declined` for
`nonmatch 15/41`, and one decline TEXT on `sa3:sa2__sub_80078D4:agbcc`, where a catch-all refusal
is split into the two gaps that reached it. THE COST LIST IS ENTIRELY FASTER — twelve rows over
10 s and 1.5×, every one of them between 0.47× and 0.59× — with outcome, score and fan unmoved on
each, and no row in the corpus carries a `timed out` dropped candidate. The base's artifact was
taken with three sibling rounds live and this one after they finished. Read the fan, not the
seconds.
The artifact before this one read **1,531 s over 183 real rows** and **669 s over 725 synthetic
rows**, walling 285.5 s and 288.9 s. THAT TREE WAS BENCHED THREE TIMES, and the spread is the
cheapest reminder this file can offer that the SECONDS are not the measurement. Two of the runs are six minutes apart: one
walled **572.8 s** against a coldish store with two neighbour rounds sweeping, the next **318.1 s**
against the store the first had warmed. The third walled **574.4 s** with three sibling
rounds live — and its ranked-pass sum reads **1,531 s** where the middle run read 875 s on the same
tree, a 1.75x swing with every outcome, score and fan identical. Read the fan, not the seconds; and
do not budget a multiple for a busy machine without measuring one, because 574.4 s over 1,215 rows
is still under §1's ~708 s solo nominal over 1,201.
Its own base read 1,113 s and 699 s over 1,203 rows: `bench diff` across that pair reports
**16 field changes over 2 rows, 12 added, 0 removed**, 0 lost and 0 gained, and the fan **unmoved
at 66,934 (1.00×) over 902 comparable rows** with six more rows priced here — a branch that reads a
narrow load covering the low-order end of a wider access at the same base as a CAST of that access
rather than a second field at one offset. The two rows that leave `declined` are the whole of the
move (`pokeemerald:AnimTask_FlashHealthboxOnLevelUp_Step` 66/117 and `marioparty3:FileSeek` 37/62,
the big-endian inhabitant of the rule) and the fan does not move at all, because the fold adds no
candidate: it removes a refusal. The one fan that does move SHRINKS
(`kleod:WorldMapScreenUnlockNewWorld:agbcc`, 432 → 384) — folding two widths into one field leaves
the spellings that exist to choose between them with nothing to apply to, the same mechanism the
walked-address entry below records in both directions.
The artifact before this one read 893 s and 510 s over one fewer synthetic row: `bench diff` across
the pair reports **8 field changes over 1 row, 0 added, 0 removed**, 0 lost and **1 gained**, the fan
unmoved at **66,932 → 66,932 (1.00×) over 901 comparable rows** with one more row priced here, and
the ranked pass at **1.29×** — a branch that emits a call the rendered `&&`/`||` would skip at the
position the asm ran it, and declines the function where the operand it would skip reads an object
the map declares volatile. Read the fan and not the seconds, and here the seconds say so themselves:
this tree was benched twice against the same base, the two runs differing by one comment, and the
ranked pass came out **1.04×** and then **1.29×**. The rule adds no candidate to any row and the one
row it moves had no fan at all before it (`-` → 2); the dearer run's COST list is two
`snowboardkids2:…:gcc2.7.2kmc` rows at 1.67× and 1.51× whose outcome, score and 96- and
100-candidate fans are all unmoved and whose `droppedCandidates` is 0, and the cheaper run's list is
empty.
The artifact before THAT read 835 s and 530 s over 1,202 rows: `bench diff` across the pair
reports **32 field changes over 8 rows, 1 added, 0 removed**, 0 lost and **1 gained**, the fan at
**59,847 → 66,928 (1.12×) over 900 comparable rows**, and the ranked pass at **1.03×** — a branch
that names a walked-to address the symbol map knows and adds a value-home variation for a narrowed
value every consumer reads elsewhere. That fan move is a RESULT, not the machine, and it is the
only entry in this list where a fan moves in BOTH directions at once: six rows pay a second
candidate for the new variation (1.70×–2.75×), and one SHRINKS because naming the walk leaves the
variations that exist to spell one with nothing to apply to (`sub_0804E708`, 8 → 7). The eighth is
the same mechanism inverted — where the naming pass REFUSES it leaves arithmetic those variations
can apply to again, and `ButtonConfigurationScreenInit` goes 440 → 446.
The artifact before THAT read 772 s and 984 s over 1,201 rows: `bench diff` across the pair
reports **16 field changes over 2 rows, 1 added, 0 removed**, 0 lost and 0 gained matches, the fan
unmoved at **59,783 → 59,783 (1.00×) over 898 comparable rows**, and the ranked pass at **0.78×** —
a branch that folds a loop update into the bottom test that reads it early, which buys two rows a
price neither end paid before (they DECLINED at the base) and adds no candidate to a row that
already ranked. The two tiers move opposite ways under an unmoved fan, which is the whole of that
0.78×: the synthetic tier halves against a warm store, nine rows falling from 48.5 s, 41.5 s and
33.7 s to under 2.2 s each, while the real tier RISES 772 → 835 s on a few seconds spread across its
heaviest rows.
The artifact before THAT read 1,188 s and 940 s over 1,200 rows, the same day and the same
machine: `bench diff` across the pair reports **14 field changes over 3 rows, 1 added, 0 removed**,
0 lost and **2 gained** — `preupdate_exit` declined → match and `preupdate_exit_pure` nonmatch → match,
which is why asmlift reads 658. Thirteen of the fourteen changes are those two rows. The fourteenth
is `pokeemerald:AcroBikeHandleInputTurning:agbcc`, whose `droppedCandidates` falls 1 → 0: the older
artifact recorded an `'arm-none-eabi-cpp' timed out` on one of its 28 candidates and this run did
not hit it, which is also the whole of that row's 123.4 s → 1.0 s. A transient compile failure is
the one thing in this table that a re-run erases, so read a single row's seconds beside its
`droppedCandidates` before believing it. The fan is unmoved at 59,775 → 59,775: lifting a refusal
buys rows without adding a candidate to any row that already ranked.
The artifact before THAT read 1,026 s and 1,223 s over 1,198 rows: `bench diff` across the pair
reports **87 field changes over 87 rows, 2 added, 0 removed**, 0 lost and 0 gained matches among
them, and every one of the 87 is diagnostics text — 76 `m2c.errorMarkers` and 8
`asmlift.errorMarkers` reordered errors-first, and 3 `droppedCandidates` counts on rows whose fan is
now declared stillborn. The two added rows are `leafand` and `memscope`, both MATCH, which is why
asmlift reads 656. The enumerated fan falls 60,011 → 59,271, and the COMPILED candidates fall
60,011 → 20,715: 38,556 of them belong to fans the stop never hands to a compiler, which is why the
real tier's WALL moved far more than its `rankSeconds` sum did.
The artifact before this one read 914 s and 1,311 s over the SAME 1,198 rows: `bench diff` across
the pair reports **7 field changes over 2 rows, 0 added, 0 removed**, 0 lost and 0 gained matches,
the fan unmoved at 60,011 → 60,011 (1.00×) over 895 comparable rows, and the ranked pass at
**1.01×** — a branch that gives every candidate a fresh scratch directory and stops summarising a
compile failure to its first line. The seven fields are `compileErrors`/`errorMarkers` on six of
the eight noncompile rows, which now carry the compiler's actual diagnosis instead of the first
warning or a bare `#   Error:` caret. **A figure here is a price under a CACHE STATE and a
MACHINE, not a property of the corpus**, and this reading is its sharpest illustration yet: the two
tiers were measured in DIFFERENT cache states. The synthetic tier ran against a candidate store
purged to nothing, so every candidate recompiled — hence 1,311 s against the previous 649 s, a 2.0×
on a branch that changes no candidate. The real tier then re-ran with that store warm and came in
BELOW the previous reading. Read the fan beside it: unmoved.
The artifact before this one read 944 s and 649 s over the SAME 1,198 rows: `bench diff` across the
pair reports **0 field changes, 0 added, 0 removed**, the fan unmoved at 60,011 → 60,011 (1.00×)
over 895 comparable rows, and the ranked pass at **1.40×** — a regeneration for a branch that
deletes a `decomp.yaml` key no benchmark path reads.
The artifact before THAT read 957 s and 666 s over the SAME 1,198 rows: `bench diff` across the
pair reports **0 field changes, 0 added, 0 removed**, the fan unmoved at 60,011 → 60,011 (1.00×)
over 895 comparable rows, and the ranked pass at **0.98×** — a regeneration at the branch's final
head, over a commit that changed only comment lines. The one before THAT read 951 s and 646 s over the SAME 1,198 rows: `bench diff` across the
pair reports **0 field changes, 0 added, 0 removed**, the fan unmoved at 60,011 → 60,011 (1.00×)
over 895 comparable rows, and the ranked pass at **1.02×** — a regeneration at the branch's final
head, over a commit that reads a function's start address off the objdump header instead of off its
first parsed line and moves no row. That pair is a second clean reading of how much of a figure here
is the machine. The one before THAT read 1,349 s and 675 s over the SAME 1,198 rows: `bench diff` across
the pair reports **14 field changes over 4 rows, 0 added, 0 removed**, one row moved (declined to
nonmatch), and the fan **unmoved at 60,001 → 60,001 (1.00×) over 894 comparable rows** — a branch
that makes the objdump reader account for every word the listing printed adds no candidate to any
row; the one row it recovers is 3.3 s of fan nobody was paying before. Its ranked pass reads
**0.79×** on the same machine an hour later, which is the store being warm and nothing else — the
two readings share 894 rows and 13 of their 14 field changes are decline TEXT. The one before THAT
read 958 s and 597 s over the SAME 1,198 rows: `bench diff` across the
pair reports **417 field changes over 85 rows, 0 added, 0 removed**, twelve gained matches, and the
fan **unmoved at 58,880 → 58,880 (1.00×) over 853 comparable rows** — 41 rows are priced here that
were priced at neither end before, because they DECLINED there: a branch that models the MIPS
branch-likely delay slot buys its rows by lifting what used to refuse, and adds no candidate to a
row that already ranked. Its ranked pass reads **1.12×**, and the whole of that is the 281.3 s those
41 newly-ranked rows cost. The one before THAT read 972 s and 560 s over the SAME 1,198 rows:
`bench diff` across that pair reports **8 field changes over 3 rows, 0 added, 0 removed**, one
gained match, and the fan at **54,750 → 58,880 (1.08×)** — a branch that shares a slot across switch
arms and copies a pointer parameter for one region, so that fan move is a RESULT rather than the
machine. Its ranked pass read **1.01×**, and the same tree benched twice minutes apart read 0.96×
first: two runs, one tree, one base, and the price moved 5%. The one before THAT read 911 s and
463 s over the SAME 1,198 rows: `bench diff` across the
pair reports **77 field changes over 24 rows, 0 added, 0 removed**, three gained matches, the fan at
54,757 → 54,750 over 853 comparable rows, and the ranked pass at **1.12×** — a branch that narrows a
MIPS parameter where the object says it was declared narrow, on a machine running nothing else.
The one before THAT read 1,139 s and 553 s over the SAME 1,198 rows: `bench diff` across that pair
reports **0 field changes, 0 added, 0 removed**, the fan unmoved at 54,757 → 54,757, and the
ranked pass at 0.81× — one tree benched twice, a commit apart that changed only comment lines. That
pair is the cleanest reading in this list of how much of a figure here is the machine. The one
before THAT read 901 s and 499 s over three fewer synthetic rows: `bench diff`
across the pair reports 402 field changes over 201 rows — a `return;` each, and the `lines` that
follows it — the fan moved on **2 rows, 54,735 → 54,751 over the 850 comparable rows**, and the ranked pass
at **1.20×**. That fan move is the one entry in this whole list that is NOT the machine, and it has a
cause: `synthetic:{memcpy1,memset1}:mwcc_242_81` go 16 → 24 because an emitted source that has lost
its trailing `return;` makes the `initfirst` variation applicable. A fan number here is otherwise a
price, not a result. The one before THAT read 813 s and 419 s over one more real row — that branch refuses a row
that used to rank: the fan **unmoved, 54,735 → 54,735 over the 850 comparable rows**, with the ranked
pass at 1.14×, the corpus and the eight shards identical. Its own predecessor read 772 s and 808 s
over the same 679 synthetic rows and three fewer real ones, 0.78× with the fan unmoved at
54,731 → 54,731 over 846 comparable rows. The one before THAT — taken the SAME day as it — read
1,028 s and 1,001 s, 0.78× again, with the fan unmoved and only the rows carrying one decline's text
moved. The one before THAT read 955 s and 857 s on the
same 846 rows with **0 rows moved at all**, 1.12× the other way, differing in nothing but the m2c pin
and the load; the one before THAT read 4,449 s over the real tier, 0.21× again — a re-derivation of
two projects' flags, and a store the day's benches had filled against one that was cold. Earlier
artifacts of the same corpus read 818 s and 417 s off a warm store, 941 s and 889 s off a cold one,
1,120 s and 1,067 s off one just pruned, and 1,742 s and 1,677 s while several rounds shared the
machine. Read a figure beside the cache state AND the load of the run you are planning, not on its
own.

The single row `kleod:PauseMenuScreenHandler:agbcc` is 120 s of that real total — **14% of the
tier in one row**, over a fan of 30,240 of which 35 are compiled. It is also the row that will strand a shard: in an earlier
round's first full run it was still ranking 14 minutes after the other fifteen shards had finished.

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
  # 3200 s of no growth is ~30% over this corpus's long-pole ROW — the 2,454 s below, not the
  # 2,169 s the whole real tier walls at. Below that, a static log is normal, not a hang.
  # Raise it, never lower it, as that row grows.
  [ "$still" -ge 3200 ] && { echo "NO GROWTH ${still}s — investigate, do NOT kill yet"; break; }
  [ "$waited" -ge 9000 ] && { echo "OVER BUDGET ${waited}s"; break; }
done
```

**A log that stopped growing is almost certainly `kleod:PauseMenuScreenHandler:agbcc`** — one row,
~2,454 s of ranked pass, alone on one shard while the other seven sit finished. That 2,454 s is a
figure from a run slower than any §3 now lists, and it is the number the threshold above is set
from; the spelling count it was taken over has since moved, so read the row's size from §3 (30,240
in the artifact of 2026-09-19, 27,360 in the one before it), never from here.
Before 2026-09-13 the row at that address was `kleod:ProcessInputAndUpdateEntities:agbcc`: 77,760
spellings and ~1,840 s. The swap cut the fan by nearly two thirds, and the ranked pass still grew. That is
this corpus's normal long-pole shape, not a hang. **Never kill a bench you have not proven
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

**`kill -TERM` does not stop a `bench run`** — measured 2026-09-10: one sent SIGTERM 6 s in ran all 291 cases
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
