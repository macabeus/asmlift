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

1. Resolve the row: `pnpm bench run --tier real --only $1`. Record the outcome verbatim for both
   decompilers.
2. Reproduce outside the harness with **the command in
   [`docs/ranked-repro.md`](../../docs/ranked-repro.md), verbatim** — its flags (`--proto` when a
   callee's arity matters, `--jobs 6 --progress`) are part of the number, and its `grep -F
   '[score]'` recipe is how two such runs get compared. That file is shared with
   `/match-function`; correct it there, never here. The best `[score]` line is the number every
   later claim is measured against, and it goes into your report verbatim, flags included.
3. State the baseline in your first user-facing message.

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
- **diff:N** → a gap row. Attribute the N by diffing the probe's candidate asm the Phase-2 way —
  a small N can still be a distinct capability (operand order) or can be noise.
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

One family, one block comment, modeled on the existing families in `dataset/synthetic.ts` (the
uninit-local block is the reference): what each row isolates, which are controls, and an
attribution line for every decline naming its first blocker. Constraints learned the hard way:

- **No extern data globals.** Synthetic candidates have no ELF to synthesize declarations from,
  so a row whose asm relocates against a named global fails candidate compilation. Spell shapes
  with absolute addresses (pointer locals, `#define` address macros) — codegen-equivalent for
  these purposes and self-contained.
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
2. Expect the two tag-vocabulary tests to fail BETWEEN adding the tag and merging the artifacts;
   they must pass after. `npx vitest run`, `pnpm test:matching`, `pnpm typecheck`,
   `npx eslint apps packages` (not `pnpm lint`), `pnpm format` check.
3. Artifacts (`apps/benchmark/results/results.json`, both web copies) regenerated at the source
   commit's HEAD (`meta.asmlift.dirty` must be false) and committed separately — **after** your
   final rebase, as the last commit. A rebase rewrites the commit the artifact's stamp names, and
   it can slide a base commit that changes the decompiler underneath numbers measured without one.
   `scripts/check-artifact-provenance.sh` fails both; run it before opening the PR.
4. Zero-flip over the previously committed rows blocks the branch, same as `/match-function`.
   `pnpm bench diff --base origin/main` is that check by row and field, and its output is the
   report's list of what moved.

## Phase 8 — Write it down and report

- Research doc in `research/` (untracked — never cite its path in commits, PR bodies, or the
  dataset): the compiler facts with file:line, the experiment pairs, the per-row outcome matrix,
  the levers each row gates in expected-impact order, and every finding you EXCLUDED with the
  machinery it actually belongs to.
- Correct any stale attribution the investigation falsified (memory files, earlier research docs).
  An attribution that has silently gone stale sends the next session down the wrong lever.
- Report: baseline, the named gap classes with their verified causes, the row matrix, and what
  a future `/match-function` should build first. Push the branch and open the PR.

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
   whole corpus.
3. **Never edit the benchmark to make a row look better** — the reference source defines the
   target; manifests and results are never tuned. Harness defects (a hang, a missing timeout)
   are fixed or documented as their own labelled change.
4. **Rows, not fixes.** Implementation belongs to `/match-function`, gated by the rows this
   command leaves behind. If you cannot resist sketching the fix, put it in the research doc's
   lever list.
5. **Attribute declines to their first blocker** and pre-existing links to their own families.
   A family whose rows all decline on an unrelated link has measured that link, not itself —
   say so in the block comment.
