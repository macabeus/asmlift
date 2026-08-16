---
description: Match never-decompiled Klonoa functions and land them, while dogfooding asmlift + Transmuter + gba-kit to improve the whole flow
argument-hint: [function-count] (default 10)
---

Number of functions: **$1** — if that is empty, use **10**.

This command has **two deliverables of equal standing**:

1. **Matched functions, landed.** Byte-exact C for $1 never-decompiled Klonoa functions, named,
   documented, and pushed to the decomp repo as a PR. A round that produces a beautiful report and no
   merged matches has failed.
2. **A dogfood of the whole decompilation flow** — **asmlift**, **Transmuter** and **gba-kit** — with a
   defect log per tool, ranked by what each defect actually cost in this round, so the next round of
   tool work has targets. A round that matches everything and cannot say what slowed it down has also
   failed.

The two feed each other: you find the defects *because* you are seriously trying to match, and the
matches get cheaper as the tools improve. Do not sacrifice either for the other.

This is the counterpart to `/match-function`: that one improves asmlift on a benchmark row, this one
finds out what to point it at — and ships real decomp work while doing it.

---

## Fixed facts (verify, do not re-derive)

| thing | path / remote |
|---|---|
| asmlift (this repo, tool under test #1) | `/Users/macabeus/ApenasMeu/decompiler/asmlift` |
| klonoa decomp, **live checkout — read-only, worktree from it** | `/Users/macabeus/ApenasMeu/decompiler/klonoa-empire-of-dreams` → `git@github.com:macabeus/kl-eod-decomp.git` |
| Transmuter (tool under test #2) | `<klonoa>/tools/transmuter` submodule → `git@github.com:macabeus/transmuter.git` |
| gba-kit (tool under test #3) | `/Users/macabeus/ApenasMeu/gba-kit` → `git@github.com:macabeus/sgba.git` |
| prior runtime-analysis logs | `/Users/macabeus/ApenasMeu/gba-kit/klonoa-analysis` |
| committed runtime experiments + their rules | `<klonoa>/docs/dynamic-analysis/` (read its `README.md`) |
| prior rounds | `research/asmlift-dogfood-report*.md` (round 3 is the most load-bearing: it re-measured the instruments the earlier two trusted), plus `research/dogfood-gaps-vs-benchmark-2026-08-02.md` |

Run asmlift **from source**, never a published npm build: `pnpm asmlift <abs-path-to.s> …` from this
repo. `decomp.yaml` resolves from the *input file's* nearest ancestor and compiler templates run with
`cwd` = that config's directory, so absolute input paths into a worktree work from anywhere. Record
`git rev-parse HEAD` for all three tools in the report — a defect log is only meaningful against commits.

Round number **N** = highest existing `research/asmlift-dogfood-report*.md` + 1. Scratch work goes under
`/tmp/dogfood-r<N>/`.

---

## Phase 0 — Study first (never skip; the user explicitly asked for this)

Read, before touching anything: both prior reports, the gaps-vs-benchmark doc, `<klonoa>/CLAUDE.md`
(its policies are binding on anything you commit there), `<klonoa>/docs/dynamic-analysis/README.md`,
and enough of `klonoa-analysis/` to know what runtime evidence already exists — never re-prove a fact
that has a committed script. Check the repo's GitHub issues for the functions you are about to touch.

Then write a **traps-carried-forward checklist**. Each item is either avoided by construction in your
setup or explicitly re-tested this round; say which. Known traps, all paid for in blood:

- **Scoring targets.** A 2-byte pad for `non_word_aligned_thumb_func_start` is *wrong* — 43 of 45 such
  functions are word-aligned per `klonoa-eod.map`; the pad shifts every pc-relative pool reference and
  flattens Transmuter's search gradient. Luvdis also emits **spurious mid-function labels**
  (`.thumb_func / sub_XXXX:` inside a body) which truncate objdiff to the first N rows. And luvdis
  labels can be off by two (`0x0804539A` where the ROM has `push` at `0x08045398`).
- **Score ≠ match.** objdiff is blind to the literal pool (a "score 4" candidate had `0x0000F807`
  where the ROM has `0xFFFFF807`). Against a raw-address target a byte-exact source can score >0
  wherever it NAMES a global, because the target's pool word is a bare number and the candidate's is
  a relocation — a penalty that lands only on the spelling you want. `scripts/pool_abs_syms.sh`, wired
  into both `decomp.yaml` templates, removes it; verify it is running before trusting any score.
- **The oracle could certify a NON-match, and on an old branch still can.** The ELF and the ROM live
  outside `build/`, so make may skip relinking and `compare` then re-verifies the PREVIOUS ROM.
  Reproduced twice: breaking a source file and running `rm -rf build && make compare` still printed
  `klonoa-eod.gba: OK`. `compare` now tidies first, so this is fixed — **but confirm it on the branch
  you are on**, by breaking a file and checking that `make compare` fails. If it does not, spell the
  oracle `make tidy compare` for the whole round. Neighbouring versions of the same hazard: make skips a rebuild when a source and its object land in the same clock second, and
  the Makefile tracks **no** header dependencies, so after a struct change an incremental build
  leaves **stale DWARF** that anything reading the ELF silently resolves against.
- **A byte-exact function is not sufficient.** agbcc's codegen couples across a whole translation
  unit: a function that compiled byte-identical still broke the ROM in another function **1833 lines
  further down the same `.c`**, because it referenced an extern symbol rather than reaching the same
  cell by address. objdiff cannot see this and neither can Transmuter — both score one symbol. Run
  the full-ROM oracle after **every** function you add to a branch.
- **Build flags.** `AGENT_INSTRUMENT=1` (the default) suppresses agbcc's DWARF on older checkouts;
  re-test rather than assume. `make asmlift-elf` is **not** part of `all`, so `klonoa-eod-syms.elf`
  is stale or absent after a plain `make`.
- **Transmuter.** Its reported scores were phantoms until `set -e` landed in `decomp.yaml`: a
  multi-command template without it exits 0 after the compiler fails, so a REJECTED candidate got
  assembled from agbcc's error-recovery output and scored. Confirm `set -e` is present. It also
  reports an **injected** candidate as its own success in the banner — check `min score by origin`
  in the session JSON before crediting it. Run the built `dist/index.js` under **bun**, not node;
  the pinned submodule may be a WIP whose `dist/` is stale against its own `src/`, in which case
  build upstream `main` from source once and share it.
  **`--concurrency 2` maximum per agent** — CPU-count default × parallel agents exhausted machine
  memory. It also **cannot invent declaration-level edits** (bitfields, array-typed externs, a macro
  becoming a real object) by construction — those are exactly what you inject through the API.
- **gba-kit.** `di.structMember` returns the *first CU's* definition (stale DWARF → silently the old
  layout); `symbolToAddress` returns `null` and `null >>> 0 === 0` makes reads silently return 0;
  `*gLevelStatePtr` points at unallocated EWRAM reading as uniform `0x7b` in every shipped savestate,
  which looks exactly like plausible field values.
- **Evidence hygiene.** A script that fails to *start* proves nothing, and grepping stderr for
  `TypeError` misses `ERR_MODULE_NOT_FOUND` — check **exit status**, and commit every helper a cited
  script imports.

## Phase 1 — Build one prototype worktree and prove it before fanning out

**Worktrees need no bespoke tooling — this was got wrong before, so do not re-derive it.**
`git worktree add` plus `./setup.sh` in the new tree is the whole recipe: submodules initialise
normally there and `setup.sh` copies `baserom.gba` from the main checkout itself. Budget ~90s per
worktree, most of it rebuilding agbcc (the build cache lives inside the submodule, so it is
per-worktree); a second run in the same tree is ~15s.

Do **not** clone a provisioned tree with `cp -Rc` to save that 90s. It is ~15× faster and it
inherits whatever state the main checkout happens to be in — that is exactly how a submodule left on
a WIP commit, whose `dist/` did not run, got imported and cost more than the rebuild would have.

Build `/tmp/dogfood-r<N>/proto` first and prove it before fanning out. The prototype is not done
until all of these hold, each shown as command output:

1. **`make compare` prints `klonoa-eod.gba: OK`** — and confirm it is the version that rebuilds
   from scratch, by breaking a source file and checking it fails. On an older branch use
   `make tidy compare`.
2. `make asmlift-elf` produces `klonoa-eod-syms.elf`; record its symbol-map counts. Round 3 measured
   557 shapes / 222 signatures / 116 macros, and 502 of 1268 addresses carrying more than one name.
   If signatures or macros are 0, fix that before spending a single function on it.
3. **Calibration:** compile a KNOWN-GOOD source — an already-matched function, lifted out of its
   module — and score it against a target you built. It must be 0. If it is not, your target
   pipeline is wrong; stop and fix it before measuring anything. Round 3 needed three fixes to get
   there, and the residual is real: a function lifted out of its TU gets a different literal-pool
   layout than it has in the ROM, so calibrate on several and expect a minority to disagree for
   that reason alone.
4. Transmuter runs, its `--api` server answers, **and the source it reports recompiles under
   `tools.transmuter.compiler` and independently scores what it claimed**. If `set -e` is missing
   from `decomp.yaml`, fix that first — every number it prints is otherwise suspect.
5. A target builder, and a **check that proves its output against the ROM**: extract the symbol's
   bytes from `baserom.gba` at the address the built ELF gives it and compare, masking relocation
   slots. Round 3 verified 145 of 156 this way; the 11 failures are luvdis over-capture and are the
   functions to exclude from selection. A target you have not proved is not a measurement.

## Phase 2 — Select, and measure the population while you are there

The population is every undecompiled function in `asm/nonmatchings/` **excluding `m4a`/`eeprom`** —
those are `old_agbcc` and unfaithful to the canonical toolchain.

First **prove every target against the ROM** (Phase 1 gate 5) and drop the ones that fail — a
population measured against targets you have not verified is not a measurement. Round 3 kept 145 of
156 that way.

Then score the whole surviving population twice, with `tools.asmlift.elf` and with a no-ELF config.
That sweep costs one command and produces the round's most valuable number: how many asmlift declines
outright, how many score in both arms, ELF better/worse/same. Rounds 2 and 3 both landed near 79%
declined against the benchmark's 21%; reproducing the rate is table stakes.

**Capture the decline REASON, not just the count.** This is what turned round 3's headline from "79%
is bad" into something actionable: roughly 43 of 114 declines were one luvdis defect — literal-pool
data rendered as instructions, which asmlift is right to refuse — while the largest genuine
capability gap (`sp used as data`, 24 functions) was ~4× the next real one. A raw decline rate
attributes nothing and quietly blames the decompiler for its input.

Then pick that many functions, biased toward **what you can realistically land** but not only
easy wins: include at least two the prior round left **stuck**, and at least one from each of the two
largest decline families — one input-quality, one genuine gap. Round 3 did this and both declined
picks matched by hand *and* produced the capability analysis that made the round worth running.
State the selection rule in one sentence, and check GitHub issues for each pick.

## Phase 3 — One subagent per function, one worktree each

Launch them in parallel batches. Each brief carries: the worktree path, the function, its baseline
scores in both arms, the traps checklist, and this escalation ladder.

**Do not give up early.** A "stuck" verdict is only admissible after all six rungs, and it must name
the exact differing instructions plus a hypothesis class — never a vague "register allocation":

1. asmlift both arms; keep the raw output verbatim for the defect log.
2. Hand-fix asmlift's mistakes one at a time, **recording each as a category + what it cost**.
3. **Declaration-level levers** — struct bitfields, array-typed `extern`s, typed pointers over byte
   arithmetic, a `#define` becoming a real object, the right alias for the access shape. These decided
   most of round 2's matches and **all ten of round 3's**, and Transmuter *cannot* invent them, so
   try them before it. Round 3's catalogue, each measured by ablation: a named extern vs a cast
   address constant for a base live across a loop or call (19–33 points, three functions); a bitfield
   group's container type (`u8` → `neg`, `u32` → a CSE'd `sub`, and two groups in one struct can need
   different ones); a struct's scalars becoming a run-time-indexed array; index operand order; and
   *not* caching a global in a local.
4. **Transmuter, steered through its HTTP control API — never fire-and-forget.** Start it with `--api`
   (`--concurrency 2` max) and drive the running search from the discovery file it prints: inspect the
   state and the current best, prune branches that are wandering, and **inject your own hypotheses as
   branches** — the declaration-level and regalloc-intermediate spellings from rungs 3 and 5 that its
   rule set cannot invent. Use `transmuter ctl` or plain HTTP against the API, whichever you prefer;
   read its README for what the API exposes. Random mutation alone found no match in round 2, so the
   agent-in-the-loop is precisely the part being dogfooded — but note it decided **none** of round
   3's ten, so treat a run that does not beat rung 3 as the expected outcome, not a failure to try
   harder. **Recompile every candidate it reports** with the project's own
   `tools.transmuter.compiler` before believing a score, and check `min score by origin` in the
   `session-*.json`: its banner reports an **injected** candidate as its own success.
5. Regalloc intermediates (`u8 val` / `s32 mask` locals), `do { … } while (0)` wrappers, statement
   reordering, `return (x & M) != 0` vs `!!`, one `cmd`/`entries` pair per function.
6. Byte-compare `.text` and inspect the literal pool by hand.

Oracle for "matched": `INCLUDE_ASM` removed, C function present, **`make compare` →
`klonoa-eod.gba: OK`**. Nothing else counts. If `compare` on this branch does
not tidy first, `rm -rf build && make compare` can print OK for a tree that does not match — check
once, at the prototype gate, rather than assuming. For near-misses report exact ROM bytes off.

Each agent returns: verdict, iterations, both baseline scores, final score/bytes, the ranked defect
log **per tool**, Transmuter forks and verified deltas, and **the hypotheses it disproved** (those are
what stopped round 1's wrong diagnoses from surviving round 2).

## Phase 4 — Name from runtime evidence (matched functions only)

klonoa's policy is that no `sub_XXXXXXXX` reaches committed C, so every match needs a semantic name, a
`/** docstring */`, and a rename in `klonoa-eod-decomp.toml`. Earn those names with `gba-kit`, and
dogfood it while you do. Method: **causal intervention with a control** — force one field, hold
everything else, observe which hardware register or on-screen object moves. Correlation is not evidence.

- Resolve every address and struct offset through DWARF via `docs/dynamic-analysis/scripts/_harness.mjs`;
  never hand-type an offset or a mask.
- **Check hardware labels against `<klonoa>/include/io_reg.h`.** Round 2's worst error was a proof
  script with `WIN0V`/`WIN1H` transposed: the observations were right, the labels were wrong, the
  rename was confidently wrong, and because it was offset-preserving **no build gate could ever catch it**.
- **A placeholder beats a guess.** `unk…` / `sub_…` is the correct answer when the evidence supports
  the mechanics but not the meaning, and when one name would be wrong for a sibling function
  (`GfxStreamEntry` is a union-in-disguise).
- Every claim in a header comment cites a committed script that runs end to end, checked by exit
  status, with its helpers committed too.
- **The ROM's own addressing arithmetic is layout evidence**, and unlike an emulator script it cannot
  be undone by a mislabelled hardware map. Round 3 settled a struct's `[window][axis]` order from the
  register pointer's `+4/-2/+4` walk before confirming it at runtime; use the cheap proof first.
- Log every gba-kit friction point as you hit it: missing API, silent-null read, savestate trap. That
  log is deliverable #2 for this tool.

## Phase 5 — Adversarial pass (mandatory, before anything is pushed)

Three independent reviewers, each in its own worktree: **code quality**, **comments**, **naming**.
Brief them to *redo the work* — their own static reads and their own runtime experiments — not to
re-read the agents' scripts. Round 2's reviewers overturned 3 renames outright, overstated 4 more, and
caught 7 citations pointing at scripts that had never run. Round 3's overturned four *mechanisms* —
the observations were right and the explanations attached to them were fabricated, which is worse
than no explanation because it gets cited — plus one function name, one bit claim in shipped code,
and one invented matching constraint.

Brief them to attack **explanations**, not just conclusions: "this matches" is usually true, "it
matches *because* agbcc does X" is where the errors live, and it is checkable in one command.

Remediate every confirmed finding, then **re-run the reviewers on the fixes — this is not optional**.
Both rounds that did it found defects in the remediation itself; round 3's included one that broke
every candidate compile, and one where a reviewer's claim was repeated without being re-run and was
false.

## Phase 6 — Land the matches, and file the tool fixes

**The decomp PR (deliverable #1) — exactly ONE PR against `kl-eod-decomp`, containing every function
this round matched.** Not one PR per function, not one per batch: a single feature branch
`asmlift-dogfood-round<N>` off `main`, pushed, opened as one PR. Merge every worktree into one merge
worktree, then per `<klonoa>/CLAUDE.md`: `make format`, one *commit* per matched function with the
technique in the message, renames in `klonoa-eod-decomp.toml`, docstrings, `python3 scripts/generate_asm.py`.
Never push `main` directly. Non-matching functions stay out of the branch (their header/struct work
may still be worth a separate commit — say so). Post findings on the related issues, success or failure.

### The merge kills matches. Verify that it didn't

**A match proven in an isolated worktree is not a match on the merged branch.** Conflicts are real —
two agents naming the same address differently, incompatible struct layouts for the same bitfield word,
a shared header field that one function needs as `u8` and another as `u16` — and *resolving the
conflict changes the codegen of functions that were byte-exact before it*. This has already cost this
project matches. The merge is the most dangerous step in the round, not a formality.

So the branch is not done until all four hold, each shown as command output:

1. **`make compare` → `klonoa-eod.gba: OK`.** Run it after **every** function you merge, not
   only at the end: agbcc's codegen couples across a whole translation unit, so adding one function
   can break another 1800 lines away while both look byte-exact to objdiff.
2. **The function census matches the scoreboard.** Count the functions on the branch and diff that list
   against the per-worktree verdicts. Every function that matched in isolation is still C on the
   branch. A silent revert to `INCLUDE_ASM` to make a conflict go away is the failure mode this check
   exists to catch.
3. **Per-function re-verification after every conflict resolution**, not just at the end. Whenever you
   unify a name, a struct layout or a header field, rebuild and re-check *every* function that reads
   that declaration — not only the one you were editing.
4. The PR body lists each function with its verdict, and names any that changed spelling during the
   merge and why.

If a resolution breaks a previously-matching function: **fix the source, do not drop the function.**
Find the shared spelling that keeps both byte-exact — round 2's unified `u16` layout under the weaker
name `targetIndex` did exactly that, and the disputed bit was then settled outright by one function's
own matching code. Forking the declaration to dodge the conflict, or reverting a function to assembly,
are last resorts that must be stated loudly in the PR body and the report, never quietly taken.

**The tool fixes (deliverable #2).** A defect that *blocked matching work* gets fixed in its own repo,
on its own branch, now — Transmuter not running, gba-kit reading zeros for a null symbol. Anything
else is logged, not patched mid-round.

- **asmlift**: do not patch it during the round; the numbers describe one pinned commit. Route each
  defect to `/match-function` afterwards, with the benchmark rows that carry it (Phase 7).
- **Transmuter / gba-kit**: fix or file, your call on cost. If you fix, it is a separate PR in that
  repo with a test, and the report says which round-N numbers predate the fix.

## Phase 7 — Report

Write `research/asmlift-dogfood-report-round<N>.md`. **Structure it around what this round actually
learned, not around the previous round's table of contents.** The prior reports are a source of
questions, not a template: round 2 devoted its longest section to the ELF/DWARF gain because that was
a brand-new capability being measured for the first time — re-running that section now, on a feature
that has been in place for rounds, would produce a paragraph nobody needs. Let the sections that earn
space be the ones where this round changed someone's mind.

Decide the shape yourself, and say in one line why you chose it. A reasonable default is: what landed ·
a scoreboard dense enough to audit · the two or three findings that matter most, each with the evidence
that decided it · the per-tool defect logs · what you got wrong · what to do next · how to reproduce.

Whatever the shape, these have to be somewhere in it:

- **Both deliverables, plainly.** What landed in the PR (and what didn't and why), *and* the defect
  logs for asmlift, Transmuter and gba-kit — each defect with what it actually cost this round, not a
  wishlist. A defect nobody hit is a note, not a finding.
- **The honest denominators.** The population sweep from Phase 2, the decline rate, and how the real
  flow compares to what the benchmark reports for the same capability. Uncomfortable numbers first.
- **Round-over-round.** Re-test the prior round's stuck functions *and re-examine its diagnoses* —
  round 2 proved two of round 1's confident explanations wrong ("register allocation" was really a
  bitfield idiom). Then assume this round's diagnoses are wrong too, and say which are least supported.
- **What to point the tools at next**, ranked by evidence. For asmlift defects that means naming the
  benchmark rows that carry them (method in `research/dogfood-gaps-vs-benchmark-2026-08-02.md`), since
  that is what `/match-function` consumes — and the benchmark's leverage ranking is routinely
  *inverted* from the report's own, so check rather than assume. For Transmuter and gba-kit, an issue
  or a PR is worth more than a paragraph.
- **Reproducing this**: tool commits, the worktree recipe, the scripts you had to write, and any
  number that is already stale because a tool was fixed mid-round.

Then update the memory files under
`~/.claude/projects/-Users-macabeus-ApenasMeu-decompiler-asmlift/memory/` (at minimum
`asmlift-adversarial-validation.md` and `klonoa-first-shipped-match.md`).

---

## Hard rules

1. **Ship the matches, in one PR.** Every function that reaches `make compare` → `OK` gets named,
   documented, committed and pushed in a **single** `kl-eod-decomp` PR. Work that stays in `/tmp` did
   not happen.
2. **The round is done when the *merged* branch matches, function census included** — never when the
   individual worktrees did. Conflict resolutions silently break byte-exactness; re-verify after each
   one, and never drop a function to close a conflict without saying so.
3. **Never write to the user's live checkouts, and never push `main`** in any of the three repos.
   Worktrees and feature branches only.
4. **A score is not a match.** Only `make compare` is — and only on the merged branch.
5. **Numbers come from commands you ran**, shown or quoted. Recompile any score another tool reports
   before repeating it — Transmuter reported a 152→34 improvement that did not exist.
6. **asmlift stays pinned for the duration.** Log its defects; fix them after the round.
7. **Never declare a function irreducibly unmatchable from hand experiments.** Name the blocking
   hypothesis and leave it open.
8. **A placeholder name beats a guess**, and an unverified runtime claim beats nothing only if it is
   labelled as unverified.
9. **Never use an `asm("")` barrier, and never count a function that carries one as matched.** A
   barrier is never load-bearing — it is a workaround for not having found the right C, and it can
   *always* be made to work, which is exactly the trap: it ends the search and leaves behind
   something the original source could not have contained. The plain-C levers to try instead are
   catalogued in `<klonoa>/docs/learnings/agbcc-source-shape-levers.md`. Same reason Transmuter's
   `asm-barrier` rule must be treated as inadmissible: it is that tool's highest-yield rule by
   construction and can only produce source you cannot ship.
10. `research/` is gitignored — **never cite those paths** in klonoa commits, PR bodies, or anything a
   reader off this machine sees.
