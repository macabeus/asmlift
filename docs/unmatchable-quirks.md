# The unmatchable-quirk register

A row is **unmatchable by source quirk** when the original C contains a construct that (a) changes
the bytes the compiler emits and (b) leaves no evidence of itself in those bytes. Then no recovery
from the object can produce it, because the object does not know it happened, and a decompiler that
emitted it anyway would be guessing at the source rather than reading the machine.

`/match-function`'s Phase 1 lists that as one of its four outcomes and tells the agent to **stop**.
This file is what "stop" is allowed to rest on. A verdict here is not an opinion about how likely a
spelling is; it is two measurements, and both are compiler runs:

- **NECESSARY** — a sweep of honest spellings, none of which reaches the target bytes.
- **INVISIBLE** — the construct's own effect is absent from the target instruction stream, so the
  lift has nothing to recover it from.

A verdict without both halves is a hypothesis. The entry says the date it was taken and the asmlift
commit it was taken at, because an entry here closes a row to future rounds and that is exactly the
kind of claim that rots unwatched.

**How an entry is falsified:** find one honest spelling that reaches the target bytes. The recipe
below is the one to run, and a falsified entry is deleted, not annotated.

## The register

| row                  | verdict taken | asmlift | the quirk                                        |
| -------------------- | ------------- | ------- | ------------------------------------------------ |
| `kleod:StrCpy:agbcc` | 2026-09-12    | 2a626ac | a redundant re-read the compiler then eliminates |

## The recipe

Both halves are "compile a C file the way the row's harness compiles a candidate, and compare the
function's bytes with the target's". One command hands you the target and the exact compile line:

```sh
pnpm bench target <row-id> --out <dir>      # writes target.o, decomp.yaml, ctx.i
```

`decomp.yaml`'s `tools.asmlift.compiler` is the compile command, with `{{inputPath}}` the candidate
`.c` and `{{outputPath}}` the `.o`; `ctx.i` is the prelude it is prepended to. Run it over each
spelling and compare the function's own bytes — not the whole object, whose inter-function pad
differs between the harness's assembly path and a hand one (`c046` against `0000` on this row):

```sh
arm-none-eabi-objcopy -O binary --only-section=.text <o> - | xxd -p
```

The spelling asmlift actually publishes comes from `pnpm bench fan <row-id> --show best`, so the
first thing to try is always **that source plus the candidate construct**: if the row is a quirk
row, the delta is usually one line.

## `kleod:StrCpy:agbcc`

Taken 2026-09-12 at asmlift `2a626ac`. Every number below is from that day.

### The row

```
pnpm bench baseline StrCpy
kleod:StrCpy:agbcc  asmlift=nonmatch 5/8  m2c=nonmatch 6/7  fan=1 rank=3.6s
```

The fan is **1**: asmlift considers exactly one spelling for this function, so there is no ranking
question here, only a generation one. All three vehicles agreed on the day (`docs/ranked-repro.md`'s
table is still the one that measures): `pnpm bench fan kleod:StrCpy:agbcc` and
`pnpm bench repro kleod:StrCpy:agbcc --run` both `unsigned: 5/8`, the project-checkout command
`unsigned: 6/9`.

The target is seven Thumb instructions, `0a78 0270 0130 0131 002a f9d1 7047`:

```
ldrb r2, [r1]    strb r2, [r0]    adds r0, #1    adds r1, #1    cmp r2, #0    bne .-10    bx lr
```

The published source is `void StrCpy(u8 *dst, u8 *src)` with `u32 c` and a loop body that reads
`*src` into `c`, stores it through `dst`, **reads `*src` into `c` a second time**, then advances
both pointers.

### The residual is one instruction, not three

The artifact's breakdown is `insert 1, delete 0, replace 0, opMismatch 0, argMismatch 4`. asmlift's
candidate is the same seven operations in the same order plus one extra register copy at the top:

```
adds r2, r0, #0   ← the insert
ldrb r0, [r1]     strb r0, [r2]    adds r2, #1    adds r1, #1    cmp r0, #0    bne .-10    bx lr
```

The four `argMismatch`es are that copy's consequence: `c` lives in `r0` and `dst` in `r2`, the
target's assignment the other way round. So the whole 5/8 is **one register-allocation decision**,
not three independent gaps — which answers the obvious second question ("part of the residual must
be a real capability gap") with a no.

### The allocation decision is not asmlift's to make

The tempting theory is that asmlift's own spelling causes it: the candidate opens `v1 = a1; v2 = a0;`
— copies of the parameters into locals — and the extra instruction is a register copy. It is wrong,
and the measurement that refutes it is cheap. Hand-write the honest spelling with **no** local
copies, mutating the parameters directly:

```c
void StrCpy(u8 *dst, u8 *src) { u32 c; do { c = *src; *dst = c; dst++; src++; } while (c != 0); }
```

Its object is **byte-identical to asmlift's candidate's** — `cmp` on the whole `.o` file, not just
the text. The local copies cost nothing; agbcc coalesces them and then makes the same choice. In the
other direction, adding the copies to the published source (`u8 *dst = d0; u8 *src = s0;` with the
re-read kept) still matches. The copies are free in both worlds; the re-read is the whole difference.

### NECESSARY: 252 honest spellings, none of them reach the bytes

A sweep over six types for `c` (`u8`, `u16`, `u32`, `s32`, `int`, `unsigned int`) × fourteen loop
bodies carrying no redundant read (`do`/`while (1)`/`for (;;)`/`goto`, pre- and post-increment,
fused `*dst++ = *src++`, both increment orders, `c != 0` and `c` and `c > 0` as the test) × three
signatures (parameters mutated directly, parameters copied into locals in either order) — **252
spellings, 252 compiles, 0 reaching the target bytes.** Every one of them emits the same eight
instructions with the same leading copy.

The control is the same sweep with the re-read restored: 48 spellings, **24 matching byte-exactly**
— every 32-bit type, in all three loop forms, parameters or locals. The two arms of the sweep
differ in one statement and in 24 outcomes.

The sharpest form of the same measurement: take `bench fan --show best`'s published candidate
verbatim, add one line `v0 = *v1;` after `*v2 = v0;`, and it compiles to the target bytes exactly.
One line, and it is a line with nothing behind it in the object.

### INVISIBLE: the second read is not in the machine code

`ldrb` appears **once** in the target. agbcc eliminates the second read as a common subexpression —
storing through `dst` does not, to its alias analysis, kill a load of `*src` — and then allocates
registers on the post-CSE program, where `c`'s extra reference changes which of `r0`/`r2` it wins.
The load is gone; only its effect on the allocator survives.

So the lift sees one load and the IR holds one load. For asmlift to spell this row it would have to
emit a memory read the machine demonstrably did not perform, chosen because doing so happens to
move a register allocation. That is the direct inverse of the rule this repo already enforces in the
other direction — a read the machine _did_ perform must survive into the spelling, even when the
value is discarded (#183) — and it is unsound for the same reason: on device memory a fabricated
read is an extra bus cycle, and nothing in a lifted function proves its pointers are not device
memory.

It is also a construct with essentially no inhabitants. Over the 252 functions in
`apps/benchmark/dataset/real`, exactly one — this one — repeats an identical read statement inside
a single straight-line block at a distance under 24 statements. (The 48 other repeated reads are all
`af:Skin_Matrix_MulMatrix` recomputing four matrix rows, 24 statements apart, which is arithmetic
rather than redundancy.)

### What the quirk is NOT

Three near neighbours that do not produce the target, each measured:

- **A dead extra reference.** `c = c;` in the same position: eight instructions. The allocator is
  not simply counting references to `c`.
- **The re-read before the store.** `c = *src; c = *src; *dst = c;`: eight instructions. It has to
  sit after the store.
- **A re-read of the destination.** `c = *dst;` after the store leaves a real second `ldrb` in the
  object — agbcc does not forward its own store. That one _is_ visible, so it is a different case
  and not a quirk at all.

Also measured: `u8`/`u16` for `c` do not match even with the re-read, and swapping `dst++`/`src++`
under the re-read gives seven instructions with the two `adds` transposed — near, not equal.

### A note on the m2c column

m2c's `6/7` reads better than asmlift's `5/8` and is not: its source drops both pointer increments,
so it copies one byte forever. It scores better by being two instructions shorter (`delete 2`), on a
function it did not recover. The comparison is between a correct spelling that is one instruction
long and an incorrect one that is two short.

### What would change the verdict

A general capability that produced this source from this object. It would have to decide, from
seven instructions, that the compiler eliminated a load, and re-introduce it — a search over source
redundancies scored by the compiler, unbounded in the number of places a redundancy could go, with
one inhabitant in the corpus and no soundness argument for fabricating memory traffic. Nobody should
build it because this row wants it. If it arrives for another reason, delete this entry and re-run
the sweep.
