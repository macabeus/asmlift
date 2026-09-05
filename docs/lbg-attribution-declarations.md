# Declaration-list experiment

This is a priced null for declaration-only register-home inversion. No score-moving implementation is proposed. Direct compiles use the benchmark checkout, branch `asmlift-benchmark`, its `gba.h`, its compile flags and its `build/src/gfx.o` target. These are direct reference compiles, not enumerated candidates.

The two requested spot checks reproduce the supplied table exactly: symbol +FAKE plain **59**, symbol +FAKE swap+n2 **35**. Both preserve the author’s two FAKE lines.

## Curve

Columns remain within their own basin. No alignment-pad subtraction is applied.

| Change             | sym +FAKE | sym −FAKE | raw +FAKE | raw −FAKE |
| ------------------ | --------: | --------: | --------: | --------: |
| baseline           |        59 |        76 |       199 |       201 |
| add-unused         |        59 |        76 |       199 |       201 |
| move-pointer-block |        59 |        76 |       199 |       201 |
| reverse-stack      |        92 |       109 |       220 |       222 |
| split-var-r3       |        59 |       261 |       199 |       321 |
| merge-pointers     |       108 |       116 |       205 |       210 |
| address-sp4        |       277 |       265 |       291 |       291 |

`add-unused` inserts an unused s32 before sp4. `move-pointer-block` moves temp_r8 into its branch (the reverse operation is the baseline). `reverse-stack` reverses only the six stack local declarations. `split-var-r3` separates the initial table index from the later loop induction variable. `merge-pointers` removes temp_r8 and gives both mutually exclusive branches one u8* sp8. `address-sp4` adds a volatile pointer initialized to &sp4; this is explicitly an address-escape intervention, not a declaration-only edit. Split and merge likewise rewrite the affected uses.

Adding an unused declaration and changing pointer scope leave all four scores unchanged. Reversing spilled declarations loses 33 symbol rows and 21 raw rows in each FAKE condition. Splitting is neutral with FAKE but loses 185 symbol / 120 raw rows without FAKE. These interventions do not yield a new improving lever. The split without FAKE moves the loop’s var_r3 from r3 to r4 (both basins); this changes value identity and optimized live ranges, so it does not falsify the earlier declaration-permutation null. Reversing the six spills preserves all six register-named homes. Compiled-assembly comparison finds exactly 34 changed lines in each symbol condition and 35 in each raw condition, all exclusively `[sp, #offset]` operands; line counts, register tokens and literal-pool lines are identical. These are source-assembly line counts, not objdiff rows.

## Observed homes

The instrumented compiler maps the symbol +FAKE baseline exactly as the author named it: sp4/sp8/spC/sp10/sp14/sp18 at sp+4/+8/+12/+16/+20/+24; temp_r8/var_r3/var_r7/var_sl/var_r8/var_sb at r8/r3/r7/r10/r8/r9. Homes below come from final reload RTL, not guessed disassembly. An unallocated pseudo is reported as such, not asserted to have a physical home. The extended named-declaration trace catches sp4’s address-taken replacement and the direct-memory volatile pointer. Its named memory RTL retains a frame-base register, so final assembly verifies the physical offsets: all four address-sp4 arms begin `add r2, sp, #0x8; str r2, [sp]`, placing sp4 at sp+8 and address_sp4 at sp+0. These two homes use named trace plus emitted instructions; the original pseudo alone was insufficient.

| Variant / basin / FAKE       | User-local final homes                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline-sym-plus            | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| baseline-sym-minus           | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| baseline-raw-plus            | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| baseline-raw-minus           | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| add-unused-sym-plus          | unused=unallocated pseudo 24, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9 |
| add-unused-sym-minus         | unused=unallocated pseudo 24, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9 |
| add-unused-raw-plus          | unused=unallocated pseudo 24, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9 |
| add-unused-raw-minus         | unused=unallocated pseudo 24, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9 |
| move-pointer-block-sym-plus  | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9, temp_r8=r8                               |
| move-pointer-block-sym-minus | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9, temp_r8=r8                               |
| move-pointer-block-raw-plus  | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9, temp_r8=r8                               |
| move-pointer-block-raw-minus | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9, temp_r8=r8                               |
| reverse-stack-sym-plus       | sp18=sp+4, sp14=sp+8, sp10=sp+12, spC=sp+16, sp8=sp+20, sp4=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| reverse-stack-sym-minus      | sp18=sp+4, sp14=sp+8, sp10=sp+12, spC=sp+16, sp8=sp+20, sp4=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| reverse-stack-raw-plus       | sp18=sp+4, sp14=sp+8, sp10=sp+12, spC=sp+16, sp8=sp+20, sp4=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| reverse-stack-raw-minus      | sp18=sp+4, sp14=sp+8, sp10=sp+12, spC=sp+16, sp8=sp+20, sp4=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                               |
| split-var-r3-sym-plus        | temp_r3=r3, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                   |
| split-var-r3-sym-minus       | temp_r3=r3, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r4, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                   |
| split-var-r3-raw-plus        | temp_r3=r2, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                   |
| split-var-r3-raw-minus       | temp_r3=r2, sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, temp_r8=r8, var_r3=r4, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                   |
| merge-pointers-sym-plus      | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                                           |
| merge-pointers-sym-minus     | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                                           |
| merge-pointers-raw-plus      | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                                           |
| merge-pointers-raw-minus     | sp4=sp+4, sp8=sp+8, spC=sp+12, sp10=sp+16, sp14=sp+20, sp18=sp+24, var_r3=r3, var_r7=r7, var_sl=r10, var_r8=r8, var_sb=r9                                           |
| address-sp4-sym-plus         | sp4=sp+8, address_sp4=sp+0, sp8=sp+12, spC=sp+16, sp10=sp+20, sp14=sp+24, sp18=sp+28, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=sp+32, var_r8=r8, var_sb=r9          |
| address-sp4-sym-minus        | sp4=sp+8, address_sp4=sp+0, sp8=sp+12, spC=sp+16, sp10=sp+20, sp14=sp+24, sp18=sp+28, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=sp+32, var_r8=r8, var_sb=r9          |
| address-sp4-raw-plus         | sp4=sp+8, address_sp4=sp+0, sp8=sp+12, spC=sp+16, sp10=sp+20, sp14=sp+24, sp18=sp+28, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=sp+32, var_r8=r8, var_sb=r9          |
| address-sp4-raw-minus        | sp4=sp+8, address_sp4=sp+0, sp8=sp+12, spC=sp+16, sp10=sp+20, sp14=sp+24, sp18=sp+28, temp_r8=r8, var_r3=r3, var_r7=r7, var_sl=sp+32, var_r8=r8, var_sb=r9          |

## Ownership and limits

Compiler mechanisms cited by the supplied task: `gcc/stmt.c:3323` assigns pseudos by declaration position; `gcc/reload1.c:769` walks pseudos ascending for spill slots; `gcc/function.c:703` grows this frame upward. asmlift already owns this at `packages/core/src/target.ts:343`, `packages/core/src/l3/slotorder.ts`, and `packages/core/src/backend/cfamily.ts:549`. This study confirms the reference-side law; it does not reprice the supplied 376→386 ablation. Existing `spillorder` and `spillorder_rev` rows are the appropriate controls, not a new register-order family.

Register priorities depend on optimized RTL (`gcc/global.c:605`); declaration reordering alone is not an inverse. No asmlift site exists for simulating those optimized RTL priorities and interference. The current level tower has L1–L3 only. A future compiler-informed search would sit outside those IR levels, around L3 candidate generation and compile/score feedback; adding an IR level is not justified by this experiment. The supplied task’s earlier 34+4 reordering null is prior evidence, not rerun evidence.

Address-taking also introduces an observable volatile pointer store, so its score cannot be attributed solely to moving sp4. It is excluded as a semantic reconstruction lever. The existing out-parameter/address-taken family owns such semantics. Full-function split/merge losses cannot honestly become new minimal benchmark gaps without a separately round-tripped probe; this study does not claim that unperformed experiment.

## Reproduction

The companion `scripts/lbg-declarations/` directory preserves the author reference, variant generator, compile driver, raw score JSONL and parsed home JSON. Run `generate.py` then `compile.py` from the benchmark checkout. The compile driver requires `LBG_TRACE_COMPILER` to name the separately instrumented compiler copy; it never writes the real toolchain. Score using `node --import tsx scripts/lbg-declarations/score.mts <benchmark>/build/src/gfx.o <scratch>/*.o` from the asmlift worktree. All generated files live under `LBG_STUDY_DIR`. The compiler agent separately records instrumentation neutrality and the real-toolchain checksum manifest.

Reproduction asset check: generating into a fresh scratch directory produced 29 C variants byte-identical to the measured sources. The additional measured `plain.c` is the same source as `baseline-sym-plus.c`.

Existing row presence (not a new outcome claim):

```text
$ rg -n "sym: '(spillorder|spillorder_rev|outparam)'" apps/benchmark/dataset/synthetic.ts
853:    sym: 'spillorder',
864:    sym: 'spillorder_rev',
5657:    sym: 'outparam',
```

Every one of the 30 measured variants was recompiled with the real compiler, instrumented copy with tracing off, and tracing on. All 30 assembly comparisons passed (the compile driver’s appended `.text/.align` footer was accounted for).

Scoped smoke commands (cache on; no full benchmark):

```sh
source /tmp/wt-env.sh
pnpm bench run --tier synthetic --only spillorder --toolchain agbcc --serial
pnpm bench run --tier synthetic --only spillorder_rev --toolchain agbcc --serial
```

The first selector also includes `spillorder_rev` because `--only` uses substring matching: both asmlift MATCH; m2c noncompile(1). The second ran spillorder_rev alone: asmlift MATCH; m2c noncompile(1). This reports observed outcomes without attributing m2c’s compilation error.
