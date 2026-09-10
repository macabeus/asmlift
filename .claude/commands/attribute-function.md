---
description: Attribute a non-matching real-project row to missing asmlift capabilities and pin each untested one with a benchmark row
argument-hint: <FunctionName>
---

Target function: **$1**

If `$1` is empty, ask which function before doing anything else. Do not guess.

This is the counterpart of `/match-function`. That command *builds* a missing capability; this one
*names* them. Your job is: decompose the row's residual diff into distinct capability gaps, verify
each one against the project's real compiler, and leave behind a benchmark row for every gap that
no existing row exercises. You do **not** implement levers here — if a fix looks obvious, record
it as "the lever this row gates" and stop. A finding without a row (or a reason it cannot have
one) is an unfinished finding.

---

## Phase 0 — Resolve and baseline (never skip)

0. **Re-derive the baseline before you attribute against it**: `git fetch origin && pnpm bench
   baseline $1`. A number handed to you is a hint with a timestamp, and a gap sized against a stale
   one is sized against nothing. The rule, and the fresh-base worktree it must be measured in, is
   [`docs/baseline-freshness.md`](../../docs/baseline-freshness.md). `/match-function` opens with
   the same step, so correct the rule in that doc and not here.

1. Resolve the row: `pnpm bench run --tier real --only $1`. Record the outcome verbatim for both
   decompilers — **the whole `diff:N/M`, never the `N` alone** (see "the denominator moves" below).
2. Reproduce outside the harness with **the row's own generated script**: `pnpm bench repro $1
   --run`. It writes that script (`results.json` → `scripts.asmlift`) into the gitignored
   `.local/repro/<row>/` with this machine's paths filled in, runs it, and prints the `[ranked]`
   line. Two commands look like this one and are not: `pnpm bench target` is the script's step 1
   (no `[score]`, no input `.s`), and the project-checkout command at the top of
   [`docs/ranked-repro.md`](../../docs/ranked-repro.md) measures a decomp repo's function — a
   different input `.s` down a different compile path, and on `kleod:StrCpy:agbcc` a different
   score against a different denominator. **Read § "The VEHICLE is part of the number" and its
   four warnings before you quote anything**; the flags are per-vehicle and do not transfer. That
   file is shared with `/match-function`; correct it there, never here. **The `[ranked]` line is
   the number every later claim is measured against** — it carries `best …` and the source sha —
   and it goes into your report verbatim, **naming the vehicle**. Never a `[score] … | tail -1`:
   that table is sorted best-first, so the last line is the WORST candidate.
3. **Read the FAN before you name a missing capability**: `pnpm bench fan $1` prints every
   candidate spelling the harness ranked for this row — label, score over its own denominator,
   dropped, withheld — and `--show <label>` prints any one of their SOURCES, which `results.json`
   does not carry for a non-winner. An attribution that says "asmlift never considers X" is a claim
   about this list, so read it. Its `[ranked]` line carries the same `synthesized` count and
   `[asmlift source <sha>]` stamp as the vehicles above, so it is quotable in the same way.
   `--enumerate` lists the same candidates' LABELS without compiling anything — no scores, because
   nothing was compiled (~120 candidates/s, so a huge fan takes minutes to list: that is a big fan,
   not a hang). It still serves `--show <label>`, though not `--show best`: nothing has been
   scored, so there is no winner to name. A fan over 2,000 is
   refused unless you pass `--force`, and the refusal quotes what `--force` would cost on THIS row.
   Unlike the two vehicles above, this one runs in the harness's own configuration by construction
   — it is the same call `bench run` makes for the row.
   **A declined row usually has no fan at all** — and that is a finding, not a broken command:
   enumeration throws on the very gap the row declines on (`enumerateCandidates` has no annotate
   mode), so you get `asmlift: [fan] no fan for <row>: <the gap>` followed by "the gap named above
   is the one this row DECLINES on", and exit 2 — which names your missing capability directly.
   That sentence is chosen by the ERROR, so it is the same with or without `--force`. On a
   `noncompile` row the `[dropped]`/`[withheld]` lines are printed in full and they are the row's
   entire fan. Anything else that throws is reported as a HARNESS defect, with its stack — read
   that as the tool being broken, never as this row's outcome.
4. State the baseline in your first user-facing message.

## The denominator moves — so a residual is never a "partition"

`maxScore` is not a property of the target function. It is the objdiff row count of the **winning
candidate's** alignment, so a different candidate is scored against a different scale. Across two
committed artifacts (`eb6dec7d` → `2fed1e42`) fourteen of 1013 rows moved their denominator (twelve
on the asmlift side), and `kleod:CountCollectedGems:agbcc` moved 290/404 → **171/387** — 17 points
of scale inside a 119-point "improvement". Read as a subtraction on a fixed 404, that row's
residual was decomposed into six gaps said to **PARTITION the 290**; the gaps then predicted 297
points and delivered 119, and an extra attribution round was spent explaining a shortfall that was
partly the scale.

Rules, and they are not optional:

- **Never write "partition", "accounts for all of", "the N decomposes into", or any other
  exhaustive-decomposition word about a residual** unless you have shown the denominator is fixed
  across every measurement you are comparing. Write "these gaps cover X of the N *measured at
  maxScore M*" and give M.
- **A delta is a pair of fractions, not a difference.** Quote `before N₁/M₁ → after N₂/M₂` in the
  report, the PR body and the row comment. If M moved, say so in the same sentence and say by how
  much; if you do not know M, you do not have the delta.
- **The tools tell you.** `pnpm bench run` prints `diff:<score>/<maxScore>` per row, and
  `pnpm bench diff` prints `asmlift.score: 290/404 → 171/387` plus a separate
  `asmlift.maxScore: 404 → 387` line **whenever** the denominator moves — alone or beside a moving
  score. Every denominator move between `eb6dec7d` and `2fed1e42` printed both lines, so a
  `maxScore` line is never evidence that the score held still. You do not have to open
  `results.json` to see this.
- **Gap arithmetic is a prediction until measured.** Sum-of-parts vs. whole is a claim about a
  moving scale; state it as a prediction with the ablation that falsifies it.

## Phase 1 — Capture what was actually compiled

The CLI's stdout render is NOT the compile unit that was scored: the scoring world synthesizes its
own declarations, and (for example) a symbol the ELF carries no shape for is downgraded to a raw
address — which is codegen-visible. Compare compiled asm to compiled asm, never C to asm.

- Temp compile dirs (`asmlift-usercc-*`) are deleted. To capture them, copy `decomp.yaml` to an
  UNTRACKED file, append `cp "$PRE_FILE" / cp "$ASM_FILE"` capture lines to its compiler template,
  and rerun with `--config` pointing at the copy. Delete the copy afterwards.
- Every candidate axis gets compiled, so the capture dir holds many variants. Find the winner by
  its axis markers (param signedness, named vs raw globals) or by normalized-body similarity —
  exact string match against stdout will fail for the reason above.

## Phase 2 — Attribute the diff structurally

A raw text diff of the two `.s` files is useless: register allocation renames everything, so
near-identical code diffs as ~100% different. Instead:

- Normalize both streams (strip labels/directives, fold `lsls→lsl`-style alias splits, `#0x01→
  #0x1`, implicit `, #0x0]` offsets, pool refs → `=pool`, branch targets → `L`), then align at
  SHAPE level (all registers → `R`). Diff regions of the shape alignment are where instruction
  *structure* differs; equal shape regions with different registers are pure allocation drift.
- **Tally the literal pools on both sides** (`.word` / `.4byte`, counted per distinct value). A
  pool-shape divergence — baked-offset literals vs one plain base reused at `[rN, #imm]` — is
  often the dominant class and is invisible in an instruction-count comparison.
- **The scorer's `breakdown` is not a census.** It counts objdiff's per-row `diffKind`, and
  `arg-mismatch` means only "same opcode, some operand differs" — a register, a stack slot, a pool
  word, a pc-relative offset, an immediate or a branch target, indistinguishably. The repo's own
  scorer fixtures render `add r0, #1` against `add r0, #2` as `arg-mismatch` with the SAME register.
  So `argMismatch / score` is not the register-allocation share: on LoadBGTilemapData at 395 it is
  66.1%, while the rows whose ONLY difference is a register are 163 — 41.3%. The other 98 move a
  stack-slot offset, a pc-relative pool offset, a branch target, a bare immediate or the operand
  shape, and 2 of them are the frame size. Say which convention a count uses: "rows involving a
  register" is 217 of the same 261, because a row is free to change two things at once. A round
  published the first number as the second one. Decompose the rows, then name the class.
- Classify every diff region into a named pattern. Expect a MIX: some regions will be this row's
  capability gaps, some will belong to other, known machinery (dispatch shape of a recovered
  `switch`, signedness of locals, operand order). Separate them explicitly — a finding attributed
  to the wrong machinery produces a row that gates nothing.

## Phase 3 — Verify every hypothesis against the compiler itself

Never conclude a cause from the diff alone. For each candidate pattern, write a minimal C **pair**
— the spelling the original source plausibly used, and the spelling asmlift emits — and compile
both with the project's real compiler and flags. The hypothesis is confirmed only when the
original-style spelling reproduces the ROM's pattern AND the asmlift-style spelling reproduces the
divergence. One associativity difference in how a constant folds can be the entire cause; only the
compiler can tell you that.

- Read the compiler's source for the mechanism when it is available in the checkout (register
  classes, cost macros, constraint alternatives, CSE behavior). Cite file:line in your notes.
- Some project toolchains carry agent instrumentation (stderr-only dump flags for register
  lifetimes / pool literals). Check the project Makefile before instrumenting anything yourself.

## Phase 4 — Round-trip each minimized shape through asmlift

For each confirmed pattern, probe what asmlift does TODAY: compile the minimal source with the
**benchmark's** toolchain (`apps/benchmark/dataset/toolchains/<id>/decomp.yaml`, env vars per
`packages/toolchains/src/toolchain.ts`), then run the CLI on the produced `.s` with
`--score-against` the produced `.o`. A ~20-line probe script is enough. The outcome sorts the
pattern:

- **MATCH** → the capability exists; the shape is a CONTROL. Then find where it stops: add the
  aggravation from the real function (a read-back, a second block, a fixed-index access) until
  the score moves. The minimal failing shape is the row; the passing one may be its control.
- **diff:N/M** → a gap row. Attribute the N by diffing the probe's candidate asm the Phase-2 way —
  a small N can still be a distinct capability (operand order) or can be noise. Quote `M` too:
  two probes' Ns are comparable only when their Ms agree.
- **declined** → name the FIRST blocker from the decline message. If it is a pre-existing link
  (branch-likely on MIPS is the usual one), the row still measures something on that toolchain —
  but say which link, and never credit the decline to this family.

## Phase 5 — Check existing coverage before authoring

For each gap: grep `apps/benchmark/dataset/synthetic.ts` and the feature vocabulary for a row or
tag that already exercises the shape. A capability can also be effectively untested even when a
guard for it exists in core — the measure is whether any ROW changes when the capability changes,
not whether a unit test exists. Findings that belong to a different machinery (Phase 2's
exclusions) get written down for their own future family, not smuggled into this one.

## Phase 6 — Author the rows

This phase writes files, and the mid-run provenance sampler counts every path but the benchmark's
own regenerated artifacts — so **run `pnpm bench in-flight` first**: exit 1 means a bench is
measuring this worktree and one save stamps its whole run dirty, stickily. Wait for that run's
`EXIT=` line.

One family, one block comment, modeled on the existing families in `dataset/synthetic.ts` (the
uninit-local block is the reference): what each row isolates, which are controls, and an
attribution line for every decline naming its first blocker. Constraints learned the hard way:

- **Extern data globals are fine, and respelling them to absolute addresses destroys the row.**
  A candidate synthesizes its declarations from the target asm's own relocations (the CLI says
  `[declared] N declaration(s) synthesized from the target asm`), so a named global compiles. The
  earlier rule here said the opposite; obeying it collapses the very distinctions such a family
  exists to pin — at an absolute address the bare, cast and array-typed spellings become one
  object and a baked addend constant-folds away, so every row scores 0 and pins nothing.
- The reference source in `src` is the definition of the target. Keep it verbatim from your
  Phase-3/4 probes so the row measures exactly what you measured. Never tune it toward either
  decompiler.
- **Every row the comment names must exist, and every claim about one you did not run is a
  prediction.** Paste into your report the `grep -n "sym: '<name>'"` that proves each cited row is
  real before resting an attribution on it, and mark a claim about a row you did not measure as a
  prediction with the command that would falsify it. A family comment once rested its whole
  attribution on a contrasting row nobody had written, and asserted a second row's score would
  move without flipping — it flipped to MATCH the next round.
- `features`: judgement tags only (source/codegen tags are derived). A new tag needs a
  `FeatureDef` in `packages/bench-schema/src/features.ts` and at least one row carrying it;
  a floor is optional and several tags deliberately have none.
- `ctx` with **named** parameters (m2c uses the names and the types), `proto` for `returnsVoid`
  and callee arities. Check that m2c noncompiles are m2c's genuine behavior, not context you
  withheld — both tools must get the same information.
- `toolchains`: default `ALL`; the same shape is usually coverage or a control elsewhere. But
  **smoke every row × toolchain individually first** (`pnpm bench run --tier synthetic --only
  <sym> --toolchain <id> --serial`) before any full run. If an mwcc row hangs: `docker stats`,
  kill the compile inside the pool container (no `pkill` there — walk `/proc/*/cmdline`), and
  pin the row off that toolchain with the reason in the comment. A candidate compile has no
  timeout, so one compiler-hostile candidate stalls every future full run.

## Phase 7 — Gates and commits

1. Source commit first (dataset + tag). Then `pnpm bench run` (all tiers) → `pnpm bench:merge` →
   `pnpm bench regression --base origin/main`. **Regression without a preceding run+merge compares
   stale results and is vacuous** — the order is the gate; and without `--base`, a branch that has
   already committed its own artifact compares it against itself, which is vacuous the other way.
   The commit-first order is ENFORCED: `pnpm bench run` refuses to start on a tree whose code
   differs from HEAD, naming the files, because `bench:merge` refuses those numbers anyway ~39
   minutes later — and twice that refusal was a single untracked env file. Put anything a worktree
   needs locally (env exports, PATH overrides) in **`.envrc.local`**, gitignored for exactly this —
   nothing loads it, so `source .envrc.local` yourself — and anything else under **`.local/`**,
   gitignored too. `$(git rev-parse --git-path info/exclude)` is the last resort, for a path you
   cannot move: from a worktree it is the MAIN checkout's file, shared with every other worktree
   and never pruned, so add ONE line and `grep` for it first. Never reach for a way around the
   refusal. Exempt is a run that rewrites no tier file WHOLE — the Phase-6 smoke runs carry
   `--only`, which scopes both tiers. `--project` alone scopes only real and `--toolchain` alone
   only synthetic, so pair either with its `--tier` or the other tier is run whole and refused. A
   scoped run is not read-only either: it rewrites `results/<tier>.json` with only its own rows.
   The `cpp` probe is on a DIFFERENT axis and this exemption does NOT cover it: **every run that
   touches the real tier is probed, `--only` included** — that is where TRAP 6 bites. A refusal
   there means your shell resolved `cpp` to Apple clang, which a LOGIN shell does; a WARNING means
   no MIPS toolchain is installed, so those rows would SKIP. A synthetic-only run is never probed —
   no synthetic row preprocesses. **So a real-tier `noncompile` you see in Phase 6 is a real
   attribution signal, not your shell: the preflight has already ruled that out.**
2. Expect the two tag-vocabulary tests to fail BETWEEN adding the tag and merging the artifacts;
   they must pass after. `npx vitest run`, `pnpm test:matching`, `pnpm typecheck`,
   `pnpm lint`, `pnpm format` check. **`pnpm format` is `prettier --write .`, a tree WRITE**, and
   step 1 above is a bench you were told to background: `pnpm bench in-flight` first, exit 1 means
   wait.
3. Artifacts (`apps/benchmark/results/results.json`, both web copies) regenerated at the source
   commit's HEAD (`meta.asmlift.dirty` must be false) and committed separately — **after** your
   final rebase, as the last commit. A rebase rewrites the commit the artifact's stamp names, and
   it can slide a base commit that changes the decompiler underneath numbers measured without one.
   `scripts/check-artifact-provenance.sh` fails both; run it before opening the PR.
4. Zero-flip over the previously committed rows blocks the branch, same as `/match-function`.
   `pnpm bench diff --base origin/main` is that check by row and field, and its output is the
   report's list of what moved. It exits **2**, "nothing was compared", if `results.json` still
   carries the base's `generatedAt` — the artifact is committed, so a gate run before `run`+`merge`
   compares the base with itself and prints a green line in a second.

## Phase 8 — Write it down and report

- Research doc in `research/` (untracked — never cite its path in commits, PR bodies, or the
  dataset): the compiler facts with file:line, the experiment pairs, the per-row outcome matrix,
  the levers each row gates in expected-impact order, and every finding you EXCLUDED with the
  machinery it actually belongs to.
- Correct any stale attribution the investigation falsified (memory files, earlier research docs).
  An attribution that has silently gone stale sends the next session down the wrong lever.
- Report: baseline, the named gap classes with their verified causes, the row matrix, and what
  a future `/match-function` should build first. Push the branch and open the PR.
- Then `scripts/pr-wait.sh <pr>` — it polls the PR's real state under a deadline and exits with the ANSWER (0 merged · 1 a check failed · 2 still pending, nothing decided · 3 green and ready to merge). Never ask a human whether CI is green or whether the PR merged; that question was asked six times in one session and the script answers all six.

## Cost discipline — measured, and a rule rather than a preference

Read off this project's own logs, not estimated:

| command | cost |
| --- | --- |
| `pnpm bench run` (all tiers) | **~1800 s** — synthetic 182 s + real 1618 s |
| `pnpm bench run --tier synthetic` | **~182 s** |
| `pnpm bench run --tier <t> --only <sym>` | 5–15 s |
| a ranked run at LoadBGTilemapData scale | 1500–8000 s |
| `npx vitest run` (root config) | ~120 s |

**A full `pnpm bench run` runs EXACTLY TWICE in a round: once at the zero-flip gate, and once at
ship after the final rebase.** Everything else uses the scoped forms — the synthetic tier for a
broad sanity check, `--only` for the rows a change can reach. This is not a style note. One round
ran it **eleven times**, four of them inside a single remediation agent, and spent about four and a
half hours on nine runs that the scoped forms answer in three minutes. The real tier is ~90% of the
cost and is dominated by asmlift's own enumeration, which is the thing under test and therefore
uncacheable — so the saving comes from not repeating it, never from making it faster.

If you believe a third full run is genuinely needed, run it and **say in your report why** — a
stated reason is fine, a silent extra half hour is not.

### Start the long command, then keep working

A full bench and a ranked run are pure waiting. Launch one in the BACKGROUND at the start of a
phase whose other work does not depend on its answer, and read the log at the end:

```sh
( pnpm bench run > /tmp/<round>-bench.log 2>&1; echo "EXIT=$?" >> /tmp/<round>-bench.log ) &
… meanwhile: read the diff, grep the corpus, run the unit tests, draft the report …
until grep -q 'EXIT=' /tmp/<round>-bench.log; do sleep 30; done
```

**What you keep working ON is constrained, and it is checkable.** `provenance.ts` samples git
DURING the run and the sample is STICKY, so ONE edit — a comment audit, a `pnpm format`, an editor
save, anywhere but the benchmark's own regenerated artifacts — stamps the whole run dirty and
`bench:merge` throws the numbers away 39 minutes later. A round lost **2,420 s** to exactly that,
auditing its comments beside its own gate bench. So a run in flight records itself, in
`/tmp/asmlift-bench-running-<uid>/<pid>.json`. **Run `pnpm bench in-flight` before any phase that
EDITS the tree, and read its exit code: 1 means a run is measuring this worktree — wait for its
`EXIT=` line — and 0 means the tree is yours.** The work this background pattern is for is
read-only: reading the diff, grepping the corpus, drafting the report. **The unit suites are NOT**
— `packages/cli/test/offline/provenance.test.ts` writes an untracked `__provenance-probe__/` into
`packages/` for the length of one test (it has to: it is asserting that the sampler can tell three
dirty states apart), and a bench that samples inside that window is stamped dirty for good. Measured
on this branch's own gate run. Run the suites before the bench or after it, not beside it. A
run that was killed leaves its record behind and it reads STALE — that blocks nothing, and the next
run sweeps it.

**If you edit anyway, the run says so within ~2 s** — `[provenance] THE TREE WENT DIRTY MID-RUN`,
on the run's own stderr, once, naming the paths. That line means the run is already lost: the
sample is sticky and reverting does not undo it. Stop it, revert or commit, start it again.

**`kill -TERM` does not stop a `bench run`** — measured: one sent SIGTERM 6 s in ran all 291 cases
and REWROTE `results/synthetic.json` before exiting 143. A run is blocked in `spawnSync` for every
case, so no signal handler can run until it is done. `kill -9` is the stop that works, and the
record it strands is stale.

**Wait on a log marker, never on `pgrep -f "<pattern>"`** when the pattern also matches your own
waiting shell — five waiter shells once deadlocked on each other for eight hours doing exactly
that, long after the jobs they watched had finished.

**Two full benches must never overlap on this machine.** It has 10 cores, the run fans 8 shards,
and a ranked run takes `--jobs 6`; a bench measured **2704 s against a neighbour versus 1800 s
solo**. Worse than slow: a shard killed by a neighbour writes a partial tier with **no error line**,
and `grep -c SKIP` reads 0 either way — so always read the `✓`/`✗` tier line. **`bench run`
enforces this**: the register is machine-wide, so a second FULL bench is refused while one is
running in ANY worktree, and a second run in THIS worktree is refused when it writes a tier file
the live one is writing. What is still allowed is the scoped dev loop — a `--tier synthetic --only
<sym>` probe beside a background `--tier real`, here or beside a neighbour's full bench — because a
15 s probe is not what fans 8 shards. If you have a real reason to measure anyway, `--no-lock` says
so out loud and leaves every other record alone; **never `rm` a record you did not write**, which
is the one move that silently unprotects someone else's run.

---

## Hard rules

1. **Numbers come from commands.** Never state a score, a pool count, or a compiler behavior you
   did not just observe in tool output.
2. **Every compiler claim is verified by compiling — and every claim about asmlift's own code by
   running asmlift.** The diff suggests; only the compiler confirms. The same asymmetry bites on
   this side: name the site that declines by instrumenting it (print which `return null` fires) or
   by ablating it and watching the row move, never by reading the source and inferring. A guard
   you did not watch fire is a hypothesis, and one printed as a mechanism aims the next round at
   the wrong guard — a round once attributed a decline to a refusal that fires zero times on the
   whole corpus. **When you had to patch a refusal to print why it fired, say so in the PR body
   (not only in `research/`, whose path nothing may cite) and name the pass.** That instrument
   episode is one of the two things that license converting those refusals to a `Gate` table later
   (`grep -n "THE UNIT OF THAT DECISION" docs/level-tower.md`); a refusal you come to suspect never
   fires at all is the other. Before you instrument, check whether you have to, in this order:
   **`pnpm bench gates --pass unmerge` prints the per-id refusal census of a tabled pass** — every
   rule, how many times it refused first, over the agbcc synthetic tier in ~10 s, with no edit to
   core and nothing to revert. `--toolchain id` picks another synthetic tier; `--only` reaches both
   tiers but matches a SUBSTRING of the row id and pools every match, so name the full
   `tier:sym:toolchain` id when you want one row. Its numbers reproduce `l3/unmerge.ts`'s
   instrumented 40/16 split with no patch, which is what a census is FOR. **Do not write your own
   script for this** — the three hazards measured in
   `grep -n "WHY A SUBCOMMAND AND NOT A DOCUMENTED SCRIPT" apps/benchmark/src/run/gate-census.ts`
   are why it is a subcommand, and one of them stamps your next `bench run` DIRTY after 2,000 s. A
   pass NOT in that registry is not censusable this way and the command says so: the seam its caller
   needs is what a second entry costs. A count is FIRST REJECTIONS and not reach — of the six
   ablatable rules in `l3/unmerge.ts` exactly one moves a row, three refuse and are overruled, and
   two never fire — so read the MOVED column beside it
   (`grep -n "TWO COLUMNS, AND THEY DISAGREE HERE" packages/core/src/l3/unmerge.ts`) before you
   build anything on a big number. Failing that, if the pass exports a census
   (`arrayShapeRefusals` in `raise/globalshape.ts`) or returns a `refusals` map
   (`l3/coalesce.ts`, `l3/scopebase.ts`, `structure/namecoalesce.ts`), a test reads the id straight
   out. Only a table that is neither injectable nor reported still costs a patch —
   26 of the 32 `firstRejection` call sites compare the id to `null` and drop it. All three report
   the FIRST rejecter, so a rule missing from the census is starved or refused-earlier, not proven
   dead.
   If the first blocker is one a round has already reasoned about beside the gate, cite that
   instead of re-deriving it.
3. **Never edit the benchmark to make a row look better** — the reference source defines the
   target; manifests and results are never tuned. Harness defects (a hang, a missing timeout)
   are fixed or documented as their own labelled change.
4. **Rows, not fixes.** Implementation belongs to `/match-function`, gated by the rows this
   command leaves behind. If you cannot resist sketching the fix, put it in the research doc's
   lever list.
5. **Attribute declines to their first blocker** and pre-existing links to their own families.
   A family whose rows all decline on an unrelated link has measured that link, not itself —
   say so in the block comment.
