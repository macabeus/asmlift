# Sibling residual census

This is evidence for a **priced null**, not a plan to improve LoadBGTilemapData.
In this deliberately small sample, register renaming is widespread and one residual has a strict
majority of register-only objdiff rows: **54 of 106** in sub_0804C484. Another high-register function
has register-only as its largest individual category. Their remaining rows must not be credited
to allocation.

## Provenance and selection

All runs used the a56952a bundled CLI, one worker, `ASMLIFT_CANDCACHE=0`, strict scoring against
each function's own translation-unit object. Both sibling checkouts were read-only. The sibling
symbol maps were loaded; these are **not** the benchmark-checkout LBG configuration and their
scores cannot be subtracted from LBG scores.

The live upstream kleod revision was checked with `git ls-remote`: **64a83ad65b52daba92b41328c3220fdd790dd9d9**.
It was fetched and extracted into scratch, without fetching into the sibling clone. Upstream
`math.c` and `m4a.c` are byte-identical to the locally built source. Upstream `code_0804B254.c`
renames two fields; it was compiled with upstream headers, the project's preprocessor and real
agbcc in scratch. Each of the seven scored functions in that unit compares **0** against its
existing object, and the captured candidate scores against the new upstream object reproduce
46, 5, 15, 100, 39, 106 and 26 respectively. The complete ten-function CLI sample was rerun
against that upstream assembly/object.

Selection started with compiled functions having conditional merges, repeated global reads,
indexed accesses and high-register saves. The additional m4a sample selected call-free bodies
with high-register moves and 50–56 instructions. These are allocation/structure shapes, not a
selection by graphics or sound subject matter. Math functions provide small controls.

**Toolchain correction:** m4a has a Makefile-specific `old_agbcc` override and omits
`-fprologue-bugfix`. An initial generic-config pass was discarded and all three runs repeated
with that exact override. The repeated scores were 27, 31 and 29. The published m4a evidence is
from the corrected pass. The override is not a proposed agbcc capability gap.

## Results

Counts below use aligned **objdiff rows**, not source lines or the separately aligned instruction
stream. Register-only means every other rendered token is identical. A mixed row appears once
under its combined category. Pool/data rows include mapping/alignment data; instruction counts
never replace the pool tally.

| Function                 | Score | Candidates | Strict register-only | Classification                               |
| ------------------------ | ----: | ---------: | -------------------: | -------------------------------------------- |
| kleod MultiplyQ8         |     0 |          6 |                    0 | MATCH control                                |
| other clone MultiplyQ4   |     0 |          6 |                    0 | MATCH control                                |
| other clone ReciprocalQ4 |     0 |          6 |                    0 | MATCH control                                |
| sub_0804B2A0             |    46 |          4 |                   11 | structure/conditional merge                  |
| sub_0804B2EC             |     5 |          4 |                    1 | pool order and allocation mix                |
| sub_0804B464             |    15 |         12 |                    6 | address expression/structure mix             |
| sub_0804BBD4             |   100 |         46 |                   37 | allocation largest category; mixed           |
| sub_0804C0EC             |    39 |        224 |                    6 | structure dominates                          |
| sub_0804C484             |   106 |         11 |                   54 | register-only majority; remaining rows mixed |
| sub_0804DA60             |    26 |          2 |                    4 | pool/structure dominates                     |
| m4aMPlayVolumeControl    |    27 |         16 |                    9 | loop structure dominates                     |
| m4aMPlayPitchControl     |    31 |          8 |                   11 | loop structure dominates                     |
| m4aMPlayPanpotControl    |    29 |          8 |                   11 | loop structure dominates                     |

All completed ranked runs reported zero dropped and zero withheld candidates. Synthesized
extern declarations were retained in the captured compilation units. The source-unit-wide
missing-prototype diagnostic also names callees outside the selected function; the m4a samples
are call-free. `thunk_HeapFree` was supplied with one parameter and void return for the gfx runs;
`__divsi3` with two parameters for the other clone's math runs.

The complete per-category counts, separate shape alignment, and **per-distinct-value pools on
both sides** are committed in [siblings.json](lbg-attribution-evidence/siblings.json). For example,
sub_0804B2EC has the same four data entries on each side (zero halfword, 67108928,
`gUnk_030034A0`, and 4294967040), but a changed order. Calling that five-row residual simply
“register allocation” would hide two pool rows. No constant pool penalty was subtracted.

## Declines: observed first blockers

The [instrumentation patch](../scripts/lbg-attribution/sibling-decline-trace.patch) was applied only
to a separate scratch copy of asmlift and each decline rerun.
The measured shared bundle was never edited. These are excluded from allocation evidence:

| Function     | Instrumentation output                                  | Owner / existing row                                                   |
| ------------ | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| sub_0804C300 | `LBG-FIRST thumb.ts:2374 declared-arity sub_08003DC0 9` | declared outgoing stack arguments; `stkarg`                            |
| sub_0804D408 | `LBG-FIRST structs.ts:96 overlapping 0 2 1`             | same-offset mixed-width field recovery; union family (`uhalf`, `utag`) |
| sub_0804EE60 | `LBG-FIRST thumb.ts:2523 prefixStored 0`                | unread stack store before call; `spill10`                              |

The first is a known nine-argument call; the second encounters widths two and one at offset zero;
the third reaches `bl sub_0804EE34` before reading the store at `[sp,#0]`. None measured the
allocator behind those gates. Their rows already exist, so this study adds no duplicate decline
rows and makes no claim that an unexecuted future fix would match them.

## What this does and does not establish

The two largest-category allocation residuals support the published generality finding; they do
not establish a new declaration-order lever. One passes the strict-majority test in this sample (54/106).
The published 41-of-49 generality result remains prior evidence, not a count reproduced here.

Review correction: ~~no sample residual has a register-only majority~~ was falsified after fixing
the analysis script. Token alignment had counted reordered register operands and intervening
commas as operand structure. Comparing the entire register-erased token sequence first restores
those rows to register-only while retaining register-list cardinality. All ten residuals were
regenerated; sub_0804C484 changed from 50 to 54 strict register-only rows, crossing the threshold.
Scores and candidate objects did not change.

No new compiler mechanism is inferred from these residuals. Conditional merges, address
expressions, loop shaping and pool ordering are **handoff classes**, not verified causal claims.
A future claim about one requires the task's minimal two-source compiler experiment and a
round-trip row. Existing `stkarg`, `spill10` and union rows already cover the instrumented first
blockers. Existing `reread`/`rereadctl` cover a register-residual pair. This census therefore
justifies no additional synthetic row by itself: its finding is a mixed population, not a new
isolated capability. The parent plan's independently compiled probes carry any new rows.

Nor can sub_0804C484 become a **real** row as things stand, and the reason is neither its residual
nor its provenance. The benchmark's pinned kleod checkout (`704fd74`) does carry it, renamed by the
project's own symbol map to `StreamCmd_SetEntityTransform` in `src/gfx.c` — the same translation
unit as `LoadBGTilemapData`. It is an `INCLUDE_ASM` stub, so no reference C exists for it, and all
42 entries in `apps/benchmark/dataset/real/kleod.json` carry a `funcC`. A real row would need
upstream to decompile it first.

## Reproduction

`KLEOD` and `OTHER` below are user-provided checkout roots; `REPO` is this asmlift worktree and
`SCRATCH` is outside every checkout. Use the scratch compiler-template capture described in the
main plan: retain the preprocessed C, `.s`, and `.o` of **every** candidate. A basename alone is
not unique (`cand.s` is reused); allocate a fresh directory per compiler invocation. Identify the
winner by rescoring captured objects, rather than recompiling CLI stdout.

```sh
cd "$KLEOD"
ASMLIFT_CANDCACHE=0 node "$REPO/packages/cli/dist/asmlift.mjs" \
  "$SCRATCH/upstream-gfx.s" --name sub_0804C484 \
  --config "$SCRATCH/kleod.yaml" --score-against "$SCRATCH/upstream-gfx.o" \
  --proto '{"thunk_HeapFree":{"params":1,"returnsVoid":true}}' \
  --jobs 1 --progress > "$SCRATCH/result.c" 2> "$SCRATCH/result.err"
node "$REPO/scripts/lbg-attribution/rowdiff.mjs" \
  "$SCRATCH/upstream-gfx.o" "$SCRATCH/winner.o" sub_0804C484 > "$SCRATCH/rows.json"
python3 "$REPO/scripts/lbg-attribution/residual.py" "$SCRATCH/rows.json"
```

For the m4a rows substitute `build/kleod/src/m4a.s` and its `.o`, and use the scratch config with
`old_agbcc` and without `-fprologue-bugfix`. For MultiplyQ8 use `build/kleod/src/math.s` and its
`.o`. For the other clone's two controls use `build/src/math.s`, its `.o`, its own copied config,
and `--proto '{"__divsi3":{"params":2}}'`. Copied config ELF paths must be absolute and the
compiler template must `cd` to its originating checkout before accessing relative tools/headers.

Object and symbol-map SHA-256 fingerprints:

| Input             | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| kleod gfx object  | `2e2ef91c35ec250eccd9a61219be9e569cf7ad9c8862ad889729f66d0a978050` |
| kleod m4a object  | `719f3fcd71d06184efaa0be88f3f8be4f5366aca6075541a53a768ce8f1806a1` |
| kleod math object | `efcd4a087c96786a530ee0ad0b244e974ebcf3bc954fe8d852241c3cb8a95ad7` |
| kleod ELF         | `cb8d94d24527251b72a6d2512d70635215a90894255be38894c64d968023b24c` |
| other math object | `b89c6dae0b09b79693ae0be4b61ec386d96c7ca072302a9c8181ea82e9e722d0` |
| other symbols ELF | `09f85508f6f2fc4d2ebfdecc0ed41f809131cdfce3ac0412d425490851084e49` |
