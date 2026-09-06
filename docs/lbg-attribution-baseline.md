# Completed LoadBGTilemapData baseline

This is a **priced null**, not a plan claiming an attainable score reduction. The completed
canonical fan confirms **376 in the raw basin** and **455 in the symbol basin**. Its residual is
mixed: **194 of 376 aligned differing rows (51.6%) are strictly register-only**. Neither that
count nor the other 182 rows is an additive price for a proposed missing capability.

The run used the benchmark's `asmlift-benchmark` checkout, its assembly, symbol ELF, compile
configuration and `build/src/gfx.o`, with the required `thunk_HeapFree` arity. The CLI bundle
reported source `a56952a`. The completed record is:

```text
225792 candidates scored, 0 dropped, 0 withheld, 0 synthesized
179712 raw labels; 46080 symbol labels
best unsigned/flip-branch/defsite/merge-names/addr-home/expr-home/uns-cmp/copy-defpos/livebase-block/volatile/coalesce-v20-v14/initfirst/raw-globals: 376
candidate cache: 225792 misses, 225792 stored; sample=2%
wall 8517.2s; RANKED_COMPLETE exit=1
```

Exit 1 denotes the completed nonmatch; this was not a stale-object exit 3. Input hashes and the
full completion lines are retained in [run-summary.json](lbg-attribution-evidence/baseline/run-summary.json).
The first recorded input fingerprints were taken **mid-run**, not at launch; the end check
matched them. This boundary is retained rather than represented as a start-to-finish hash audit.

The raw winner was located by exact normalized function-body correspondence with CLI stdout,
then checked using the **captured compiled unit**, including its synthesized declarations.
Two captures matched, with one distinct object SHA-256:
`7e9f6e826782b47a59a7b01a98e61f0af9036f275bce0e2d650123cfaa224535`.
The captured object scores 376; body similarity alone is not the scoring evidence.
The independent reassembly/recompilation is a separate validation from the completed fan.

The supplied historical symbol minimum ~~462~~ is **superseded by this run's 455**. Independent
capture discovery found a named-symbol object scoring 455, then fresh compilation with the
canonical flags reproduced **identical assembly and object bytes**, again scoring 455. The
object has `R_ARM_ABS32` relocations for `gBgInfo` and `gUnk_03004DB0`.
Its SHA-256 is `43110c6795cd60086a758bcc1d70f8b6af6b263ca4aa414d93a50440dc73aec1`.
Four non-raw labels tie at 455 in the log; capture discovery does not map this object to one
particular label. No cause for the historical seven-point discrepancy was established.
See [symbol-confirmation.json](lbg-attribution-evidence/baseline/symbol-confirmation.json).

## Residual conventions and classification

The raw comparison has 582 aligned display rows, 376 differing. Objdiff reports 258 argument
mismatches, 38 inserts, 54 deletes, 18 replacements and 8 opcode mismatches. Thus **68.6% is the
argument-mismatch fraction**, not a register census. The strict register test requires equality
of the **entire** register-erased token sequence, including punctuation and operand-list arity.
A push/pop with a different number of saved registers is not a pure register substitution.

The contextual categories below partition the 376 differing rows exactly once. Mixed labels
name changed token classes; they are not independently proven compiler mechanisms.

| Contextual category                                                          |    Rows |
| ---------------------------------------------------------------------------- | ------: |
| Register-only                                                                |     194 |
| Instruction insertion/deletion                                               |      87 |
| Immediate + operand structure + register                                     |      23 |
| Pool/data replacement or mismatch                                            |      14 |
| Opcode/structure                                                             |      10 |
| Actual branch-target annotation                                              |      10 |
| PC reference address + pool offset + register                                |       7 |
| PC reference address + register                                              |       6 |
| Operand structure + register                                                 |       5 |
| Pool/data insertion/deletion                                                 |       5 |
| Stack offset/immediate                                                       |       4 |
| PC reference address + pool offset                                           |       4 |
| PC reference address + operand structure + register + stack offset/immediate |       3 |
| Immediate + register                                                         |       2 |
| Register + stack offset/immediate                                            |       2 |
| **Total**                                                                    | **376** |

**F1 correction:** objdiff's `branch-dest` token also renders a PC-relative load's `(->address)`
annotation. Of 30 rows originally carrying the classifier's `branch-target` label, **20 are
`ldr`/`ldr` pairs** and only **10 are actual branch rows**. Those twenty belong to literal
placement/reference annotation, not CFG recovery. The retained summary supplies both the original
renderer-token categories and this contextual relabeling, including the twenty affected row IDs.
The correction changes neither score 376 nor strict-register count 194. It does not modify the
analysis script or claim that display addresses are additional encoded instruction operands.

Independent instruction-shape alignment reports 437 equal-shape pairs: 146 identical, 207
register-only and 84 normalized branch/pool pairs. It leaves 87 target and 65 candidate
instructions unmatched across 79 structural regions. This is a different alignment convention;
its counts cannot be summed into an objdiff score. The task's historical 386-object/41.3%
register-only measurement was not reproduced here, and these percentages do not establish an
allocation improvement or deterioration without reclassifying the older object identically.

## Full literal census

Counts are per distinct literal **word**, in the raw winner's basin, not aligned differing rows.

| Word            | Target | Candidate |
| --------------- | -----: | --------: |
| 0x08057acc      |      1 |         1 |
| 0x08057acd      |      0 |         1 |
| 0x030034a0      |      1 |         1 |
| 0x03003430      |      9 |         8 |
| 0x08189ccc      |      2 |         2 |
| 0x03004db0      |      1 |         1 |
| 0x03003478      |      1 |         1 |
| 0x040000d4      |      2 |         1 |
| 0x0300347a      |      1 |         1 |
| 0x03003434      |      1 |         1 |
| 0x0300346c      |      0 |         1 |
| 0x81000020      |      1 |         1 |
| **Total words** | **20** |    **20** |

The target has 10 distinct words; the candidate has 12. The candidate additionally renders six
zero halfwords, making 26 data rows and 13 distinct directive/value identities. The target
renders no halfword data inside this symbol; its split-assembly alignment pads are instructions.
Consequently this data census is not a census of every zero alignment byte on both sides.

**F4 disposition:** the 19 aligned pool/data residual rows are not nineteen changed words and
not a pad tax. Pool order, length and mapping-symbol presentation affect alignment. No fixed
12-point or other constant is subtracted. The candidate-only `0x08057acd` is a base-plus-one
literal; `0x0300346c` is the fixed element's pointer-cell address. These and the changed base
multiplicities are observed materialization shapes, not proof of an unobserved optimizer pass.

## Final Round 1 triage ledger

This carries F1–F5 for the required independent remediation re-audit; prior D/R1/R2 ledgers
remain in [the review record](lbg-attribution-review.md).

| ID  | Finding                                                                                      | Verdict and completed remedy                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Literal-load destination annotations were labeled branch targets.                            | Accepted. Contextually relabeled the 20 ldr/ldr rows; retained original labels and affected IDs. Ten actual branch rows remain. Score376 and strict-register194 are unchanged. |
| F2  | Supplied symbol462 disagreed with completed455.                                              | Accepted. Marked462 superseded and independently found, rescored and freshly compiled a captured named-symbol455 object. Cause remains unestablished.                          |
| F3  | Stack/frame differences might imply the shipped spill-order rule failed.                     | Rejected attribution. Frame60→52 and offset changes do not isolate declaration order; matching spill controls and explicit no-new-row disposition retained.                    |
| F4  | Nineteen aligned data rows might mean nineteen changed literal words or a constant pad cost. | Rejected interpretation. Full20/20-word and0/6-halfword census retained; mapping/order caveats explicit; no constant subtraction.                                              |
| F5  | All182 non-register rows might name one missing capability.                                  | Rejected aggregation. Separate ownership boundaries and no-row reasons retained; no causal minimal pair, additive price or new implementation inferred.                        |

## Ownership, remedies, and row dispositions

This section carries final-review F1–F5, alongside the prior review ledgers. Existing families
name ownership boundaries; their probe scores are not prices to subtract from this function.

| Finding / review remedy                                                                      | Compiler and asmlift ownership                                                                                                                                                                                                                                                                                                                                                                                                   | Row or explicit no-row reason                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Allocation: retain 194 strict rows without promising headroom                                | Established priority/search in `gcc/global.c:605` and `:926`. **No asmlift inverse-allocator site exists**; post-optimization compiler feedback would surround L3 candidate formation. `packages/core/src/ir/core.ts:108` records information lost when copies become one SSA value.                                                                                                                                             | Existing `reread`, new `erback`, and sibling sub_0804C484's 54/106 provide generality. No declaration-reorder lever is inferred.                                                                       |
| Pool/base-plus-offset materialization: retain both new literals and multiplicities (F4/F5)   | Established `gcc/explow.c:45` constant-address folding and `gcc/config/arm/thumb.h:926` empty address legalization. Existing inference `packages/core/src/raise/globalshape.ts:890`, ordering licence `:924`, and L3 base shaping `packages/core/src/l3/basecse.ts:639` are distinct seams, not observed firing guards here.                                                                                                     | Existing `harridx`/`arrbias`, `bgfixed`/`bgbaked`, and extern ordering controls are boundaries. No new minimal raw-basin pair or guard attribution was established, so no duplicate row.               |
| Frame/stack: do not call frame 60→52 an ascending-order failure (F3)                         | Established declaration/reload/frame mechanisms `gcc/stmt.c:3323`, `gcc/reload1.c:769`, `gcc/function.c:703`; shipped policy `packages/core/src/target.ts:343` and L3 `packages/core/src/l3/slotorder.ts:90`.                                                                                                                                                                                                                    | `spillorder`/`spillorder_rev` freshly MATCH. Address/out-parameter families own different operations. No isolated new spill-order failure was measured, so no additional row.                          |
| Loop/branch/instruction structure: keep twenty PC annotations out of CFG attribution (F1/F5) | Established loop threshold `gcc/loop.c:1833`; structuring boundary `packages/core/src/structure/structure.ts:1295` and switch machinery `packages/core/src/structure/switch-recover.ts:92`. These are ownership boundaries, not causal findings for every unmatched region.                                                                                                                                                      | Existing loop/merge/switch families do not prove which region belongs to which mechanism. No causal region-level minimal pair was performed; bulk counts license no new row or computed-jump frontend. |
| Mapping/alignment presentation: no constant subtraction (F4)                                 | The observed compiler `.align 2, 0` spelling is emitted by `ASM_OUTPUT_ALIGN` at `gcc/config/arm/thumb.h:100` (flattened as `gcc/thumb.h:100` in this compiler checkout). The comparison gate is `packages/cli/src/objdiff.ts:151`; frontend pad interpretation begins at `packages/core/src/frontend/thumb.ts:152` (L1). Frame/code length and assembler mapping symbols affect presentation; no new compiler pass is inferred. | Existing frontend alignment controls own presentation. Nineteen data rows are not a new pad-price family; no additional minimized failure was measured.                                                |
| Symbol minimum: replace 462 with reproduced 455 (F2)                                         | Canonical compile/rescore verifies the number, but no compiler or asmlift mechanism for the historical discrepancy was established.                                                                                                                                                                                                                                                                                              | Measurement correction only; no causal capability or new row is licensed by a changed carried number.                                                                                                  |

**F5 remedy:** the remaining 182 non-register-only rows stay a heterogeneous descriptive
residual. No one-family explanation, additive price, or implementation is proposed. A future
causal hypothesis must produce a minimal compiled pair and pass the task's round-trip protocol.
The final independent second review re-audited these dispositions; publication gates remain
separate from this baseline measurement.

## Retained evidence and reproduction boundary

[Baseline evidence](lbg-attribution-evidence/baseline/) contains raw and symbol `.i`/`.s` units,
completion/input hashes, raw object mapping, contextual residual/pool summaries and the fresh
symbol confirmation. Retained assembly is byte-identical to capture. In `.i` files only absolute
preprocessor **diagnostic filenames** are replaced with `captured-input.c`; declarations and
function tokens are unchanged. Both original-capture and retained-file hashes are recorded.
Both filename-sanitized archival `.i` files were independently compiled with the exact canonical
flags and footer, then assembled. Both resulting `.s` files are byte-identical to their retained
assembly, and both object SHA-256 values equal the original captured objects listed above. This
validates archival reproduction as well as the original-capture checks. Command logs and compiled
outputs are retained under ignored `apps/benchmark/results/lbg-archive-check.log/`, including
`confirmation.json`. No object binaries or machine-specific sibling paths are required in the
committed evidence.

Canonical compile flags are `-mthumb-interwork -Wimplicit -Wparentheses -O2 -fhex-asm
-fprologue-bugfix`. Append `.text` and `.align 2, 0` exactly as the benchmark checkout's template
does, then assemble with `-mcpu=arm7tdmi -mthumb-interwork`. The target object SHA-256 is
`4179071f8be0a0e637a1cb769feb26bb92e8109b46f5f5ee0cf8b50867bd88c7`.
Reassembly and `scoreObjects` against that object can verify retained assembly without invoking
candidate-cache initialization or enumerating another fan. Canonical full-run instructions remain
in [ranked-repro.md](ranked-repro.md); the completed record here does not claim the separate full
benchmark, regression, tests, or publication gates have finished.
