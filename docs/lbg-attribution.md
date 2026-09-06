# LoadBGTilemapData attribution

This is a **priced null, not a plan to move the score**. It adds four benchmark rows and
reproducible attribution evidence. No decompiler implementation changes are proposed.
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

| Finding                                                                             | Measured price                                                                                                               | Compiler mechanism / asmlift ownership                                                                                                                                                                                                                               | Benchmark disposition                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spill declaration order is already recovered                                        | Reversing the reference's six spills adds 33 symbol rows or 21 raw rows, in either FAKE condition; register homes stay fixed | `gcc/stmt.c:3323`, `gcc/reload1.c:769`, `gcc/function.c:703`; shipped at `packages/core/src/target.ts:343`, `packages/core/src/l3/slotorder.ts:90`                                                                                                                   | Existing `spillorder` and `spillorder_rev` both freshly MATCH; no duplicate row or new lever                                                                         |
| Unused declaration / pointer scope are neutral                                      | All four reference cells unchanged: 59/76 symbol, 199/201 raw                                                                | Declaration eligibility `gcc/stmt.c:3312`; local construction `packages/core/src/structure/structure.ts:4582`                                                                                                                                                        | Negative controls in the declaration curve; no failing round-trip shape, hence no additional row                                                                     |
| Splitting an initial table index changes value identity, not just declaration order | Without FAKE: 76→261 symbol, 201→321 raw; loop var_r3 changes r3→r4. With FAKE, neutral                                      | Optimized RTL priorities `gcc/global.c:605`, search `:926`; **no asmlift inverse-allocator site exists**. Compiler feedback would surround L3 candidate formation, not justify a new IR level                                                                        | Full-function loss, not a verified minimal general gap; no new row claimed from this intervention                                                                    |
| Taking a local's address is not a register-home lever                               | 277/265 symbol, 291/291 raw, against 59/76 and 199/201 baselines                                                             | Register eligibility `gcc/stmt.c:3312`; L3 local construction `packages/core/src/structure/structure.ts:4582`                                                                                                                                                        | Adds an observable volatile pointer store; its whole score is not attributable solely to the changed home. Existing address/out-parameter family owns that operation |
| Extern array-base evaluation order survives in the control                          | `ereadctl`: 2 rows, the index shift moved across the base load                                                               | Established array/pointer expansion fork `gcc/c-typeck.c:1383`, `:1449`, `:1469`; shape recovery `packages/core/src/raise/globalshape.ts:890`, consumer `packages/core/src/rank.ts:1177`; order licensing at `globalshape.ts:924` and `rank.ts:2309`                 | New `ereadctl` records the ordering residual; no licensing guard or proposed two-point fix is claimed                                                                |
| A same-value store affects the compiled loop even after the store disappears        | `ereread`: 11; `erback`: 12, including 10 strict register-only rows                                                          | Established allocator `gcc/global.c:605`, `:926`; loop motion `gcc/loop.c:1833`. The pair verifies emitted behavior, not a newly instrumented optimizer cause. **No asmlift inverse-allocator site exists**; L3 candidate/compile feedback is the ownership boundary | New `ereread`, `erback`, and paired control `erbctl`; full decomposition in the extern study                                                                         |
| High-register sibling residuals generalize, but are mixed                           | `sub_0804C484`: 54/106 strict register-only rows; other categories remain distinct                                           | Established allocation mechanisms above; absent inverse site, L3 feedback ownership                                                                                                                                                                                  | Generality evidence for `value-home`; not a new isolated compiler capability or a duplicate sibling row                                                              |

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
remains extern; neither tool receives the original global layout as context. Function parameters
are named, and both void functions carry `returnsVoid` metadata. Existing feature vocabulary is
used; no new tag is needed.

| Row      | agbcc asmlift | m2c                           | Role                                                   |
| -------- | ------------: | ----------------------------- | ------------------------------------------------------ |
| ereread  |            11 | declined: `extern ? gReadBgs` | Same-value-write gap, mixed residual                   |
| ereadctl |             2 | declined: `extern ? gReadBgs` | No-write intervention control; ordering gap, not MATCH |
| erback   |            12 | declined: `extern ? gReadBgs` | Read-back gap, mostly register-only                    |
| erbctl   |            12 | declined: `extern ? gReadBgs` | No-write intervention control with a mixed residual    |

Every m2c decline belongs first to unknown extern-type recovery (`? placeholder`), not allocation.
The family cannot give a numerical comparison of the tools' allocator recovery. Existing raw
`rereadctl` freshly MATCHes, but its score does not replace the extern control's score.
No asmlift row in this family declines. The sibling study instruments its three declines and
hands them to existing outgoing-stack-argument, mixed-width-field, and unread-stack-spill rows.

All four new rows were smoked with the required command before a full benchmark run:

```sh
pnpm bench run --tier synthetic --only ereread --toolchain agbcc --serial
pnpm bench run --tier synthetic --only ereadctl --toolchain agbcc --serial
pnpm bench run --tier synthetic --only erback --toolchain agbcc --serial
pnpm bench run --tier synthetic --only erbctl --toolchain agbcc --serial
```

All exited 0 with completed row records. `--only` is a substring selector: `ereadctl` also ran the
existing `rereadctl` control. Each invocation selected only one _new_ row. No full run was used
for smoke discovery.

## Evidence and reproduction

- [Declaration curve and observed homes](lbg-attribution-declarations.md): two published-cell spot
  checks, seven variants across four basin/FAKE conditions, and real/trace-off/trace-on neutrality.
- [Compiler instrumentation](lbg-attribution-compiler.md): environment-gated scratch-only patch,
  exact named homes, unchanged manifest of 2,104 real-toolchain files.
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

## Validation status

Source rows were committed as `b2f4506a`; review corrected the ordering control’s feature tag
in `8f2aeb0b`. Two full runs are budgeted exactly: the zero-flip gate and the final post-rebase
publication run. The first full run completed 751 synthetic and 252 real rows at `aa3c8093`.
A clean scoped synthetic rerun replaced a tier whose dirty stamp correctly detected an
accidental Python bytecode file; the stamp was never edited. Merge, regression and diff
then ran in that order. Regression found `llcmp:agbcc` MATCH→11 against the newly advanced
`origin/main`; full cache verification reproduced 11 (6 objects verified, no disagreements).
Rebasing onto upstream `5efc34cc` brought in its short-circuit fix; a scoped rerun
then produced `llcmp:agbcc` MATCH for both tools (exit 0). Final full-run verification
and artifact provenance are still pending. The two existing m2c switch rows
`sw_jtfall`/`sw_jtfalldesc` changed from failed to nonmatch:1 and reproduced in a scoped
rerun. Both artifacts name the same m2c commit; no cause for the earlier failures was
established, and the status changes are retained rather than hidden.

The first full run took 8,288 seconds with the default cache cap. Subsequent runs use
`ASMLIFT_CANDCACHE_MAX_MB=16384` to avoid repeated eviction scans; scoring and compiler
flags are unchanged, and normal runs retain default cache verification. The clean synthetic
rerun completed in 171.8 seconds.

Validation uses Node 24.15 and the installed GNU cpp-14 shim on PATH. Node 23.11 reproduced an
`rmSync` directory-symlink failure in both a standalone script and the unchanged source checkout;
the same test passes under Node 24. Apple cpp added a blank line in the preprocessing-identity
test; the documented GNU preprocessor passed all 21 focused tests. Neither issue was fixed by
changing project sources or test assertions.

- `npx vitest run` was executed against the root config. After fixing the Node prerequisite,
  fork-pool runs passed all 3,370 tests but exited 1 on a worker `onTaskUpdate` RPC timeout.
  One-worker execution reproduced it. An all-thread experiment was stopped after the focused
  environment test demonstrated that changing HOME inside a thread does not reproduce fork
  behavior; it is not reported as a passing gate.
- The complete root-config suite then passed **201 files / 3,370 tests, exit 0**, using the supported
  Vitest API to route only the long synchronous fuzz file to threads. All other files retain forks.
  No tests or iterations were filtered, and unhandled errors still fail the run. The focused pair
  first passed 67/67 tests; the full invocation was:

  ```sh
  node --input-type=module -e 'import { startVitest } from "vitest/node"; const ctx = await startVitest("test", [], {run:true,maxWorkers:1,poolMatchGlobs:[["**/narrowlocal-fuzz.test.ts","threads"]]}); await ctx?.close();'
  ```

  This is supplemental strict validation with an execution-pool workaround, **not** a claim that
  the unmodified `npx vitest run` command exited 0 on this loaded machine.

- `pnpm test:matching`: **41 files / 354 tests passed, zero skipped, exit 0**. The worktree’s
  checkout-gated tests use a link to the existing benchmark checkout; it is not a new checkout
  or a source modification. The initial run’s missing-checkout skips and Apple-cpp failure were
  remedied before this complete rerun.
- `pnpm typecheck`, `pnpm lint`, and `pnpm format` exited 0. Lint’s pre-existing warnings remain;
  the two warnings introduced in the analysis script were corrected.

The four individual benchmark smoke commands were repeated under Node 24/GNU cpp and reproduced
11/2/12/12, with the same m2c placeholder declines. A full benchmark was not used to discover
these environment prerequisites.

Later validation attempts must also be retained: the unmodified root command passed 3,321
and failed 49 tests (7 RPC errors); affected-file retries reduced this to the isolated
`nearbase rides at BOTH orderings` 5-second timeout, which still failed alone. No test
deadline or assertion was changed. These failures prevent claiming the required unmodified
root gate is green, despite the earlier complete 3,370-test supplemental pass.

After rebase onto `5efc34cc`, the required unmodified `npx vitest run` completed with
**201 files: 184 passed / 17 failed; 3,388 tests: 3,355 passed / 33 failed; seven
`onTaskUpdate` RPC errors; exit 1**, in 632.24 seconds. Reported failures were test or
hook timeouts. A subsequent full root-config rerun using the earlier one-worker workaround
was **stopped at the user’s request to skip the complete suite and document it**. Its partial
passes are not a completed gate. No further complete-suite retry is planned, and the required
unmodified root suite is explicitly not reported as passing. Logs remain in the worktree’s
ignored `apps/benchmark/results/root-rebased.log` and `root-serial-rebased.log`.

The post-rebase `pnpm test:matching` attempt was also **stopped at the user’s explicit
request to skip matching tests and document it**. No post-rebase matching pass is claimed.
The earlier 354-test pass above belongs to the pre-rebase tree. The interrupted log is
`apps/benchmark/results/matching-rebased.log`; no further matching run is planned.

Post-rebase `pnpm typecheck`, `pnpm lint` (zero errors, 109 existing warnings), and
`pnpm format` completed successfully.
