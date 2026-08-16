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
    `decompileRanked` path only: `/argbase`, `/scopebase`, `/coalesce`, `/indexed`, `/regcopy`.
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
