---
description: Match a benchmark function by building the missing asmlift capability, then adversarially verify it
argument-hint: <FunctionName>
---

Target function: **$1**

If `$1` is empty, ask which function before doing anything else. Do not guess.

Your job is **not** "make this one row match". It is: find the *general capability* asmlift is
missing, build it soundly, and let this row fall out as evidence. A change that only works because
you looked at this function's diff is a failure, even if the row flips to MATCH.

---

## Phase 0 — Resolve and baseline (never skip)

1. Resolve the row: `pnpm bench run --tier real --only $1` (`--only` is a substring match on the
   symbol; row ids are `project:sym:toolchain`). If it hits more than one row, list them and pick
   the one the user meant — say which you picked.
2. Record the **baseline** verbatim: asmlift outcome (`MATCH` / `diff:N` / `noncompile(k)` /
   `declined(k gap(s))` / `failed`) and m2c's for the same row. Every later claim of improvement is
   measured against this exact number, produced by this exact command.
3. Read the asm and the current asmlift output side by side. Get the target `.o` and a working dir
   with `pnpm bench target <row-id> --out <dir>` so you can iterate without the full harness.
4. State the baseline in your first user-facing message. Never report progress without a
   before/after pair of real command output.
5. **Write every repro command down verbatim, flags included** — the `--only` line above, and any
   ranked enumeration you run outside the harness. Every later measurement (each reviewer's, each
   remediation's, the PR body's) re-runs *that* command, not one recomposed from memory. The flags
   are part of the number: a callee still written in assembly has no DWARF signature, so
   `LoadBGTilemapData` without `--proto '{"thunk_HeapFree":{"params":1}}'` scores 578 where the
   round's baseline is 547 — a plausible number that is comparable to nothing. Quote the candidate
   and dropped counts beside every ranked score.

## Phase 1 — Diagnose the gap honestly

Classify the gap before writing any code. The four outcomes are not equally likely and three of
them are not "add a feature":

- **Missing capability** — asmlift cannot *represent* or *recover* something (an idiom, a type, a
  control-flow shape). This is the case the rest of this prompt is written for.
- **Missing lever** — asmlift can represent it, but never chooses that spelling. A lever is a
  candidate-generation change, and levers regress other rows far more often than they help; it
  needs a gate (see Hard Rules).
- **Unmatchable source quirk** — the original C used a construct no honest recovery would produce
  (register-allocation intermediates, a hand-written temporary, an unusual build flag). Real
  precedent in this repo: `StrCpy`. Say so, prove it, and stop — do not invent machinery to imitate
  a quirk.
- **Harness / fidelity problem** — the row is built with a toolchain or flags the real project did
  not use (the `old_agbcc` class of bug). Then the fix is in the manifest/toolchain, not the
  decompiler, and it may *remove* the row rather than match it.

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
- Add unit tests in `packages/core/test/` next to the sibling capability's tests. A capability with
  no test that fails before the change is not done.
- Gate: `pnpm test:offline` + `pnpm typecheck` + `pnpm lint`, and re-run `pnpm bench run --tier real
  --only $1` plus the rows you predicted are affected. Report the diff number movement.
- Commit only when green. Message says what capability was added and what it moved, e.g.
  `feat(raise): recover X from Y idiom (Foo 41→18)`.
- If a step moves the number the wrong way, keep it only if it is a prerequisite, and say so in the
  commit body.

## Phase 4 — Full-bench zero-flip gate

Before declaring the branch done: `pnpm bench run` (all tiers) and `pnpm bench regression`. **Any
lost match blocks the branch.** If a match is lost, either tighten the gate on your lever or drop
the lever — do not rationalize a trade unless the user explicitly approves it. Report the totals
(asmlift vs m2c) before and after.

Two things this gate does not catch by itself:

- **The regenerated artifact is the LAST commit on the branch.** `results.json` stamps the commit
  it was generated at, and every number you publish reads from it — so a commit that touches core,
  cli, the harness or the dataset after it silently republishes numbers a rule version that no
  longer exists produced. Regenerate after Phase 5's remediation, and run
  `scripts/check-artifact-provenance.sh` before opening the PR.
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

Then: **remediate every confirmed finding as new commits**, and **re-run both agents on the fixes**.
Precedent from this repo's history: a remediation itself introduced a silent-wrong-address bug that
only the second pass caught. One round is not enough.

## Phase 6 — Audit the commentary you introduced

Do this AFTER the adversarial rounds, never before: remediation rewrites code, and a comment
written for the first version is the likeliest thing in the diff to have become false.

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
   the next step would be. Do not force an ad-hoc hack to close the last few bytes.
5. **Numbers come from commands.** Never state a diff number, a match, or a regression you did not
   just observe in tool output that you show or quote.
6. **Never explain a discrepancy — re-run it.** A number that disagrees with this round's own
   chain is a broken measurement until the Phase 0 command reproduces it. Running *a* command is
   not enough to make a number real: a round once published 557 and 578 for a function whose
   baseline was 547 and rationalised the gap as unpinned build objects, when the cause was a
   dropped flag — the false number and the false story merged together.
