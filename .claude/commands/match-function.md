---
description: Match a benchmark function by building the missing asmlift capability, then adversarially verify it
argument-hint: <FunctionName>
---

Target function: **$1**

If `$1` is empty, ask which function before doing anything else. Do not guess.

Your job is **not** "make this one row match". It is: find the *general capability* asmlift is
missing, build it soundly, and let this row fall out as evidence. A change that only works because
you looked at this function's diff is a failure, even if the row flips to MATCH.

**Read this file from YOUR OWN worktree, by absolute path.** A relative path resolves into whatever
checkout your shell started in, which is usually tens of commits behind — 16 of 21 reads of this
file across rounds #183–#188 returned a stale copy, and those agents followed a specification that
named none of the tooling built for them. §0 of
[`docs/measurement-discipline.md`](../../docs/measurement-discipline.md) is the rule and the fix.

Three things this command does not restate, because they are shared with `/attribute-function` and
a rule spelled twice is a rule with two chances to be lost:

- [`docs/measurement-discipline.md`](../../docs/measurement-discipline.md) — the laws every number
  here is measured against. **Read it before Phase 0.**
- [`docs/bench-cost.md`](../../docs/bench-cost.md) — what each command costs, how many full benches
  a round gets, and how to wait on one.
- [`docs/ranked-repro.md`](../../docs/ranked-repro.md) — the vehicles that produce a ranked number.

---

## Phase 0 — Resolve and baseline (never skip)

0. **Re-derive the baseline before you believe it**: `git fetch origin && pnpm bench baseline $1`.
   Any row number you were handed is a hint with a timestamp. The rule, what to do when it answers
   `NOT CURRENT`, and the fresh base it must be measured on are
   [`docs/baseline-freshness.md`](../../docs/baseline-freshness.md). `/attribute-function` opens
   with the same step, so correct the rule in that doc and not here.

   **This step usually ENDS the baseline question.** It costs seconds and runs no bench at all
   (`docs/bench-cost.md` §1 prices it), prints EVERY
   row whose symbol matches (so it disambiguates for you), and since #192 prints each row's price
   as `fan=N rank=Ns`. Record what it prints verbatim: the asmlift outcome, m2c's, and the whole
   `N/M` — never the `N` alone (`docs/measurement-discipline.md` §5).

1. **Run the row only when step 0 did not answer**, which is the four cases
   [`docs/baseline-freshness.md`](../../docs/baseline-freshness.md) §3 owns — correct that list
   there, not here:
   - step 0 said **`NOT CURRENT`** — commits that decide a measurement landed after the artifact, so
     re-measure with `pnpm bench run --tier real --only $1` and name the commits you measured
     across;
   - step 0 **exited 1** (no row for that symbol) — the target is measured outside the harness, so
     the ranked repro is your vehicle, not `bench run`;
   - **your own branch or worktree touches a scoring path** — `baseline` reads only
     `<artifact commit>..origin/main`, never your `HEAD`, index or working tree, so `CURRENT` is a
     statement about main and not about you. From this command's first capability commit onward you
     are in this case. **Do not eyeball this and do not run a bare `git status`** — the doc gives a
     two-line command whose pathspec is derived from `SCORING_PATHS`, and an unfiltered status makes
     a stray untracked `.bin` order you a re-measure;
   - you are about to claim a MOVE, in which case the before/after pair must come from the same
     command.

   On a tree that touches no scoring path, a `CURRENT` verdict is the fact. Do not follow that with
   a re-derivation "to be sure": four agents in one chain did exactly that and paid 450–471 s each
   for a number the artifact already held.
   (`--only` is a substring match on the symbol; row ids are `project:sym:toolchain`. Say which row
   you picked.)
2. State the baseline in your first user-facing message, and say which brief was stale and by how
   much. Never report progress without a before/after pair of real command output.
3. Read the asm and the current asmlift output side by side. Get the target `.o` and a working dir
   with `pnpm bench target <row-id> --out <dir>` so you can iterate without the full harness — but
   that is step 1 of the row's generated script, not the reproduction: no `[score]`, no input `.s`,
   and ONE frozen context rung where the harness escalates per candidate, so a candidate your
   change emits that names a project type can noncompile here and still be scored by the harness.
   Reproduce with the row's own script (`pnpm bench repro <sym|id> --run`) and confirm a moved row
   with `pnpm bench run --tier real --only <sym>`; see "The VEHICLE is part of the number" in
   [`docs/ranked-repro.md`](../../docs/ranked-repro.md).
4. **Write every repro command down verbatim, flags included** — the `--only` line above, and any
   ranked enumeration you run outside the harness. Every later measurement (each reviewer's, each
   remediation's, the PR body's) re-runs *that* command, not one recomposed from memory. For the
   ranked enumeration that means **whichever vehicle in
   [`docs/ranked-repro.md`](../../docs/ranked-repro.md) you ran, verbatim, named by vehicle** —
   that file documents two, they give different numbers on the same function, and their flags do
   not transfer (never "fix" the generated script by adding the checkout command's). Only the row's
   generated script is comparable with a harness outcome: `pnpm bench repro <sym|id> --run`. The
   **`[ranked]` line** is the comparison recipe for both — it carries `best …` and the
   `[asmlift source <sha>]` stamp. Never `grep '[score]' | tail -1`: that table is sorted
   best-first, so the last line is the WORST candidate, and on `kleod:GetEntityLookupData:agbcc` it
   reports `15/18` against a published `4/14`. That file is shared with `/attribute-function` — the
   last time this command was described in two prompts they drifted and a round published a number
   comparable to nothing, so correct it there and never here.

## Phase 1 — Diagnose the gap honestly

Classify the gap before writing any code. The four outcomes are not equally likely and three of
them are not "add a feature":

- **Missing capability** — asmlift cannot *represent* or *recover* something (an idiom, a type, a
  control-flow shape). This is the case the rest of this prompt is written for.
- **Missing lever** — asmlift can represent it, but never chooses that spelling. A lever is a
  candidate-generation change, and levers regress other rows far more often than they help; it
  needs a gate (see Hard Rules).
- **Unmatchable source quirk** — the original C used a construct no honest recovery would produce
  (register-allocation intermediates, a hand-written temporary, an unusual build flag, a redundant
  expression the compiler then eliminates). Say so, prove it, and stop — do not invent machinery to
  imitate a quirk. The bar for "prove it" and the rows that have cleared it are
  [`docs/unmatchable-quirks.md`](../../docs/unmatchable-quirks.md): two compiler sweeps, not an
  argument about plausibility, because the verdict closes a row to every later round. An entry there
  is falsified by one honest spelling reaching the target bytes — so read the row's entry and try to
  break it rather than citing it.
- **Harness / fidelity problem** — the row is built with a toolchain or flags the real project did
  not use (the `old_agbcc` class of bug). Then the fix is in the manifest/toolchain, not the
  decompiler, and it may *remove* the row rather than match it.

**"Missing capability" vs "missing lever" is decided by the FAN, and the harness computes it for
you.** `pnpm bench fan <sym|row-id>` prints every spelling asmlift considered for that row — each
one's label, its score against its own denominator, the ones the scorer dropped, the ones withheld
— in the harness's own configuration (the row's target object, prototypes, context compile and
symbol map), so it is comparable with the published row rather than with a checkout. The flags:

- `--show <label>` prints that candidate's SOURCE. Nothing else can: `results.json` carries the
  winner's C and no other's, so "the near-miss spelling is right and only loses on X" is a claim
  you can now read instead of infer. `--show best` is the winner (on the SCORED path only — under
  `--enumerate` nothing has been scored, so `--enumerate --show best` is refused rather than
  answered with whatever came out of the enumerator first). A DROPPED candidate's source — usually
  the one worth reading — is reachable only as `--enumerate --show <label>`, and the command says
  so when you ask for it the other way.
- `--enumerate` lists the fan without compiling anything and still serves `--show <label>`. Use it
  to answer "did my new lever produce a candidate at all" — a label that is absent was never
  enumerated, and a lever that THREW prints as `[lever] … threw (no candidate from it)`, which a
  `bench run` does not print anywhere. It is cheap against compiling, not cheap absolutely — the
  rate and what the biggest fans therefore cost to merely LIST are in `docs/bench-cost.md` §1, and
  that rate is the figure §2 shows moving fastest of all. A long enumeration is a big fan, not a
  hang.
- `--base <ref>` prints one line — this tree's enumeration against the count that ref's artifact
  recorded for the same row: `[fan-diff] <row>: 5952 → 11904 (2.00×) vs origin/main`. **That is the
  multiplier a round is asked to report before it merges an axis**, and it costs an enumeration
  rather than a bench run. It prints at every exit, including the over-limit refusal and a declined
  row — where the recorded count IS the answer. An unreadable or empty ref is refused at exit 2
  before the enumeration, not diagnosed after it.
- `--asm <file.s> --toolchain <id>` prices a function that is not a dataset row — the one a dogfood
  round is about to attempt. ENUMERATION ONLY, and not the harness's configuration (no prototypes,
  no asmData, no symbol map), which the command says every time. `--force` beside either
  enumeration-only path is refused rather than ignored, and `--toolchain` without `--asm` is
  refused rather than eaten.

A fan over 2,000 candidates is refused rather than scored (`--force` overrides): that is a compile
each, and the refusal quotes the row's own price at its own TIER'S measured per-candidate rate,
which is higher on a real row than a synthetic one because a real candidate escalates through up to
three preludes where a synthetic one is a single small prelude. Both rates are rows of
`docs/bench-cost.md` §1. **Ask `pnpm bench baseline <sym>` for the fan before you type `--force`**:
it prints `fan=N rank=Ns` off the artifact in seconds, and those fans move fast —
`kleod:CountCollectedGems:agbcc` was 5,952 when this paragraph was written and had grown to 9,192
by 2026-09-12. `LoadBGTilemapData`'s 225,792 is HARD-RULE forbidden to score and expensive even to
`--enumerate`; **never start the scored run** (`docs/bench-cost.md` §1 prices both). **And the 2,000
guard is not a cheap shield**: it is tested on `cands.length` AFTER the enumeration (`fan.ts:914`,
read 2026-09-12), so a bare `pnpm bench fan` on a row that size pays the whole enumeration and only
then refuses.

**A declined or noncompile row has NO fan, and the command says so** (`asmlift: [fan] no fan …`,
exit 2) rather than crashing: enumeration throws on the same gap the row declines on, and on a
noncompile row every candidate was refused — there the `[dropped]`/`[withheld]` lines printed above
the message ARE the fan, and they are the row's whole diagnostic. Which of the two you are looking
at is decided by the ERROR CLASS, not by the flags, so `--force` does not change the answer; a
throw that is neither is named a HARNESS defect and printed with its stack, and must never be read
as this row's outcome.

Write the classification down with the evidence that decided it. If it is one of the last two, go
straight to Phase 7 and report — that is a successful outcome of this command, not a failure.

## Phase 2 — Break it down

Split the capability into the smallest sequence of changes where **each one is independently
defensible and independently testable**. For each, write one line: what it does, where it lives in
the tower (`docs/level-tower.md`), what test proves it, and what it is expected to do to the diff
number. Show the user this list before implementing.

If a step's only justification is "the next step needs it", that is fine — say so explicitly. If a
step's only justification is "$1 needs it", split differently.

## Phase 3 — Implement, one atomic commit per capability

Branch first: `git checkout -b match/<function-name>`. Never commit to `main`.

Per commit:

- Place the change where the architecture says it goes. `docs/level-tower.md` is binding — in
  particular **"earn the level"**: do not add a representation, opcode, or pass boundary that has no
  inhabitant. Prefer patterns-as-data over new imperative special cases. Respect the `L1 → L2 → L3`
  stage contracts (`packages/core/src/contracts.ts`) and keep `@asmlift/core` browser-pure.
- If the step converts a pass's refusals to a `Gate` table — or you are tempted to, because you just
  patched a `return null` to log why it fired — read the passage
  `grep -n "THE UNIT OF THAT DECISION" docs/level-tower.md` finds, FIRST. It is settled: table the
  refusals you had to instrument — or one you suspect never fires, which is the other admission —
  leave the rest, name the residue in the table's doc comment. Tabling ALL of a small pass's refusals
  is that, not a sweep. And table it REPORTED: a `Gate` table whose id is compared to `null` and
  dropped has shortened the instrument loop, not removed it. The cheapest way to close that is to
  take the tables as an OPTIONAL PARAMETER, which costs one interface and lets a later round census
  them from outside core with `tallying()`
  (`grep -n "export function tallying" packages/core/src/l3/gates.ts`) — `l3/unmerge.ts` is the
  worked example, and `pnpm bench gates --pass unmerge` is what reading it back looks like. The
  parameter is NECESSARY AND NOT SUFFICIENT: the census also needs a caller-side seam a process
  outside core can reach — a mutable record holding the call, not a static import (whose bindings
  are read-only). Five of the sixteen passes that take a table have one: `/unmerge` in
  `PRE_FAN_PRODUCTS`, and every tabled pass in `PRE_RECOVERY_PASSES` (which is how `--pass
  arm-reread` reaches the branch short-circuit fold) — not every pass in `raise/`. Making a pass
  censusable is therefore a claim about its CALLER, not about its table —
  `grep -n "WHAT PUTS A PASS IN THE REGISTRY" apps/benchmark/src/run/gate-census.ts`.
  A refusal that is a CONJUNCTION WITH BUY-BACKS cannot become a table at any price, and that
  decline is written down rather than re-derived
  (`grep -n "NOT CONVERTIBLE" packages/core/src/raise/const.ts`). Otherwise return a `refusals` map
  (`structure/namecoalesce.ts`) or export a census off the table (`arrayShapeRefusals` in
  `raise/globalshape.ts`) in the same change. What is settled is the UNIT: convert refusals, not
  files — do not re-open whether a file should adopt `Gate<Ctx>` wholesale.
- Add unit tests in `packages/core/test/` next to the sibling capability's tests. A capability with
  no test that fails before the change is not done.
- Gate: `npx vitest run` (NOT `pnpm test:offline` — see Phase 4's fourth bullet: `test:offline`
  runs three directories and CI runs five) + `pnpm typecheck` + `pnpm lint`, and re-run
  `pnpm bench run --tier real --only $1` plus the rows you predicted are affected. Report the diff
  number movement.
- Commit only when green. Message says what capability was added and what it moved, e.g.
  `feat(raise): recover X from Y idiom (Foo 41→18)`.
- If a step moves the number the wrong way, keep it only if it is a prerequisite, and say so in the
  commit body.

## Phase 4 — Full-bench zero-flip gate

`pnpm bench run` REFUSES to start when the tree's code differs from HEAD, and names the files:
`pnpm bench:merge` refuses those numbers anyway — a whole run later (`docs/bench-cost.md` §1) — and twice that
refusal was one untracked env file. Commit first. Anything local a worktree needs (env exports, PATH overrides)
goes in **`.envrc.local`**, gitignored for exactly this — but nothing loads it, so
`source .envrc.local` yourself in the shell you run from; anything else local goes under
**`.local/`**, gitignored too. Reach for `$(git rev-parse --git-path info/exclude)` only for a path
you cannot move: from a worktree it resolves to the MAIN checkout's file, shared with every other
worktree and never pruned, so add ONE line and `grep` for it first.

Exempt is the run that rewrites no tier file WHOLE: `--only` scopes both tiers, so the Phase-3 dev
loop is untouched, but `--project` scopes only the real tier and `--toolchain` only the synthetic
one — pair those with `--tier real` / `--tier synthetic` or the other tier is still run whole and
still refused. A scoped run is not read-only either: it REWRITES
`apps/benchmark/results/<tier>.json` with only the rows it selected, so always run whole before
`bench:merge`.

The `cpp` probe is on a DIFFERENT axis and that scoping does not exempt it: **every run that
touches the real tier is probed, `--only` included**, because the scoped loop is where TRAP 6
bites. If it refuses, your shell resolved `cpp` to Apple clang — a LOGIN shell does — and the run
would have failed every real ido/kmc/gcc272 row while reporting `✓` and exit 0; if it only WARNS,
no MIPS toolchain is installed here, so those rows were going to SKIP anyway. A synthetic-only run
is never probed: no synthetic row preprocesses with the host `cpp`. So a real-tier row that comes
back `noncompile` is a real signal, not your shell — the preflight already ruled that out.

Before declaring the branch done: `pnpm bench run` (all tiers), `pnpm bench:merge`, then
`pnpm bench regression --base origin/main` and `pnpm bench diff --base origin/main`. **Any lost
match blocks the branch.** Pass the base ref: both gates read the COMMITTED artifact, so on a
branch that has already committed its own they compare it against itself and pass vacuously.
Keep the order too: `diff` exits **2**, "nothing was compared", if `results.json` still carries the
base's `generatedAt` — run before `run`+`merge` it compares the base with itself in a second and
prints a green line. `regression` answers "did a match break"; `diff` names every row and field that
moved — that list is the PR body's inventory of what the round did, and for a commit claiming to
move nothing it is the gate. The fields it watches are `report/diff.ts`'s `FIELDS`; read them there
rather than from memory, they are wider than the score. Expect lines you did not predict: from
`maxScore` and `breakdown` (the denominator and the shape of the gap moving), and from the dropped
count, which moves when the FAN changed even though every score held. If a match is lost, either
tighten the gate on your lever or drop the lever — do not rationalize a trade unless the user
explicitly approves it. Report the totals (asmlift vs m2c) before and after.

Since #192 `diff` also prints a **FAN** section and a **COST** section under the verdict — the rows
whose candidate count or ranked seconds moved most, with their multipliers, and a total over the
rows both artifacts could answer for. **Both are INFORMATIONAL: neither moves an exit code**, and
`candidateCount` is deliberately not in `FIELDS`. Read them anyway and put the fan multiplier in the
PR body: an axis that moves no row and multiplies the confirming gate's own price by four is exactly
what every gate this repo runs was blind to for three weeks. A row that stopped ranking is reported
as `vanished` with the count that left, not silently dropped from the total.

Four things this gate does not catch by itself:

- **The regenerated artifact is the LAST commit on the branch — after the final rebase.**
  `results.json` stamps the commit it was generated at, and every number you publish reads from it,
  so a commit that touches core, cli, the harness or the dataset after it silently republishes
  numbers a rule version that no longer exists produced. Rebasing counts twice over: it rewrites
  the commit the stamp names, and it can slide a base commit that changes the decompiler underneath
  numbers measured without it — which a per-row diff against the base then credits to your branch.
  So the order is rebase → gates → regenerate → push. `scripts/check-artifact-provenance.sh` fails
  all three shapes; run it before opening the PR.
- **A number measured OUTSIDE the harness goes stale the same way, and nothing checks it.** The
  ranked run from Phase 0 measures the commit it ran at, and when the target is not a benchmark
  row the regression gate cannot see it move — so remediation rewrites what it measures with
  nothing to notice. Re-run it at the branch's final commit and publish *that* number; "the
  primary output is byte-identical" is a claim about one candidate out of tens of thousands, not
  about the best score. Launch it beside the final `pnpm bench run`, not after it, with the same
  `docs/ranked-repro.md` flags **of whichever vehicle you ran** — the two carry different ones, and
  only the project-checkout command has `--progress`. Skipping it is unquotable on that vehicle:
  the `[progress]` lines timestamp the run's own cost, so "it had not finished" is checkable
  against the log — a round once wrote that of a re-score "not finished after 2h", in a session
  under an hour long that had run no ranked command at all.
- **A CI SUITE THAT NO OTHER GATE RUNS.** `pnpm test:offline` runs three directories
  (`packages/core/test`, `packages/cli/test/offline`, `packages/toolchains/test`); hosted CI runs
  those three PLUS `apps/benchmark/test` and `apps/web/test` (`ci.yml`), and `pnpm test:matching`
  runs only in `benchmark.yml`, which is `workflow_dispatch`-only — so no PR gate runs it at all.
  A gate list spelled as `test:offline` + `apps/benchmark/test` +
  `test:matching` — which is what several rounds have run — leaves `apps/web/test` collected by
  nobody, and a change to the DEFAULT map-less spelling lands there: the playground preset pins its
  own map-less source byte for byte. Run `npx vitest run` (the root config, which is a strict
  SUPERSET of those three CI suites — `packages/{core,cli/test/offline,toolchains}/test` plus
  `apps/*/test`; read `include` in `vitest.config.ts`) and `pnpm test:matching`, and **quote both
  counts**. The shapes to expect are in [`docs/bench-cost.md`](../../docs/bench-cost.md) §1, dated
  and re-measured there rather than here — **both counts GROW as tests are added, so yours
  disagreeing is not a failure; yours missing a whole suite is.** The skips are the tell: a
  `test:matching` run that
  reports SKIPS is a gate that did not run, and three PRs have published one as their gate. A
  branch has shipped twenty commits, two adversarial rounds and every full bench run green while
  `pnpm exec vitest run apps/web/test` was red — from its very first capability commit.
- **A corpus sweep's configuration is part of its claim.** Sweeping a project's functions with the
  new rule ON vs OFF proves nothing about the configuration you did not run: with a symbol map
  every absolute pool constant lifts to a `gaddr`, so a symbol-map sweep is blind to a rule that
  only fires on raw addresses — which is exactly how a branch's own 464-function validation missed
  a match it was losing. Run both, and say which sweep each count came from.

## Phase 5 — Adversarial round

Launch **both** subagents in parallel, in one message. Give each the branch name, the commit list,
the diff numbers, and the classification from Phase 1.

**Agent A — sustainability / breaker.** Brief: "Do not evaluate whether $1 matches. Evaluate the
new capability against *every other function that could hit this code path*. Hunt: unguarded
assumptions, inputs where the new path fires but shouldn't, ordering/interaction with existing
passes, determinism, and above all **loud→silent conversions** — any case where asmlift used to fail
visibly and now emits confidently wrong C. Find real inputs, not hypotheticals. Report each finding
as file:line + a concrete triggering input + why it is wrong."

**Agent B — architectural soundness.** Brief: "Judge whether this is a general mechanism or an
ad-hoc patch shaped like this one function. Read `docs/level-tower.md` and
`docs/asmlift-101.md` first. Check: is the change at the right level; does it earn any new
structure it introduced; is it data where it should be data; does it duplicate an existing pass;
would a reviewer who has never seen $1 understand why it exists? Name the redesign if there is one."

Then: **remediate every confirmed finding as new commits**, and **re-brief and re-run both agents
on the fixes**. Precedent from this repo's history: a remediation itself introduced a
silent-wrong-address bug that only the second pass caught. One round is not enough.

The second brief carries the first round's triage ledger — every finding, its verdict, and the
reason behind each DECLINE or NOT-REPRODUCED — and any premise this round has since falsified is
struck from it, not restated. Reissuing the first brief with the round number changed spends the
second wave re-finding the first wave's work: one round did exactly that, and its second breaker
built a semantic-differential rig to re-report a pre-existing defect the first breaker's rig had
already found and remediation had confirmed and declined with three reasons — while the brief
still aimed its hunt list at a guard that round's own instrumentation had shown fires zero times
on the corpus. A finding already triaged is not a new finding unless it falsifies the triage.

## Phase 6 — Audit the commentary you introduced

Do this AFTER the adversarial rounds, never before: remediation rewrites code, and a comment
written for the first version is the likeliest thing in the diff to have become false. And **not
while a bench is in flight** — this phase rewrites files across the whole diff, the mid-run sampler
is sticky, and a round has paid for a whole voided real tier on exactly this pair
(`docs/bench-cost.md` §5). **Run `pnpm bench in-flight` first**:
exit 1 means a run is measuring this worktree, so wait for its `EXIT=` line before you touch a
file.

Inventory first — `git diff main HEAD`, added lines matching `^\+\s*(//|/\*|\*)`, counted per
file. That number is the budget you are arguing about; core already runs ~31% comments.

Then, over every comment you added or changed, **tests included**:

- **Consistency.** Match the density and idiom of the file you are in — the refusal-condition list,
  the `KNOWN GAP:` marker, the `/** … */` on an interface field. A comment three times longer than
  the sibling it is modelled on is too long, whatever it says.
- **Trim what the code says.** If a quick read of the surrounding lines answers it, delete it: a
  destructuring the type already spells, a polarity the two names already state.
- **Delete the history.** Anything about how the code got here rather than what it does — "used
  to", "previously", "the last commit", "an adversarial pass found", a gate that "could never be
  shown load-bearing", a comment arguing back at a review finding. Positional references rot the
  same way: "fourteen lines apart" survives exactly one refactor.
- **Hunt for the FALSE one.** This is the finding worth the whole phase, and remediation is what
  produces it: a test-file header claiming every refusal case is a one-fact edit of an accepted
  fixture, when three of the four became separate fixtures; a doc comment listing a loop body's
  parts after you added one. Rewrite those — do not shrink them.

Keep the refusal conditions, and any *why* not derivable from the code: a compiler behaviour, a
shape the IR cannot represent, why an absence is deliberate.

Finish with a mechanical sweep for survivors and re-run `pnpm format`. No test covers a comment, so
this phase is the only pass they get.

## Phase 7 — Report and write back

- Summary: baseline → final for $1, full-bench totals before/after, one line per commit.
- What you did **not** do and why (blocked capability, unmatchable quirk, rejected lever).
- Update the relevant memory file under
  `~/.claude/projects/-Users-macabeus-ApenasMeu-decompiler-asmlift/memory/` (usually
  `asmlift-adversarial-validation.md`) with the round's outcome and any gate that turned out to be
  load-bearing.
- Push the branch (this project's convention is commit + push on a finished goal).
- Then **`scripts/pr-wait.sh <pr>`**, never a human — `docs/measurement-discipline.md` §8 has
  its exit codes and why a pending check is not a failed one. Read that table; never carry a count
  of it in your head — the round that WIDENED it wrote the old count into this sentence in the
  same commit, and the count is the smallest possible copy of a list.

## Cost discipline

**[`docs/bench-cost.md`](../../docs/bench-cost.md) is the table, and the only copy of it.** Every
figure there carries the date it was measured, because they move: the real tier grew 4.3× in 17 days
on an unchanged row count. **Do not retype one of those numbers here** — a second copy drifts
silently, and `apps/benchmark/test/command-files.test.ts` fails on one. Read the table before you
launch anything long. What this command leans on:

- a full `pnpm bench run` is the expensive one (`docs/bench-cost.md` §1), and it runs **once at the
  zero-flip gate plus once after the final rebase** — a round whose base did not move runs it once,
  and a round that touches no path in `MEASURED_PATHS` runs it zero times;
- `pnpm bench baseline <sym>` answers the price of a scoped run in seconds, without one;
- **`pnpm bench sweep --base origin/main` is the corpus A/B**, and it is the one to reach for
  whenever you would otherwise write a throwaway census script: it re-lifts every row in both
  trees, map-ful and map-less, compiles nothing, and prints the rows whose emitted C moved. `--fan`
  does the same for the whole enumerated candidate set, which is the arm an axis actually moves —
  a corpus whose DEFAULT spelling is unchanged can still have had its fan doubled, and that is the
  multiplier this command asks you to report. `--repeat N` asks the same of this tree against
  itself. Read its exit code as `diff`'s with one addition: 1 = something moved, 2 = it did NOT
  answer — an empty selection, or a row this shell could not lift at all (trap #6). And a moved
  line that opens `asm …` or `opts …` says the row's INPUT moved, not the decompiler. Prices in
  `docs/bench-cost.md` §1, and §3 carries the measured example of the two arms disagreeing;
- background the long ones, wait on a bounded marker-AND-log-growth condition, keep only
  READ-ONLY work beside a bench, and `pnpm bench in-flight` before any phase that edits the tree;
- `kill -TERM` does not stop a bench, `kill -9` orphans its shards, and two full benches must never
  overlap on this machine. All four are in that file with what they cost when ignored.

---

## Hard rules

1. **Never trade a loud failure for a silent wrong answer.** `declined` / an `ASMLIFT_ERROR` marker
   beats plausible-but-wrong C. Every new transform must state the condition under which it refuses.
2. **Every lever needs a gate**, and the gate must be justified by a row it protects. Ungated levers
   have regressed matches here repeatedly (multi-use const → `sum_to`; base-CSE without the
   loop-gate; const-MMIO RMW without the scalar-fixed-offset gate).
3. **Never edit the benchmark to make a row look better** — no manifest tweaks, no results.json
   edits, no adding context that a real user of the published repro script would not have. If the
   harness is genuinely wrong, fix it as its own clearly-labelled commit and say the numbers moved
   for harness reasons.
4. **Stop rule.** If the capability is bigger than this session, or the row turns out unmatchable:
   keep and ship the commits that genuinely reduced the diff, and report what is blocked and what
   the next step would be. Do not force an ad-hoc hack to close the last few bytes. "Unmatchable"
   here means it cleared the bar in
   [`docs/unmatchable-quirks.md`](../../docs/unmatchable-quirks.md) — two compiler sweeps — and
   never "I ran out of session": that case is blocked, which is a different report.
5. **Everything in [`docs/measurement-discipline.md`](../../docs/measurement-discipline.md)** —
   numbers come from commands; a compiler claim is verified by compiling; a refusing site is named
   by instrumenting or ablating it; NO REACH ≠ LOSES ≠ DOES NOT COMPOSE; the denominator moves;
   never explain a discrepancy, re-run it; a measured null ships. Those are hard rules of this
   command too. They live there because `/attribute-function` has the same ones, and the last time
   a rule lived in only one of the two prompts they drifted.
