# Hardware floating point

asmlift has no floating-point model. Not a partial one: there is no `IrType` kind for a float, no
opcode that computes one, no ABI home that carries one, and no backend that spells one. On MIPS and
PowerPC that shows up as a decline; on the GBA it does not show up at all, because agbcc routes
every `float` through soft-float helper calls that asmlift already models as ordinary calls.

This document exists because hardware floating point is the largest single gap between asmlift and
m2c, and because the obvious first move — decode the FPU instructions — is the wrong one. It
measures the gap, prices the layers, and says which layer a round should build first. It does not
propose a design.

Every figure below names the command that recomputes it. Run them; do not quote them.

## 1. How big it is

### In the benchmark corpus

```sh
node -e "const R=require('./apps/benchmark/results/results.json').results;
const MN=/^\s*[0-9a-f]+:\t([a-z][\w.]*)/;
const FP=/^(l|s)(wc1|dc1)$|^(mf|mt|ct|cf)c1$|^bc1[tf]l?$|^(add|sub|mul|div|mov|neg|abs|c|cvt|trunc|round|ceil|floor|sqrt)\.[sdw]|^f[a-z]|^(lfs|lfd|stfs|stfd|psq_|ps_)/;
const t=r=>(r.targetAsm||'').split('\n').some(l=>{const m=MN.exec(l);return m&&FP.test(m[1])});
const fp=R.filter(t), gap=R.filter(r=>r.m2c.outcome==='match'&&r.asmlift.outcome!=='match');
console.log('rows:',R.length,'| asmlift match:',R.filter(r=>r.asmlift.outcome==='match').length,
            '| m2c match:',R.filter(r=>r.m2c.outcome==='match').length);
console.log('rows whose target contains an FPU instruction:',fp.length,
            '| asmlift declines:',fp.filter(r=>r.asmlift.outcome==='declined').length,
            '| m2c matches:',fp.filter(r=>r.m2c.outcome==='match').length);
console.log('m2c matches and asmlift does not:',gap.length,'| of those, FPU-touching:',gap.filter(t).length)"
```

Against this branch's artifact, and identically against `origin/main`'s at `43534788`, that prints
1,262 rows, asmlift 678 / m2c 446; **113 rows contain an FPU instruction and asmlift declines every
one of them, while m2c matches 37**; and of the **90** rows m2c matches and asmlift does not, **37
are FPU-touching — 41%**.

BOTH REFS ON PURPOSE. Every figure here names m2c, which this branch does not touch, so it is a
claim that can expire on `main` while a branch's own gates stay green — `bench regression` compares
a head against the base it was rebased onto, and an outcome that moved on BOTH sides is not a flip.
Re-derive it against the ref you actually rebased onto:

```sh
git show 'origin/main:apps/benchmark/results/results.json' > /tmp/base.json
```

The 113 are not one refusal. 69 of them decline with a message naming an FPU instruction — the
population `frontend/opaque.ts`'s `fpReg` reaches — and the other 44 decline at some earlier guard
(the `bc1t`/`bc1f` condition-code branches have their own, and several PowerPC rows refuse on a
constant-pool name or a `bctr` first). **A capability that closed only the FPU gap would move at
most those 69, and a round pricing it should say which.**

### In the projects, which is the number that decides it

A corpus row count bounds demand from below: the benchmark samples _chosen_ functions. The three
MIPS projects with a remaining-work `asm/` tree are the honest denominator. (The three PowerPC
projects have no such tree — `ls apps/benchmark/checkouts/*/asm` — so **PowerPC FP demand against
remaining work is unmeasurable here, and this table says nothing about it**, even though PowerPC is
41 of the 69 corpus declines.)

`docs/probes/fp-demand.awk` counts one record per `glabel` whose body contains at least one
instruction:

```sh
C=apps/benchmark/checkouts          # `pnpm bench setup` populates it; a git worktree has none
for p in marioparty3 snowboardkids2-decomp af; do
  find $C/$p/asm -name '*.s' -print0 | xargs -0 cat | awk -v PROJ=$p -f docs/probes/fp-demand.awk
done
```

| project        | functions  | touch the FPU | …and contain no call | FPU as a word carrier only | …and no call |
| -------------- | ---------- | ------------- | -------------------- | -------------------------- | ------------ |
| marioparty3    | 10,133     | 4,351         | 519                  | 140                        | 55           |
| snowboardkids2 | 2,760      | 50            | 17                   | 1                          | 1            |
| af             | 11,434     | 2,970         | 414                  | 234                        | 41           |
| **total**      | **24,327** | **7,371**     | **950**              | **375**                    | **97**       |

**303 per 1,000 remaining functions touch the FPU** — larger than every entry in board 004's demand
table, whose biggest is 171. (The denominators are not the same and must not be stacked: 004 counts
19,613 remaining functions across ten checkouts by each project's own convention; this counts 24,327
`glabel`-delimited functions in the three MIPS `asm/` trees. The comparison is of magnitudes.)

But **87% of the 7,371 also contain a `jal` or `jalr`**, and the MIPS frontend refuses a call
outright — `grep -n "MIPS calls not yet modelled" packages/core/src/frontend/mips.ts` — so an FP
model _alone_ reaches **950 = 39 per 1,000**. For scale, the 64-bit gap a round built in September
is 1.8 per 1,000 of the same remaining work.

**So: MIPS calls gate floating point**, which is the same conclusion board 004 reached from the
other end, counting what the 64-bit ceiling costs. A float model shipped before them buys 39/1,000,
not 303/1,000.

## 2. The four layers, and which one the refusal names

A `float fadd(float a, float b){ return a+b; }` compiles on MIPS to two instructions
(`jr ra` / `add.s $f0,$f12,$f14`). Matching it needs all four of:

1. **A register file.** `isMipsReg` is `/^(\$\d+|[a-z][a-z0-9]*)$/i` and PowerPC's `isReg` is
   `/^r\d+$/`: an `$f12` or an `f1` is not a register to either frontend. This is the layer the
   decline now names (`unmodelled floating-point instruction … the floating-point register file`),
   and it is the only layer that exists today.
2. **Decode and an IR opcode.** 41 distinct FPU mnemonics over 2,286 sites in the corpus' targets
   (the `FP` regex above, counted per line rather than per row), and arithmetic needs
   `fadd`/`fsub`/`fmul`/`fdiv` plus the conversions as ops the verifier and the pattern engine
   understand.
3. **ABI homes.** MIPS o32 passes floats in `$f12`/`$f14` and returns in `$f0`; the PowerPC EABI
   uses `f1`–`f8` and returns in `f1`. These are per-target tables, and the second one interacts
   with the GPR argument tables a `double` already perturbs.
4. **A type and a spelling.** An `IrType` kind for a float, and a C backend that prints `f32`.

**Layer 1 alone is worth nothing and layer 2 alone is worth less than nothing**, which an ablation
shows in two lines. Widen `isMipsReg` to accept `$fN` and `add.s` stops throwing — it becomes an
opaque on `$f0`, which still declines. Add a decode arm as well and `synthetic:fadd` lifts to

```c
void fadd(s32 a0, s32 a1) { return; }
```

because `$f0` is not the integer return home, so the add is dead and DCE reaps it. That is the
silent-wrong the refusal exists to prevent, produced by exactly the change that looks like progress.

## 3. The subset that looked like it needed no float model, and did

`lwc1`/`swc1` are 32-bit moves with no conversion: a compiler emits them to copy a float-typed
struct member, and 375 remaining project functions — plus 3 corpus rows, of which only
`marioparty3:CameraScissorSet:gcc2.7.2` is one m2c matches — use the FPU for nothing else.
It is tempting to decode that pair onto the existing word load/store, add no type, and take the
rows.

**Compiling refutes it.** `marioparty3:CameraScissorSet:gcc2.7.2` is the shape: m2c matches it,
asmlift declines at 0x28 on `lwc1`, and everything before that point already lifts. Ablated onto
`emitLoad`/`emitStore`, asmlift lifts it and scores **19/27 — a nonmatch** — because the candidate
it prints is

```c
((s32 *)(((s16)a0 * 36 - (s16)a0 << 4) + v0))[36] = *a1;
```

and an `s32` element compiles to `lw`/`sw`. Change **only the element type** to `f32`, at the row's
own flags, and the same statement compiles to `lwc1`/`swc1`:

```sh
pnpm bench repro marioparty3:CameraScissorSet:gcc2.7.2 --tool asmlift --run
cd .local/repro/marioparty3_CameraScissorSet_gcc2.7.2   # decomp.yaml holds the row's own compile command
cp out.c a.c && sed 's/s32 \*)(((/f32 *)(((/g; s/s32 \*a1/f32 *a1/' a.c > b.c
# concatenate ctx.i ahead of each, run the `compiler:` line from decomp.yaml, objdump both
```

Against the target, the `f32` object differs in **two instructions of twenty**, and neither is
floating point: the `lui`/`lw` pair that loads `gCameraList` sits at the top instead of at 0x1c,
which is the global-access placement question asmlift already enumerates variations over.

So the carrier subset is not a way to get FP rows without a float type. **The type IS the FP part of
the gap here** — `sw` against `swc1` is decided by nothing else — and a carrier decode with no type
would print a candidate that compiles to the wrong instruction on every one of its 375 inhabitants.
It would also be a `float` the tool cannot say out loud in a project whose header declares one,
which is the failure mode `docs/level-tower.md` means by adding a representation with no inhabitant,
run backwards: an inhabitant with no representation.

## 4. What layer 4 costs, measured

```sh
grep -rn "\.kind === 'int'\|\.kind === 'ptr'\|\.kind === 'unknown'\|\.kind === 'struct'\|\.kind === 'array'\|\.kind === 'void'" packages/core/src | wc -l
grep -rln "kind === 'int'\|kind: 'int'\|case 'int':" packages/core/src | wc -l
```

**102 discrimination sites across 17 files.** Two of them are named in `ir/types.ts` as the reason
`intWidth` has exactly one copy: `ir/verify.ts` reads a null width as "not subject to the rule, so
pass" and `raise/runtime-helpers.ts` reads it as "refuse to fold". A float kind is null-width under
both readings and lands on opposite policies, so **a new kind reaches the verifier and the
recogniser together or neither** — the file says so, and this is the first kind that would test it.

## 5. The recommendation

**Do not build hardware floating point before MIPS calls.** The ordering is not a preference; it is
the 87% above. A float model landed first reaches 39 functions per 1,000 of remaining MIPS work and
turns 69 corpus declines into candidates, most of which would then decline one guard later on the
call they also contain. Board 004 reached the same ordering from the 64-bit side; two independent
gaps now point at the same missing capability.

When it is built, build it **downwards, not upwards**: the type and its spelling (layer 4) are what
decide whether any of it matches, the ABI homes (layer 3) are what make a value reach a return, and
the decode (layer 2) is the cheapest and the only one that produces a wrong answer on its own.

What this round shipped instead is layer 1's honesty: the refusal now names the register file rather
than describing the shape of the instruction that ran into it, so the 69 rows read as one capability
in the report instead of three, and `apps/web`'s decline table stops re-deriving "is this floating
point?" from a list of mnemonics that core never told it.
