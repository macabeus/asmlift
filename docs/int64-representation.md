# The 64-bit integer representation

Core has no 64-bit integer value. `packages/core/src/l3/typing.ts:112-114` says so in as many
words, and `packages/core/src/contracts.ts:511` says the same from the other end (the decomp
typedef vocabulary `C_TYPEDEFS` stops at 32, so `SCALAR_WIDTHS` is `{1, 2, 4}`).

This file is the measured case for adding one, the measured price of adding one, and the list of
things that are blocked while it is absent. It exists because the decision is a permanent
project-level trade — a documented soundness invariant with three consumers, against a corpus
clientele of three real rows — and a trade like that should be made against evidence rather than
re-derived by each round that walks into it.

Everything below is a command that was run. Where a claim is a design judgement that has not been
built, it says so.

## 1. It is required by the bytes, not preferred by the design

`pokeemerald:MathUtil_Mul32:agbcc` is nine lines of C whose target calls `__muldi3`. Five
spellings, compiled at the row's own agbcc flags (`-mthumb-interwork -O2 -fhex-asm -g`) in the
row's own `ctx.i`, each disassembled and diffed against the row's `target.o`:

| spelling                           | `bl __muldi3` | differing disassembly lines vs target |
| ---------------------------------- | ------------- | ------------------------------------- |
| `return (x * y) / 256;`            | 0             | 37                                    |
| `s32 r = x; r *= y; r /= 256;`     | 0             | 38                                    |
| `u64 r = x; r *= y; r /= 256;`     | 1             | 37                                    |
| `s64 r = x; r *= y; r >>= 8;`      | 1             | 37                                    |
| **`s64 r = x; r *= y; r /= 256;`** | 1             | **0 — identical**                     |

**No 32-bit spelling emits `bl __muldi3` at all.** The target instruction is unreachable from any
C that does not name a 64-bit type, so a decompiler with no 64-bit value cannot reach these bytes
by any route. The two near misses each pin one axis: `u64` pins the signedness (its disassembly
carries no `asr` sign-extends and no bias), and `>>= 8` pins the operator (the `+255`-when-negative
bias is what distinguishes `/` from `>>`, which is `raise/divpow2.ts`'s existing territory).

Nothing external is needed to recover the type. `asr r5, r0, #31` and `asr r3, r2, #31` pin the
sign extension, `__muldi3` rather than `__umuldi3` pins the signedness, the `r0:r1` return pair
pins the width, and the bias pins `/256` over `>>8`.

## 2. The cheap route is closed, and the reason is about C

The obvious alternative is to leave the type alone and let a call return two 32-bit results —
`call` in `packages/core/src/ir/opcodes.ts:123` has `results: 1`, and `r0:r1` is a pair.

It fails three times over, and the third is fatal:

1. **No op in the IR has more than one result.** Every entry in `OPCODES` is `results: 0` or
   `results: 1`, so `results: 2` is a new shape for the whole IR rather than a field edit.
2. **The structurer materialises an effectful call once per RESULT, not once per op.** Binding
   `r1` as a second result of the `__muldi3` call makes `packages/core/src/contracts.ts:229-232`
   fire with _structuring emitted 3 calls to `__muldi3` on one path in `MathUtil_Mul32`, where the
   asm makes 1_. A pair return therefore has to be **one value**, not two results — and that is a
   fact about the structurer that will be rediscovered by anyone who tries the field edit first.
3. **C has no spelling for the second return register.** Even granting a perfect pair-lift, the
   backend has to print the high half. m2c does model the pair and prints `SECOND_REG(temp_ret)`,
   which does not compile, and m2c is itself declined on this row for exactly that reason. So the
   structurer fix buys a correct lift whose only renderings are a decline at the backend — which is
   where the tool already is — or a fabricated spelling, which is forbidden outright.

## 3. The price: `arithConversionSignedness` and its three consumers

`arithConversionSignedness` (`packages/core/src/l3/typing.ts:119`) answers the usual arithmetic
conversions over two rendered operands, and returns a DEFINITE answer from an UNKNOWN operand when
the known side is unsigned. Its own comment states the condition that makes that sound: every
integer here is rank `int`, so the unequal-rank case cannot arise. A 64-bit type creates it.

The broken case is exactly one: **an unsigned operand of lower rank against a signed operand of
higher rank.** C converts to the wider type first, so `unsigned int & long long` is SIGNED, while
the function returns `false` — unsigned. The other unequal-rank combinations stay correct by
accident (`s32 & u64` and `u32 & u64` are both unsigned in C, and `false` is what comes back).

So the price is not "an unknown"; it is one definite wrong answer, in these three places:

| consumer                  | verdict   | what goes wrong                                                                                                                                                                                                                                                                                                |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `l3/typing.ts:203`        | **WRONG** | the binary-op tail of `renderedIntSignedness`, _the_ one rendered-signedness judgment. A wrong `false` here propagates to every consumer of that function, not only to the two below.                                                                                                                          |
| `l3/initfirst.ts:128-130` | **WRONG** | the compare-meaning gate accepts when `before === after`. Substituting a 32-bit `v` for a 64-bit operand `X` against an unsigned 32-bit operand computes `false` on both sides while the compare's real signedness flips from signed to unsigned, so the gate accepts a substitution that changes the meaning. |
| `backend/cfamily.ts:211`  | **WRONG** | `pinnedOperands` emits no cast when the computed verdict already equals `wantSigned`. A division whose pair really renders signed, wanted unsigned, is printed uncast — C that means something other than the IR, in the last stage before bytes.                                                              |

`initfirst`'s gate carries a second, independent break, visible in its own sufficiency argument.
The comment at `l3/initfirst.ts:105-113` justifies the gate by "v's declared width must be 32 (the
assignment `v = X` then represents any 32-bit-or-narrower X exactly)", and the check at `:122` is
on `v`, not on `X`. A 64-bit `X` is not 32-bit-or-narrower, so the argument is void for it while
the check still passes.

**The shape of the repair, unbuilt and unmeasured.** `arithConversionSignedness` needs the RANK of
each side, not only its signedness; at unequal rank the answer is the wider side's signedness,
which is decidable rather than unknown, so a rank-aware version refuses nothing it answers today.
`initfirst`'s gate needs `X`'s width alongside `v`'s. Neither is written, neither is measured, and
the estimate that they are small is a judgement, not a result.

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
unmodelled calls. Separately, six rows decline on a carry opcode — `adc` ×2, `sbc` ×1, `addc`+`adde`
×1, `subfe` ×2 — which is the second half of the same family.

**Reach is three real rows, all agbcc, all one idiom.** That number is the honest other side of the
price in §3, and it is the number the decision turns on.

## 5. What the corpus publishes while this is absent

The four shift rows of §4 — `synthetic:llshl:agbcc`, `synthetic:llshr:agbcc`,
`synthetic:llshl:mwcc_242_81` and `synthetic:llshr:mwcc_242_81` — publish a function with **no
parameters** calling a helper with **no arguments**:

```c
s32 llshl(void) {
    return __shl2i();
}
```

for a source that reads `long long llshl(long long a, int b) { return a << b; }`. On mwcc that
recompiles byte-identically, so the two `mwcc_242_81` rows are scored as MATCHES on a signature the
source never wrote. The same fabrication is visible at `sa3:sa2__sub_80855C0`, where the published
`__ashrdi3(__muldi3(…))` passes one argument where the asm passes three, and the function's fourth
parameter — the shift count, `lsl`/`lsr`-narrowed to `(u8)a3` and moved into `r2` immediately before
the `bl` — does not appear in the output at all.

This is a consequence of the gap rather than a separate defect: a call whose arity the frontend
guesses (`fallbackArgc`, `packages/core/src/frontend/ssa.ts:676`) is rendered as a C call with the
guessed argument list, and for a helper taking register PAIRS the guess is short. Any accounting of
what building the representation is worth has to include that two of the corpus's matches are
resting on it, and any decision to close the family has to say what happens to them.

## 6. Two routes that are measured nulls

Both were built as throwaway ablations, measured with
`pnpm bench sweep --base origin/main`, and reverted.

- **Modelling the `bl` caller-saved clobber.** `packages/core/src/frontend/thumb.ts:4114-4116`
  asserts that the callee's clobber of `r1..r3` needs no modelling because agbcc has already moved
  anything live across the call into a callee-saved register. A probe that throws on a read of
  `r1`/`r2`/`r3` after a `bl` with no intervening write sweeps to **86 records against an 84-record
  clean-tree control** — 2 records, 1 row, `pokeemerald:MathUtil_Mul32:agbcc`, which already
  declines. Corpus-wide the model costs nothing, and in the one row that reads `r1` after a call,
  `r1` is the callee's HIGH HALF — a result, not a clobber. It is not a clobber question.
- **Recognising the `*di3` family on `raise/softdiv.ts`'s template.** Neither half stands alone.
  The rewrite half needs an existing op to rewrite to, and none computes a 64-bit product. The
  signature half would recover the second argument register, whose value after a `bl` is the
  callee's high half — so supplying `__ashrdi3`'s real 3-argument signature replaces a short
  argument list with a wrong one.

## 7. What would change this entry

A fourth real row outside the fixed-point idiom, a second compiler family reaching it, or a
measured repair of `arithConversionSignedness` cheaper than §3 estimates, each moves the trade.
A 32-bit spelling that reaches `MathUtil_Mul32`'s bytes falsifies §1 outright — the recipe is the
table there, and one compile settles it.
