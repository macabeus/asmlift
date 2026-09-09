# LoadBGTilemapData attribution

This is a **priced null, not a plan to move the score**. It adds four benchmark rows and
reproducible attribution evidence. No decompiler implementation changes are proposed.

**Every score in this study was measured at asmlift source `a56952a`.** `ereadctl` has since
MATCHed — see the ledger row for the order licence — so its `2` is what this family measured, not
a current delta. The dated capture and residual tables below are left as measured.
The experiments confirm the shipped spill-order capability, show that changing value identity
can change register homes while losing score, and separate allocation drift from global-address
ordering, loop structure and literal-pool data. None licenses a new score-improving lever.

## Measurement boundary

The source baseline is `a56952ad`. The preliminary canonical run, from the benchmark-owned
`asmlift-benchmark` checkout with its `klonoa-eod-syms.elf`, printed:

```text
asmlift: [progress] 1/225792 candidates scored, best so far 683
```

That preliminary run was stopped after the fan was identified. The full run uses an untracked
copy of the same `decomp.yaml`, adding only capture copies after assembly. Each compiler call
gets its own capture directory; `cand.i`/`cand.s` worker paths are reused and cannot identify a
candidate. The preprocessed unit, assembly and object are retained together. The source bundle
was built in the separate attribution worktree. No source under `packages/` was edited.

The completed captured run scored all 225,792 candidates and reproduced the raw winner at 376. The best symbol candidate was 455, independently recompiled and rescored; the supplied
462 was not reproduced. The 376/386 spill-order ablation remains prior evidence, not a new
measurement here. See the [completed baseline census](lbg-attribution-baseline.md).

The target still contains four `lsls r0, r0, #0x00` alignment pads, confirmed by the prescribed
assembly search. Identical bytes can therefore have different ARM mapping-symbol presentation.
No constant pad penalty is subtracted from any price in this report.

The dataset mentions LoadBGTilemapData in explanatory comments but contains no row whose symbol
is LoadBGTilemapData; the committed results likewise contain no such result. The ranked run is
its measurement, and the new synthetic rows measure their own compiled targets.

## Findings and row ownership

Prices are local to the named experiment and basin. A small-probe score is not a component to
subtract from the large function's score.

| Finding                                                                                            | Measured price                                                                                                                                                                                                                                                             | Compiler mechanism / asmlift ownership                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Benchmark disposition                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spill declaration order is already recovered                                                       | Reversing the reference's six spills adds 33 symbol rows or 21 raw rows, in either FAKE condition; register homes stay fixed                                                                                                                                               | `gcc/stmt.c:3323`, `gcc/reload1.c:769`, `gcc/function.c:703`; shipped at `packages/core/src/target.ts:343`, `packages/core/src/l3/slotorder.ts:90`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Existing `spillorder` and `spillorder_rev` both freshly MATCH; no duplicate row or new lever                                                                                                                                                                                                                             |
| Unused declaration / pointer scope are neutral                                                     | All four reference cells unchanged: 59/76 symbol, 199/201 raw                                                                                                                                                                                                              | Declaration eligibility `gcc/stmt.c:3312`; local construction in `structure/structure.ts`'s `slotsOfName` build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Negative controls in the declaration curve; no failing round-trip shape, hence no additional row                                                                                                                                                                                                                         |
| Splitting an initial table index changes value identity, not just declaration order                | Without FAKE: 76→261 symbol, 201→321 raw; loop var_r3 changes r3→r4. With FAKE, neutral                                                                                                                                                                                    | Optimized RTL priorities `gcc/global.c:605`, search `:926`; **no asmlift inverse-allocator site exists**. Compiler feedback would surround L3 candidate formation, not justify a new IR level                                                                                                                                                                                                                                                                                                                                                                                                                                 | Full-function loss, not a verified minimal general gap; no new row claimed from this intervention                                                                                                                                                                                                                        |
| Taking a local's address is not a register-home lever                                              | 277/265 symbol, 291/291 raw, against 59/76 and 199/201 baselines                                                                                                                                                                                                           | Register eligibility `gcc/stmt.c:3312`; L3 local construction in `structure/structure.ts`'s `slotsOfName` build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Adds an observable volatile pointer store; its whole score is not attributable solely to the changed home. Existing address/out-parameter family owns that operation                                                                                                                                                     |
| A declared extern array subscripted inside a loop costs two, and neither fact costs anything alone | `ereadctl`: 2 rows, the index shift moved across the base load. `ername` keeps the loop without the array shape and MATCHes; `erflat` keeps the array shape without the loop and MATCHes; `gReadBgs[4]` for `[]` still scores 2                                            | Established array/pointer expansion fork `gcc/c-typeck.c:1383`, `:1449`, `:1469`; shape recovery `raise/globalshape.ts`'s `inferGlobalArrays`, consumed at its probe site in `rank.ts`. The order licence was a hypothesis when this was measured, named with no guard instrumented, and the `/livebase` roster note in `rank.ts`'s `enumerateCandidates` records it empty on both symbol-map arms of LoadBGTilemapData. `erflat` MATCHes carrying `unsigned/orderbase`, so the axis reaches this basin; #159 then showed it reached the LOOP arm too and lost on `HoistPlacement`, and `/orderbase/scoped` closed `ereadctl` | New `ereadctl` records the conjunction and new `ername`/`erflat` bracket it from both sides; no guard is named and no two-point fix is proposed                                                                                                                                                                          |
| A read-back collapses the price of a same-value store                                              | The same-value write costs 9 with no read-back (`ereread` 11 against `ereadctl` 2) and 0 with one (`erback` 12 against `erbctl` 12); `erback` carries 10 strict register-only rows (`ereadctl` has since MATCHed; the 9 is what this family measured, not a current delta) | Established allocator `gcc/global.c:605`, `:926`; loop motion `gcc/loop.c:1833`. The pair verifies emitted behavior, not a newly instrumented optimizer cause. **No asmlift inverse-allocator site exists**; L3 candidate/compile feedback is the ownership boundary                                                                                                                                                                                                                                                                                                                                                          | New `ereread`, `erback`, and paired control `erbctl`; full decomposition in the extern study                                                                                                                                                                                                                             |
| High-register sibling residuals generalize, but are mixed                                          | `sub_0804C484`: 54/106 strict register-only rows; other categories remain distinct                                                                                                                                                                                         | Established allocation mechanisms above; absent inverse site, L3 feedback ownership                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Generality evidence for `value-home`; not a new isolated compiler capability. It also cannot become a real row as things stand: the benchmark's pinned kleod checkout carries it as `StreamCmd_SetEntityTransform` in `src/gfx.c` under `INCLUDE_ASM`, and every one of the 42 `kleod.json` entries requires reference C |

The address-immediate constraint remains a supplied compiler fact (`gcc/config/arm/thumb.md:595`),
not a new priced lever: high-register homes can require extra low-register operations. No new
asmlift cost-inversion site exists; it would need measured allocation feedback around L3 emission.

**Reach terminology:** these experiments establish _loses_ for several full-function source
interventions and _neutral_ for others. They do not count zero generated labels for a new spelling.
No new _no reach_ or _does not compose_ claim is made. In particular, non-additive scores alone
do not show that Cartesian axes cannot enumerate a combination. A full Cartesian product can
reach it if both transformations are admitted and compose; missing labels require separate evidence.
The task's previously closed ideas remain excluded, not proposed again.

## Benchmark rows

Each source is verbatim from a probe compiled before insertion into the dataset. Extern data
remains extern; these rows pass no global layout as context, which is a choice and not a corpus
rule — see the extern study for what supplying it does. Function parameters are named, and the
void functions carry `returnsVoid` metadata. Existing feature vocabulary is used; no new tag is
needed. `erbctl` is not tagged `value-home`: six of its twelve rows are register-only and it
carries an opcode mismatch, which is not a diff dominated by where a value lives.

| Row      | agbcc asmlift | m2c                           | Role                                                        |
| -------- | ------------: | ----------------------------- | ----------------------------------------------------------- |
| ereread  |            11 | declined: `extern ? gReadBgs` | Same-value-write gap, mixed residual                        |
| ereadctl |     2 → MATCH | declined: `extern ? gReadBgs` | The array-shape × loop conjunction; intervention control    |
| erback   |            12 | declined: `extern ? gReadBgs` | Read-back gap, mostly register-only                         |
| erbctl   |            12 | declined: `extern ? gReadBgs` | No-write intervention control with a mixed residual         |
| ername   |         MATCH | declined: `extern ? gReadBgs` | One-fact control: the loop without the declared array shape |
| erflat   |         MATCH | declined: `extern ? gReadBgs` | One-fact control: the declared array shape without the loop |

Every m2c decline belongs first to unknown extern-type recovery (`? placeholder`), not allocation.
The family cannot give a numerical comparison of the tools' allocator recovery. Existing raw
`rereadctl` freshly MATCHes, but its score does not replace the extern control's score.
No asmlift row in this family declines. The sibling study instruments its three declines and
hands them to existing outgoing-stack-argument, mixed-width-field, and unread-stack-spill rows.

Every new row was smoked with the required command before a full benchmark run:

```sh
pnpm bench run --tier synthetic --only ereread --toolchain agbcc --serial
pnpm bench run --tier synthetic --only ereadctl --toolchain agbcc --serial
pnpm bench run --tier synthetic --only erback --toolchain agbcc --serial
pnpm bench run --tier synthetic --only erbctl --toolchain agbcc --serial
pnpm bench run --tier synthetic --only ername --toolchain agbcc --serial
pnpm bench run --tier synthetic --only erflat --toolchain agbcc --serial
```

All exited 0 with completed row records. `--only` is a substring selector: `ereadctl` also ran the
existing `rereadctl` control. Each invocation selected only one _new_ row. No full run was used
for smoke discovery.

## Evidence and reproduction

- [Declaration curve and observed homes](lbg-attribution-declarations.md): two published-cell spot
  checks, seven variants across four basin/FAKE conditions, and real/trace-off/trace-on neutrality.
- [Compiler instrumentation](lbg-attribution-compiler.md): environment-gated scratch-only patch,
  exact named homes, unchanged manifest of 2,104 real-toolchain files.
- [Hypothesis ledger and exclusions](lbg-attribution-ledger.md): every premise this round
  confirmed or falsified, and what each result licenses.
- [Extern probes](lbg-attribution-extern.md): every captured candidate rescored, retained compiled
  units, separate instruction-shape alignment and per-value pool census.
- [Sibling census](lbg-attribution-siblings.md): current upstream source checked in scratch,
  16 functions, 3 MATCH controls, 10 scored residuals and 3 instrumented first blockers.
- [Adversarial ledger](lbg-attribution-review.md): findings, verdicts, remedies and remediation audit.

The normalization tools retain tagged objdiff tokens and distinguish register-only substitutions
from changed register-list arity, stack offsets, immediates, destination annotations, relocations
and data. Objdiff uses destination annotations for both branches and PC-relative literal loads;
the baseline census contextually separates those cases.
Independent shape alignment strips instruction aliases and normalizes pool/branch references;
its counts are not objdiff scores. Literal data never counts as register drift.

Every number in this document is the **project-checkout vehicle**, not a benchmark row: it reads
the project's committed `asm/nonmatchings/…` split file and scores against the project's own
`build/src/gfx.o`. `LoadBGTilemapData` has no benchmark row at all — it is a klonoa checkout
function — so none of these numbers is comparable with a harness outcome, here or on a neighbouring
function: a row is scored on a different input `.s` down a different compile path. See "The VEHICLE
is part of the number" in [ranked-repro.md](ranked-repro.md).

Set `REPO` to the attribution worktree and run from the benchmark-owned checkout:

```sh
node "$REPO/packages/cli/dist/asmlift.mjs" \
  asm/nonmatchings/gfx/LoadBGTilemapData.s \
  --config decomp.yaml --score-against build/src/gfx.o \
  --proto '{"thunk_HeapFree":{"params":1}}' --jobs 6 --progress \
  > "$SCRATCH/winner.c" 2> "$SCRATCH/ranked.err"
```

Build the bundle first and export the toolchain overrides as instructed by
[ranked-repro.md](ranked-repro.md). For capture, use an untracked config copy and append `cp`
operations for `$PRE_FILE`, `$ASM_FILE`, and `{{outputPath}}` into a fresh per-call scratch
directory. Delete the config copy after use. The capture changes no compile flags or declarations.
Use `find-capture.py` to locate body-token matches, then score retained objects; stdout's
declaration block is not a substitute for the scored compile unit.

## Validation status of this study's own rounds

_This section is the record of the rounds THAT PRODUCED THIS STUDY (measured at asmlift source
`a56952a`), not a statement of the repo's test posture. For the gates a change has to pass, see
[docs/releasing.md](releasing.md) and the CI workflow._

Source rows were committed as `b2f4506a`; review corrected the ordering control's feature tag
in `8f2aeb0b`. Two full runs were budgeted exactly: the zero-flip gate and the final post-rebase
publication run. The first full run completed 751 synthetic and 252 real rows at `aa3c8093`, in
8,288 seconds. A clean scoped synthetic rerun replaced a tier whose dirty stamp correctly detected
an accidental Python bytecode file; the stamp was never edited. Merge, regression and diff then ran
in that order.

Three artifact facts the rest of this study rests on:

- Regression found `llcmp:agbcc` MATCH→11 against the newly advanced `origin/main`; full cache
  verification reproduced 11 (6 objects verified, no disagreements). Rebasing onto upstream
  `5efc34cc` brought in its short-circuit fix, and a scoped rerun then produced `llcmp:agbcc`
  MATCH for both tools (exit 0).
- The two existing m2c switch rows `sw_jtfall`/`sw_jtfalldesc` changed from failed to nonmatch:1
  and reproduced in a scoped rerun. Both artifacts name the same m2c commit; no cause for the
  earlier failures was established, and the status changes are retained rather than hidden.
- The four individual benchmark smoke commands were repeated and reproduced 11/2/12/12, with the
  same m2c placeholder declines. A full benchmark was not used to discover any of this.

**Neither the unmodified root `npx vitest run` nor a post-rebase `pnpm test:matching` was claimed
green for this study** — the root suite's last complete post-rebase invocation exited 1 on test and
hook timeouts, and the post-rebase matching attempt was stopped at the user's explicit request; a
supplemental pass under an execution-pool workaround is not that gate. `pnpm typecheck`, `pnpm lint`
and `pnpm format` exited 0 both before and after the rebase.
