# Measurement discipline

The laws every round in this repo is measured against, and the one place they live. **Both command
files link here and neither restates them; a brief that wants them names this file.** They were
brief-only until 2026-09-12, which meant a round the supervisor did not brief — the user ran
`/match-function` by hand on 09-11 — got none of them.

---

## 0. WHICH COPY OF THE SPEC ARE YOU READING?

**Read `.claude/commands/<command>.md` from your OWN worktree, by absolute path**, or through
`git show origin/main:.claude/commands/<command>.md`. Never through a relative path, and never out
of another agent's checkout.

This is not pedantry about paths. A round's worktree is created from a just-fetched `origin/main`;
the user's own checkout sits wherever the user last left it, and rounds are told not to write to
it, so it is routinely tens of commits behind. A relative path from a working directory that is not
your worktree resolves there. **The mining round of 2026-09-12 counted 16 of 21 reads of
`match-function.md` across rounds #183–#188 returning the copy from before #174** — every one of
those agents was following a specification that named none of the tooling built for it, and the
"neutral" column of that report is mostly this.

So, mechanically:

- **Agent:** `cat <your worktree>/.claude/commands/match-function.md`. If your brief gave you a
  relative path, resolve it against your worktree yourself before reading.
- **Brief author:** give the path as `<the worktree you just created>/.claude/commands/…`, or as a
  `git show origin/main:…`. Do not paste an excerpt of the file into the brief — a copy is a
  fourth version to go stale, and this file exists because that already happened.
- **Either:** the cheapest check that you are on the current copy is `git -C <dir> log --oneline -1
origin/main -- .claude/commands`.

The same rule covers every doc these prompts link: `docs/` is versioned with the prompt that links
it, so read it from the same tree.

---

## 1. Numbers come from commands

Never state a diff number, a score, a match, a regression, a pool count, a timing or a compiler
behaviour you did not just observe in tool output that you show or quote.

## 2. A compiler claim is verified by COMPILING; an asmlift claim by RUNNING asmlift

The diff suggests; only the compiler confirms. Write the minimal C **pair** — the spelling the
original source plausibly used, and the spelling asmlift emits — and compile both with the
project's real compiler and flags. The hypothesis holds only when the original-style spelling
reproduces the target's pattern AND the asmlift-style spelling reproduces the divergence.

This applies to claims about two SOURCE spellings too. "These two spellings are underdetermined" is
a claim about a compiler: compile both, diff the objects, and do it on the shape you intend to
GENERALIZE over — an identity that holds in a degenerate one-case shape is not the identity you are
about to build an axis on.

## 3. Name a refusing site by INSTRUMENTING or ABLATING it, never by reading

Print which `return null` fires, or ablate the guard and watch a row move. A guard you did not
watch fire is a hypothesis, and one published as a mechanism aims the next round at the wrong
guard: a round once attributed a decline to a refusal that fires zero times on the whole corpus,
and another named a gate that had never been touched by the change that moved its row.

Check whether you have to instrument at all, in this order:

1. **`pnpm bench gates --pass <pass>`** prints the per-id refusal census of a tabled pass, with no
   edit to core and nothing to revert (~29 s, measured 2026-09-12). A count there is FIRST
   REJECTIONS and not reach — read the MOVED column beside it before building on a big number. A
   pass that is not in the registry is not censusable this way and the command says so.
2. A pass that exports a census (`arrayShapeRefusals` in `raise/globalshape.ts`) or returns a
   `refusals` map (`l3/coalesce.ts`, `l3/scopebase.ts`, `structure/namecoalesce.ts`) — a test reads
   the id straight out.
3. Only a table that is neither injectable nor reported costs a patch. **When you had to patch a
   refusal to print why it fired, say so in the PR body and name the pass** — that instrument
   episode is one of the two things that license converting those refusals to a `Gate` table later.

**Do not write your own census script.** The three hazards that made it a subcommand are recorded
at `grep -n "WHY A SUBCOMMAND AND NOT A DOCUMENTED SCRIPT" apps/benchmark/src/run/gate-census.ts`,
and one of them stamps your next `bench run` DIRTY after 2,000 s.

## 4. NO REACH is not LOSES is not DOES NOT COMPOSE

Three different failures, three different next moves, and they are routinely reported as one word
("it didn't work"):

| what happened                                                     | how you tell                                                  | what it means                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **NO REACH** — 0 candidates enumerated                            | the label is absent from `pnpm bench fan <row> --enumerate`   | the lever never produced a candidate; a lever that THREW prints `[lever] … threw (no candidate from it)`, which `bench run` prints nowhere |
| **LOSES** — it fired and scored worse                             | the label is in the fan with its own score                    | the spelling exists and the ranker rejected it; `--enumerate --show <label>` prints its source so you can read why instead of inferring    |
| **DOES NOT COMPOSE** — it fires alone and not beside another axis | present in a one-axis fan, absent or worse in the stacked one | an interaction, not a missing capability                                                                                                   |

Say which one you measured. An axis discarded as "no reach" that actually loses is a different
round's worth of work.

## 5. A score carries a denominator, and the denominator MOVES

`maxScore` is not a property of the target function. It is the objdiff row count of the **winning
candidate's** alignment, so a different candidate is scored against a different scale.

- **Quote the whole `N/M`, never the `N` alone.** `diff:290/404 → diff:171/387` is 119 points on a
  scale that also lost 17; written `290 → 171` it makes the next reader subtract.
- **A delta is a pair of fractions, not a difference.** `before N₁/M₁ → after N₂/M₂`, in the report,
  the PR body and the row comment. If M moved, say so in the same sentence and by how much. If you
  do not know M, you do not have the delta.
- **Never write "partition", "accounts for all of", "the N decomposes into"** or any other
  exhaustive-decomposition word about a residual unless you have shown the denominator is fixed
  across every measurement you are comparing. Write "these gaps cover X of the N _measured at
  maxScore M_" and give M. A round that read a residual as a subtraction on a fixed 404 predicted
  297 points from its six gaps, delivered 119, and spent an extra attribution round explaining a
  shortfall that was partly the scale.
- **Gap arithmetic is a prediction until measured.** State it as a prediction, with the ablation
  that falsifies it.
- **The tools tell you.** `bench run` prints `diff:<score>/<maxScore>` per row; `bench diff` prints
  `asmlift.score: 290/404 → 171/387` plus a separate `asmlift.maxScore: 404 → 387` line **whenever**
  the denominator moves, alone or beside a moving score — so a `maxScore` line is never evidence
  that the score held still.

## 6. Never explain a discrepancy — re-run it

A number that disagrees with this round's own chain is a broken measurement until the Phase 0
command reproduces it. Running _a_ command is not enough to make a number real: a round once
published 557 and 578 for a function whose baseline was 547 and rationalised the gap as unpinned
build objects, when the cause was a dropped flag — the false number and the false story merged
together.

The corollary, for anything measured OUTSIDE the harness: re-run it at the branch's FINAL commit
and publish that number. The regression gate cannot see a non-row target move, so remediation
rewrites what such a number measures with nothing to notice.

## 7. A measured null is a successful outcome

If the thing turns out not to pay, say so with the measurement that shows it and ship the evidence.
A null PR that documents the falsification merges like any other. Do not build something you have
measured to be useless in order to satisfy a brief; discard an item only on proof.

The same rule applies to the brief you were given. **A brief's attribution is a hypothesis with a
denominator** — one round's premise was wrong in both of its countable halves and the round still
paid, because it measured instead of arguing. Strike a falsified premise from the record rather
than restating it.

## 8. Never ask a human what a command answers

"Is CI green?" and "did the PR merge?" are measurements too. **`scripts/pr-wait.sh <pr>`** polls the
PR's real state under a deadline and exits with the ANSWER. **Six codes, not four** — the script's
own header block (`scripts/pr-wait.sh:20-26`) is the list, and a round handed a short version has no
reading for the two that mean _stop waiting_:

| exit | meaning                                                                                     | what it means you should do                                                  |
| ---- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0    | merged                                                                                      | done                                                                         |
| 1    | a check failed — a verdict GitHub actually gave                                             | read the failing job                                                         |
| 2    | still pending, nothing decided; also a network blip, an expired token, "no checks reported" | poll again or raise `--timeout`; **never** read a 2 as a red check           |
| 3    | green and ready to merge                                                                    | merge it                                                                     |
| 4    | **`CLOSED` — closed without merging** (`:124`, `:210`)                                      | the PR is dead; stop waiting and say so, rather than polling to the deadline |
| 64   | **usage error, or the PR cannot be read at all** (`:43`, `:92`, `:112`)                     | you asked the wrong question; fix the invocation, do not retry it            |

Exit 2 is deliberately wide because `gh`'s own exit 1 confounds a failing check with a network
error, an expired token and "no checks reported" (`gh help exit-codes`), so the buckets are read
rather than the status. That question was asked of a human six times in one session and the script
answers all six.

The same applies to the tree you are about to edit (`pnpm bench in-flight`), the row you were
handed (`pnpm bench baseline`), the fan you are about to pay for (`pnpm bench fan --enumerate`) and
whether a branch owes an artifact (`scripts/check-artifact-provenance.sh`).
