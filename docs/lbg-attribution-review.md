# Adversarial review ledger

## Round 1 — declaration and compiler studies

Review scope: Study 1/2 reports, generated variants, trace interpretation, and reproducibility.
This is a subset review; the parent review must cover benchmark families, siblings and the final plan.

| ID  | Finding                                                                                                                          | Verdict                                     | Remediation / evidence                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Address-sp4's initial pseudo is dead after its DECL_RTL is replaced; reading `hard=-1` as its physical home is invalid.          | Accepted, fixed                             | Extended named-declaration tracing captures replacement and volatile pointer declarations. All four arms emit `add r2, sp, #0x8; str r2, [sp]`; corrected homes sp4=sp+8 and address_sp4=sp+0. Named RTL retains a frame-base register, so the assembly establishes the final offset. |
| D2  | Plain-reference neutrality alone does not prove all perturbations are neutral under instrumentation.                             | Accepted, fixed                             | Recompiled all 30 measured variants real/off/on. All 30 assembly comparisons passed, accounting for the driver's appended alignment footer.                                                                                                                                           |
| D3  | Full split/merge/escape interventions are not strictly declaration-list edits.                                                   | Accepted, documented                        | Report states the use rewrites and volatile pointer store explicitly; escape scores are not priced as pure declaration effects. Split-induced r3→r4 without FAKE is not presented as falsifying the declaration-permutation null.                                                     |
| D4  | The FAKE-removal filter might accidentally delete unrelated semantics, including a declaration or a whole transformed statement. | Rejected after source verification          | Exactly two reference lines contain `// FAKE?`: `var_r3 = arg1;` and `if (gBgInfo);`. Generated minus arms remove exactly those lines. Split retains the initial fake assignment only in plus arms, as intended. Four baseline cells reproduce 59/76/199/201; no basin mixing.        |
| D5  | Generated sources might differ from measured source files.                                                                       | Rejected after execution                    | Ran the committed generator into fresh scratch and compared all 29 generated C files byte-for-byte to measured inputs. All identical; measured plain is duplicate baseline-sym-plus.                                                                                                  |
| D6  | Reversing spills might change register or pool allocation despite unchanged named homes.                                         | Rejected after compiled-assembly comparison | Exactly 34 symbol / 35 raw text lines differ per condition, exclusively sp-offset operands; all other assembly, including pool directives and registers, identical. These counts are explicitly source lines, not objdiff score deltas.                                               |
| D7  | Existing spill rows were cited without fresh asmlift execution.                                                                  | Accepted, fixed                             | Scoped agbcc benchmark executed spillorder and spillorder_rev, both asmlift MATCH and m2c noncompile(1). Repeated spillorder_rev alone with same outcome. Selector spillorder is a substring and selected both rows; documented rather than claiming it ran one.                      |
| D8  | A nonexistent L4/L5 level was suggested for allocator inversion.                                                                 | Accepted, fixed                             | Removed. Tower has L1–L3; compiler feedback would surround L3 candidate generation, with no new level justified by this null.                                                                                                                                                         |
| D9  | Split/merge losses could be called new benchmark gaps without a minimal round-trip.                                              | Accepted as limit; no fabricated row        | Report explicitly states no such probe was run and no new family is licensed by those full-function scores. Existing spill-order and address/out-parameter ownership is cited; the parent study must supply any new general gap rows.                                                 |

## Round 2 — remediation re-audit

Carried all D1–D9 findings and verdicts above. The invalid premise that the old sp4 pseudo
was its final physical home is withdrawn; it is not reused in the corrected home table.

- D1: checked all four emitted address-sp4 prologues, not just symbol +FAKE; they agree on sp+8/sp+0.
- D2: checked completion output `30 variants real/off/on assembly identical`; all inputs include the perturbations.
- D3/D4: interventions remain clearly separated from declaration-only effects; no claim that FAKE removal itself preserves recovered semantics.
- D5: generator reproduction remains deterministic and files contain no checkout-specific paths.
- D6: score deltas (33/21) remain distinct from changed assembly-line counts (34/35).
- D7: smoke results name both tools and do not manufacture an m2c decline attribution.
- D8/D9: report has no nonexistent tower level or claimed new row without a round-trip.

Remaining limitation: this review does not turn a full-function declaration perturbation into a
minimal general register-allocation benchmark gap. The reference curves are negative evidence.

## Logical review of the supplied interaction claim

D10 — accepted correction to a supplied premise: swap-alone losing while swap+aid wins
establishes non-additivity of score response. It does **not** establish that independently
enumerated Cartesian axes cannot reach swap+aid. A complete Cartesian product containing both
compatible transformations does contain that combination, and minimum selection can choose it.
A no-reach claim additionally needs observed absence of its label/body or a demonstrated failure
to compose transformations. The spot checks validate two published scores; they do not measure
asmlift reachability of all aids. No extra enumerator limitation is inferred from that table.

Re-audit D10: the corrected claim retains the empirical interaction and withdraws only the
unsupported logical conclusion. No score or basin has been altered.

## Independent broad Round 1 — plan, new rows, and evidence

Reviewed the plan, all four study reports, analysis scripts and the four synthetic additions at
`b2f4506a`. The full captured baseline and validation gates were explicitly pending; their known
pending status is not presented as a newly discovered defect. This round also carries D1–D10
above, including each rejection reason, for the next independent remediation audit.

| ID   | Finding                                                                                                                                                                                          | Verdict                                                                        | Remediation / evidence                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | `ereadctl` has `value-home` although its measured residual is two moved-address-scaling rows and zero register-only rows. That misattributes the row in feature summaries.                       | Accepted; root remediation requested                                           | Remove `value-home` from this ordering-only control and distinguish its role in the family comment. `global`/`array` remain justified by source. Do not remove the row or tune its source.                                                                                                                                                                                                                                               |
| R1-2 | The extern report and plan pair `globalshape.ts:924` with `rank.ts:1171` as if one directly consumed the other. They conflate the array-declaration inference and the separate ordering licence. | Accepted; extern report fixed, parent plan remediation requested               | Cite `inferGlobalArrays` at globalshape:890/rank:1177 separately from `orderLicensedGlobals` at globalshape:924/rank:2309, its L3 handoff rank:2370 and gate basecse:639. No guard firing is claimed without instrumentation.                                                                                                                                                                                                            |
| R1-3 | Arbitrary selection among minimum-score captures could attribute a different object than the CLI winning label.                                                                                  | Rejected as an object ambiguity after execution; evidence wording strengthened | Every extern score list has exactly one distinct SHA-256 at its minimum (4/72/40/40 captures). Reassembled all four retained `.s` files with exact harness assembler flags; each SHA matches that unique minimum. Recompiled all four retained `.i` files with the real compiler and benchmark flags; all four `.s` files are byte-identical. Therefore tied labels do not change the analyzed object. The report now states this proof. |
| R1-4 | “m2c declined” might be mistaken for an observed internal compiler/optimizer refusal.                                                                                                            | Accepted clarification, extern report fixed                                    | `extern ? gReadBgs` is an observed emitted marker, classified before compilation by `apps/benchmark/src/eval/outcome.ts:40`. It blocks numerical comparison but does not identify a private m2c refusal or demonstrate failed allocator recovery. All four row comments already name the extern placeholder and do not credit allocation.                                                                                                |
| R1-5 | ~~No sibling residual has a register-only majority~~ was a false census premise after token matching misclassified reordered register operands and commas.                                       | Accepted, already fixed before this broad review                               | The analysis first compares complete register-erased token sequences. Regenerated all ten sibling residuals; sub_0804C484 has 54/106 register-only rows, not 50/106. The sibling report strikes the false premise. Full token sequence retains register-list cardinality, so added/removed save registers remain structure.                                                                                                              |
| R1-6 | A probe score or a symbol-basin declaration price may have been subtracted from the raw LBG score.                                                                                               | Rejected after report and table audit                                          | Curves retain 59/76 symbol and 199/201 raw baselines independently; new rows are scored against their own objects. The plan explicitly refuses probe subtraction and fixed alignment subtraction. The pending LBG baseline is not assigned a partial best-so-far value.                                                                                                                                                                  |
| R1-7 | Full-function split/merge/address-taking findings lack new synthetic rows.                                                                                                                       | Rejected as an unfinished finding                                              | Each is explicitly a loss or semantic intervention with no independently minimized general gap. Existing spill/address families own measured established operations; the documents state why no new row is licensed. No implementation lever is manufactured.                                                                                                                                                                            |
| R1-8 | `erback`/`erbctl` might inherit the no-readback pair's causal behavior without actual compiler evidence.                                                                                         | Rejected for the reported emitted behavior                                     | Both have their own captured 40-candidate fans, retained compiled units, independently categorized residuals and source/compiler pair observations. Both score 12, but their residuals differ (10 strict register rows versus 6). Reports distinguish these objects and do not claim a newly instrumented deletion/hoisting pass.                                                                                                        |
| R1-9 | Captured assembly could be compared outside the requested ELF symbol or literal pools omitted from allocation counts.                                                                            | Rejected after script audit and evidence check                                 | `rowdiff.mjs` uses `displaySymbol` extents and both row streams. `residual.py` retains data directives, values, symbols and addends separately. Sibling/extern category totals equal their CLI scores. Separate shape alignment is explicitly not another score.                                                                                                                                                                         |

Reviewer command for the retained-object proof:

```sh
arm-none-eabi-as -mthumb -mthumb-interwork \
  docs/lbg-attribution-evidence/extern/erback-candidate.s -o "$SCRATCH/erback.o"
shasum -a 256 "$SCRATCH/erback.o"
```

Repeated for every retained candidate. Minimum object hashes observed:

- ereread: `f34f769d8d44265963a2b0cef2f857cb9eccca2e8f7dd9d81feff776bba5aa84`
- ereadctl: `1ae09058f7835b9193e12bedc1f10ba53f79517cd7a4f87f554ad9e6842a6c47`
- erback: `6980170f6a9278d64e15155ca672d9619929e240765bdc536220009b8343bb50`
- erbctl: `265928dd547ae924fbf26d34dafac92c9f91e1e0edd1c9a03a458fc9b5b49acf`

Do not replace the exact assembler flags with `-mcpu=arm7tdmi`: the resulting ELF attributes
change the whole-object hash. The initial reviewer invocation used that different option,
failed all four hash checks, and was rerun with the actual harness command before any conclusion
was drawn. The exact-command rerun passed all four; no mismatch explanation substitutes for it.

Round 2 must independently verify R1-1/R1-2 root edits, retain the rejection rationale for
R1-3/R1-6–R1-9, and check that no report restates the struck R1-5 premise. It must also review the
completed LBG census once available rather than treating its current pending status as evidence.

## Independent broad Round 2 — full remediation re-audit

Carries **all D1–D10 and R1-1–R1-9**, with the verdicts and rejection reasons above.
Scope is the main plan, all study reports, retained evidence, scripts and four new dataset rows.
The full ranked baseline/census and full benchmark/publication gates remain expressly reserved
for a final audit after completion; this review does not certify those pending measurements.

| Carried IDs | Re-audit verdict and evidence                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1–D2       | Remediation stands: address-taken homes use named traces plus final assembly, and the recorded 30-way real/off/on comparisons include every perturbation. No dead pseudo is presented as a physical home.                                                                                                                             |
| D3–D5       | Remediation/rejections stand: split, merge and volatile escape interventions are explicitly disclosed; exactly two FAKE lines are removed. Deterministic generation and measured-source identity remain recorded.                                                                                                                     |
| D6–D7       | Rejections/remediation stand: spill score deltas and assembly-line counts remain separate; scoped logs show both spill rows MATCH for asmlift and noncompile for m2c.                                                                                                                                                                 |
| D8–D10      | Invalid premises remain withdrawn: ~~an inverse belongs to an existing L4/L5~~; ~~non-additivity proves independent Cartesian axes cannot reach the combination~~. Reports name L1–L3 and require separate reachability evidence. No unminimized split/merge loss is sold as a new row.                                               |
| R1-1        | Fixed and independently checked: ereadctl has only global/array tags. Its two-row ordering residual is called an intervention control, not MATCH or allocator evidence.                                                                                                                                                               |
| R1-2        | Fixed and independently checked: main and extern reports separate inferGlobalArrays at globalshape:890/rank:1177 from orderLicensedGlobals at globalshape:924/rank:2309. Source lines confirm separate call sites; reports make no unobserved guard-fire claim.                                                                       |
| R1-3        | Rejection independently reproduced: all four score lists have one distinct minimum SHA; all four retained assemblies reassemble to it with exact -mthumb/-mthumb-interwork flags. Recompiled all four retained .i files with the real compiler and stated flags; assembly byte-identical. Counts/minima are 4/11, 72/2, 40/12, 40/12. |
| R1-4        | Clarification stands: m2c's first observed incompleteness marker is attributed to extern-type output recovery, not a private optimizer or allocator refusal. No numerical m2c allocation score is inferred.                                                                                                                           |
| R1-5        | Correction stands: ~~no sibling residual has a register-only majority~~ remains visibly struck. Retained census has 54/106 for sub_0804C484. No main/study report restates the invalid premise as fact.                                                                                                                               |
| R1-6–R1-7   | Rejections stand for the same reasons: each price stays within its basin/target; no fixed pad subtraction; full-function losses explicitly lack a minimized general gap and do not mint duplicate rows.                                                                                                                               |
| R1-8        | Rejection independently checked: read-back pair has its own 40-candidate evidence per row and distinct retained assembly, rather than borrowing the no-readback result. Decompositions remain mixed and optimizer-pass causality is not newly claimed.                                                                                |
| R1-9        | Rejection independently checked: 14 retained residuals (10 siblings, 4 extern) reconcile category sums and diff-kind sums to scores, and each per-value pool sum to its pool total. rowdiff uses symbol-bounded displays; shape alignment remains a separate convention.                                                              |

Additional Round 2 findings:

| ID   | Finding                                                                                   | Verdict                                    | Remedy / evidence                                                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2-1 | Extern report's pasted row-existence line numbers predate the family-comment expansion.   | Accepted, fixed                            | Reran the exact rg command and updated the paste to 2811/2819/2827/2834. All four named rows exist once.                                                                                                                                                                                                                                               |
| R2-2 | Family comment might omit a non-MATCH control or attribute a decline to the wrong family. | Rejected after dataset and smoke-log audit | Comment names ereread, ereadctl, erback, erbctl and existing raw rereadctl; explicitly calls both intervention controls non-MATCH and gives all four observed scores. It attributes all four m2c declines to the extern ? marker. There are no asmlift declines in this family. Each new row is agbcc-only and has its completed individual smoke log. |
| R2-3 | Sibling declines may point to nonexistent owner rows.                                     | Rejected after row-presence check          | Existing stkarg:2307, spill10:2331, uhalf:395 and utag:414 are present. Reports retain the three instrumented first-blocker outputs and do not credit their declines to allocation.                                                                                                                                                                    |

Remediation recheck for R2-1: updated four line numbers match current dataset output; no source,
feature assignment, score or result was changed by this documentation correction. No outstanding
study-document defect was found in this pass. This is **not** the reserved final baseline/census,
zero-flip, test-count, or artifact-provenance audit.

## Final independent Round 2 — completed baseline remediation audit

Carries the full **D1–D10, R1-1–R1-9, R2-1–R2-3 and F1–F5** ledgers, including the
rejection reasons and limits recorded above and in the baseline report. This pass independently
checks the newly completed baseline report, main report and retained baseline evidence. It is
not a certification of the still-pending final benchmark, unmodified test command, or artifact
publication gates. The post-rebase llcmp control is tracked separately by the parent validation.

| ID / carried group | Independent verdict and evidence                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1                 | Accepted remedy verified. Recomputed the contextual partition from the original scratch residual rows: exactly the listed 20 row IDs have ldr/ldr opcodes and a changed branch-dest annotation; the remaining ten have actual branch opcodes. Both original and contextual category totals equal376. ~~All30 renderer branch-target rows describe CFG changes~~ is withdrawn. Strict register194 and score376 remain unchanged.            |
| F2                 | Accepted correction verified. Reparsed all225792 score lines from the log whose SHA matches run-summary:179712 raw labels,46080 symbol labels, minima376/455; four symbol labels tie455. Retained symbol evidence names its unique captured object, same fresh-compile hash, and two named relocations. ~~The current symbol minimum is462~~ remains struck. No capture-label mapping or cause for the historical discrepancy is invented. |
| F3                 | Rejected attribution upheld. Target prologue reserves0x3c bytes and captured raw candidate0x34, confirming60→52. This does not isolate declaration ordering or falsify the independently matching spill controls. No new spill-order failure or row is claimed.                                                                                                                                                                            |
| F4                 | Rejected interpretation upheld. Independently summed per-value directives: target20 words/0 halfwords, candidate20 words/6 halfwords; contextual data residual14+5=19. Four target pads remain instruction-spelled. ~~Nineteen aligned data rows are nineteen changed words or a constant pad tax~~ is withdrawn; no subtraction is applied.                                                                                               |
| F5                 | Rejected aggregation upheld. The194 strict register rows are51.6% of376;258 arg-mismatch rows are68.6%, a different measure. The182 other rows remain mixed, with explicit ownership boundaries and no-minimal-pair/no-new-row dispositions. No additive capability price, allocator inverse, or score-improving lever is manufactured.                                                                                                    |
| D1–D10             | Earlier fixes and rejection reasons remain intact. Address-home evidence is distinguished from stale pseudos; interventions and FAKE conditions stay explicit; declared homes do not become an inverse allocator; the nonexistent L4/L5 and Cartesian non-reach premises remain withdrawn.                                                                                                                                                 |
| R1-1–R1-9          | Earlier fixes and rejection reasons remain intact. Ordering-only control tagging, separated shape/order sites, unique-minimum object proof, m2c placeholder attribution, corrected sibling majority, basin boundaries and separate residual conventions are retained. No invalid sibling-majority premise is restored.                                                                                                                     |
| R2-1–R2-3          | Earlier row-presence/control/decline audit remains the historical checked result; this baseline change adds no new dataset row or decline claim. Existing owner rows and explicit no-duplicate-row reasons remain the dispositions.                                                                                                                                                                                                        |

Additional retained-artifact verification: recomputed all four retained .i/.s SHA-256 values
against run-summary. The raw object mapping retains two normalized-body hits/one distinct object,
score376 and the original-capture hashes. Both archival .i files use sanitized diagnostic
filenames, as disclosed. During this audit the compiler reviewer completed fresh archival
compilation, replacing the earlier limitation. Independently checked both resulting .s/.o hashes
in `apps/benchmark/results/lbg-archive-check.log/confirmation.json` against the actual files and
retained assembly: both archival units reproduce the captured assembly and original object hashes. The raw
comparison contains582 aligned display rows. Independent shape counts remain a separate alignment
and are not added to the376-row score.

Remediation recheck: rederived F1's entire contextual category map equals the retained JSON,
not merely its total; all20 affected IDs match in order. F2's455 supersedes462 visibly, while
unknown historical cause and label identity remain explicit. F3–F5 preserve their rejected
interpretations and no-new-row rationale. No additional baseline evidence defect was found.
All writes in this audit were confined to this review document; Python ran with `-B`.

Final concurrent-remediation check: the alignment ownership citation now names the observed
`ASM_OUTPUT_ALIGN` macro at thumb.h:100, the objdiff gate and frontend boundary, without
inventing an allocator mechanism. The archival compilation evidence directory was renamed to
`lbg-archive-check.log` so Git actually ignores it. Its measured files were checked after the
rename; the root must keep the baseline reproduction path synchronized with that final name.
~~The sanitized archival units have not been compiled~~ is superseded by the verified compile
outputs above. All prior numerical/categorical conclusions remain unchanged.
