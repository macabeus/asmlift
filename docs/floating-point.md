# Hardware floating point

asmlift lifts the SINGLE-PRECISION ARITHMETIC of the FPU's register file on MIPS o32 and the
PowerPC EABI — `add.s`/`sub.s`/`mul.s`/`div.s`/`neg.s`/`mov.s` and `fadds`/`fsubs`/`fmuls`/`fdivs`/
`fneg`/`fmr` — through each ABI's float argument and return homes, and nothing else in that file.
§6 says what is built and what the next layer is; `docs/level-tower.md` ("A float, across the
tower") carries the refusal table. Every other FPU instruction declines, naming the register file.
On the GBA none of this shows up at all, because agbcc routes every `float` through soft-float
helper calls that asmlift already models as ordinary calls.

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

The 113 are not one refusal, and the split is three ways:

```sh
node -e "const R=require('./apps/benchmark/results/results.json').results;
const MN=/^\s*[0-9a-f]+:\t([a-z][\w.]*)/;
const FP=/^(l|s)(wc1|dc1)\$|^(mf|mt|ct|cf)c1\$|^bc1[tf]l?\$|^(add|sub|mul|div|mov|neg|abs|c|cvt|trunc|round|ceil|floor|sqrt)\.[sdw]|^f[a-z]|^(lfs|lfd|stfs|stfd|psq_|ps_)/;
const t=r=>(r.targetAsm||'').split('\n').some(l=>{const m=MN.exec(l);return m&&FP.test(m[1])});
const has=(r,re)=>(r.asmlift.errorMarkers||[]).some(m=>re.test(m));
const fp=R.filter(t);
const named=fp.filter(r=>has(r,/unmodelled floating-point instruction/));
const cc=fp.filter(r=>has(r,/floating-point condition-code branch/));
console.log('FPU-touching:',fp.length,'| names an FPU instruction:',named.length,
            '| fp-cond-branch:',cc.length,'| neither:',fp.length-named.length-cc.length)"
```

**69 / 14 / 30.** The 69 decline with a message naming an FPU instruction — the population
`frontend/opaque.ts`'s `fpReg` and `fpControl` reach. The **14** are `bc1t`/`bc1f` condition-code
branches, refused by their own guard in `frontend/mips.ts` and reported as their own class
(`fp-cond-branch`): the same missing file, but a branch has no destination to degrade, so it is a
different mechanism and `opaqueDest` could not answer it — the `float` class in
`apps/web/src/pages/benchmark/lib/declines.ts` says so, and this is the figure it is saying it
about. The remaining 30 refuse at some earlier guard entirely (a PowerPC constant-pool name, a
`bctr`, an unpaired relocation).

**A capability that closed only the FPU register file would move at most those 69, and a round
pricing it should say which.** The condition code is a fifth thing to build, not part of layer 1.

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

1. **A register file.** Neither frontend's integer register predicate takes one. PowerPC's `isReg`
   is `/^r\d+$/`, so an `f1` is not a register to it at all. MIPS is the worse half and in the other
   direction: `isMipsReg` is `/^(\$\d+|[a-z][a-z0-9]*)$/i`, which REJECTS the objdump spelling `$f12` and ACCEPTS a bare
   `f12` — so on the Splat dialect, which strips the `$` sigil, an FPU register passes for a GPR
   and an `add.s` becomes an opaque on a register in a file nothing models. This is the layer the
   decline names (`unmodelled floating-point instruction … the floating-point register file`) for
   every FPU instruction outside the decoded arithmetic (§6). `frontend/splat.ts` keeps the sigil on
   an FPU register for exactly this reason — objdump writes a GPR bare and an FPU register with the sigil,
   so preserving it is what the reader's own header promises, and the bare form is indistinguishable
   from an objdump branch target, which is also bare lower-case hex (`f4`, `fa0`).

   WHICH TOKENS ARE FPU REGISTERS IS ITS OWN QUESTION, and it has three answers, not one: objdump
   numbers the file (`$f12`), the Splat trees use o32 ABI names (`$ft2`, `$fv0`, `$fa0`, `$fs0`),
   and those names take a trailing `f` for the ODD HALF of a double-precision pair. `mtc1 $at,
$ft0f` is a line in this corpus' own denominator — six sites, all in `af`:

   ```sh
   grep -rnE '\$f[a-z]+[0-9]+f\b' apps/benchmark/checkouts/*/asm
   ```

   A predicate anchored on a final digit covers the first two and not the third, and the miss is
   silent: the reader strips the sigil off what it did not recognise and `isMipsReg` takes the
   result. The reader's decision and the frontend's are therefore ONE predicate — `MIPS_FP_REG`,
   exported from `frontend/splat.ts` — because two copies can disagree in either direction and each
   direction is green on its own. Across every `$`-token in the three MIPS `asm/` trees it matches
   52 and all 52 are FPU registers; `$fp` is the frame pointer and the required digit is what
   excludes it.

   PowerPC cannot require a sigil, because objdump prints an FPU register bare (`f1`) — so `f8` is
   both an address and a match there. What keeps that safe is not the predicate: no `b*` mnemonic
   reaches `opaqueDest` at all, because a modelled branch is decoded as a transfer or a call and
   every other one is refused by `ppc.ts`'s whole-function control-transfer pre-pass.

   THE FILE HAS A SECOND HALF THAT NAMES NO REGISTER. The FPU control moves — MIPS `cfc1`/`ctc1`,
   PowerPC `mtfsfi`/`mtfsb0`/`mtfsb1`/`mcrfs` — spell the control register in the ISA's other
   namespace (`$31`, a field number, a condition register), so no register-name predicate can see
   them. `opaqueDest` carries an `fpControl` mnemonic pattern beside `fpReg` for them, producing
   the same phrase. They are the MIPS I/II float→int rounding-mode dance and they are not rare:
   **593 sites in 61 functions** across the `marioparty3` and `af` trees, against **0** corpus rows,
   which is why the corpus could not referee this at all. Both numbers come out of one command —
   a site count is a `grep`, but a FUNCTION count needs the `glabel` delimiter, so it needs `awk`:

   ```sh
   C=apps/benchmark/checkouts
   for p in marioparty3 af snowboardkids2-decomp; do find $C/$p/asm -name '*.s'; done \
     | tr '\n' '\0' | xargs -0 cat \
     | awk '/^[[:space:]]*glabel[[:space:]]/{g=$2}
            /\*\/[[:space:]]+(cfc1|ctc1)[[:space:]]/{s++; f[g]=1}
            END{printf "%d sites in %d functions\n", s, length(f)}'
   ```

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

**107 discrimination sites across 17 files**, counted at `e8db01a0`. Two of them are named in
`ir/types.ts` as the reason `intWidth` has exactly one copy: `ir/verify.ts` reads a null width as "not subject to the rule, so
pass" and `raise/runtime-helpers.ts` reads it as "refuse to fold". A float kind is null-width under
both readings and lands on opposite policies, so **a new kind reaches the verifier and the
recogniser together or neither** — the file says so, and this is the first kind that would test it.

## 5. The recommendation

**Do not build hardware floating point before MIPS calls — for MIPS remaining work.** The ordering
is not a preference there; it is the 87% above. A float model landed first reaches 39 functions per
1,000 of remaining MIPS work and turns 69 corpus declines into candidates, most of which would then decline one guard later on the
call they also contain. Board 004 reached the same ordering from the 64-bit side; two independent
gaps now point at the same missing capability.

It does not bind the corpus or PowerPC, which is why §6 exists: every MIPS row that declines on the
FPU is a leaf. And when it is built, build it **downwards, not upwards**: the type and its spelling
(layer 4) are what decide whether any of it matches, the ABI homes (layer 3) are what make a value reach a return, and
the decode (layer 2) is the cheapest and the only one that produces a wrong answer on its own.

Layer 1's honesty came first: the refusal now names the register file rather
than describing the shape of the instruction that ran into it, so the 69 rows read as one capability
in the report instead of three, and `apps/web`'s decline table stops re-deriving "is this floating
point?" from a list of mnemonics that core never told it. It says so on **both MIPS dialects**, in
**every spelling either of them uses** — the numbers, the o32 ABI names and their odd-half `f`
suffix — and for the **control register** as well as the data file. None of those three halves moves
a benchmark figure: the corpus is objdump-only, has no control-register row and no odd-half token,
so **no gate in this repository could have found any of them** and the only evidence is the project
trees and `packages/core/test/fp-refusal.test.ts`, which runs each spelling through `decompile` on
both dialects. The FPU layer of `packages/core/test/contract-invariant.test.ts` is what an ISA with
an FPU is measured against; `OpaquePolicy.fpReg` and `OpaquePolicy.fpControl` are required fields,
so the next frontend with an FPU has to answer for them rather than inherit the generic messages by
omission. The predicate itself has exactly one copy, and a test counts them: the reader decides
which tokens still carry a sigil when the frontend's policy sees them, so a second copy is not a
duplicate but a second half of one decision.

## 6. What is built, and the next layer

Built downwards, in §5's order, and every step of it is in `docs/level-tower.md` ("A float, across the
tower"): an `IrType` kind and its C spelling, the float opcodes and their own L3 operators, the ABI
homes as target data (`TargetDescription.fpu`), and last the decode, which lands only beside the homes.

**What it reached.** Of the 69 rows that decline naming an FPU instruction, the ones whose every FPU
instruction is in the decoded set — rerun it against the artifact you rebased onto:

```sh
node -e "const R=require('./apps/benchmark/results/results.json').results;
const MN=/^\s*[0-9a-f]+:\t([a-z][\w.]*)/;
const FP=/^(l|s)(wc1|dc1)\$|^(mf|mt|ct|cf)c1\$|^bc1[tf]l?\$|^(add|sub|mul|div|mov|neg|abs|c|cvt|trunc|round|ceil|floor|sqrt)\.[sdw]|^f[a-z]|^(lfs|lfd|stfs|stfd|psq_|ps_)/;
const fpm=r=>(r.targetAsm||'').split('\n').map(l=>MN.exec(l)).filter(m=>m&&FP.test(m[1])).map(m=>m[1]);
const named=R.filter(r=>fpm(r).length&&(r.asmlift.errorMarkers||[]).some(m=>/unmodelled floating-point instruction/.test(m)));
const A=new Set(['add.s','sub.s','mul.s','div.s','neg.s','mov.s','fadds','fsubs','fmuls','fdivs','fneg','fmr']);
const B=new Set([...A,'lwc1','swc1','lfs','stfs']);
const inA=named.filter(r=>fpm(r).every(m=>A.has(m))), inB=named.filter(r=>fpm(r).every(m=>B.has(m))&&!inA.includes(r));
console.log('arithmetic only:',inA.length,'| m2c matches:',inA.filter(r=>r.m2c.outcome==='match').length);
console.log('+ 32-bit load/store:',inB.length,'| m2c matches:',inB.filter(r=>r.m2c.outcome==='match').length)"
```

Against `origin/main` at `e8db01a0` (before this layer) that prints **13 / 13** and **15 / 6**. The 13
are all synthetic — `fadd`, `fsub`, `fmul` and `fdiv` on ido7.1, gcc2.7.2kmc and mwcc_242_81, and
`fma1` on mwcc_242_81 — and each lifts to the program that compiled it.

**§5's ordering held for MIPS remaining work and not for this.** Every MIPS row that declines on the
FPU in the corpus is a leaf, and PowerPC calls are modelled, so 58 of the 69 are reachable with no call
work. What bounds the PowerPC half is a refusal of this layer's own: a function that computes on a
float and makes a call refuses, because which FPRs a callee reads, returns in and destroys is not
modelled.

**The next layer is 32-bit FP load and store** (`lwc1`/`swc1`, `lfs`/`stfs`): the second count above,
15 rows, 6 of which m2c matches, real rows among them. §3 is the warning that comes with it — the type
IS the FP part of that gap, and a carrier decode onto the word load is the wrong one. The layer owns a
typed memory access (a float element, a float struct member), and it owns an `lfs` of a small-data
constant, which is how a float LITERAL arrives on PowerPC. **It must first replace two rules this
layer rests on**: the float RETURN is decided by scanning for a decoded write to `$f0`/`f1`
(`frontend/fpu.ts` `writesFloatReturn`), and `ir/verify.ts` holds that a float reaches only a float
op or `ret`. Both are sound only while no float can reach memory, so a store that lands before them
lifts `int st3(float a, float b, float *p, float *q){ *p = a * b; *q = a + b; return 2; }` as a
float return that drops the `2` — `fpu-lift.test.ts` pins that function. The return has to be read
from the value that reaches each `ret`. After it: doubles and `frsp`, the
int/float conversions, and the compares and `bc1t`/`bc1f`, the fifth thing §1 named.
