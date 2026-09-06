# Allocator observation for the attribution study

This is evidence for a priced null, not a proposal to move the score. The trace recovers the
reference's declaration-to-pseudo-to-home mapping; it does not supply an inverse allocator.
The declaration study supplies scores and the perturbation curve. No independent benchmark row
is warranted by instrumentation alone: this observation confirms the reference's annotation,
and any gap row must survive the declaration or sibling study's round trip.

The compiler copy was outside every checkout. Only `gcc/stmt.c` and `gcc/global.c` in that copy
were edited, using [allocator-trace.patch](../scripts/lbg-attribution/allocator-trace.patch).
Every added print is gated by `LBG_ALLOC_TRACE`. The original toolchain's before/after SHA-256
manifests contain 2,104 files and compare equal. The manifest's SHA-256 is
`01be3440b147e439206c3a7aafc5bbcbfd74358a9d2213cca77c0b29aad64f81`.

Compiling the preprocessed plain symbol-basin reference with the real compiler, the copied
compiler with tracing disabled, and the copied compiler with tracing enabled produced identical
assembly (`cmp` exited 0 for both comparisons). Assembly SHA-256:
`c3f5774bf40a21d4d81856e45e9786b68c5c6d549cc0b20fb2e0a9b670d43c23`.
After extending named-home tracing, all 30 declaration-study variants were recompiled real/off/on and their assembly compared identical.
Flags were `-mthumb-interwork -Wimplicit -Wparentheses -O2 -fhex-asm -fprologue-bugfix`.

| Declaration | Pseudo | Final home | Pre-reload refs | Pre-reload live length |
| ----------- | -----: | ---------- | --------------: | ---------------------: |
| sp4         |     24 | sp + 4     |               6 |                    510 |
| sp8         |     25 | sp + 8     |               7 |                    260 |
| spC         |     26 | sp + 12    |              14 |                    278 |
| sp10        |     27 | sp + 16    |              27 |                    396 |
| sp14        |     28 | sp + 20    |              15 |                    348 |
| sp18        |     29 | sp + 24    |              15 |                    644 |
| temp_r8     |     30 | r8         |               7 |                     70 |
| var_r3      |     31 | r3         |              61 |                    162 |
| var_r7      |     32 | r7         |              68 |                    538 |
| var_sl      |     33 | r10        |              52 |                    742 |
| var_r8      |     34 | r8         |              33 |                    244 |
| var_sb      |     35 | r9         |              28 |                    284 |

`LBG_DECL` records user declarations immediately after `mark_user_reg`. The extended `LBG_NAMED_HOME` also preserves declaration pointers until after reload, catching direct-memory declarations and later address-taking that replaces DECL_RTL. It is bounded at 4,096 automatic declarations and aborts a trace run if exceeded; all measured functions are below that limit. Named memory RTL may still spell the frame-base register (r7), so final emitted assembly must establish its physical sp offset. In all four address-sp4 variants, `add r2, sp, #0x8; str r2, [sp]` proves sp4 at sp+8 and address_sp4 at sp+0.
`LBG_ALLOC` records all pseudos immediately before reload; refs and live length are allocator
inputs, not a reconstructed source-level lifetime. `LBG_HOME` records the post-reload RTL:
`hard=-1` alone does **not** mean a stack slot (dead pseudos also have it); the six stack claims
above come from explicit `mem:SI (plus:SI (reg:SI 13 sp) (const_int OFFSET))` expressions.

## Established mechanisms and ownership

These mechanisms are supplied prior findings in the task, cited rather than re-derived here.
The experiment above verifies their reference mapping, not every general compiler law.

| Compiler mechanism                                                                                                             | Knowledge an inverse needs                                                                         | asmlift ownership                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gcc/stmt.c:3323` creates declaration pseudos; `gcc/reload1.c:769` walks them ascending; `gcc/function.c:703` allocates upward | Which recovered locals share a home, frame direction, and which slots are reload spills            | Already shipped: `packages/core/src/target.ts:343`, `packages/core/src/l3/slotorder.ts:90`; L3 orders eligible locals, using provenance carried from L1. No new lever.                                                                                                                                                                              |
| `gcc/global.c:605` priority and `gcc/global.c:926` register search                                                             | Post-optimization RTL refs, live ranges, conflicts, classes, and allocation history                | No asmlift inverse-allocator site exists. A future measured capability would belong at L3 candidate formation with compiler feedback; machine provenance originates at L1. `packages/core/src/ir/core.ts:108` documents information lost when register copies become one SSA value. This is an architectural requirement, not a proposed new level. |
| `gcc/stmt.c:3312` excludes volatile/addressable locals from pseudos                                                            | Whether a candidate is deliberately forcing memory and whether the observed target home permits it | Candidate-local declaration policy belongs in L3; `packages/core/src/structure/structure.ts:4582` begins local/slot construction. Address-taking is not a register-home lever.                                                                                                                                                                      |
| `gcc/config/arm/thumb.md:595` low-register immediate alternatives                                                              | The extra instructions imposed when a value receives a high register                               | Target-specific candidate costing would need allocator feedback; no site currently inverts this cost. L3/emit boundary owns spelling choices, not a new IR level.                                                                                                                                                                                   |

The published declaration-order null remains the prior result until a scored perturbation
falsifies it. In particular, showing different pseudo numbers is not evidence of different homes.

## Reproduction

Set `REAL_AGBCC_DIR` to the project toolchain, `SCRATCH` to an empty directory outside checkouts,
`REPO` to this repository, and `INPUT_I` to the captured preprocessed reference. Keep both manifests
in scratch. First hash every regular file under the real toolchain by relative path, then:

```sh
cp -R "$REAL_AGBCC_DIR" "$SCRATCH/agbcc"
(cd "$SCRATCH/agbcc" && patch -p1 < "$REPO/scripts/lbg-attribution/allocator-trace.patch")
make -C "$SCRATCH/agbcc/gcc" -j4
"$SCRATCH/agbcc/gcc/agbcc" "$INPUT_I" -o "$SCRATCH/off.s" -mthumb-interwork -Wimplicit -Wparentheses -O2 -fhex-asm -fprologue-bugfix
LBG_ALLOC_TRACE=1 "$SCRATCH/agbcc/gcc/agbcc" "$INPUT_I" -o "$SCRATCH/on.s" -mthumb-interwork -Wimplicit -Wparentheses -O2 -fhex-asm -fprologue-bugfix 2> "$SCRATCH/trace.log"
"$REAL_AGBCC_DIR/agbcc" "$INPUT_I" -o "$SCRATCH/real.s" -mthumb-interwork -Wimplicit -Wparentheses -O2 -fhex-asm -fprologue-bugfix
cmp "$SCRATCH/off.s" "$SCRATCH/on.s"
cmp "$SCRATCH/real.s" "$SCRATCH/on.s"
```

Hash the real toolchain again and compare manifests before accepting results. The instrumentation
prints only compiler state and never assigns to it. It intentionally does not instrument asmlift
refusals or claim a decline attribution.

## Residual analysis tooling

`node scripts/lbg-attribution/rowdiff.mjs TARGET.o CANDIDATE.o SYMBOL > rows.json`
uses the CLI's installed objdiff engine with its default configuration and saves every typed
render token. `python3 scripts/lbg-attribution/residual.py rows.json > residual.json` reports
mutually exclusive categories for aligned differing rows. A mixed category is counted once;
`register-only` requires that every changed token is a register. Stack-immediate, PC-relative
pool offset, branch destination, relocation symbol/addend and opcode changes remain separate.
The pool/data census retains directive width, numeric value, symbol and relocation addend.
Halfword padding is explicitly data, not a register difference.

A second alignment operates only on instruction shapes, folding register names, branch
destinations and PC-relative pool offsets. It reports structural regions separately and counts
a pair as register-only only when its original changed tokens pass the strict register test.
These shape counts are **not** objdiff rows: repeated instruction shapes can align differently.
The tool consumes objdiff's symbol display extent rather than guessing a function end from the
next local label or ignoring ELF symbol size. GNU alias variants are normalized; numeric tokens
are parsed directly as integers, avoiding textual hex/decimal ambiguity. Objdiff supplies a
consistent explicit/implicit zero-offset rendering for both objects.

Validation used separately assembled instrumentation-off/on output: score 0, 521 identical
instruction pairs. Against the declaration study's reversed-stack reference, score 34 and all
34 aligned differing rows are stack-offset/immediate; the independent strict assembly check
also found 34 changed lines exclusively in stack offsets. Shape alignment for that pair has
487 equal-shape pairs, including one register-only pair caused by its different alignment;
it does not replace the zero register-only count in aligned objdiff rows.
