# The level tower

This is the architecture behind asmlift's pipeline: _why_ the decompiler is built as a tower of
IR levels, what a "level" actually means here, and how the current shape — `L1 → L2 → L3` — was
arrived at. It goes one layer deeper than [asmlift-101 §2.4](asmlift-101.md#24-the-ir-tower--l1-l2-l3);
read that first for the ground terms (IR, SSA, block arguments). If you are about to add a
capability that a stage cannot yet represent, this is the document that tells you when to grow a
new level and when not to.

## Why an IR, and why more than one

A decompiler cannot work on assembly text (no structure to analyze) or directly on a C syntax
tree (too rigid to transform incrementally). It works on an **intermediate representation**: a
data structure between the two, designed to be analyzed and rewritten. That much is universal.

The question this document answers is the next one: should there be _one_ IR, or several at
different heights? The received wisdom points three ways, and asmlift's design is a synthesis of
all three.

- **[LLVM](https://llvm.org/) — few representations, many verified passes.** LLVM has only a
  handful of genuinely distinct representations (LLVM IR, SelectionDAG, MachineInstr, MCInst),
  and each is distinct because it answers a _fundamentally different question_ — SSA values, vs.
  machine registers, vs. assembled bytes. The hundreds of "phases" you hear about are passes over
  _one_ representation, disciplined by a verifier and a pass manager. **Lesson: don't multiply
  representations; multiply passes, and verify between them.**
- **[MLIR](https://mlir.llvm.org/) — levels are op-vocabularies in one substrate, gated by
  legalization.** MLIR's tower is real, but it is implemented as different _legal op-sets_
  (dialects) inside a **shared** IR and type system, progressively lowered. The boundary between
  levels is _which ops are legal here_, enforced by verification — not a different container type
  per level. **Lesson: two levels sharing one data structure is legitimate; a level can be "which
  opcodes are legal," checked by the verifier.**
- **[m2c](https://github.com/matt-kempster/m2c) — fewer boundaries, tuned for a human in the
  loop.** m2c goes flow-graph → C-ish translation → string, and it is genuinely good at what it is
  built for: producing a readable first-draft C that a person then refines toward a match,
  strongest on MIPS/N64. Keeping the stages close together is a reasonable call when a human reads
  and corrects the output. asmlift aims at a _different_ consumer — an automated score loop that
  must attribute a failure to one stage and change it in isolation — and that consumer rewards
  more separation than m2c needs. **Lesson: how much to separate the stages depends on who debugs
  them; for a machine-driven loop, more enforced boundaries pay off.**

The three converge on one point: **what matters is not the number of representations but whether
each boundary carries (i) an enforced contract and (ii) a dumpable artifact** — sized to how the
output will be consumed. A boundary is real when something _checks_ it, not when the two sides
happen to have different types.

## What a "level" means in asmlift

asmlift takes MLIR's stance. A level is **an enforced pipeline stage with a dumpable, verifiable
postcondition** — and a stage becomes a genuinely _distinct data structure_ only when a
capability forces it to. This is the load-bearing rule, and it is worth stating as a slogan:

> **Earn the level.** A new representation appears the moment a capability needs it and the
> differ can prove the payoff — never as scaffolding ahead of an inhabitant.

The failure mode this rule exists to prevent is building the frame before the picture:
four-level tags on two real representations, an opcode vocabulary with no emitters, a verifier
rule that never fires. Such scaffolding is not _wrong_ — each piece is a promise awaiting a
payoff — but together they make the architecture read as more enforced than it is, and anyone
(human or agent) editing it will trust structure that nothing actually checks. So asmlift keeps
the machinery honest: a level exists exactly when it has inhabitants and a checked boundary.

## The tower today

Three levels, but only **two** in-memory representations — because `L1` and `L2` are the same
container (`Fn`, the typed-SSA graph) at two points in the pipeline, exactly as MLIR would have
it, while `L3` is a genuinely different structure (`SFn`, the neutral AST). The stages, as
`decompile()` runs them ([`packages/core/src/pipeline.ts`](../packages/core/src/pipeline.ts)):

```
asm ─▶ lift ─▶ idiom fold ─▶ recover types ─▶ structure ─▶ L3 rewrites ─▶ emit
        (L1)     (patterns)      (L1→L2)         (L2→L3)     (in L3)      (backend → string)
```

- **L1 — machine-shaped SSA.** What the frontend emits. Values are `unk32` (32 bits, type
  unknown); operations mirror instructions (`shr_u`, `icmp_sge`); the control-flow graph is the
  machine's. The verifier ([`ir/verify.ts`](../packages/core/src/ir/verify.ts)) enforces the
  structural SSA invariants here: one terminator per block, single definition per value,
  definitions dominate uses, correct opcode arity.
- **L2 — typed SSA.** _The same `Fn` graph_, after **type recovery**
  ([`raise/recover.ts`](../packages/core/src/raise/recover.ts)) fills the types in place — a
  signed compare proves its operands `s32`, a word load proves its base a pointer, and so on. No
  new container; the level is the enforced _postcondition_, not a new structure (see the next
  section).
- **L3 — the neutral AST.** A genuinely different structure
  ([`l3/ast.ts`](../packages/core/src/l3/ast.ts)): `if`/`while`/`switch`/expressions, no
  registers, no `goto`. Structuring ([`structure/`](../packages/core/src/structure)) recovers it
  from the L2 CFG and destroys SSA (assigning merge values back to named variables).
- **The L3 rewrites** ([`l3/`](../packages/core/src/l3)) then improve that tree _within_ the
  level — no lowering, so this is a stage rather than a fourth level. They come in two
  populations, and the difference is architectural, not incidental:
  - **Committed**, inside `structureChecked`: tail-merge → dead-store elimination → base-CSE.
    Every path gets these, which is why the boundary contracts run on both sides of them (below).
  - **Ranked re-spellings**, in [`rank.ts`](../packages/core/src/rank.ts) and so on the
    `decompileRanked` path only. Two populations of them: SPELLING re-writes of one structured
    tree (e.g. `/argbase`, `/scopebase`, `/indexed`, `/livebase`, `/volatile`, `/mulfirst`,
    `/regcopy`, `/coalesce`) and STRUCTURING axes, which re-run `structure()` under a different
    lever (e.g. `/flip-branch`, `/defsite`, `/inplace`, `/no-bitfield`, `/reread-globals`,
    `/merge-names`) — plus `/raw-globals` and the signedness pin, which re-run the lift itself.
    The roster is illustrative; `rank.ts` is the source of truth.
    Each emits an _alternative candidate_ rather than replacing the primary, and the differ
    referees — the
    [ranked-candidate idea](asmlift-101.md#26-types-as-ranked-candidates-judged-by-the-differ)
    applied to spelling instead of types.

  Which population a pass belongs to decides how much its opinions cost. Four passes currently
  answer "is this address a local?" differently — `raise/gvn.ts` (never), `l3/basecse.ts`
  (function top), `l3/scopebase.ts` (innermost scope), `l3/argbase.ts` (immediately before the
  call). The last two are candidate generators, so their disagreement costs a candidate. The first
  two are committed, so theirs would cost a **match**, and the constraint that keeps them
  compatible lives in neither file: `gvn`'s entry-block hoist is free only because
  `structure/analysis.ts` re-materializes address ops at each use instead of binding them to a
  local. That is a promise between modules, with no natural home in any one of their unit tests,
  so it is pinned in
  [`test/addr-placement.test.ts`](../packages/core/test/addr-placement.test.ts).

The **backends** ([`backend/`](../packages/core/src/backend)) then print L3 as concrete source —
C, Pascal, and a scoped C++ — one neutral tree, three spellings. Every language-specific decision
(Pascal's `:=`, C's `?:`) lives in a backend, never in the tower.

## The contracts are the point

The reason the levels earn their keep is not that the graph changes shape between them — it is
that each boundary has a **postcondition that fails at its own stage**, so a bad edit is
localized _there_ instead of surfacing three stages later as mysterious wrong C. These live in
[`contracts.ts`](../packages/core/src/contracts.ts) and run in every entry path (`decompile`,
`decompileRanked`, `decompileWithReport`, and the traced tower) via the one shared spine
`raiseRecovered` / `structureChecked`:

- **`assertTypesRecovered`** (after recovery, the L1→L2 boundary): no value may still be
  `unknown`. A recovery bug that leaves a parameter untyped is caught _here_ — before any C is
  emitted or scored — rather than degrading silently into wrong output.
- **`assertResolved`** (after structuring, the L2→L3 boundary): the AST references no unresolved
  value. The structurer emits a `"?"` sentinel when it cannot resolve a value (a dropped
  definition, an opcode it has no lowering for); this contract turns that into a loud decline
  instead of uncompilable source.
- **`assertDerefsTyped`** (also after structuring): every memory access and operator in the tree
  is _spellable_ — a field base is a pointer-to-struct or a struct value, no operand sits under a
  C operator that rejects pointers, and every scalar access width is a real C scalar (1/2/4). A
  regressing pass that produced, say, a width-8 access would otherwise print the nonexistent
  `(s64 *)` typedef and fail at candidate-compile three stages downstream.
- **`assertEffectsPreserved`** (also after structuring): every call the asm makes is emitted, and
  none is emitted more times than the asm makes it on any one path — same for the `opaque` ops
  standing in for unmodelled instructions. It is the odd one out and worth the attention: the
  other three check L3 against _itself_, so they catch a tree that is ill-formed. This one checks
  L3 against the L2 graph it came from, which is the only way to catch a pass that **loses**
  something well-formedly — a dropped call, or an unmodelled instruction quietly vanishing
  because its destination register was dead.

**Where they run matters as much as what they say.** The three post-structuring contracts fire
_before_ the committed L3 rewrites, so a readability pass cannot hide a structuring defect by
deleting the statement that carries it; deref-typing and effect-preservation then fire _again_
after, so those passes cannot introduce one either. And each ranked re-spelling gets its own
`assertResolved` + `assertDerefsTyped` inside `respell`'s guard ([`rank.ts`](../packages/core/src/rank.ts)),
where a failure costs that one candidate and is reported through `onLeverError` — never silently
dropped, which would be indistinguishable from a lever that correctly declined.

This is the concrete meaning of "build the tower for real." It needs no per-op level tag and no
level enum (asmlift deliberately has neither) — the contracts are plain functions on `Fn` / `SFn`
that make the boundaries honest. They are also what makes the whole thing improvable in an
automated score loop: when a match fails, the contracts and the per-stage IR dumps let the
failure be attributed to a _stage_, which is the unit an agent can then change in isolation.

### One level down: a pass's own gates

A contract guards a stage boundary. But most of what keeps asmlift honest is finer-grained than
that: the conditions under which an individual pass **refuses** to fire. Those refusals are the
[cardinal rule](asmlift-101.md#28-the-cardinal-rule-loud-decline--silent-miscompile) at its
smallest scale, and they are where the real bugs have been
— a gate that turns out to be decoration is a silent miscompile waiting for the right input, and a
comment claiming a gate is load-bearing is not evidence that it is.

So a pass whose refusals carry weight declares them as **data** rather than as `if`s and prose
([`l3/gates.ts`](../packages/core/src/l3/gates.ts)):

```ts
interface Gate<Ctx> {
  readonly id: string; // stable, kebab-case
  readonly why: string; // one line: the reason the rule exists
  readonly sound: boolean; // remove it and some candidate is WRONG, not merely worse
  readonly guardedBy?: string; // required when `sound` — the test that fails without it
  readonly rejects: (c: Ctx) => boolean; // true ⇒ REJECT
}
```

The point is not tidiness. Because the table is a **value**, a test can drop one entry and re-run
the pass — the real predicate on real input, with no test-only branch in the shipped path — so
"this gate is load-bearing" becomes an executable claim instead of a comment. That makes
`sound: true` _cost_ something to declare: a shared contract test
([`test/gate-contract.test.ts`](../packages/core/test/gate-contract.test.ts)) rejects a sound gate
that names no guard, and checks the named guard against the suite's actual test titles, so the
field cannot decay into a reference to a test deleted two refactors ago. Returning _which_ gate
refused each candidate makes the dual question checkable too: a rule nothing ever reaches is a
rule no test can be failing on purpose.

Adopt this when a pass's refusals are load-bearing — not for every `if` in the codebase. The same
"earn it" discipline applies: `l3/basecse.ts` declares a table in which **no** gate is sound,
because a wrong hoist there costs bytes and a match, never meaning, and saying so plainly is worth
more than three gates pretending to a soundness they do not have.

## How the architecture came to be: earning L2

For a long time asmlift matched Thumb and MIPS byte-exact on an L1-only graph with in-place type
recovery — L2 was a _postcondition_, not a distinct op-vocabulary. That was correct: no function
needed anything L1 could not represent. Even pointer and constant-offset struct access (`*p`,
`s->c`, `p[2]`) rides entirely on L1 pointer typing plus the neutral L3 `index` node — a _simple_
struct fixture does **not** force a new level.

The capability that finally earned one was **variable-index array access**. `int aget(int *a, int
i){ return a[i]; }` compiles to `sll t,i,2; addu t,a,t; lw v0,0(t)` — the load's base is an
_add result_, so `a` never gets typed as a pointer, and the compiler rejects the naive emitted C
(and even typed, pointer `+` would re-multiply by the element size — a double-scale miscompile).
That is a real capability the existing representation could not express, so it earned two typed,
element-scaled ops in [`ir/opcodes.ts`](../packages/core/src/ir/opcodes.ts):

- `aload base, index {elemSize, signed}` — a typed element-scaled load, `index` a runtime value;
- `astore base, index, value {elemSize}` — its store dual.

Two design choices in that step are the "earn the level" rule made concrete:

1. **It is legalization, not an idiom.** The match needs the _relation_ `1 << shiftImm ==
accessWidth`, which the patterns-as-data idiom engine (fixed-constant and equality matches)
   cannot state. That is the tell that this is _addressing-mode recognition_ — recognize a legal
   shape, leave the rest raw — a different kind of pass than the algebraic idiom layer, so it
   earned its own pass ([`raise/arrays.ts`](../packages/core/src/raise/arrays.ts)) rather than
   contorting the engine.
2. **The new ops appear with inhabitants and a differ-proven payoff** — byte-exact on real
   codegen for scaled loads and stores at element sizes 2 and 4 — not as reserved scaffolding.

The compiler axis of `TargetDescription` was earned the same way. Holding the ISA constant and
adding a second MIPS compiler (KMC GCC beside IDO) produced a concrete divergence — the same `x /
2` shift idiom that one compiler emits with hardware divide and the other without — which proved
the predicate for that idiom is the _compiler_, not a hardware capability. Only then did
`compiler` become a first-class field with two real consumers. Same principle: the abstraction
followed the second inhabitant, never preceded it.

## When to grow the tower (and when not to)

- Add a **contract** whenever a stage boundary has a postcondition that a bad edit could violate
  silently — this is cheap and almost always worth it.
- Convert a pass's refusals to a **gate table** when they are load-bearing — the other cheap move.
  It costs a few lines and buys the ablation ("drop this rule and something breaks") as a test
  rather than a claim. A pass whose gates only trade bytes can say so in the table and skip the
  guards; one that declares a gate sound now owes a differential test, and the contract enforces
  the debt.
- Add a **new op / representation** only when a capability genuinely cannot be expressed in the
  current one _and_ the differ can prove the result matches. Constant-offset access did not clear
  that bar; variable indexing did. If the corpus stays leaf/arithmetic-heavy, the tower may never
  need to grow further — and that is a right-sized outcome, not a failure.
- Prefer **legalization over a new IR op** when the thing you are recognizing is a machine
  addressing/idiom shape; prefer a **new op** when downstream stages need to reason about the
  recovered concept as a first-class value.

### A case where the bar was met on capability but not on the differ: `undef`

`undef` (an uninitialised local — storage whose only writer is this function's own stores, read on
a path where none of them ran) is the only op that appears in emitted C without a byte match behind
it, so it is worth being explicit about which half of the bar it cleared. (`opaque` also has none
and never will, but it is the loud-gap escape hatch — it exists to stop a function compiling, not
to be recovered code.) "Only writer" rather than "owns": the two
came apart in review, and the escape clause below is the difference.

It clears "cannot be expressed in the current one", though narrowly. asmlift's builder had fused two
questions — "is there a reaching definition?" and "is this a parameter?" — so a def-less read had
exactly two fates: a fabricated argument standing in for uninitialised stack, or a decline. That was
asmlift's convention, **not** a property of the construction it cites.

Braun's own paper mints an undefined value at precisely this point — `tryRemoveTrivialPhi`
(Algorithm 3) reads `if same = None: same ← new Undef()`, for the φ that is "unreachable or in the
start block". [`ir/simplify.ts`](../packages/core/src/ir/simplify.ts) is where that case lands here,
and the port skipped it. Ghidra has kept the two questions apart for twenty years: a def-less read
becomes an SSA **input varnode** that a later phase may or may not map to a parameter slot, and its
decompiler names the outcomes separately — `param_N`, `in_stack_...` for an input the prototype
model could not place, `unaff_<reg>` for a callee-saved register read before it was written, and a
plain stack local.

So `undef` is not a new idea; it is asmlift catching up to the one its own citation contains. What
was genuinely missing was any way to SAY it, and that is what the opcode adds.

It does **not** clear "the differ can prove the result matches". Measured across the whole corpus,
**exactly one row moved** — `synthetic:uninit_spill:agbcc`, `declined → nonmatch`. The row in that
family that already matched is the more instructive one: its fabricated parameter happens to land in
the register the local occupied anyway, so it matches with an arity the source never had. That
register-half fabrication is untouched here and is still silent, which is the honest shape of the
remaining distance — a second, separate capability (the same shape in a _register_ rather than a
slot) that cannot be classified without either prototype knowledge or prologue-save elision.

The envelope is narrow, and worth stating in one sentence: **on Thumb, a word-wide slot strictly
below the measured local area, which some store reaches but not on every path, in a function where
no frame address escapes to something that could write the frame.** The last clause is a second
function-wide condition, established after the fact by the frame-object audit rather than at the
mint site — an escaped address usually means a callee may write any frame offset, so "no store of
ours reaches it" stops implying "nobody wrote it". The qualifier on it is earned below.

The reusable lesson is where the decision lives, not the op, and it is easier to state as the two
arrangements that do not work.

**The shared pass cannot decide.** The builder classified a def-less read by the key's
spelling (`sp@…`). That is the "arch check inside a shared pass" this document warns about, one
layer down — it reads as data rather than as a branch on target, which is exactly why it slipped
through. The answer depends on the _frame model_, and the frame model is per-ISA: Thumb bounds a
slot to `off + 4 <= localArea` and keys incoming stack arguments separately, so nothing incoming can
reach a `sp@` key there; MIPS applies no frame bound at all, and its `sp@` reaches O32's
caller-owned argument home area. The shared rule silently rewrote a fifth argument as an
uninitialised local on a function that had been declining.

**Nor can the frontend, by handing over a verdict.** A frontend-supplied
`(key) => 'param' | 'undef' | 'refuse'` fixes the first problem and leaves a worse shape: both
frontends implement it as a CONSTANT function of the key, so what crosses the seam is one bit of ABI
knowledge wearing a lambda — and it is unfalsifiable at the point of use, because Thumb's `'undef'`
is sound only by a bound established twelve hundred lines away and joined to the verdict by a
comment. _A postcondition enforced by convention is not enforced_: a `push` after the reservation
slides the window off the reserved area while the verdict goes on saying `'undef'`.

**What it is now: the frontend supplies the PARTITION, the shared pass applies the rule.**
`FrameModel` carries byte ranges — `ownedLocals`, `callerParams` — and one generic rule classifies
an offset against them, refusing anything that falls in neither. The dependency became an argument
instead of a promise: Thumb passes `{ from: 0, to: localArea }`, so when the prologue walk cannot
measure the frame that range collapses to empty and every slot refuses on its own. MIPS claims no
partition and therefore refuses, and the shape of its eventual fix is now a pair of numbers rather
than a rewrite.

The same split has a second instance on this very capability. The envelope's last clause was first
written as plain "no frame address escapes", and the first inhabitant to reach it was a klonoa DMA
fill where the address goes to a transfer's SOURCE register: the device reads the object, and the
register is write-only, so nobody can read the address back out and turn it into a destination. The
premise the guard _stated_ was false there. The fix was to ask the question the premise names — can
anything write? — rather than the one that was easy to compute, and the addresses are target data
(`capabilities.readOnlyAddressSinks`) so no shared pass learns a platform. The accepting half is
pinned as `synthetic:dma_fill_uninit:agbcc`. Note what did NOT move with it: the sibling rule
refusing a SECOND address-taken object still keys on any escape at all, because its argument is
about frame LAYOUT, and a device reading past the object it was given is as wrong as a callee
writing past it.

That split — declarative partition, generic rule — is Ghidra's. Its compiler-spec files carry the
same thing as data, and `mips32be.cspec` states the very asymmetry that forces it: a `<localrange>` whose own comment notes the 16-byte region is "backup
storage space for register params, but we treat as locals", beside a stack `<pentry>` that starts
incoming arguments at 16. The measurement stays code — Thumb's local area is a per-function prologue
walk, and Ghidra likewise solves the stack pointer per function — but the _rule_ belongs in the
shared pass, and the numbers belong to whoever can measure them.

The through-line, from the first frontend to the latest: a level is a promise the code keeps, not
a label it wears — and asmlift only makes the promise once it has something to put behind it.

## References

- Lattner et al., _MLIR: Scaling Compiler Infrastructure for Domain Specific Computation_, CGO
  2021 — [arXiv](https://arxiv.org/abs/2002.11054) · [mlir.llvm.org](https://mlir.llvm.org/)
- The [LLVM](https://llvm.org/) reference manual on its IR / SelectionDAG / MachineInstr / MCInst
  representations.
- [m2c](https://github.com/matt-kempster/m2c) — the decompiler asmlift is an alternative to; its
  human-in-the-loop design is what asmlift's automated-loop priorities are contrasted against.
- In this repo: [`asmlift-101.md`](asmlift-101.md) (the from-zero tour),
  [`packages/core/README.md`](../packages/core/README.md#architecture) (the module map),
  [`contracts.ts`](../packages/core/src/contracts.ts) (the boundary contracts themselves).
