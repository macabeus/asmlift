# The 64-bit integer representation

Core has no 64-bit integer value. `grep -n "Core has no 64-bit integer type at all" packages/core/src/l3/typing.ts`
says so in as many words, and the decomp typedef vocabulary says the same from the other end —
`grep -n "the decomp typedef vocabulary (C_TYPEDEFS) has no 64-bit scalar" packages/core/src/contracts.ts`
stops `SCALAR_WIDTHS` at `{1, 2, 4}`.

This file is the measured case for adding one, the measured price of adding one, and the list of
things that are blocked while it is absent. It exists because the decision is a permanent
project-level trade — a documented soundness invariant with three consumers, against a corpus
clientele of three real rows — and a trade like that should be made against evidence rather than
re-derived by each round that walks into it.

Everything below is a command that was run. Where a claim is a design judgement that has not been
built, it says so.

**Where the blocker sits, by level.** `docs/level-tower.md`'s bar has two halves — a capability
that genuinely cannot be expressed in the current representation, _and_ a differ that can prove the
result matches. §1 clears the second half at the **backend**: the bytes are reachable only from C
that declares a 64-bit local, and one compile proves it. §2 is about the first half, and it does
**not** land where the first draft of this file put it. The IR can already produce two 32-bit halves
of one 64-bit machine result (§2.1). What it cannot do is let such a pair survive as a **value** —
which is an `L2`→`L3` and backend question (a type in `C_TYPEDEFS`, a width in `SCALAR_WIDTHS`, a
rendering), not a new IR op. Section 3 prices that side and is the expensive one.

## 1. It is required by the bytes, not preferred by the design

`pokeemerald:MathUtil_Mul32:agbcc` is nine lines of C whose target calls `__muldi3`. Six spellings,
compiled at the row's own agbcc flags in the row's own `ctx.i`, each disassembled and diffed against
the row's `target.o`:

| spelling                           | `bl __muldi3` | differing disassembly lines vs target |
| ---------------------------------- | ------------- | ------------------------------------- |
| `return (x * y) / 256;`            | 0             | 37                                    |
| `s32 r = x; r *= y; r /= 256;`     | 0             | 38                                    |
| `u64 r = x; r *= y; r /= 256;`     | 1             | 37                                    |
| `s64 r = x; r *= y; r >>= 8;`      | 1             | 37                                    |
| `return ((s64)x * y) / 256;`       | 1             | 28                                    |
| **`s64 r = x; r *= y; r /= 256;`** | 1             | **0 — identical**                     |

**No 32-bit spelling emits `bl __muldi3` at all.** The target instruction is unreachable from any
C that does not name a 64-bit type, so a decompiler with no 64-bit value cannot reach these bytes
by any route. The two near misses each pin one fact: `u64` pins the signedness (its disassembly
carries no `asr` sign-extends and no bias), and `>>= 8` pins the operator (the `+255`-when-negative
bias is what distinguishes `/` from `>>`, which is `raise/divpow2.ts`'s existing territory).

**The cast-only row is the one that separates two questions.** `return ((s64)x * y) / 256;` names a
64-bit type but declares no 64-bit local. Its algorithm is IDENTICAL to the target's — same `adc`
rounding block, same `+255` bias, same `<<24 | >>8` merge — and all 28 differing lines are register
copies and an extra `{r6, r7}` push. So the bytes require a 64-bit **local with a home**, not merely
a 64-bit rendering of an expression. That is the strongest evidence in this file for §2's "one
value, not two results", and it is why a route that produces the pair and consumes it immediately
(§2.1) does not reach these bytes.

Nothing external is needed to recover the type. `asr r5, r0, #31` and `asr r3, r2, #31` pin the
sign extension, `__muldi3` rather than `__umuldi3` pins the signedness, the `r0:r1` return pair
pins the width, and the bias pins `/256` over `>>8`.

## 2. What is actually in the way

The obvious alternative is to leave the type alone and let a call return two 32-bit results. The
first draft of this file argued that no op in the IR has more than one result, therefore a pair
return must be one value, therefore the route is closed. The premise is true — every entry in
`OPCODES` is `results: 0` (×6) or `results: 1` (×42) — and the inference from it is wrong.

### 2.1 The IR already models one machine operation producing two 32-bit halves

`grep -n "High word of the 32x32->64 product" packages/core/src/ir/opcodes.ts` is the counter-shape,
and it is the same operation this row needs: MIPS `mult` + `mfhi` and PPC `mulhw` lift as `mul`
beside `mulhu`, two `results: 1` ops. A `__muldi3(a_lo, a_hi, b_lo, b_hi)` decomposes the same way,
with no new IR shape and no `results: 2`, and because the call is REPLACED rather than extended, the
once-per-result materialisation of §2.2 never fires.

**This route is nevertheless not the one.** `mulh`/`mulhu` are TRANSIENT by construction: they carry
no C spelling, and a `mulh` that survives to the structurer hits its `"?"` loud-fail. They work
because the magic-division recognizer consumes both halves and rewrites them away before recovery.
This row's halves are consumed by a 64-bit divide, a 64-bit shift and a truncating return, none of
which has a 32-bit-pair form — and §1's cast-only row shows that even a pair produced and consumed
inside one expression does not reach the bytes, because the bytes want a HOME. So the pair-of-ops
route relocates the blocker rather than removing it: not "the IR cannot produce two halves" but
"nothing downstream can hold one as a value".

### 2.2 The structurer materialises an effectful call once per RESULT, not once per op

Binding `r1` as a second result of the `__muldi3` call makes
`grep -n "where the asm makes" packages/core/src/contracts.ts` fire with _structuring emitted 3
calls to `__muldi3` on one path in `MathUtil_Mul32`, where the asm makes 1_. So the `results: 2`
field edit is not merely a new shape for the IR; it is rejected by a stage contract. That is a fact
about the structurer which will be rediscovered by anyone who tries the field edit first.

### 2.3 C has no spelling for the second return register

Even granting a perfect pair-lift, the backend has to print the high half. m2c does model the pair
and prints `SECOND_REG(temp_ret)`.

**What the harness does with that is a separate defect, and this file previously got it wrong.** m2c
is declined on `pokeemerald:MathUtil_Mul32:agbcc` on its `M2C_CARRY` marker, NOT on `SECOND_REG` —
`SECOND_REG` is not in the decline vocabulary at all
(`grep -n "const DECLINE_MARKERS" apps/benchmark/src/eval/outcome.ts`), although the comment beside
`(bitwise ` there describes exactly the family it belongs to. Three rows' m2c output contains
`SECOND_REG`; the other two, `sa3:sa2__sub_80855C0:agbcc` and `sa3:sa2__sub_8085654:agbcc`, carry no
marker, no compile error and real scores of 20 and 31. Neither row's `ctx` defines the macro — it
compiles as a K&R implicit function declaration — so m2c is being scored on C carrying its own
cannot-express pseudo-call. That is a benchmark-fairness defect on `main`, orthogonal to the
representation question, and it wants its own labelled commit rather than this one.

## 3. The price: rank-blind conversions, and casts hardcoded at 32 bits

`grep -n "The USUAL ARITHMETIC CONVERSIONS over two rendered operands" packages/core/src/l3/typing.ts`
answers the usual arithmetic conversions over two rendered operands, and returns a DEFINITE answer
from an UNKNOWN operand when the known side is unsigned. Its own comment states the condition that
makes that sound: every integer here is rank `int`, so the unequal-rank case cannot arise. A 64-bit
type creates it.

The broken case is exactly one: **an unsigned operand of lower rank against a signed operand of
higher rank.** C converts to the wider type first, so `unsigned int & long long` is SIGNED, while
the function returns `false` — unsigned. Measured on a 64-bit-typed environment:

```
renderedIntSignedness(s64 var) = undefined    (C: signed)
renderedIntSignedness(u64 var) = undefined    (C: unsigned)
arithConv(u32, s64)            = false        (C: SIGNED)   ← the one WRONG case
arithConv(s32, u64)            = undefined    (C: unsigned)
arithConv(s64, s32)            = undefined    (C: signed)
```

The other unequal-rank combinations come back `undefined` rather than `false`, because `promoted`
inside `renderedIntSignedness` answers definitely only at width `< 32` or `== 32`. A rank-aware
repair has to extend that too.

**`undefined` is NOT the safe outcome.** The three named consumers below is where the first draft of
this file stopped, on the reasoning that an unknown only costs a redundant cast. With a 64-bit value
that reasoning inverts: **the cast that resolves an unknown is hardcoded to 32 bits, so it
truncates.** Feeding `emitCFamily` this row's own winning spelling with `r` declared `s64` prints:

```c
s32 MathUtil_Mul32(s32 x, s32 y) {
    s64 r;
    r = x;
    r = r * y;
    r = (s32)r / 256;      /* inserted by the backend; no marker */
    return r;
}
```

`(s32)r` discards the high half of the product. Compiled at the row's own flags, `r = r / 256;` is
0 lines from the target and `r = (s32)r / 256;` is **26** — the whole `adc` rounding block is gone.
So the naive representation produces silently wrong C, scored, with no loud failure anywhere: the
contract at `contracts.ts` guards memory-ACCESS widths, while a 64-bit LOCAL prints `s64 r;` through
`cType`/`typeToString`, which spell any width.

The cast sites, all hardcoded at 32:

| site                                                                                       | what it does                                                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `grep -n "function recast32" packages/core/src/backend/cfamily.ts`                         | builds `T.int(32, signed)`; reached three times from `pinnedOperands` |
| `grep -n "const pinSigned = (x: Expr): Expr =>" packages/core/src/structure/structure.ts`  | the signed-compare pin, `T.s(32)`                                     |
| `grep -n "r = { k: 'cast', to: T.u(32), e: r };" packages/core/src/structure/structure.ts` | the unsigned-compare pin, `T.u(32)`, both arms                        |

And the three consumers of the wrong ANSWER:

| consumer                                                                                        | verdict   | what goes wrong                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grep -n "return arithConversionSignedness(e.l, e.r, varType);" packages/core/src/l3/typing.ts` | **WRONG** | the binary-op tail of `renderedIntSignedness`, _the_ one rendered-signedness judgment. A wrong `false` here propagates to every consumer of that function — including the two `structure.ts` pins above, which is why the repair cannot be costed from this table alone. |
| `grep -n "The compare-meaning gate (see SCOPE)" packages/core/src/l3/initfirst.ts`              | **WRONG** | the gate accepts when `before === after`. Substituting a 32-bit `v` for a 64-bit operand `X` against an unsigned 32-bit operand computes `false` on both sides while the compare's real signedness flips, so the gate accepts a substitution that changes the meaning.   |
| `grep -n "function pinnedOperands" packages/core/src/backend/cfamily.ts`                        | **WRONG** | emits no cast when the computed verdict already equals `wantSigned`. A division whose pair really renders signed, wanted unsigned, is printed uncast — C that means something other than the IR, in the last stage before bytes.                                         |

`initfirst`'s gate carries a second, independent break, visible in its own sufficiency argument. The
comment at `grep -n "then represents any 32-bit-or-narrower X exactly" packages/core/src/l3/initfirst.ts`
justifies the gate by v's declared width, and the check at
`grep -n "if (vt?.kind !== 'int' || vt.width !== 32)" packages/core/src/l3/initfirst.ts` is on `v`,
not on `X`. A 64-bit `X` is not 32-bit-or-narrower, so the argument is void for it while the check
still passes.

**The shape of the repair, unbuilt and unmeasured.** `arithConversionSignedness` needs the RANK of
each side, not only its signedness; at unequal rank the answer is the wider side's signedness, which
is decidable rather than unknown, so a rank-aware version refuses nothing it answers today. The
same change has to reach `promoted`, or the other three combinations stay `undefined`. `initfirst`'s
gate needs `X`'s width alongside `v`'s. And the three cast sites need a width from the operand
instead of the literal 32, or they truncate. Nothing here is written, nothing is measured, and the
estimate that they are small is a judgement, not a result.

## 4. The clientele, counted

Rows whose published record names a 64-bit compiler runtime helper — `__muldi3`, `__ashrdi3`,
`__ashldi3`, `__divdi3`, `__shl2i`, `__shr2i` — over the whole 1,203-row corpus: **10**.

| row                                              | today                                     |
| ------------------------------------------------ | ----------------------------------------- |
| `pokeemerald:MathUtil_Mul32:agbcc`               | declined (`unmodelled instruction 'adc'`) |
| `sa3:sa2__sub_80855C0:agbcc`                     | nonmatch 18/26                            |
| `sa3:sa2__sub_8085654:agbcc`                     | nonmatch 20/32                            |
| `snowboardkids2:func_80051C80_52880:gcc2.7.2kmc` | declined                                  |
| `snowboardkids2:func_8005AB58_5B758:gcc2.7.2kmc` | declined                                  |
| `snowboardkids2:func_8005AE8C_5BA8C:gcc2.7.2kmc` | declined                                  |
| `synthetic:llshl:agbcc`                          | nonmatch 2/4                              |
| `synthetic:llshr:agbcc`                          | nonmatch 2/4                              |
| `synthetic:llshl:mwcc_242_81`                    | match 0/8                                 |
| `synthetic:llshr:mwcc_242_81`                    | match 0/8                                 |

Three of those are reachable by one agbcc capability and are one fixed-point idiom: the two `sa3`
rows publish `a0 - __ashrdi3(__muldi3(a2, a2 >> 31, a0 - a1, a0 - a1 >> 31))`, the same
`(s64)c * (a - b) >> d` shape as `MathUtil_Mul32`. The three MIPS rows are blocked earlier, on
unmodelled calls.

**Reach is three real rows, all agbcc, all one idiom.** That number is the honest other side of the
price in §3, and it is the number the decision turns on.

### 4.1 A carry opcode is not evidence of a 64-bit add

Six rows decline on a marker naming a carry opcode — `adc` ×2, `sbc` ×1, `addc`+`adde` ×1, `subfe`
×2. That six **includes** `pokeemerald:MathUtil_Mul32:agbcc`, which is also row 1 of the table
above, so the carry population is not a separate clientele: outside this row it is entirely
synthetic `ll*` rows that exist to pin this family.

Scanning `targetAsm` for a carry-consuming mnemonic over all 1,203 rows finds **10** rows, all
declined, and they are at least three unrelated idioms:

- **`srawi; addze` is signed division by a power of two.** Four sites over three rows —
  `marioparty4:fn_1_83C8:mwcc_242_81` (`srawi r0,r0,5; addze r27,r0`),
  `pikmin:calcDataSize__6TexImgFiii:mwcc_233_163n` (×2) and
  `pikmin:drawSphere__8GraphicsFR8Vector3ffR8Matrix4f:mwcc_233_163n`. This is
  `raise/divpow2.ts`'s existing territory. A model keyed on "reads the carry bit ⇒ high half of a
  64-bit add" would convert a correctly-recoverable signed divide into a fabricated 64-bit add, and
  if it ran before `divpow2`, silently.
- **`subfe rX, rY, rY` — the same source register twice — is a branchless compare.**
  `ac-decomp:JW_JUTGamePad_read:mwcc_242_81` runs `subfc r0,r4,r7; subfe r5,r5,r6; subfe r5,r6,r6;
neg. r5,r5`, with the surrounding `xoris rX,rY,32768` flipping the sign bit so the unsigned carry
  ops perform a SIGNED comparison. Note that one `subfc` feeds TWO `subfe`s, so a
  one-producer-one-consumer pairing rule drops or duplicates one of them.
- **A genuine 64-bit `addc`/`adde` pair that the marker count does not see.** That same
  `ac-decomp:JW_JUTGamePad_read:mwcc_242_81` declines EARLIER, at lift, so its carry opcodes never
  reach the structurer's refusal. The marker count is a floor on the clientele, not a measure of it.

### 4.2 The agbcc `adc` population is narrow, and all three of its shapes break a naive pairing

Hazards predicted and NOT reproduced on agbcc, at this row's flags: `u64 x << 1` lowers to
`lsr/lsl/orr` and never touches the carry; unsigned-overflow and carry-to-boolean tests
(`(a+b) < a`, `a >= b`) emit `cmp` + `bcs`/`bcc` + `mov`; `s64` comparison branches; `-a` calls
`__negdi2`. So "the carry was set by a shift" and "`adc` as a conditional increment" do not arise
here. What does:

| C                       | agbcc                                                 | why it breaks a naive pairing                                                                       |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `u64 t = x; t += t;`    | `add r0,r0,r0 ; adc r1,r1,r1`                         | both `adc` sources are the SAME register; the value is `x+x`, not `a+b`                             |
| `(u64)a + b`, a,b `u32` | `mov r4,#0 ; mov r2,#0 ; add r3,r3,r1 ; adc r4,r4,r2` | both `adc` sources are literal ZERO — the carry bit is the entire value; fold `0+0` and it vanishes |
| `a + 1`, a `u64`        | `mov r0,#1 ; mov r1,#0 ; add r0,r0,r2 ; adc r1,r1,r3` | the constant is pre-loaded into the DESTINATION; operand order is reversed against the source       |

## 5. The fabricated signatures are a SEPARATE defect, and they cost nothing to fix

Thirteen matched rows publish a shorter parameter list than their reference source. Four of them are
undecidable and must not be "fixed" — an unused parameter leaves no trace in the asm:
`ac-decomp:aNRG2_setup_j11_cont:mwcc_242_81`, `marioparty4:HuSysVWaitGet:mwcc_247_107`,
`pokeemerald:EReader_Reset:agbcc` and `pokeemerald:AcroBikeHandleInputTurning:agbcc`.

The other **nine** publish a function with **no parameters** calling a runtime helper with **no
arguments**:

```c
s32 llshl(void) {
    return __shl2i();
}
```

for a source that reads `long long llshl(long long a, int b) { return a << b; }`. They are
`synthetic:fadd:agbcc`, `synthetic:fsub:agbcc`, `synthetic:fmul:agbcc`, `synthetic:fdiv:agbcc`,
`synthetic:fcmp:agbcc`, `synthetic:f2i:agbcc`, `synthetic:i2f:agbcc`,
`synthetic:llshl:mwcc_242_81` and `synthetic:llshr:mwcc_242_81`. Seven of the nine are 32-bit
soft-FLOAT helpers, so **the mechanism is not register pairs.** It is PASS-THROUGH, which
`grep -n "it can under-count pass-through parameters" packages/core/src/frontend/ssa.ts` already
names: the helper's arguments are the caller's own parameters, which the caller never writes, so
`fallbackArgc` sees no reaching definition and guesses zero.

Four measured facts about the repair:

1. **asmlift ALREADY emits the honest spelling when the arity is declared.** No capability is
   involved:

   ```
   $ asmlift fadd.s --target agbcc --name fadd --proto '{"__addsf3":{"params":2}}'
   s32 fadd(s32 a0, s32 a1) {
       return __addsf3(a0, a1);
   }
   ```

   The same command without `--proto` emits `s32 fadd(void) { return __addsf3(); }`.

2. **The honest spelling costs 0 MATCHES.** Both spellings compiled at the row's own `decomp.yaml`
   agbcc line and disassembled: the only differing line is the objdump filename header. The `.text`
   is byte-identical, so the match is not resting on the fabrication.

3. **asmlift ALREADY WARNS.** The un-`--proto`'d run prints `asmlift: [proto] 1 callee(s) have no
declared arity, guessed from the argument registers: __addsf3 — pass --proto …`. The loud channel
   exists; the benchmark harness does not treat it as a decline marker. This is an unheeded warning
   in the harness, not a silent wrong answer in the CLI.

4. **A short list and a wrong list are different, and only the NESTED case produces the wrong one.**
   At `sa3:sa2__sub_80855C0:agbcc` the published
   `__ashrdi3(__muldi3(…))` passes one argument where the asm passes three, and the function's
   fourth parameter — the shift count, `lsl`/`lsr`-narrowed to `(u8)a3` and moved into `r2`
   immediately before the `bl` — is declared but never passed. Here a declared arity would recover
   `r1` at the OUTER call, which is the INNER call's unmodelled high half, so a signature alone
   would replace a short argument list with a WRONG one. That hazard is specific to a helper whose
   argument is another helper's return pair; it is not a property of argument registers in general,
   which are read BEFORE their call. Both `sa3` rows are nonmatches, so even there the honest
   signature costs no match.

**So this is not a consequence of the 64-bit gap.** It is a live correctness defect on `main`, it
inflates the published match count by presenting nine fabricated signatures as recoveries, and its
fix is a signature table rather than a representation. The table's HOME is an open design question
and is deliberately not answered here: `RUNTIME_HELPERS` is derived from `SOFT_DIV`, whose value
type is a division `Opcode`, so `__addsf3` cannot live there without a fake op; and `proto.ts` holds
signatures fixed by the C STANDARD, which a compiler runtime helper is precisely not.

## 6. Two routes that were measured, and what each measurement does and does not say

Both were built as throwaway ablations, measured with `pnpm bench sweep --base origin/main`, and
reverted.

### 6.1 Modelling the `bl` caller-saved clobber — a null on REACH, not a clearance on SOUNDNESS

`grep -n "needs no modelling — agbcc has already" packages/core/src/frontend/thumb.ts` asserts that
the callee's clobber of `r1..r3` needs no modelling because agbcc has already moved anything live
across the call into a callee-saved register. A probe that throws on a read of `r1`/`r2`/`r3` after
a `bl` with no intervening write sweeps to **86 records against an 84-record clean-tree control** —
2 records, 1 row, `pokeemerald:MathUtil_Mul32:agbcc`, which already declines.

**That is a measurement of corpus REACH and nothing else. The comment is not sound, and this file
must not be read as clearing it.** A function outside the corpus demonstrates it:

```
probe_r3_after_call:
	push {r4, lr}
	mov  r3, #0x2a
	mov  r0, #0x3
	bl   callee          @ AAPCS: r3 is caller-saved; its contents are now undefined
	add  r4, r3, #0
	add  r0, r4, #0
	pop  {r4} ; pop {r1} ; bx r1
```

```
$ asmlift clobber2.asm --target agbcc --name probe_r3_after_call --proto '{"callee":{"params":1}}'
s32 probe_r3_after_call(void) {
    callee(3);
    return 42;
}
EXIT=0
```

`42` is the value `r3` held BEFORE the call. Expected: a refusal. No marker, no warning, exit 0. The
same happens with `r1` as an argument register. Corpus reach 0 is not user reach 0 — asmlift is run
on real decomps outside this corpus.

**This bears directly on the capability §1 argues for.** The row's target does
`add r1,r5,#0; bl __muldi3; add r5,r1,#0; … cmp r5,#0; bge`, and the published source tests
`a0 >> 31` where the asm tests the call's high half: the wrong value is already in the row's record.
The only thing making that loud today is the unrelated `ASMLIFT_ERROR("unmodelled instruction
'adc'")` beside it. **Modelling `adc` removes that mask.** So a carry model must not land before
either a refusal here or a pair-return result model — otherwise the row emits compilable, scorable,
arithmetically wrong C.

For this row, `r1` after the call is the callee's HIGH HALF — a result, not a clobber — so the
narrow fix is the pair-return model and not the general clobber model. That is a statement about
THIS row, not about the corpus.

### 6.2 Recognising the `*di3` family on `raise/softdiv.ts`'s template

Neither half stands alone **for the nested case**. The rewrite half needs an existing op to rewrite
to and none holds a 64-bit value (§2.1 qualifies this: `mul`+`mulh` produce the pair, but nothing
downstream can hold it). The signature half hits §5.4's nesting hazard. For the nine PASS-THROUGH
rows of §5 the signature half does stand alone, costs nothing, and is a different piece of work.

## 7. What would change this entry

A fourth real row outside the fixed-point idiom, a second compiler family reaching it, or a measured
repair of `arithConversionSignedness` cheaper than §3 estimates, each moves the trade. A 32-bit
spelling that reaches `MathUtil_Mul32`'s bytes falsifies §1 outright — the recipe is the table
there, and one compile settles it. A consumer that can hold the `mul`+`mulh` pair as a value moves
§2.1 from a relocation of the blocker to a removal of it.
