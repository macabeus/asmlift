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
spelling and compare **the function's own bytes, cut to the symbol's size**:

```sh
arm-none-eabi-objcopy -O binary --only-section=.text <o> /tmp/f.bin
sz=$(arm-none-eabi-nm -S <o> | awk '$4=="<Symbol>"{print $2}')
xxd -p -l $((0x$sz)) /tmp/f.bin
```

Two traps, both measured on 2026-09-12 on this machine's toolchain (Arm GNU Toolchain 14.2.Rel1,
`objcopy` 2.43.1 — the one the row's harness uses), and both of which make the comparison **lie**
rather than fail:

- **Never write `… <o> - | xxd -p`.** This `objcopy` does not honour `-` as stdout. It prints
  nothing, exits **0**, and writes a file literally named `-` into the current directory. So every
  comparison becomes `"" == ""`: every spelling "falsifies" the entry, on the one path this page
  offers for overturning a verdict that closes a row. The stray file also leaves `?? -` in
  `git status`, which is the mid-run-dirty condition that voids a bench run from the worktree an
  agent following this page is standing in.
- **`--only-section=.text` is not the function.** The inter-function pad lives inside `.text` and
  differs between the harness's assembly path and a hand one. On this row the target's `.text` is
  `0a78027001300131002af9d17047`**`0000`** while the hand-compiled spelling that is byte-identical
  to it carries the same fourteen bytes followed by **`c046`**. Cut to the symbol's size
  (`0000000e` here) and they are equal. Without the cut, the one spelling that _does_ match is the
  one the recipe reports as a mismatch.

The spelling asmlift actually publishes comes from `pnpm bench fan <row-id> --show best`, so the
first thing to try is always **that `candidate` plus the construct**: if the row is a quirk row, the
delta is usually one line.

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

Two sources are in play below and `results.json` already names them, so this page uses its words
rather than "published" for both. The **`refSource`** — the kleod ground truth — is
`void StrCpy(u8 *dst, u8 *src)` with `u32 c` and a loop body that reads `*src` into `c`, stores it
through `dst`, **reads `*src` into `c` a second time**, then advances both pointers. The
**`candidate`** is what asmlift emits (`pnpm bench fan --show best`), which declares `s32 v0` and
carries no second read. They differ by exactly the one line this page is about.

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
other direction, adding the copies to the `refSource` (`u8 *dst = d0; u8 *src = s0;` with the
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

The sharpest form of the same measurement: take the `candidate` verbatim, add one line `v0 = *v1;`
after `*v2 = v0;`, and it compiles to `0a78027001300131002af9d17047` — the target's fourteen bytes
exactly (re-taken 2026-09-12 with the symbol-size cut above). One line, and it is a line with
nothing behind it in the object.

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

### The inhabitant count, and what it is a count OF

The construct also has almost no inhabitants — but the predicate has to be the CLASS, not a proxy
for it, and the first version of this section stated a proxy. Say the class outright: **a repeated
identical read statement, inside one straight-line run, with no intervening call.** Over the 252
functions in `apps/benchmark/dataset/real` (6 projects × 42) it has **one** inhabitant, this row.
Re-run it — split each `funcC` into straight-line runs at every brace and control keyword, split
those into statements, and report a statement that (a) repeats verbatim, (b) has a memory access on
its right-hand side, and (c) has no `ident(` between the two occurrences.

Dropping clause (c) — which is what the earlier wording did, under a distance bound of "under 24
statements" — returns **two**, and lifting the distance bound too returns **three**. Both extras are
near-misses, and each is excluded by a measurement rather than by the bound (taken 2026-09-12):

| near-miss                                  | repeats                                   | why it is not an inhabitant                                                                                                                                                                                                             |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sa3:sub_806132C` (4 repeats, 15–16 apart) | `s->x = TO_WORLD_POS_RAW(…)` and its twin | A call sits between them, and agbcc does **not** CSE a load across a call: `*p = g; f(); *q = g;` keeps two `ldr` of `g` (`2168` … `2068`), while `*p = g; *q = g;` keeps one (`1268`, two `str`). The repeat is VISIBLE in the object. |
| `af:Skin_Matrix_MulMatrix` (48, 24 apart)  | `cx = mfB->xx;` and its fifteen siblings  | An `ido7.1` row, not agbcc, and ido7.1 keeps both loads: `cx = b->xx; d->xx = cx*cx; cx = b->xx; d->yx = cx*cx;` disassembles to **two** `lwc1 $f0,0(a0)`, the single-read form to one. VISIBLE again.                                  |

The bound "under 24" was doing the work of the second row and was set at exactly that row's
distance, which is how a census stops meaning anything. It is gone.

**And the clause that looks like it belongs here does not.** "No intervening may-aliasing store" is
the obvious third condition, and it is wrong for agbcc: `c = p->a; q->b = c; c = p->a;` compiles
byte-identically to the single-read form (`0068486008607047`, one `ldr`) even though `p` and `q` are
the same struct type. agbcc CSEs straight through a may-aliasing store — which is precisely why this
row is an inhabitant at all, since `*dst = c` sits between its two reads of `*src`.

**The count is over READS; the Phase-1 bullet it backs is wider.** `/match-function` writes the
outcome as "a redundant expression the compiler then eliminates", and a redundant _store_ is one
too. `sa3:sub_804D360:agbcc` (`outcome: nonmatch`) has `s->qAnimDelay = 0;` twice in a row in its
`funcC`, and that duplicate really is invisible: `s->a=1; s->b=0; s->b=0; s->a=2;` and the same
without the repeat both compile to `00214160022101607047`. Nobody has shown that duplicate is what
makes that row nonmatch — it is a far larger function with a fan of 8 — so it is not a second entry
in this register. But the inhabitant count above buys "essentially no inhabitants" for repeated
READS only, and should not be cited for the wider class.

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

**And the extra reference is not the only thing that moves `c` into `r2`.** A test-at-top loop with
no redundant read anywhere already produces the target's register assignment:

```c
void StrCpy(u8 *dst, u8 *src) { u32 c; while ((c = *src) != 0) { *dst = c; dst++; src++; } *dst = c; }
→ 02e0 0270 0130 0131 0a78 002a f9d1 0270 7047
```

`0a78` is `ldrb r2, [r1]` and `002a` is `cmp r2, #0` — `c` in `r2`, `dst` in `r0`, exactly the
target's assignment, with no `021c` copy. Only the rotation and the extra tail store are wrong. So
the allocation flip is a function of loop SHAPE as well as of the extra reference, and loop shape is
asmlift's business in a way that fabricating a load is not.

### A note on the m2c column

m2c's `6/7` reads better than asmlift's `5/8` and is not: its source drops both pointer increments,
so it copies one byte forever. It scores better by being two instructions shorter (`delete 2`), on a
function it did not recover. The comparison is between a correct spelling that is one instruction
long and an incorrect one that is two short.

### What would change the verdict

Two directions, and they are not equally unsound.

**The one this entry rules out.** A general capability that produced this source from this object
would have to decide, from seven instructions, that the compiler eliminated a load, and re-introduce
it — a search over source redundancies scored by the compiler, unbounded in the number of places a
redundancy could go, with one inhabitant in the corpus and no soundness argument for fabricating
memory traffic. Nobody should build it because this row wants it.

**The one a falsifier should push on first.** Loop rotation, per the `while ((c = *src) != 0)`
probe above: that spelling needs no fabricated read and already wins the target's register
assignment. Everything tried so far still costs more than it saves — twelve rotated and mid-exit
forms (`for(;;){…;if(!c)break;}`, `while(1){…;if(c==0)return;}` and `goto`, each in
`u32`/`s32`/`int`/`u8`) all re-emit the leading `021c` and give
`021c08781070013201310028f9d17047`, and the test-at-top form above pays an extra tail store — but
this is the axis where a falsification would not require the unsound part, and it is squarely
asmlift's business.

If either arrives, delete this entry and re-run the sweep.
