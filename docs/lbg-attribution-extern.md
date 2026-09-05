# Extern same-value-write probes

These are gap measurements, not a plan to move the score. The extern family preserves relocation
identity and exposes a small ordering residual in its control; it does not establish a new compiler
mechanism or price the large target by subtraction. All prices below are in this family's symbol
basin, against each probe's own compiled object.

The exact compiled sources are the `ereread`, `ereadctl`, `erback`, and `erbctl` entries in
`apps/benchmark/dataset/synthetic.ts`. `ereread`/`ereadctl` differ only by
`gReadBgs[2].v = gReadBgs[2].v + 0;`; `erback`/`erbctl` make the same comparison with a read-back
of that field after the indexed store. Controls are causal controls, not claims of MATCH.

Direct compiler pair observations:

- `ereread` has no halfword read/write for the same-value statement. Its destination-pointer load
  stays inside the loop; `ereadctl` loads it before the loop and uses `stmia` pointer advancement.
- `erback` likewise reloads the destination pointer in the loop; `erbctl` hoists it and uses
  `stmia`. Both have a halfword read after the store for the source's explicit read-back.
- All four reference pools have exactly one `.word gReadBgs`. The same-value-write references
  also contain one zero halfword of alignment data. The controls have none.

This reproduces the existing raw `reread` family's observed source/codegen contrast while
retaining the extern relocation. It does not newly instrument which optimizer pass preserves
or deletes the same-value write. The allocator/loop explanation in the existing family remains
prior attribution, not a newly established mechanism from these four compiles.

## Actual compiled candidates

Used the benchmark agbcc config copied to scratch, appending copies of each preprocessed unit,
assembly and object into a new `mktemp -d` directory **per compiler invocation**. Worker scratch
paths are reused, so naming captures after worker directories loses candidates. Prelude probes
were excluded by checking the compiled unit's function name. Candidate cache was disabled.
The final captured counts exactly equal each CLI fan count. Every captured function object was
rescored through `packages/cli/src/objdiff.ts:137` (`scoreObjects`); minima equal the canonical
CLI results stamped `asmlift source a56952a`.

| Row      | Captured candidates | Best score | CLI best label                                  |
| -------- | ------------------: | ---------: | ----------------------------------------------- |
| ereread  |                   4 |         11 | unsigned                                        |
| ereadctl |                  72 |          2 | unsigned/fresh-merge/initfirst                  |
| erback   |                  40 |         12 | unsigned/defsite/loop-entry/offmember/initfirst |
| erbctl   |                  40 |         12 | unsigned/defsite/loop-entry/offmember/initfirst |

The minima were analyzed as compiled objects with `rowdiff.mjs` and `residual.py`. Each row has
exactly **one distinct object SHA-256 among all minimum-score captures**. The retained candidate
assembly reassembles with the exact harness flags (`arm-none-eabi-as -mthumb -mthumb-interwork`)
to that same SHA-256, so the analyzed object is the CLI winning object even when several labels
tie. Each retained preprocessed candidate was also recompiled with the real compiler and exact
benchmark flags; all four assembly files reproduced byte-for-byte. CLI stdout is not substituted
for these compiled units.
The capture contains `extern u32 gReadBgs;`, with element/member access through synthesized
struct casts. Thus the original array-shaped declaration and the scored unit's declaration are
not interchangeable descriptions.

| Row         | Aligned objdiff residual decomposition                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ereread, 11 | 6 register-only; 2 changed push/pop register-list arities; 1 mixed register/PC-pool-offset; 2 insertion/deletion rows for moved index scaling |
| ereadctl, 2 | 2 insertion/deletion rows for the same `lsl r0, #3` moving across the global-base load                                                        |
| erback, 12  | 10 register-only; 2 insertion/deletion rows for moved `lsl r0, #3`                                                                            |
| erbctl, 12  | 6 register-only; 1 mixed immediate/register/operand-structure; 3 instruction insertion/deletion; 2 pool/data alignment rows                   |

Every row belongs to exactly one category. In particular, a push/pop with fewer saved registers
changes operand-list arity and is not called a pure register substitution. The pool census on
both sides remains one `.word gReadBgs` for every probe. Both sides have one zero halfword for
`ereread` and `erback`; neither side has one for `ereadctl`; only the candidate adds a halfword for
`erbctl`. Its two aligned data rows do not mean the relocation's value changed.

Independent shape alignment is reported separately: `ereread` has 16 equal-shape instruction
pairs (6 register-only), `ereadctl` 13 (0), `erback` 22 (10), and `erbctl` 19 (8).
These are not a second objdiff score. Repeated instruction shapes can align differently.

## Ownership and limitations

The two-row extern control residual belongs to global-address evaluation order, not register
allocation. The established compiler fork is `gcc/c-typeck.c:1383`, with array-base expansion
at `:1449` and pointer-base expansion at `:1469`; the prospective asmlift knowledge site is
`packages/core/src/raise/globalshape.ts:890` (`inferGlobalArrays`), called for declaration shapes
at `packages/core/src/rank.ts:1177`. The separate ordering licence is `globalshape.ts:924`
(`orderLicensedGlobals`), called at `rank.ts:2309`, passed to L3 at `rank.ts:2370`, and consumed
by the `order-licensed` gate at `packages/core/src/l3/basecse.ts:639`.
The candidate cast spelling and the measured load/shift order identify this as the relevant
existing machinery. No guard was instrumented here, so this is not a claim that a particular
licensing refusal fired or that a specific edit would remove two points.

The dominant register-only component of `erback` is evidence for the general allocator residual.
Its established compiler ownership is `gcc/global.c:605`/`:926` and reload at
`gcc/reload1.c:769`; no asmlift inverse allocator exists. L3 candidate formation would need
post-optimization RTL allocation information, as described in the compiler study. The emitted
loop reload already exists; `packages/core/src/rank.ts:106` (`/reread-globals`) is not a demonstrated
missing capability here. The mixed control `erbctl` must not be represented as twelve register
rows or as a pure allocation probe.

The root's individual harness smoke reports m2c declining all four rows with the first emitted
gap `extern ? gReadBgs`. This is an extern-type placeholder blocker, not a register-allocation
failure. The harness recognizes this emitted incompleteness marker at
`apps/benchmark/src/eval/outcome.ts:40`; it classifies the output before compilation. That
observable classification does not identify a private m2c optimizer refusal site. The declarations/prototype information is shared by both tools, but this blocker prevents
a numerical cross-tool comparison for the family. No claim about m2c register recovery follows.
The existing raw `rereadctl` MATCH is a control for a different basin; it cannot replace the
observed extern control score of two.

Reproduction uses the root-built CLI, captured objects, benchmark compiler flags
`-mthumb-interwork -Wimplicit -O2 -fhex-asm -fprologue-bugfix`, and `--proto` returnsVoid entries
for `ereread` and `ereadctl`. Run each source assembly with `--config` pointing at the capture
copy and `--score-against` its own object, then rescore all captured objects with `scoreObjects`.
Use the residual tools' commands in the compiler study for decomposition. These four entries
are real compiled probes, not predictions or tuned sources.

Durable evidence is in [extern captures](lbg-attribution-evidence/extern/): selected minimum
preprocessed units and assembly, categorized rendered-token rows, and SHA-256/score records for
every captured function object. The row-existence command produced:

```text
2811:    sym: 'ereread',
2819:    sym: 'ereadctl',
2827:    sym: 'erback',
2834:    sym: 'erbctl',
```

Command: `rg -n "sym: '(ereread|ereadctl|erback|erbctl)'" apps/benchmark/dataset/synthetic.ts`.
