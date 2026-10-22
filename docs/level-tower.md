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

- **L1 — machine-shaped SSA.** What the frontend emits. Values are `unk<width>` (type unknown) and
  the width is the machine's — `unk32` for a register, `unk64` for the register PAIR a 64-bit ABI
  value arrives in (see "A 64-bit value" below); operations mirror instructions (`shr_u`,
  `icmp_sge`); the control-flow graph is the machine's. The verifier ([`ir/verify.ts`](../packages/core/src/ir/verify.ts)) enforces the
  structural SSA invariants here: one terminator per block, single definition per value,
  definitions dominate uses, correct opcode arity.
- **L2 — typed SSA.** _The same `Fn` graph_, after **type recovery**
  ([`raise/recover.ts`](../packages/core/src/raise/recover.ts)) fills the types in place — a
  signed compare proves its operands `s32`, a word load proves its base a pointer, and so on. No
  new container; the level is the enforced _postcondition_, not a new structure (see the next
  section).
- **L3 — the neutral AST.** A genuinely different structure
  ([`l3/ast.ts`](../packages/core/src/l3/ast.ts)): `if`/`while`/`switch`/expressions, no
  registers, no `goto`. Expressions are pure but for `call`, `marker` and `postincr` — the last is
  an expression that WRITES, and the `l3/` passes that count a name's mentions have to know it
  (`mentionedName`, and the source scan in `test/postincr.test.ts` that holds them to it).
  Structuring ([`structure/`](../packages/core/src/structure)) recovers it from the L2 CFG and
  destroys SSA (assigning merge values back to named variables).
- **The L3 rewrites** ([`l3/`](../packages/core/src/l3)) then improve that tree _within_ the
  level — no lowering, so this is a stage rather than a fourth level. They are either committed or
  ranked, and the difference is architectural, not incidental:
  - **Committed**, inside `structureChecked`: tail-merge → unspelled-`return` deletion → dead-store
    elimination → base-CSE.
    Every path gets these, which is why the boundary contracts run on both sides of them (below).
  - **Ranked variations**, in [`rank.ts`](../packages/core/src/rank.ts) and so on the
    `decompileRanked` path only. Two kinds of them: RESPELL variations, which rewrite one structured
    tree (e.g. `/argbase`, `/scopebase`, `/indexed`, `/livebase`, `/unfolded`, `/volatile`, `/vol-store`,
    `/unreduce`, `/ptr-field`, `/offmember`, `/mulfirst`, `/regcopy`, `/coalesce`, `/unmerge`), and STRUCTURE variations, which re-run `structure()` under
    different options (e.g. `/flip-branch`, `/defsite`, `/inplace`, `/no-bitfield`, `/reread-globals`,
    `/merge-names`, `/fresh-merge`) — plus `/raw-globals`, the signedness pin, `/setup-args` and
    `/connective`, which re-run the lift itself.
    The roster is illustrative; `rank.ts` is the source of truth.

    **A missing degree of freedom the roster makes visible.** `/livebase*`, `/basefold`,
    `/unfolded` and `/offmember` are four ALTERNATIVE answers to one question asked of one base —
    does its constant offset belong in the address the compiler materializes, or in the load's
    displacement — and every one of them answers it for the WHOLE FUNCTION. `/unfolded` narrows
    WHICH bases the answer covers (its table admits only the keys an operand offset was observed
    on) without making the answer per-base: one table still decides the whole function. Nor are the
    tables a narrowness ranking one could extend by adding a sixth: `singleCell` and
    `unfoldedOffset` are independent fields, so `/unfolded` and `/livebase-block` are
    lattice-INCOMPARABLE and each binds keys the other refuses (8 keys on 7 functions one way,
    5 on 5 the other, censused over the artifact's agbcc rows at one structuring each). The roster
    is hand-picked subsets,
    so a base set that is no row's stays unreachable however many rows are added. Three rows
    want a per-BASE assignment instead: `LoadBGTilemapData` wants `/livebase-block` on its `+0x3c` key,
    `synthetic:bgfixed` wants `/offmember` on its one key, and `synthetic:dmapoll` (booked in
    PR #124) wants a per-base split of a different pair. It is a CONJUNCTION — shipped additively
    or it costs the rows each half already wins alone.
    Each emits an _alternative candidate_ rather than replacing the default, and the differ
    referees — the
    [ranked-candidate idea](asmlift-101.md#26-types-as-ranked-candidates-judged-by-the-differ)
    applied to spelling instead of types.

  Underneath both sit the **compiler behaviors**, declared as data in
  `TargetDescription.compilerBehaviors` ([`target.ts`](../packages/core/src/target.ts)) and spread
  onto `StructureOptions` by `structureOptionsFor`, so a compiler fact is one field rather than an
  `arch ==` branch. The line between a compiler behavior and a ranked variation is not how confident
  the author feels — it is whether the ASM UNDERDETERMINES THE SOURCE. A variation is right when some pass
  genuinely collapses two source spellings onto one output, so nothing but the differ can tell them
  apart (`/signed-cmp`: a signed compare emits the unsigned branch only once the compiler has PROVED
  the operand non-negative, and emission's provable set is smaller than the compiler's — which is
  also why that spelling publishes only on a byte-exact score). A compiler
  behavior is right when the mapping is a function — `readsStayWhereWritten` says a compiler with neither an
  instruction scheduler nor a code hoister emits a memory read in the block the source spelled it
  in, so re-spelling a read at the block the asm performed it in reproduces that asm, while the sunk
  per-arm spelling is one this compiler emits only for a source that read per arm. Note which way
  that claim runs: it is emission-from-spelling, not spelling-from-emission. The converse would be
  false even here (agbcc's PRE does move a load into a block the source never read in), and a
  compiler behavior read backwards is how a compiler fact turns into a wrong answer — so a compiler
  behavior owes an explicit refusal for every pass that moves the thing it is placing, and for every
  IR boundary the frontend invents where the machine had none (a block starts at every label, so a
  label nothing branches to makes one straight line of asm look like a dominating pair of blocks).
  Putting a question on the wrong side of that divide, variation or compiler behavior, is expensive
  in both directions: a variation where a compiler behavior belongs doubles every enumeration to referee a question with one answer, and a compiler behavior
  where a variation belongs quietly degrades every function the differ would have rescued.

  **A PROFILE OF A COMPILER INHERITS ITS DECLARATIONS UNTIL A PROBE REFUTES ONE THERE.** One
  toolchain compiles every flag set its projects' builds use, and `targetFor`
  ([`target.ts`](../packages/core/src/target.ts)) hands each of them the toolchain's one description.
  The flags become a **profile** ([`codegen-flags.ts`](../packages/core/src/codegen-flags.ts)) that
  the reports show and no pass reads: a profile fact a pass needs becomes a `compilerBehaviors`
  field, for the reason an `arch ==` branch is refused, and a variation is never pruned by profile,
  because the fan already carries a level's effect to the winner. Withholding a declaration at a
  profile nobody has probed does not claim nothing. A field's absent value is a reading too, the
  structurer's default, which is some other compiler's behavior; so an unprobed profile inherits,
  and the differ referees an inherited value the way it referees any default. A probe pair that
  refutes a declaration WITH A CONSTANT at a named profile is what earns a per-profile value, and
  `keepsUnusedReads` is the first: compiled, mwcc at `-O0` and IDO at `-O0` and `-O1` keep the read
  of `x = p[5]; x = 0;` that every other level deletes, so `targetFor` sets it from the level
  (target.ts `keepsUnusedReadsAt`). Inheriting is NOT the rule for a value nothing referees. The
  dead-read pin (frontend/dead-reads.ts) reads that field in every candidate alike, with no dual
  for the differ to weigh, so a profile whose level no flag names, or a word the flag table cannot
  read may set (mwcc `-opt off`), is judged at the value that withholds the stamp — keeping —
  rather than the one that publishes a `volatile` the source may not have written. Every
  family's unflagged compile was measured keeping, so the refusal is also the measured answer.
  Judged keeping, a read is stamped only where the machine left it in the register the compiler
  discards a volatile read into (`discardsUnusedReadsInto`: mwcc's r0, IDO's `$zero`), is
  dropped as plain in a home there, and on a compiler that names no such register (agbcc,
  gcc 2.7.2, KMC) refuses the lift unless a gate holds evidence the read was plain.
  A pair that comes out one way at one site and the other way at another, on the same
  compiler and the same flags, refutes the field as a declared default rather than its value:
  flipping the constant trades one site for the other, and the field has to be decided from the
  assembly at each site.

  A variation whose SIGN is base-dependent also cannot be a compiler behavior, but that is not a test you can run
  here: settling it needs two bases and therefore two rounds, where the criterion above is one you
  apply before building. It is really a rule about reading a PRICE, so it lives with the other
  pricing rules below — see **A VARIATION'S PRICE IS ONLY VALID AT THE BASE IT WAS TAKEN AT**, which
  carries `/unmerge`'s six numbers and says which three are grafts.

  **A compiler behavior may read the map BACKWARDS when the backwards mapping is ITSELF a function, the
  reach is measured, and being wrong then costs a SPELLING and not an answer — in that order.**
  `switchRequiresFrontLoadedTests` (`structure/switch-recover.ts`, PRE5) is the worked case, and it
  is the exception the paragraph above would otherwise forbid. It clears the section's PRIMARY
  criterion first, and the failure direction is the belt on top of that, never the argument by
  itself.

  1. THE MAPPING IS A FUNCTION, and three compiled pairs say so rather than a claim. Compiled at
     agbcc's canonical flags the two spellings of the same two-case body are 20 bytes each (0x14,
     ten Thumb instructions) and are DIFFERENT objects — the `switch` front-loads both tests and
     sorts them ascending (`expand_end_case` closes with the `reorder_insns` that moves the dispatch
     in front of the bodies), the ladder emits each test directly above its own body in source
     order. Both toolchains behind `MIPS_GCC` say the same on their own two-case pair. All three
     pairs are COMMITTED — `corpus/agbcc-sw{frontload,ladder}.s`,
     `corpus/gcc272kmc-sw{frontload,ladder}.asm`, `corpus/gcc272-sw{frontload,ladder}.asm` — with
     their C bodies beside them, a provenance header naming toolchain and flags, and a regen script
     (`scripts/regen-switch-spelling-probes.ts`), and a test asserts the split off each. Layout
     distinguishes the two spellings; that is the evidence, and the direction-of-failure argument
     below is not a substitute for it. (RE-READABLE IS NOT RE-MEASURABLE: the two MIPS pairs are
     byte-identical FILES, so without a regen path nothing committed could tell "compiled by this
     toolchain and it agreed" from "copied from the sibling".)
  2. THE REACH IS MEASURED, which settles the COST of a variation here — item 1 is what decides
     compiler behavior versus variation, and no reach number rescues a mapping that is not a
     function. A structure variation was POSSIBLE (`StructureVariation.options` is `(on: boolean) => StructureOptions` and this flag is one
     more entry), so the absent dual is a fact about what Regime A enumerates today rather than an
     impossibility. What rules the variation out is the term the fork below already prices: lifting every
     synthetic and real row twice, once with the field and once with it deleted, moves the emitted
     source of **5 rows out of 1026**. A variation inert on 99.5% of the corpus buys a dual only where
     the default is already right, and pays a second `structure()` everywhere.
  3. ONLY THEN the failure direction. The gate exclusively DECLINES, and Regime A's decline is
     if-recovery — behaviourally identical. A premise that breaks (a scheduler that hoists a body
     above a test, a frontend whose block list is not address order) costs the `switch` spelling on
     that row and cannot cost a wrong answer. **Say what the decline PRODUCES, not just that it is
     behaviour-preserving**, because recovery is recursive: declining a tree hands it to
     if-recovery, which recovers again on each sub-tree. On a flat tree that is a clean ladder; on a
     NESTED one (`corpus/agbcc-swnested.s`) it is an `if` nest holding a `switch` over a STRICT
     SUBSET of the source's case labels — a third spelling neither reading would give, and nothing
     in the output says a dispatch was half-declined. So the decline is not "loud in the source" in
     general, and a licence built on that word would be built on the flat case only. Contrast `readsStayWhereWritten`, which PLACES something: read
     backwards it emits a read in a block the source never read in, and no amount of measurement
     makes that recoverable.

  READ 3 WITHOUT 1 AND 2 AND IT LICENSES THE WRONG THING. A silent refusal that loses a spelling is
  this project's own failure mode, not a free action — this repo has shipped and reverted a prune
  measured at ZERO regressions that still cost six rows, and the paragraph above says a compiler
  behavior where a variation belongs "quietly degrades every function the differ would have
  rescued". So "it only refuses" is what makes a MEASURED, FUNCTIONAL backwards mapping safe to
  ship as a compiler behavior. It is not what makes an unmeasured one admissible, and a future round citing this
  paragraph owes its own compiled pair and its own reach number.

  **THE CONTRAPOSITIVE OF A UNIVERSAL IS NOT A BACKWARDS READING.** A compiler behavior that says what
  the compiler NEVER emits, for any source, may be applied to an observed output without the three
  conditions above: an output that has the shape denies the universal's antecedent, and that
  contrapositive is exactly as sound as the universal. What reads the map backwards is the CONVERSE,
  from "this output lacks the shape" to a claim about what produced it. `outgoingAreaNeverLoadedFrom`
  (`target.ts`) is the worked case: from a measured start offset up, the compiler never reads a
  word of its outgoing area, so a word it reads there is a local, and so is every word above it
  (`frontend/stackargs.ts` `loadedWordBound`). The offset is part of the universal: 0 on agbcc, 16
  on the three O32 toolchains, whose compilers stage a by-value aggregate's words in the a1..a3
  home and load them back, and 8 on mwcc, where the callee's parameter area starts. Each frontend
  measures the bound once and hands the one number to every reader: on MIPS and PowerPC it caps
  where the outgoing area of a call nothing declares can end (`o32OutgoingArea`'s `widest`,
  `measurePpcFrame`'s `outgoingEnd`). On MIPS the local area's partition, the owned range of an
  uninitialised read and the undeclared-call guess read that end; on PowerPC only the guess does,
  and the partition starts at the parameter area whatever the bound. The frame-object audit takes
  the bound itself on both (`loadedWords`). Its
  weaker sibling
  `localsAboveOutgoingArea` states only the after-call form, and the strong form is never read off
  it. The converse,
  that a word never read back is an argument, is false, because a dead local is never read back
  either, and the stack-argument licence declines on it rather than infer it. The contrapositive still
  owes what every compiler behavior owes: the universal grounded in the compiler's source and
  re-measurable from a committed probe (`corpus/agbcc-restage.s`, and `corpus/*-outarea.txt` for the
  start offsets), and its residue, every producer
  the universal does not cover, named where the field is set.

  A **third fork sits inside the ranked variations**, and the underdetermination criterion does not
  decide it: a question the asm underdetermines can be answered by a STRUCTURE variation, which
  RE-RUNS `structure()` under different options, or by a RESPELL variation, which REWRITES the tree
  `structure()` already produced. Both are ranked, both are refereed by the differ, so the deciding
  terms are COST and REACH. A structure variation doubles the enumeration wherever it CHANGES THE
  TREE, and costs one more `structure()` call and nothing else wherever it does not — `rank.ts`
  respells a structured tree once and skips a tree an earlier setting already produced, so an inert
  structure variation pays no respell work and no compiles. What is expensive is therefore a
  structure variation that fires broadly, and a ranked run is already minutes:
  `/inlinebase` inverts `structure/analysis.ts`'s const value-home decision — the same question
  `/reread-globals`, `/addr-home`, `/expr-home` and `/derived-home` each answer as a structure
  variation (a `STRUCTURE_VARIATIONS` entry) — and answering it by substitution instead costs **766
  extra candidates over 47058, +1.6%**, on the 33 of 69 klonoa functions that lift with no symbol
  map, where a structure variation over the same functions would have doubled every candidate on
  each of those 33. What a
  substitution pays for that is REACH: it can only rewrite the use shapes it can reach
  (`/inlinebase` re-spells `index` bases, so a home passed to a callee or standing as a `field` base
  is out of its grasp), where the structure variation would never have created the local at all. So
  respell while the shapes the substitution cannot reach have no row demanding them, take the
  structure variation when one appears — and name the fork in the respell variation's header,
  because otherwise the gap left behind reads as
  an oversight rather than as the price of the mechanism.

  **A VARIATION'S PRICE IS ONLY VALID AT THE BASE IT WAS TAKEN AT — the #161 dating rule, generalised
  from counts to prices.** A number here is a delta between two candidate sets, and a round that
  changes the structurer changes both sets; so a variation measured as expensive is not refuted, it is
  dated. `/unmerge` (`l3/unmerge.ts`, enumerated by `PRE_RESPELL_VARIATIONS` in `rank-variations.ts`) is the
  worked case — one variation, one row (`kleod:CountCollectedGems:agbcc`), the variation untouched throughout,
  **+44** against the #172-era winner and **+24** at #169's base, both MEASURED, then **−17/352**
  once #184 and #185 flattened the ladder and dropped the accumulator copies. It was the most
  expensive variation on that row for three rounds and is among its winner's variations now. Three more points
  exist and are GRAFTS, kept labelled because this chain's standing lesson is that a graft is a lower
  bound whose sign and magnitude both mislead: **+2** at a flat ladder, **−3** at flat+no-copies —
  #172 published that one as this round's prediction and the build delivered −17, under-read by
  5.7× — and **+4** at flat+no-copies+connective, the only point where the sign goes back POSITIVE
  at a base strictly closer to the reference, which is to say the −17 may not survive the next rung
  either. Two consequences: **a variation measured expensive on today's winner is not refuted**, and
  a variation whose sign is base-dependent can never be a compiler behavior, because its value is read
  off a base no predicate in the pass has. The delta such a measurement produces is a whole-FUNCTION
  one, and enumeration is what makes that honest — it buys no per-SITE reach, and saying otherwise is
  the trap this project has paid for three times wearing its opposite face; `PRE_RESPELL_VARIATIONS`' own
  header in `rank-variations.ts` prices that refusal with a measured k.

  **The corollary a "shrink the fan" round wants, and it is that round's whole answer: a variation's
  own LICENCE cannot prune it for CPU.** Skipping a variation wherever a predicate proves it cannot
  fire is sound exactly where the variation would have emitted no candidate — so a sound licence skip shrinks the
  fan by zero, and the fan is what compiles. All it can save is the enumeration-time gate walk, and
  enumeration is a small fraction of a ranked run beside one compile per candidate: on
  `LoadBGTilemapData` the one such skip that was built fires on every tree and leaves 112,896
  candidates at 112,896, the compile phase untouched. So a round out to buy compile CPU has to remove candidates
  that WOULD have compiled, which is not a licence question. `rank.ts`'s
  `ORDERBASE_HOISTS` carries the worked case, and with it the three wrong readings of one such
  predicate, each of which deletes live candidates — two of them the row's own neighbours in the
  same loop.

  **Before either, ask whether the DEFAULT can already spell it — and prove the answer by
  compiling.** `/connective` was shipped on the premise that `x == 0 || x == 2` and
  `switch (x) { case 0: case 2: … }` are two spellings of one asm shape that only a differ can
  choose between, and the row it was built for turned out to want neither: what was missing was a
  ten-line grouping in the structurer, which took
  `kleod:ProcessInputAndUpdateEntities:agbcc` from 367 to 306 with the variation ON and to 306 with
  it OFF — same breakdown, half the wall clock.

  The rule that follows is cheap: **an underdetermination claim about two source spellings is a
  COMPILER claim, so compile both and diff the objects before building anything.** A score table
  cannot make it for you — the cheaper spelling was never in the fan to lose. And the compile has a
  second half, which two attempts here got wrong in the same way: **compile the shape you are
  generalizing over, not the first shape that fits in a test file, and record the flags.** The
  measurements, all at agbcc's and ido7.1's canonical flags (`TOOLCHAIN_TARGETS`):

  | shape                            | grouped vs `\|\|`                                                        | duplicated body vs grouped                                                                                                                                 |
  | -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | agbcc, 1 case group + `default:` | 12 insns each, **one object**                                            | agbcc MERGES the copies                                                                                                                                    |
  | agbcc, 2 groups                  | 20 vs 16 — **different** (balanced `bgt` dispatch vs a sequential chain) | merged block keeps the LAST copy's position, so it equals the grouped arm placed THERE (md5 555abb1a) and not the one placed at the first value (fe4d7d35) |
  | agbcc, 3 groups                  | 24 vs 20 — **different**                                                 | —                                                                                                                                                          |
  | IDO, 1 group + `default:`        | 64 bytes each, **one object**                                            | IDO does **not** merge: 224 bytes against 144                                                                                                              |
  | IDO, 2 groups                    | 80 bytes each, **different bytes**                                       | the two placements also differ (689f34ec vs ec39af99)                                                                                                      |

  So the identity is a property of the DEGENERATE shape, on both compilers, and the variation is a real
  second spelling on every recovered multi-group switch. What makes the grouping right is an
  argument about the ROM rather than about which source is prettier: under agbcc the duplicated
  source is unreachable as a ROM shape, and under IDO it is a different ROM, so a shared block means
  stacked labels on either compiler.

  **And 2× is a LOWER bound, not the price.** A new variation doubles its own admitting rows, and it
  also UN-COLLAPSES sibling variations that `seenTrees` was deduping away on the base tree: a sibling
  whose output on the old tree was identical to a candidate already enumerated can be distinct on the new one, and then it enumerates
  where it did not before. So the real multiplier is 2 × (siblings the new tree makes non-inert),
  and it is measured, never assumed. `/fresh-merge` (structure.ts `freshParamMerge`, the parameter's
  merge home) is the counterexample that fixes this: `synthetic:max3:agbcc` goes **2 candidates to
  10, ×5** — `signed/flip-join` and `signed/merge-names` do not appear at all on the base tree, both
  deduped as identical to `signed`, while `signed/flip-join/fresh-merge` and
  `signed/merge-names/fresh-merge` are distinct candidates. Over the 39 map-less corpus rows the variation
  admits, distinct sources go 5449 → 10028 (mean ×1.84, histogram {×1.5:1, ×1.8:1, ×2:12, ×2.33:2,
  ×3:17, ×4:1, ×4.5:1, ×5:4}); below 2× where the new tree instead makes a sibling inert, above it
  where it wakes one. Priced in the unit that costs compiles — surviving candidates over every row's
  own `targetAsm`, map-less — `/fresh-merge` is **+4579 over a fan of 18106 without it, +25.3%**,
  and **94% of that is two klonoa functions**: `kleod:ProcessInputAndUpdateEntities:agbcc` 4800 →
  8640 and `kleod:ConfigureEntityBehavior:agbcc` 480 → 960. Quote the concentration, not just the
  total: a row count ("105 rows pay ×2") understates the dominant row by two orders of magnitude,
  because rows are not the unit that compiles.

  **And a variation can widen a gate it never mentions — price that too.** The un-collapse above is an
  ENUMERATION cost; the same tree change can also satisfy an existing rule's precondition and admit
  where that rule used to refuse. `anchorConstCopies` declines a merge whose variable names another
  SSA value, so a merge that adopted its parameter is never anchored — and `/fresh-merge`, which
  mints a home for exactly those merges, makes them sole claimants by construction: sole-claimant
  admissions go **196 → 245** over 679 corpus rows, 34 rows gaining 49 merges, and
  `synthetic:clampu8:mwcc_242_81` reaches MATCH through the pair (`signed/defsite` is inert on the
  base tree and absent from its fan). So a new variation is priced over its own refusals AND over the
  refusals it removes elsewhere; the second is the one nothing reports, because the widened gate
  does not know it was widened.

  **A variation's 2× is intrinsic, and cannot be bought back by predicting which half is redundant.**
  The signedness pin is the worked example, because it is the variation that fires most broadly:
  `LoadBGTilemapData`'s 40320 candidates are 20160 `unsigned`/`signed` pairs, every one of which ties
  in score. The fan grows with every variation admitted, so quote your own `[ranked]` line. The recurring proposal is to drop the
  redundant spelling of each pair by asking the RENDERED TYPE which one it is, and that design space
  turns out to be two points with nothing between them. Compare the pin's effect at every node
  _including_ the `var` leaves and the predicate is sound — and is exactly "no pinned param is read
  anywhere", which is the decline `rank.ts` already ships and which no winner inhabits. Exclude the
  leaves, the only reading that prunes anything, and it deletes published byte-exact matches:
  `synthetic:maxi:agbcc` is `if (a1 < a0) a1 = a0; return a1;`, no node of which changes type,
  because C says a comparison yields `int` under either pin while the compiler picks the compare
  INSTRUCTION from the operands — agbcc emits `bge` against `bcs`, one point of score between a
  match and a nonmatch. The same hole swallows a `switch` scrutinee (`synthetic:sw_sparse:agbcc`,
  `bgt` against `bhi`) and a boolean context (`synthetic:ifand_near:mwcc_242_81`). Neither point
  reaches `LoadBGTilemapData`, four of whose address expression's ten nodes move with the leaves
  already excluded. The only reading that would reach it sits BELOW both — absorb any difference
  confined under an integer→pointer conversion, which all four of those nodes are — and agbcc
  refutes that one on the same address: `*(u8 *)((a0 >> 2) + K)` is `asrs` under the signed pin
  against `lsrs` under the unsigned one. The lattice is pinned in
  [`test/signedness-variation.test.ts`](../packages/core/test/signedness-variation.test.ts). What IS removable is removed
  by OBSERVATION rather than prediction, and belongs in the scorer, not the enumerator: identical
  candidate objects have one score by definition, which is where
  `@match-kit/scoring/files`'s `scoreFiles` collects the 20880 repeats.

  **A PARAMETER'S POINTEE is refused one step earlier than that: the fact has no reader in the
  bytes.** Its one reader is a spelling — a call argument on a unit compiled as C++ is cast to its
  parameter's declared type, which the unit's header states (`core/src/proto-context.ts`) and DWARF
  would state no better.
  The recurring proposal is to carry a struct pointee on `SymbolTypeFacts` so a project's DWARF
  `Sprite *` argument stops arriving at `proto.ts` `typeSpelling` and leaving it as `void *`. But a
  declared parameter type is consulted for exactly one thing, and it does not ask what a `*` points
  at: `declaredWidth`, which answers **32 for every pointer**. Everything downstream is that answer
  rebilled — `raise/paramwidth.ts` reads the function's OWN list per parameter to veto a narrowing,
  and a callee's list goes through `proto.ts` `declaredCallArgs` to be summed into the ARGUMENT
  REGISTERS the call occupies. Neither can carry a pointee: a `Sprite *` and a `void *` are the
  same 32 bits, and both are readable, so they do not even reach the one branch where a spelling
  decides anything — the one where the width reader cannot size the type and the whole list stops
  stating a layout. So the thread would add a fact nothing consumes — the shape of the redundant
  signedness candidate above, one level down. Nor is the capability missing: asmlift already recovers a
  parameter's pointee FROM THE ASM, synthesizing `struct Struct0 *` and spelling `a1->field_6`
  off the access widths alone, and what DWARF would add is field NAMES — which `declare.ts`'s
  pointer arm already states cannot move bytes, because the cell is 4 bytes whatever it addresses
  and every stride is explicit.

  The reach bounds it twice more. `asIfUndecompiled` redacts the row's own signature BY DESIGN
  (a compiler emits one only for a function it compiled), so the transferable half is the
  CALLEES — and of the 252 real rows over six projects the corpus held when this was measured
  (before the three GameCube projects landed on 2026-09-17; it is 421 over nine now, and those
  three vendor no signatures either — `apps/benchmark/README.md`'s residuals 6 and 10 measure
  ac-decomp at `signature` 0, pikmin the same shape, and Mario Party 4 with no DWARF at all — so
  the conclusion below still holds over the rows it did not see), 109 call anything, 25 call
  something whose vendored signature
  is present, and **10 call one with a pointer parameter**; 6 of those already MATCH, 1 is a
  noncompile, and the 3 open ones are byte-identical under every pointee spelling fed to them, in
  both symbol-map configurations. Only two of the six projects vendor function signatures at all
  (pokeemerald 15678, kleod 210; af, marioparty3, sa3 and snowboardkids2 vendor zero), and **no
  signature parameter in any of the six carries a pointee**, because `@gba-kit/debug-info`'s
  `TypeFacts` is `{size, signed, pointer?}` — the absence is upstream's, so the round's first
  commit is an upstream release and a re-vendor before any threading. Pinned in
  [`test/param-pointee-variation.test.ts`](../packages/core/test/param-pointee-variation.test.ts).

  THE NEXT STEP THIS MEASUREMENT NAMES IS NOT A DECLARED POINTEE. There is one shape where a pointee is
  byte-load-bearing — a whole-struct assignment, `*dst = *src` through two `struct S *`, which
  agbcc emits as one `ldmia`/`stmia` pair while asmlift lifts it to three word copies and scores
  **7** against the real object, identically under `void *` and `struct S *`. It needs a SIZED
  struct type, which asmlift already synthesizes from the access pattern, not a declared pointee;
  and it has **0 inhabitants in the real tier** — no row's `targetAsm` carries the pair. Build it
  as a synthetic row before anyone prices it.

  Whether a pass is committed or ranked decides how much its opinions cost. Several passes answer
  "is this address a local?", and what separates them is PLACEMENT: never (`raise/gvn.ts`), a
  position in the top-level statement list — the function top, the minted inits above a run already
  there, or each init at its first use (`l3/basecse.ts`, `l3/nearbase.ts`, `l3/sinkinit.ts`) — the
  innermost enclosing scope (`l3/scopebase.ts`, and `l3/basecse.ts` too at `l3/hoist.ts`'s third
  placement, which sinks the run it places INTO the block holding every use), immediately before the
  call (`l3/argbase.ts`). The two scope-aware ones are separated by what they can SEE rather than by
  where they put it: `scopebase` plans its own locals over `addr`/`const`/`var` leaf bases, while the
  `scope` placement moves a run already minted, over the cast base no leaf pass can spell. A
  placement that lands nothing in a nested list has emitted the flat spelling under different
  variations, so `hoistBaseLocals` declines there rather than offering it. That is the roster's dedup
  rule for base SETS read onto positions, but a WITHDRAWAL in effect rather than a collapse: the
  roster carries no hoist at the spelling being refused, so the candidate has no identical candidate
  to fold into.
  `l3/scopebase.ts` also answers a SECOND question the others do not have, and it is independent of
  placement: HOW MANY locals one address gets. Its `REGION_RULES` carry both readings —
  `'whole'` gives a key one local (`/scopebase`), `'per-region'` one per disjoint region
  (`/regionbase`) — and the count, not the declaration scope, is what agbcc discriminates on
  ([`decl-scope-variation.test.ts`](../packages/cli/test/matching/decl-scope-variation.test.ts) compiles both
  spellings and both directions).
  All but `gvn` and basecse's own committed hoist are candidate generators, so their
  disagreement costs a candidate. Those two are committed, so theirs would cost a **match**, and
  the constraint that keeps them compatible lives in neither file: `gvn`'s entry-block hoist is
  free only because `structure/analysis.ts` re-materializes address ops at each use instead of
  binding them to a local. That is a promise
  between modules, with no natural home in any one of their unit tests, so it is pinned in
  [`test/addr-placement.test.ts`](../packages/core/test/addr-placement.test.ts).

  All three that place into that run now share the body rebuild, and TWO of them share the policy
  as an argument: `l3/hoist.ts` owns name allocation for every pass that mints a local, and
  `placeBaseLocals(sfn, minted, placement)` owns the leading base-init run, the first-use query and
  the rebuild. `head`, `first-use` and `scope` are three positions for a run this file has already
  ordered — that is `HoistPlacement`, the only thing `l3/basecse.ts` accepts and the only thing a
  hoist may state, so a hoist in `rank.ts` says WHERE its locals go beside WHICH bases it binds. `scope` is the first of the three that leaves the top-level statement list: it continues
  the first-use query downward while exactly one statement mentions the local, that statement
  mentions it nowhere outside the lists it opens, and exactly one of those lists holds it — and it
  reproduces `first-use` exactly where no nested list holds every mention, which is what keeps it a
  position rather than a policy. It is also the only one whose result is not above every use by
  construction, so `hoistBaseLocals` runs `assertHoistsDominate` there and nowhere else, over every
  init the placer reports having MOVED — the run it inherits from the committed default hoist
  included, not only the ones it minted itself. The setter half of `stmtLists` (`mapStmtLists`, beside it in `l3/ast.ts`) is what lets the
  rebuild reach a nested list without a second `Stmt`-kind switch.
  `l3/nearbase.ts`'s `prepend` is not a third position: it returns before the query and the sort,
  so it is `[...minted, ...body]` and shares the rebuild only. It is a separate type and not a
  third value of one — handing it to `hoistBaseLocals` spells a minted base's pool load above the
  base the compiler loads first, the exact hazard that file's own header forbids, so the boundary
  has to be something a caller cannot spell rather than something a comment asks it not to.
  `l3/advance.ts` is the SECOND caller of that same `prepend`, for nearbase's reason plus one it
  owns: its init materialises the register the chain then advances, so the target's own pool-word
  order is what says where it goes. It differs from nearbase in the one way this section is about —
  it has no `/sinkinit` alternative and cannot have one, because `sinkInitsToFirstUse` moves an init
  only where its local is assigned ONCE and an advance is a second assignment, so `prepend` is not a
  decision there but the only placement that respell variation has.

  Placement being an ARGUMENT is worth stating carefully, because two things about it are easy to
  overclaim. It is not what a single row needed, and it is not what made one reachable:
  `sinkInitsToFirstUse(hoistBaseLocals(sfn, g, 'head'))` and `hoistBaseLocals(sfn, g, 'first-use')`
  emit the same C on `sa3:sub_803213C`'s own tree and on all 105 (observation, gate table) pairs
  where any base binds over the artifact's agbcc rows in both symbol-map configurations — 74 of
  them with something actually moving. That is a lemma about the two SPELLINGS and nothing more.
  It does not say the row was already reachable: the `/sinkinit` pairing loop runs only over hoists
  carrying `pairings`, which is `/livebase` and `/livebase-block`, and neither admits this row's
  base — run `origin/main`'s core on `test/corpus/agbcc-tailmerge.s` and every gate table admits
  `[]`, the standalone `/sinkinit` declines, and 0 of 12 candidates carry `/sinkinit` or `/basefold`
  among their variations. What made the row reachable is the SYMBOL half of `unfoldedOffset`;
  reaching it then cost one hoist, spelled as a placement argument here and spellable as `pairings: true` instead.
  What the fold is actually worth is that the two spellings are the same transform BY
  CONSTRUCTION (`placeBaseLocals` orders the run by first use before consulting the policy) rather
  than by corpus luck. Two places let them drift apart before that, and both are cheap to
  reintroduce: the inits that CANNOT move, if the run is ordered only on the `head` branch, and the
  inits that sink to the SAME statement, if the splice loop lacks its descending tie-break — that
  second one reversed 3544 of 28646 candidate sources across 8 functions while changing no score,
  and left the first-use-ordered spelling of a sunk run unenumerable.
  And it is not a licence to unify POLICY: `l3/nearbase.ts` prepends, and re-placing its cluster
  bases in first-use order like basecse's turns `synthetic:dmafield` from a MATCH into diff:5.
  That is a row and not a mechanism, so it is a DEFAULT and the differ referees it like any other —
  `rank.ts` offers `/nearbase/sinkinit` beside `/nearbase` (+590 candidate sources on 15 of 1140
  observations). "Placement is refereed by the differ per pass" is a claim about the ROSTER, not
  about the passes: a respell variation that emits one tree referees nothing, and its ordering then decides a
  match with no candidate beside it to lose to.

  The eligibility half is separate and stays separate. `gates` and `placement` are independent
  arguments and neither implies the other, which is what keeps the `for`-init disagreement in
  `addr-placement.test.ts` a gate question. And `isBaseInit` ([`l3/hoist.ts`](../packages/core/src/l3/hoist.ts))
  — a ptr-cast of an `addr`/`const` assigned into a declared non-volatile local — is the WRONG
  place for any of this: it is the sole definition of where the run ends, read by all three passes
  through `placeBaseLocals`, so widening it to admit (say) a scalar `v0 = 1;` would also move what
  `l3/basecse.ts` RE-ORDERS. It is private now, which makes the trap easier to hit rather than
  harder: the knob is three lines from the predicate. The knob is the policy argument.

  For the record on what earned what, because a later round will re-derive it otherwise: the 2
  points on `sa3:sub_803213C` were the missing base local, NOT the position of the shared
  constant. The winning candidate still emits `v0 = 1;` as the first statement of the body;
  `p0 = (u8 *)&gStageData;` sinking to its own first use is the whole of the difference. Head
  placement scores worse than not hoisting at all, read off each row's own `[score]` table —
  head 5 · inline 2 · sunk 0 there, and head 9 · inline 2 · sunk 0 on the `synthetic:foldsink`
  isolate. So the roster offers both and the differ referees. THE HEAD ROW IS BRACKETED AND THE
  SUNK ONE IS NOT: `synthetic:foldhead` is MATCH at 0 under `unsigned/basefold` and NONMATCH 11
  the moment the head entry is removed, while ablated, `synthetic:foldsink` and `sa3:sub_803213C`
  are MATCH with the sunk row removed, with the head row removed and with both removed, and
  `kleod:ProcessInputAndUpdateEntities` is 211 either way. `synthetic:basecell` looks like the sunk
  row's bracket and is not — both rows emit the identical source there and `seen` collapses the
  sunk one. A bracket is a claim about the WHOLE tree and not about the rule it names, so it
  expires whenever anything else learns to reach the same spelling: the rows this pair was bought
  with win under `/offmember`, which is a TIE broken on `lineCount` rather than a subsumption, and
  exactly one artifact row carries `basefold` among its winner's variations — `foldhead`, the one
  authored to bracket the head entry. `rank.ts`'s BASEFOLD_HOISTS note
  carries the ablation, the per-configuration fan counts that prove it reached, and the recipe —
  there is no shipped ablation knob, so pricing a hoist means filtering the roster at its one
  use site behind a temporary env read and reverting, with a row that DOES move
  (`synthetic:livepark` under `/livebase`) run as the positive control.

  A second consolidation is BOOKED and deliberately unpaid: the FIVE home scopes in
  `structure/analysis.ts` (`homeSharedAddresses`, `homeLoopExprs`, `homeDerivedReads`,
  `homeMergeFeeds`, `homeEscapingExtensions`) are one `materialize.add(op)` behind shared refusals,
  differing only in an
  eligibility predicate, and `rank-variations.ts` already holds them as a data table (`STRUCTURE_VARIATIONS`) —
  only the consumer side is un-consolidated. What it can NOT absorb is `l3/basecse.ts`, on one
  premise: `coneHoldsAddr` excludes basecse's symbol bases through a refusal `analysis.ts` calls
  the soundness half of its own claim, and the first four scopes carry it. The fifth does NOT, and
  the omission is deliberate rather than an oversight: its clientele is an extension, whose result
  is never an address, so there is nothing for the refusal to exclude — which narrows the blocker's
  premise to the four scopes that can home an address at all. The const exclusion is NOT a
  second premise — `homeMergeFeeds` deliberately admits a `const`, because a const two arms of one
  merge carry is a register the compiler reserved across the branch rather than a
  re-materialization. So "one `homeSharedValues(eligibility, placement)`" is two changes, not one:
  the analysis.ts half is available, the basecse half would require deleting a sound refusal.

  The PRICE of that half is gate duplication. `mergeFeedHomes` is the only one of the five already
  a standalone function with an explicit parameter list, so it is the shape the fold would take —
  and the only one whose enumeration gate (`hasMergeFeedHome`) RUNS the scope instead of
  re-implementing it. **`hasHomeableSharedAddress` now does too, and so does
  `hasEscapingExtension`**, and the shape that paid it is
  the one the remaining two should follow: the scope became a named export
  (`sharedBaseClasses(fn, ignoreRet)` / `escapingExtensions(fn, ignoreRet)`), the gate CALLS it, so
  the SCOPE has one definition. Where
  the gate stays looser than `analyze` it is loose in TWO places, not one, and only the first is a
  parameter: `ignoreRet`, because a `ret` operand may be a void phantom the gate cannot know
  about — and for the fifth scope a dropped `ret` operand moves the answer in BOTH directions, so
  `hasEscapingExtension` asks under both readings rather than picking one; and the loop-header SEAT
  refusal (`multiBlockHeaders`), which the gate omits because it
  needs the loop model. The second is the one to watch — it is a clause of the variation's third scope
  rather than an argument to the shared predicate, so calling `sharedBaseClasses` does not carry
  it, and what makes the omission safe is that the seat refusal is applied in the scope on every
  candidate the gate enumerates (an over-admitting gate costs one duplicate-collapsed candidate,
  never a wrong one). The FIFTH scope carries the same clause for the same reason, and there it is
  weaker than a guard: four constructions of its shape decline before any variation is consulted,
  so it has no structurable inhabitant to price (`escape-home.test.ts`). So the debt is still two:
  `hasLoopSharedPureValue` and
  `hasDerivedReadHome` still restate their
  scope's predicate by hand, whose safety rests on every copy staying no stricter than the scope it
  mirrors, with nothing checking that and nothing in the harness reporting a candidate that was
  never enumerated.

  `/connective`'s `onTreeOwned` is the SHAPE that blocker wants, one level down: the enumeration
  gate is a callback the pass fires from its own refusal (`raise/shortcircuit.ts`), so there is no
  second copy of the matcher to keep in step and the "no stricter than the scope it mirrors"
  obligation is vacuous — and `PreRecoveryOptions` is the steering channel that makes it reusable,
  one field per pass, the L1 analogue of `AnalyzeOptions`. Absorbing it into `STRUCTURE_VARIATIONS`
  still needs one more gate KIND, since what is shipped is a side-effecting report rather than a
  `perLiftGate` predicate; that step is smaller than the ~200 lines above and is not paid here.

  A THIRD is booked and unpaid, and it is a per-function predicate deciding a per-site question —
  the shape `joined-branch-sense-decidable` names. `structure.ts`'s `scalarGlobals` is one set per
  FUNCTION: `bumpAgg` fires on any `add`/`sub` whose operand is the symbol's address, so ONE
  interior access drops the name from the set, and the bare spelling and the `volatile` qualifier
  both hang off it at EVERY site including the off-0 ones — `gVolA = 0;` becomes
  `*(u16 *)&gVolA = 0;` beside one walk to an address nothing is named at. `raise/offsetnames.ts`
  removes the cause for the subset where the map holds a symbol at the walked-to address, which is
  a rewrite and not an answer: every site that pass REFUSES still poisons its base. The answer is a
  per-site classification, which is a corpus-wide structure change rather than one round's work,
  and the price of not paying it is that a refusal in that pass is safe about its own bytes and not
  free elsewhere.

The **backends** ([`backend/`](../packages/core/src/backend)) then print L3 as concrete source —
C, Pascal, and a scoped C++ — one neutral tree, three output languages. Every language-specific decision
(Pascal's `:=`, C's `?:`) lives in a backend, never in the tower — with the one exception the node
list above names: `postincr` is C's `n++`, kept in the tower because the ASM decides it (the test
reads the variable before the update, so no other spelling is faithful) and a backend cannot invent
a node the structurer did not build. Pascal has no such operator and throws on one, the way it
already does on `cast`.

## A 64-bit value, across the whole tower

The one case where a single value is wider than a register, and the clearest worked example of how
a fact enters at the level that knows it. No ISA here has 64-bit integer arithmetic, so the machine
never shows one directly — it shows a register PAIR and a call into the compiler's own runtime.

**L1 — one value, not two.** A 64-bit integer is an ordinary `Value` whose type carries width 64,
and three opcodes relate it to the machine: `concat` builds it from a low and a high half, `lo32`
and `hi32` read one back. No new `IrType` kind, because the width was already a field; no 64-bit
`add`, because every arithmetic op already carries its width in its operand types. It has to be ONE
value: `call` has `results: 1`, and the structurer materialises an effectful call once per result,
so a pair modelled as two results emits the call twice.

**The rank travels with the value once it is an expression.** `exprIntWidth` (l3/typing.ts) is what
the C backend's operand pins read, and a call is the one node whose rank it cannot derive — a
callee's return type comes from a prototype outside the emitted function. So the structurer STAMPS
it (`Expr` `call.wide64`), from the same IR result width the frontend was told, and the shift, the
two divides and both signedness pins then agree. An unstamped call stays 32, which is what C makes
of a callee nobody declared.

**The frontend decides THIS function's width, because only the asm can** — `frontend/thumb.ts`
reads its RETURN width off the value graph AND the epilogue: r1 has to hold the same value's high
half, through any register copies, and `pop {r2}` cannot touch the return pair where `pop {r1}` fills
its high register with the return address — two functions otherwise identical.

**A carry pair is a 64-bit add, built in the frontend.** Thumb-1 spells one as a flag-setting `add`
(`sub`) on the low words and an `adc` (`sbc`) on the high words that takes its carry — ONE insn on
agbcc (`adddi3`/`subdi3`), so the two are adjacent. Read together they are `concat ± concat`, with
`lo32`/`hi32` written back, which is the same shape a helper call's pair already has, so the
parameter fusion reads it unchanged, and `wideReturn` reads the return off the projections — through
register copies, which agbcc makes of a sum it computed outside r0:r1. A pair that reaches the return
from another block is refused rather than joined: a 64-bit phi is the capability not built.

**PowerPC's carry is read as a compare, not as a 64-bit add.** `frontend/ppc.ts` keeps XER[CA] per
block as the 0/1 compare its writer leaves — `subfc rD,rA,rB` is `rB >=u rA` and `subfic rD,rA,K`
is `K >=u rA`, while `addic rD,rA,K` carries out of `rA + K`, so its carry is `rA >=u -K` (`rA != 0`
for mwcc's `addic -1`) — because that is what mwcc reads it for: a materialised compare with no
branch (`subfc; subfe rD,rY,rY` is `-(a <u b)`, `adde` over two sign words is `a >=s b`), which the
mwcc patterns fold to the `icmp` (pattern/engine.ts `MWCC_COMPARE_PATTERNS`). The 64-bit reading is
not built: `addc` leaves the carry unknown, an `adde` or `addze` over an `addic` carry (2.4.x's
`(long long)x + K`) refuses, a `subfe` or `subfze` whose register halves do not cancel stays an
unmodelled instruction, and a reader of an unknown carry refuses, naming its writer. A `subfze`
reads a constant, which mwcc may hoist out of the loop it sits in or out of the branch above it; one
that comes from another block is kept only where every path brings the same constant. A cancelling
`subfe`/`subfze` is ALSO the high word of a zero-extended 64-bit subtract or negate (`(u64)a - b` is
`subfc r4,r4,r3; subfe r3,r4,r4`), and the carry cannot tell the two apart; what does is the low
word, left in r4 for the caller. So where no declaration sizes the return, a word return whose r4
holds a value the function computed and nothing reads refuses (`frontend/ppc.ts` `computedPairHalf`),
and with a declared 64-bit return the narrow lift refuses after it; an r4 that only holds an entry
value (`long long z(unsigned a) { return a; }`) is not seen, and that word return still drops it.
Two r4 values are not that low word. A compare's difference whose carry a reader turns into a 0/1
value is one: 2.3.3 writes `a + (a < b)`'s `subfc` over the dead `b` and negates its `subfe`, where
a 64-bit high word uses the borrow as `CA - 1`. It is let through only where that `neg` (or the
signed form's `clrlwi 31` over `addze`) is the carry value's sole reader, in its block, and neither
value is r3's word: `u64 d = (u64)a - b; *p = -(int)(d >> 32); return d;` negates the very `subfe`
it returns as the high word. The other is a dead store to a parameter at -O0,
which mwcc keeps in that parameter's register; there a return of r3's entry value is not asked,
because -O0 writes both words of a 64-bit op.

**A CALLEE's width the asm cannot decide, so it is told.** `mov r3,#0x2a ; bl f ; add r4,r3,#0` and
a returned pair are the same instructions, so the frontend is given the fact rather than reading it:
from the target's runtime-helper table, whose signatures are the COMPILER's and need no header, or
from `FnProto.returns`, where a project's own header states it. That is the same standing as
`returnsVoid` — a return fact no assembly carries, supplied by the headers and load-bearing.

**Two seams, and they are per-target DATA, not a branch in a pass.** `TargetDescription.callerSaved`
says which registers a call destroys; `TargetDescription.runtimeHelpers`
([`runtime-helpers.ts`](../packages/core/src/runtime-helpers.ts)) says which helpers the COMPILER
calls and what each computes. Nothing in `ir/` or in the raise passes branches on a compiler or an
ISA. Both tables are also refusals: a name in the table that no recognizer folds becomes a gap
rather than a call the backend spells, because re-emitting a compiler's own runtime call is the one
failure that MATCHES — hand the compiler `__div2i(a, b)` and it emits the `bl __div2i` the row was
lifted from.

**What refuses, and why each refusal is where it is.**

| level             | refusal                                                                                                                                                              | because                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frontend, layer 0 | a caller-saved register read after a call, the returned pair aside (Thumb)                                                                                           | what it holds is the callee's, so an `r1` read after a `bl` is never the caller's pre-call value — it is the RETURNED high half where a width says a pair came back, and nothing otherwise; the PowerPC frontend builds no pair and refuses a declared wide return outright |
| frontend          | an `adc`/`sbc` that does not directly follow its low-register `add`/`sub`                                                                                            | only adjacency proves which carry it reads (every Thumb-1 ALU op writes the flags); it decodes as the unmodelled opaque it always was, and so does one whose high half is that add's own destination, which is no half of either operand                                    |
| frontend          | a word return under an epilogue that pops the return address into r2                                                                                                 | agbcc sizes that register by the return type (`eightByteReturnScratch`): r2 is 5 to 8 bytes, so a word drops r1 — and declines an 8-byte aggregate returned through memory, which the epilogue cannot tell apart                                                            |
| frontend          | a 64-bit pair that reaches the return from another block                                                                                                             | `wideReturn` is block-local, and its null is otherwise a WORD return that drops the high half of a function that computed it                                                                                                                                                |
| frontend          | a 64-bit value leaving as a word at an ordinary call boundary                                                                                                        | nothing states an undeclared callee's parameter widths                                                                                                                                                                                                                      |
| frontend          | a PowerPC word return, no declaration sizing it, whose r4 holds a value the function computed and nothing reads                                                      | that is the low word of a 64-bit return; returning r3 alone drops it, and the high word mwcc computes for a zero-extended subtract is the same carry compare a 32-bit `-(a < b)` is                                                                                         |
| frontend          | a PowerPC reader of a carry its own block did not set, or that a call or an unmodelled writer set (`adde`, `subfe`, `subfze`, `addze` after `addc`, `srawi`, a `bl`) | XER[CA] is kept per block as the compare its `subfc`/`subfic`/`addic` leaves, so any other carry is one this frontend cannot name                                                                                                                                           |
| raise             | a declared 64-bit integer parameter the lift leaves in two words                                                                                                     | only `pairparams` makes a 64-bit parameter, from the `concat` a helper call or carry chain builds; a body that tests the halves itself (`a != 0` is an `or` of them) would print two word parameters against the caller's own `long long` declaration                       |
| raise             | a helper call whose operands did not ARRIVE at the table's widths                                                                                                    | an operand count is not evidence of a pair; the pair construction is                                                                                                                                                                                                        |
| raise             | a table name no recognizer folded                                                                                                                                    | see above — the pass-through matches for free                                                                                                                                                                                                                               |
| structure         | a `concat` that is not the machine's widen                                                                                                                           | a 64-bit value this pipeline has no C spelling for, and this gap is the whole safety story for the representation                                                                                                                                                           |
| structure         | a `hi32` whose operand neither renders 64 bits wide nor has an integer type                                                                                          | the high half is `x >> 32`, undefined C below a 64-bit rank — so the operand is CAST to the value's own 64-bit type, and the refusal is for the case where recovery left it without one                                                                                     |
| backend           | Pascal, on a 64-bit integer                                                                                                                                          | it throws rather than narrowing                                                                                                                                                                                                                                             |

**What a decompiler may NOT infer**, each of which is a refusal rather than a guess: `bl __muldi3`
does not pin signedness (this libgcc has no `__umuldi3`, so both spellings call it — the signedness
is in the operand SET-UP, `asr rN,rM,#31` per half or `mov rN,#0`); `adc` does not mean the source
wrote `+`; the absence of a division bias does not mean `>>`, because `u64 / 256` and `u64 >> 8` are
byte-identical and the operator is simply not recoverable for an unsigned operand.

**What is NOT built**, said here so the tables above are not read as more than they are: no
frontend but Thumb pairs registers, so on PowerPC and both MIPS targets the helper table's effect is
the refusal alone (IDO's runtime is `__ll_*`/`__ull_*`, its 64-bit bitfield access included, and GCC's
on MIPS the four divisions; on both, the conversions between a 64-bit integer and a float too).

## A union, and why it is a type kind

An `IrType` kind, and the case for it is a compiler, not a row count.
A base read or written at two widths over the same bytes (`u->w = v; return u->h[0] + u->h[1];`)
has two C spellings: a union member whose views are those widths, and a pointer cast per access
(`((u16 *)p)[1]` beside `*p`), which is what a declared address already gets (raise/structs.ts). On
most targets they compile identically. On agbcc they do not: at -O2 it applies C's aliasing rules,
so through casts a narrow read, a word store and the same narrow read again become ONE `ldrh`
whose value is reused, and through a union the read after the store is reloaded, as in the asm
the union was compiled from (`synthetic:ureread`). The union keeps every access the asm performed,
the cast can lose one, so the union is the default and not a variation.

**Raise decides it, at L1→L2, beside the struct it lives in.** A cell read at two widths is one
overlap; a narrow cell LOADED with both extensions (`ldrh` and `ldrsh`) is another, even on a base
with nothing else overlapping and whatever stores to the cell come before or between the reads,
because one field would spell one of the two reads through the wrong extension. `union` carries its views (every
one at offset 0) and its SIZE, because the size is the compiler's: agbcc rounds every struct and
union to four bytes (`compilerBehaviors.aggregateBoundary`), so `union { u16 h; u8 b; }` is four
bytes there and two on ido, kmc and mwcc. A union that boundary would move is never declared, since
it would mislay the fields after it. Where every view is a byte or the cell's own width with the
other extension — the views a cast aliases exactly as a union member does — the cell is a plain
field of its widest view (`StructField.castViews`) and every other view is the flat cell,
`((u8 *)p)[1]`; anything else declines, a guard no measured compiler reaches (agbcc only fails
the fit on cells of two bytes or fewer, whose views are bytes or their own width). On a compiler nobody measured every union narrower than a
word declines, since a boundary guessed in either direction mislays something. It has no name — it is only ever declared inline, as the type
of the struct member holding it — so none of the name-keyed struct machinery (`collectStructs`,
the `/ptr-field` flip) reaches it. **Structure** reads an access through the view of its own
width and extension (`p->field_0.half[1]`, `p->field_0.shalf`; `ir/types.ts` `unionViewAt`); the type walk and the
deref contract share `memberOf`, so they agree on which member access is well-typed.

**A frame object is the second inhabitant.** The frame audit keeps a local area as one object in
memory where a device or a callee holds its address, or where nothing escapes and the per-object
model refuses the frame (a by-value struct parameter, spilled word by word over the spill slots and
read member by member through `mov rD, sp`, at two widths or two signednesses, or copied out a word
at a time; `chooseFrameModel` offers it before any shape is judged). That read has a second
inhabitant on Thumb, and the frontend tells them apart before the audit: agbcc promotes a `u8` or
`u16` local to a word, spills it with `str`, and reloads only the narrow part through a copy of sp
made for that one load (`mov r2, sp / ldrh r2, [r2, #4]`), because Thumb has no sp-relative
`ldrb`/`ldrh`. Those bytes are the stored word's low-order part (the slot's own address on a
little-endian target), so the load is the slot's value narrowed, a `zext` of the slot, and the copy
captures nothing (frontend/thumb.ts `narrowSlotReloads`). It is read that way only where live code
stores a word to the slot with `str` and nothing else claims it: no other capture, no by-value
block, not the one object. A word the entry block stores straight from an argument register it
has not yet written is taken as a by-value parameter's home and keeps the object model, which the
own declaration overrules where it proves that register holds one integer word (proto.ts
`ownLeadingWordRegisters`), since no struct passed by value is one. In either model a store
through a capture that reaches a call unread on every path, beneath the lowest word a load after a
call proves a local's, refuses (`storedNeverRead`): agbcc builds a by-value struct or compound-literal
stack argument in place through `mov rD, sp`, which the stack-argument analysis never sees, and a
stated list bounds it only where it lays the struct out (`FnProto.byValueLayouts`) — otherwise it
is a lower bound, a variadic callee's a prefix. A struct a declaration passes by value in argument
REGISTERS (agbcc and O32, `compilerBehaviors.byValueAggregateArgWords`) is not a store reaching the call: the
call lowering hands its words over one operand each (`byValueWords`), and `foldByValueArgs`
(frontend/call-plan.ts) folds them, before the audit, into the one object they hold at the call — a
frame object they are loaded off, or a global they are loaded off or were just stored to — or
refuses. It refuses a struct agbcc never puts in memory: an SImode struct of four bytes or less,
built in a register by an `and`/`orr` insert chain over the register's stale bits, and an all-word
eight-byte struct passed straight from the registers holding its members. Its words are values, not
one object's, and spelling them would mean a local struct the lift invents, with member stores
that cover every byte the chain leaves stale. O32 refuses the same kinds: kmc and gcc2.7.2 packing
sub-word members in registers (`sll`/`or`), an insert over a register nothing set, IDO's
`lwl`/`swl` copy, and a struct read through a pointer, which leaves no object to name. A global is
spelled bare only where C can name it and its declarations type it as that struct: the struct at
offset 0 of an array or of an enclosing struct shares the symbol's address, and a static at its
section's start is relocated against the section, and a function-scope static by a name and
counter (`sQ.3`) only its definition spells. "That struct" is the struct each side resolves
to through the context's typedefs (`structNamed`), never a spelling: `typedef struct Q {…} Q;`
passes `Q` off an `extern struct Q`. Where no rule places a declared by-value
parameter at all (no layout, a union, a target with no word rule, an 8-aligned struct at an odd
word), the call refuses on every target (`refuseUnplacedByValue`) rather than take the arity
guess, which would drop the struct or split it into separate arguments. A variadic declaration's
fixed parameters (`variadicParams`) are its only layout. Where each is one word they are the first
that many argument words, read as stated, so one this function passes through untouched is its own
argument and one a call destroyed refuses; only what the `...` takes is guessed, above them, and a
gap there is treated as for an undeclared callee (frontend/call-plan.ts `variadicFloor`), and so is a
register there that still holds this function's own incoming value, which a read of it leaves behind
as a definition (frontend/ssa.ts `fallbackArgc`), which refuses — one a call destroyed holds
nothing and one the call's block re-set since its last call is set up, so neither refuses. Where a
fixed parameter is a struct, a 64-bit value or a floating type the call refuses (`variadicRefusal`). Where one is an
unsized spelling, which may be two words, the guess places the call from the first register. Every
parameter is at least one word, so a guess that counts fewer registers than that declaration's fixed
parameters, or than an unsized plain list's parameters (`void h(int, Foo)` with `Foo` unresolved),
has dropped an argument passed through untouched, and refuses (`refuseShortOfDeclared`). The call names the operand it passes by value (`byValue`), the audit judges a frame one as
the struct and counts the call as a read of it (`byValueReads`), and the one-object answer is
withheld, since a call handed the one object would pass a pointer. Structure spells the operand
bare, `take2(sp0)` or `sub_0803D4AC(a0, gUnk_03003620)`, and the declarations block defines the
struct beside the callee's prototype. Where two widths
meet at one byte of it, the L1 audit stamps the `laddr`
with the views its accesses use (`views`, frontend/frame-objects.ts `unionViews`), and structure
declares the storage as that union — every view an array tiling it — and spells each access through
its view on the object itself (`sp0.half[1]`). Element 0 is subscripted, never dereferenced:
`*u.half` is an INDIRECT_REF agbcc types by its pointee, and compiled it reads stale exactly as the
cast does, where `u.half[0]` reloads. `contracts.ts` `assertFrameUnionsViewed` holds the default and
every respelled tree to that. Where no view names an access — misaligned to its width, a runtime
index, a qualifier the accesses need — the two widths still refuse.

**Not built:** a declared address (a named global, a literal) read at two widths keeps the cast
spelling, and the aliasing argument above applies to it too; no row has a narrow re-read across a
store there, and a union would be the wrong declaration for its inhabitants (agbcc fusing two byte
compares into one `ldrh`; a device register, whose reads are `volatile`). Nor does
raise/struct-arrays.ts read the boundary yet: it sizes an element struct naturally, which agbcc
does not.

A gap in a guessed arity, an argument register nothing reaches below one a value reaches, refuses
unless it is decided (frontend/call-plan.ts `decideGap`). It is decided when the register above it is
surely an argument. The call's own block wrote that register with a value nothing but the call
reads, at flags that delete a dead computation. Argument words fill in order, so every register
below an argument is the function's own argument passed on. So `logv(s, 1)` lifts `logv(a0, 1)` and
`g3(1, b, 3)` lifts `g3(1, a1, 3)`. A value an instruction wrote as a side effect decides nothing
(frontend/ssa.ts `noteIncidentalWrite`): agbcc's `ldmia`/`stmia` block copy leaves its advanced bases
dead in r2/r3, and a PowerPC update form's advanced base is marked the same way. Two compiler facts
narrow it. Where a discarded read may land in an argument register
(`discardedReadMayFillArgRegister`: agbcc, gcc2.7.2kmc, gcc2.7.2 and the three mwcc builds, whose
discard register is the first free one once v0/v1 or r0 are busy), a value a memory read produced
decides nothing; on ido7.1, which discards into $zero every time, `logv(s, gx)` lifts. Where a
caller hands its own destination on as a callee's hidden struct-return pointer
(`forwardsStructReturnDestination`, ido7.1), a gap at the first argument register is decided only
where something other than a `ret` reads the call's result.
The decision covers the gap and that register only. Every register the count takes past it must be
proven the same way. The call refuses where its arity could still run past the count
(`decidedCallRefusal`): an own parameter that may sit there, an outgoing stack word that reaches it,
a floating own parameter on any target with an FPU, or, where floats travel apart from the general
words (PowerPC), no own declaration that proves there is none. Where the ABI can leave a register
empty below a filled one (target.ts `argRegisterHoles`: O32's and PowerPC's 8-byte skip, O32's
leading float), the gap may be that hole, and only an own declaration that `proves` rules it out: a
stated entry, or the context's entry while the lift is bounded by exactly its words. The context's
entry, in any other lift, only refuses. A register copy never decides, since its SSA value is the
copied one (a known gap, which costs declines).

## A float, across the tower

The one value that is not an integer of any width, and the case where the first move a reader
reaches for — decode the FPU's instructions — is the wrong one. Decoded alone, the arithmetic lifts
`float fadd(float a, float b){ return a + b; }` as `void fadd(s32 a0, s32 a1) { return; }` on every
FPU target: the entry reads of `$f12`/`f1` mint phantom integer parameters, and the sum lands in a
register that is not the return, so the add is dead ([`floating-point.md`](floating-point.md) §2).
So it was built downwards, and each level is a layer that document prices.

**L1 — a kind, and opcodes of its own.** `{kind:'float', width: 32 | 64 | null}` is the one exception to the
64-bit section's rule ("for TYPES, widen the number that is already there"): a float is not an integer
of any width, so every pass that tests `kind === 'int'` must SKIP it, and a new kind is what makes it
skip. Its width says single or double, or, where null (`T.fUnstated`, IR text `f?`), that no
instruction of the function states one: PowerPC's `fneg` and `fmr` are one instruction for both, so
a function of only those compiles to one object whichever the source declared. The three widths are
three types, so a float op mixing them fails verify. The arithmetic is `fadd`/`fsub`/`fmul`/`fdiv`/`fneg`, and a
double literal is `fconst` (its IEEE bit pattern, sixteen hex digits into an `f64`), for the
same reason `concat` is its own opcode: every pass that matches `add` or `const` is an integer rewrite. `ir/verify.ts` holds both directions — a
float op computes on floats only, and a float is an operand of nothing else but a conversion, a
compare, `ret` or a call argument its callee is declared to take as a `double` — so a
pass that matched an opcode without asking what it computes on fails where it did it.

**Conversions and compares are the crossings.** `fptosi`/`fptoui`/`sitofp` convert between a float
and an integer of 32 or 64 bits, `fpext`/`fptrunc` between the precisions; they are the only ops a
float and an integer meet in. The compares are TEN, not six, because a NaN makes C's relations a
partial order: each ordered relation (`fcmp_olt` …, false on a NaN) has its logical negation as an
unordered opcode (`fcmp_uge` …, true on a NaN), so `!(a < b)` is `fcmp_uge` and never `a >= b` —
every compiler here compiles the two apart. `FCMP_TRUTH` defines each by its answer on less, equal,
greater and unordered, and `NEGATED_FCMP`, not `NEGATED_ICMP`, is their negation. At L3 they lower
to `f< f<= f> f>= f== f!=`, of which `negateCond` flips only `f==`/`f!=`, so an unordered compare
prints as the `!` it is; a conversion lowers to C's cast, an integer operand pinned to render signed.
One flip is still not free: agbcc picks `__eqsf2` or `__nesf2` by the relation the SOURCE spelled,
having folded `!(a == b)` into `a != b` first, so the fold stamps that relation on the compare
(`RuntimeHelper.relation`, carried to L3 as `Expr.helperRel`) and the structurer and the L3 arm swaps
choose the arm order that spells it rather than negate it (`keepsHelperRel`, `regainsHelperRel`);
`if (a == b) {} else` is the guard return's spelling there. A tested loop whose test the branch fold
joined to such a break guard has no `while (P && S)` spelling of it, so its test splits back into the
header and the guard (`splitHelperBreak`): `while (P) { if (a == b) break; … }`.

**The ABI homes are target DATA.** `TargetDescription.fpu` names the float argument registers, the
float return and how the two files COUNT: o32 is `'leading'` (argument k is in `$f12`/`$f14` only
while arguments 0..k are all floating, and it still takes its integer slots — one for a float, two for
a double, so the integer after `double a` is read from `a2`), the PowerPC EABI is
`'separate'` (f1..f8 count on their own). `frontend/fpu.ts` is the one reading of them, shared by both
frontends, and the SSA builder types every parameter and phi of the FPU's file a float where it mints
it (`keyType`), so recovery's s32 default never reaches one — a float carried round a loop is declared
a float.

**L3 — operators of its own too.** A float op lowers to `f+ f- f* f/` (unary `f-`), not to `+ - * /`.
C writes both with one token, but `/` at L3 is the SIGNED integer divide the C backend pins with
`(s32)` casts, and `+`/`-` are what the pointer walks and the constant folds match — so the split is
earned by what the integer operators MEAN to passes, the rule `BinOp`'s own note gives for the splits
before it. A float product read by a float add or subtract is NAMED on a compiler that can contract
(`structure/analysis.ts`, gated by the target's `contractsFloatProducts`): mwcc `-fp_contract on`
fuses a multiply into an add only within one expression, so the inline spelling recompiles to a
fused multiply-add that rounds once, where the temp compiles to the unfused pair under either
setting. MIPS II and III have no fused multiply-add, and there the product stays inline. **The
backend** spells the C89 keywords `float` and `double`, which no translation unit has to declare, so the candidate prelude and every project context
that already typedefs `f32` are untouched.

**A double without an FPU.** agbcc has no float instruction at all: its `double` arithmetic is a
libgcc call (`__adddf3`, `__negdf2` …) over the register pairs a long long travels in (a `float`'s,
`__addsf3` …, over one register, folded the same way to the op over `f32`s), so it enters
the IR the way a 64-bit integer does — a `concat` of two argument registers into the call, the
result split back into r0:r1 — and `raise/floathelpers.ts` folds the call to the float op over
`f64`s, in its own pass just ahead of the one that folds `__muldi3`. A call to an ordinary callee a
prototype declares to take a `double` enters the same way, on a target whose double takes two
general words (`TargetDescription.doubleArgWords`, which states that and their order): the frontend
lays that parameter out where it lays out any 64-bit argument, the next two argument words wherever
they fall (`frontend/thumb.ts` `outgoingBlock` — two registers, r3 and [sp,#0], or two outgoing stack
words), lists it in the call's `doubles`, and the same pass hands it a double. That pass is the only
producer of an `f64` from integer words, and it is not an op: verify holds that a `concat` builds an
integer, so a double may come only from a pair of this function's argument slots, fused into one
parameter however many calls it is handed to, from another such helper's result, or from two
constant words — a literal, which becomes an `fconst` the C backend spells as the shortest decimal
agbcc reads back as the same double. agbcc stores a double high word first
(`FLOAT_WORDS_BIG_ENDIAN`), the opposite of a long long, which is why only a pair moved whole, or
two constants read high word first, may be read as a double. The conversion helpers fold the same
way to the cast each computes, with only their float side held to that rule: the integer side is any
integer. A compare helper (`__gtsf2` …) returns libgcc's three-way answer, and folds through the test
its caller puts it to: the table states the helper's value on a NaN (`unordered`), the test is read at
-1, 0, 1 and that value, and the four answers name the compare in `FCMP_TRUTH`.

**On an FPU the crossings are instructions.** MIPS decodes `trunc.w` and `cvt.{s,d}.w`, `mfc1`/`mtc1`
of an integer word, and `c.{eq,lt,le}` into the one condition code `bc1t` reads set and `bc1f`
clear; PowerPC decodes `fcmpo`/`fcmpu` into a condition-register field whose three bits each hold a
compare, which a branch, a `cror` over one field and an `mfcr` one-bit extract read, and `fctiwz`
into the integer word its `stfd` puts in the frame for the low-word `lwz`. An FPU register then
holds a float or an integer word, and each read says which (`refuseFpWordCrossings` checks the edges).

**What refuses, and why each refusal is where it is.**

| level    | refusal                                                                                                                                                                                                                                                                                                                                                                                                                                     | because                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| frontend | every FPU instruction but the arithmetic, its copies, the signed conversions to and from a word, the moves of a word and the ordered compares (register-file refusal); an integer word in the float return home at a return, unless the integer home is proven; once a float reaches the integer file, a function whose two return homes both, or neither, hold a value computed only to be returned and whose own declaration does not say | a move to memory would let a float reach something that is not a float op, a crossing or the return, which is what makes the return rule sound; once a float reaches the integer file, a write to the float return no longer says which home holds the result, and `void f(float a, float b, int *p){ float c = a * b; if (c < a) *p = 1; }` is the object of a float function returning `c`                                                                                   |
| frontend | an FPU register's integer word read as a float, or its float read as a word; MIPS: a condition-code branch with no compare in its block; PowerPC: a `cror` across fields or over an integer compare, an `mfcr` copy read as an integer, an ordering bit of `fcmpu`                                                                                                                                                                          | a float in a general register moved in by `mtc1` is a bit cast; a compare and its readers are modelled within the shapes the compilers emit, and anything past them would be a guessed reading                                                                                                                                                                                                                                                                                 |
| frontend | an FPU register read before any write that is not a float argument home                                                                                                                                                                                                                                                                                                                                                                     | it would mint a parameter no caller passes — including a return path that never writes `$f0`, since a function returns a float on every path or on none                                                                                                                                                                                                                                                                                                                        |
| frontend | an integer argument register in a slot a float shadows (o32)                                                                                                                                                                                                                                                                                                                                                                                | `'leading'` gives a float argument its integer slots too, so `a0` beside `$f12` is not a layout the ABI produces                                                                                                                                                                                                                                                                                                                                                               |
| frontend | PowerPC: a function that computes on a float and makes a call, and MIPS: one that names an FPU register and makes a call; on both, a call to a callee declared to take or return a float; a record form (`fadds.` sets `cr1`)                                                                                                                                                                                                               | which FPRs a callee reads, returns in and destroys is unmodelled (`a * g2()` would read g2's return as `a`)                                                                                                                                                                                                                                                                                                                                                                    |
| frontend | agbcc: a call to a callee declared to take a `float` or a `long double`                                                                                                                                                                                                                                                                                                                                                                     | neither is laid out in general argument words (a `double` is, `doubleArgWords`), and the arity guess that would stand in drops a trailing argument passed through unchanged (`g(a + 1, b)` as `g(a0 + 1)`) or counts a leftover register (`h(v)` as `h(a1, a1)`)                                                                                                                                                                                                               |
| frontend | a function computing in both precisions                                                                                                                                                                                                                                                                                                                                                                                                     | the SSA builder types an FPU register once per function (`fpPrecision`), and the rounding between precisions (a conversion, `frsp`) is not modelled                                                                                                                                                                                                                                                                                                                            |
| verify   | a float operand of any op but a float op, a conversion, a compare, `ret` or a call argument declared `double`; a float op over a non-float; a float edge into a non-float parameter; an `fconst` that is not a double                                                                                                                                                                                                                       | the two silent wrongs a new kind invites, stated where they happen                                                                                                                                                                                                                                                                                                                                                                                                             |
| raise    | agbcc: a double helper operand, or an argument a callee declares `double`, that is not a pair of argument slots moved whole, another double helper's result or a finite literal; a helper result that reaches anything but one of those uses or `ret`; a float helper result, of either precision, that nothing reads; a compare helper result read by anything but a test against 0 that names a compare                                   | the pair's word order is the reverse of a long long's, so a load, a half read, a store or a phi would name the wrong double; a result nothing reads is one a guessed call after the helper took in r0 (optimising, agbcc deletes a dead helper call), so folding it would delete the arithmetic; a compare's value beyond its sign is libgcc's, not C's; a helper is gapped as an unmodelled runtime helper, and a declared `double` has no fallback, so the function declines |
| backend  | Pascal, on a float type, operator or negation                                                                                                                                                                                                                                                                                                                                                                                               | it throws rather than spelling an integer                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**What a decompiler may NOT infer.** On PowerPC an FPR holds a double whatever it carries, so the
float-versus-double choice of a parameter or return is not in the object where only `fmr`/`fneg`,
the compares and `fctiwz` touch it, and neither is the ORDER of integer parameters against float
ones: both are spellings, fixed so the output is deterministic (`fpuArgSlots`). A declaration decides
them. The C++ backend reads one for both (`bindSpecParams`); the PowerPC frontend reads the own
declaration's precision where it may prove (`declaredPrecision`: all `double` is double, both
precisions refuse), and not the order: in C, a project context declaring a float ahead of an integer
makes the fixed int-first spelling a redeclaration the compiler refuses.

## A struct returned by value, across the tower

The one call whose first argument the caller did not write for the callee to read. Where a
compiler returns a struct through memory, the caller passes the storage's address as a hidden
argument 0 and every declared argument moves one register up — so a lift that reads the declared
parameters from the argument registers names the pointer as the first of them, and drops the last.

**Whether it goes through memory is the target's, and it is DATA.** agbcc puts a struct there when
it is wider than a word or has a second member that is not a bitfield (thumb.c:1423-1493), passes
the address in r0 and shifts the arguments (thumb.h:644-645, 672); mwcc hands back up to eight
bytes in r3/r3:r4 and passes a pointer in r3 past that; ido7.1, gcc2.7.2kmc and gcc2.7.2 pass a
pointer in a0 for every struct and union, whatever its size (`'memory'`). `compilerBehaviors.aggregateReturn`,
`aggregateBoundary` and `largestAlignment` state it, with `enumBytes` and `bitfieldPacking` for the
members whose size or place is the compiler's (agbcc states both; a float is 4 bytes and a double 8
everywhere, a storage size that is not `declaredWidth`'s register count). `aggregate.ts` is the one
reading of them: `returnsInMemory`, asked by the call lowering, and `returnsWithoutHiddenPointer`,
asked by the frame-object audit, so the two cannot disagree about one call.

**Whether a callee returns a struct at all is a declaration**, never an inference: the
out-parameter call `add sp,#-4 / mov r0,sp / bl f` and the struct return are the same instructions,
and a register count cannot tell them apart (frontend/frame-objects.ts says why). `FnProto.returns`
and `returnLayout` state it — from a context's declaration and the struct it defines, from a
symbol map by size alone (a layout with no members), or from `--proto`.

**L1 — the call's value is the struct.** A memory return types the call's result as the declared
struct, laid out on the target (`aggregateType`), with a field for each member the IR can type and
none for the rest (a nested aggregate, a bitfield, an enum, a plain `char`); `attrs.sret` says
argument 0 is where it lands; the frame temp's `laddr` is a pointer to it. A register return keeps
the declared arguments where they are. Where the struct can be a local here
(frontend/call-plan.ts `registerStructLocal`, the one derivation: a type `structLocalType`
declares, of one, two or four bytes, all integers, its callee's prototype printable), the call
writes the return register as its value, marked `REGISTER_STRUCT`, and the frontend reads that
word as it reads any call's; a guessed arity after the call still does not take it (ssa.ts
`noteStructImage`), since the bytes do not say whether a callee nothing declares is handed the
struct or a member. Every other struct return writes no value: the return register is listed as
destroyed and a read of it refuses.

**L1 — the register's word becomes the struct** (frontend/register-struct-call.ts
`liftRegisterStructCalls`, from `pipeline.ts` `liftStamped`, before the own-return check). Each
marked call is rewritten onto the memory return's own form: an `laddr` marked
`CALL_RETURN_OBJECT`, one per call (`nth` keeps two calls' structs two objects), is its `sret`
argument 0, and the word is a load of that local — shifted up to the top of the word on a
big-endian target, where a sub-word struct's first byte sits (mwcc's `{u16}` is `srwi r0,r3,16`
off the call, which then cancels to the load). So the declarations block, `aggmembers` and the
`s = mk(x); gV = s.h;` spelling are the memory return's. Two things are this pass's own:

- **The frame home is the local.** mwcc stores the register to a frame word as it comes back
  (`stw r3,8(r1)`, or the struct's own bytes, `sth`) where the source names a local, and reads
  members off it; the PowerPC frontend marks such a call `STRUCT_HOMED` (and lets a home nothing
  reads stand where no call after it could take the word as a stack argument, ppc.ts). The fold
  re-points the loads that follow the store in the call's block at the local and drops the store
  where nothing else touches those bytes. A home read in another block, or written again first,
  is not folded.
- **What the image leaves out is no value.** mwcc fills only one or two bytes of r3 for a `{u8}`
  or `{u16}` (agbcc rounds every struct to four), so every reader must need only the struct's bits
  (`demandedBits`): a truncating store, a shift or mask that drops the rest. A `ret` reads all 32
  unless the function's own declaration returns nothing; with no own declaration that `ret` is the
  frontend's guess, and where it is the only reader past the struct's bits and every `ret` hands
  back a call's image as it came back, the function is lifted `void` — no C return is what the
  register below the struct holds.

**The own side composes with it.** A function whose every `ret` hands back a call's image of its
own declared register-struct type returns the call (`return mk(x);`), or the call's local where
mwcc wrote a home (`return mk_ret;`, which `struct T s = mk(1); return s;` compiles to and `return
mk(1);` does not). Where the own return is a word the own side cannot spell as the struct
(`liftOwnRegisterStruct`, a `{u8}` or `{u16}`) and the function reads any call's register struct,
it refuses: the word may be computed from that struct through a frame slot as well as an op (an
array, an escaped local, mwcc's home), and printed as the word it is it would be the scalar the
declaration contradicts.

**L3 and the backend.** The structurer stamps the call (`Expr` `call.sret`, as it stamps
`wide64`), and the temp is a local declared with the headers' own spelling of the type:
`struct Blob64 sp0; sp0 = makeblob(&gBlob);`, or `BlobT sp0;` for a tagless typedef. The struct is
the headers' type (`ir/types.ts` `declared`), so the lifted source never defines it: the
declarations block does, beside the callee's prototype, transcribed from the declaration's own
members rather than from the IR's fields (declare.ts `declaredStructDecl`), and a candidate compiled
inside the project's headers drops that block.

**What refuses, and why each refusal is where it is.**

| level       | refusal                                                                                                               | because                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| frontend    | a declared struct return whose members are not all known or not sized on this target, or a target that states no rule | where the pointer goes decides where every argument is read from     |
| frontend    | a memory return whose parameters nothing sizes                                                                        | a guessed arity reads from argument 0, which holds the pointer       |
| frontend    | a memory-returned union                                                                                               | its IR type carries no name to declare the local by                  |
| frontend    | a pointer at argument 0 that is not a local of this frame                                                             | a struct returned into a global or through a pointer is not modelled |
| frontend    | PowerPC: a memory return                                                                                              | only the register return is lowered there                            |
| frame audit | a write, an index or any other use of the return temp but a read inside it                                            | only a read of a returned struct is modelled                         |
| frontend    | the return register read after a struct came back in it that `registerStructLocal` gives no local                     | its bytes are a struct, not a word this function named               |
| L1          | a read of the register past a one- or two-byte struct's bits; a home read where the fold does not reach               | what the callee left there is no value                               |
| L1          | an own `{u8}`/`{u16}` register return, kept as its word, in a function that reads a call's register struct            | the word printed as a scalar contradicts the declaration             |

**Member reads of a returned struct.** A declared struct's range (`declaredStructs`: a return temp,
or a struct passed by value) is an object boundary. The audit rebases onto its base both a
capture's access inside it and an `laddr` strictly inside it that is only accessed — a
`str r1, [sp,#4]` into a by-value struct is a member store, not a second object — and accepts reads
of a return temp; structure spells an access that names one
declared member exactly as that member (`sp0.a`), and an L1 pass, `raise/aggmembers.ts` in
`PRE_RECOVERY_PASSES` after `structs`, splits a whole-word read of the temp — agbcc's only
sp-relative load — into the member reads its uses take.

**A hidden pointer that reaches the call through a merge.** gcc rotates a loop that calls a
struct-returning function, so `addiu a0,sp,16` runs once ahead of the loop and once in the delay
slot of its back branch, and it hoists the same instruction into both arms of an `if` ahead of one
shared `jal`. The call then reads a block parameter. Where every path hands that parameter the same
frame address, a shared pre-audit step (`frame-objects.ts` `nameMergedSretObjects`, on MIPS and
Thumb) hands the call an `laddr` of that address, minted just ahead of it, and the audit types it
as the struct like any other return temp. A merge of two different addresses names no one storage,
and the audit refuses it (`a phi merges the frame objects`).

**What is NOT built.** A member read of a returned struct at any word but the temp's first: the
Thumb slot model keys `[sp,#k]` as a slot (`stack pointer used as data`); the audit would rebase it
onto the temp, but the frontend does not route a word there to an `laddr` as it does inside a
by-value block. A struct returned straight into a global, through a pointer, or through the
caller's own forwarded pointer — each refuses on every frontend that passes the pointer
(`frame-objects.ts` `refuseSretOutsideFrame`); so does one returned into whichever of two locals the
path chose (the audit, above). MIPS and Thumb pass the pointer, and PowerPC refuses a call that
would. THE CALLEE HALF, on every frontend: a function
that itself returns a struct through a hidden pointer reads that pointer as its first parameter and
returns it, so with nothing declared it lifts as `s32 *f(s32 *a0, …)` — which is also what `void
f(S *)` compiles to, so only a declaration can say which the source wrote. Where its own
declaration — stated, or the context's own entry, whatever its parameter list — returns the
struct, the lift is checked after the frontend runs (`frontend/own-struct-return.ts`, L1, from
`pipeline.ts` `liftStamped`): where the compiler hands the pointer back (agbcc and O32, `target.ts`
`structReturnHandsBackPointer`) every return hands back the incoming pointer, and where it does not
(the three mwcc builds, which leave in r3 whatever was last there) no return hands back a value
computed for the return alone; the pointer and the constants added to it are read only as the
bases of unqualified stores inside the struct, and at least one store goes through it. Then the pointer is the function's own
return object — an `laddr` marked `returned`, which names the caller's storage and no frame offset
— its stores are that local's members, and each `ret` returns it by value: `struct S f(s32 a0) {
struct S ret; ret.a = a0; return ret; }`. A frame object the struct was built in and copied out of
whole (IDO's word copy, agbcc's `ldmia`/`stmia`) is that local, and the copy is `return ret;`'s
own lowering, so it folds where nothing else reads the object, something stores to it, and every
write to it is on a path into a copy, ahead of it. It folds one whole copy per block, of an object
that holds the struct alone: where IDO repeats the copy at each of several `return r;`s, each copy
block returns the struct itself (`returnAtEachCopy`); an object the frontend shares with another
address-taken local keeps the copy as member stores — the same function, one copy too many.
Where the check fails, a stated declaration refuses and a context's keeps the pointer function with
an `[own-return]` note, the soft policy of its arity bound. A stated return the context lays out —
`struct S`, or a typedef of one — is read with that layout (`proto-context.ts`
`withOwnReturnLayout`), so a one-word struct the rule returns in a register lifts as its word — as
the struct where it is all one word-wide integer member (`liftOwnRegisterStruct`) — and
one it returns in a register pair (mwcc's svr4 eight bytes in r3:r4) refuses, stated or from the
context, since the lift returns one word.
A symbol map states a
signless return of a word or less as nothing, since it is an enum as often as a struct; and a
context return spelled by a typedef the reader never saw keeps its parameters.

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
  regressing pass that produced, say, a width-8 access would otherwise print `(s64 *)` — and since
  `s64` IS in the typedef vocabulary, that COMPILES, which makes this rule more load-bearing rather
  than less. The 8-byte ACCESS is what does not exist: nothing recognises a pair of word loads as
  one 64-bit read, so a width-8 index is a claim no pass makes. `contracts.ts` says the same at the
  rule itself.
- **`assertLocalsWritten`** (also after structuring): every declared local is written somewhere
  before it is read, unless its declaration says why not — an `uninit` local stands on an `undef`,
  a `frame` local is the machine's own slot. It catches a materialized def whose assignment no
  position emitted.
- **`assertPostIncrUnshared`** (also after structuring): no expression names a `postincr`'s
  variable twice. C89 leaves undefined which value the second read sees, so a pass that brings one
  in has to fail here rather than compile into whichever answer the compiler picked.
- **`assertEffectsPreserved`** (also after structuring): every execution the asm makes is emitted,
  and none is emitted more times than the asm makes it on any one path. It counts by key:
  `call:<target>` for a call, and one `call:(*pointer)` for every call through a register, so
  the count cannot tell one indirect callee from another; `device:r:0x<address>` and `device:w:0x<address>` for a read and a
  write the lift pinned `volatile`, with `?` for the address where a side cannot read one off, a `?`
  on either side standing for any address and each render for one access; and `declared:<object>`
  for a read of an object the symbol map or the declaration context declares volatile. A pinned access through a named global
  and a declared read are counted for re-runs only, because their qualifier may be the declaration,
  which leaves nothing in the tree to find; a declared read or store that reaches its object through
  a cast with no `volatile` is refused, since the cast's pointee drops the declaration's qualifier. The
  `opaque` ops standing in for unmodelled instructions are checked as never dropped. It is the odd
  one out and worth the attention: the other four check L3 against _itself_, so they catch a tree
  that is ill-formed. This one checks L3 against the L2 graph it came from, which is the only way to
  catch a pass that **loses** something well-formedly — a dropped call, a hardware read rendered
  twice, or an unmodelled instruction quietly vanishing because its destination register was dead.

**What the effect contract counts is decided once, below it.** Whether an op must run where, and
as often as, the asm ran it is a fact about the OP, and
[`ir/discipline.ts`](../packages/core/src/ir/discipline.ts) owns it as a _placement_, stamped by
the one pass that knew it: `call` is its own opcode; `helper` is the stamp
[`runtime-helpers.ts`](../packages/core/src/runtime-helpers.ts) `helperOp` puts on a value the asm
computed by calling a runtime routine; `device` is the `volatile` a frontend puts on a memory
access, decided by two pins: the device pin
([`frontend/device-pins.ts`](../packages/core/src/frontend/device-pins.ts)), for an access of a
device register, and the dead-read pin
([`frontend/dead-reads.ts`](../packages/core/src/frontend/dead-reads.ts)), for a read at any
address — a RAM global, a pointer parameter, a literal — whose value the lifted function never
uses, since a compiler deletes every plain read nobody uses. That pin is the ONE decider of the
claim: it does not count the `ret` operand of a function declared void as a use, so the read-back a
void function ends on is stamped there too, its refusals are a reported gate table (`DEAD_READ_GATES`:
a level that keeps unused reads, a declaration that says plain, a value the lift lost the consumer
of — a compare, a spill, an undeclared call's argument, a pair half a guessed return width left —
and more), and the structurer spells an unused read only where it is
qualified; `declared` is the stamp
[`raise/declared-volatile.ts`](../packages/core/src/raise/declared-volatile.ts) puts on an access of
an object the symbol map or the declaration context declares volatile as the lift is made, from the
map, the context's globals and the compiler the function is lifted and structured under, before any
pass asks whether a read may be deleted. The map answers per byte where it lays an object out; the
context answers per object (`ContextGlobals.volatiles`), and only for an object the map does not lay
out. The object is read through a join every edge of which reaches it, a pointer a loop steps
through it included. The context also names the pointers whose pointee is volatile
(`ContextGlobals.pointeeVolatiles`), and an access through such a pointer's value is placed, read
through the same joins and loop steps by the same reader, so the object and pointee paths cannot
reach different shapes. An access
that does not reach its object through the object's own name carries the qualifier on a cast. A read the
compiler could not have made of a `volatile` — agbcc's sign-extending narrow load — is left plain
by this stamp and by both pins alike, through the one predicate all three ask. An access can carry
both `declared` and `device` — a dead read of an object the map declares volatile — and the
declaration places it first, as the spelling the source used; an L2 rebuilder carries both stamps,
so a later stamp that no longer finds the declaration leaves the lift's `volatile` in place. Every
pass then asks the module's questions of the op — `effectful`, `deletableWhenDead`,
`spelledWhenDead`, `speculationUnsafe`, `orderSensitive`, `reevalUnsafe`, `counted` — rather than
testing an opcode set, an L2 rebuilder carries the stamps through `carryDiscipline`, the contract
enforces the `counted` ones at L2→L3, and L3 keeps volatility only as a spelling. A helper is
placed but not counted: its value is pure, and agbcc computes one spelled twice once (`a / n + a / n`
is one `bl __divsi3`). The module header names every site that still answers from the opcode registry alone,
each marked deliberate or a gap, so a new placement's reach is read off one list.

**Where they run matters as much as what they say.** The five post-structuring contracts fire
_before_ the committed L3 rewrites, so a readability pass cannot hide a structuring defect by
deleting the statement that carries it; deref-typing and effect-preservation then fire _again_
after, so those passes cannot introduce one either. And each respell variation's tree gets its own
`assertResolved` + `assertDerefsTyped` inside `respell`'s guard ([`rank.ts`](../packages/core/src/rank.ts)),
where a failure costs that one candidate and is reported through `onEnumerationError` — never silently
dropped, which would be indistinguishable from a respell variation that correctly declined.

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
  readonly why: string; // one line: the reason the rule exists, readable without the code
  readonly sound: boolean; // remove it and some candidate is WRONG, not merely worse
  readonly guardedBy?: string | readonly string[]; // required when `sound` — the test that fails without it, one per half
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

A table that a variation's definition names is also read by people who never open the code: the
webapp's variation drawer lists its `why` strings verbatim as the rules that can refuse the
variation. So those strings are plain prose, and
[`test/variation-offers.test.ts`](../packages/core/test/variation-offers.test.ts) holds them to it.

Adopt this when a pass's refusals are load-bearing — not for every `if` in the codebase. The same
"earn it" discipline applies: `l3/basecse.ts` declares a table in which **no** gate is sound,
because a wrong hoist there costs bytes and a match, never meaning, and saying so plainly is worth
more than three gates pretending to a soundness they do not have.

**THE UNIT OF THAT DECISION IS THE REFUSAL, NOT THE PASS — a pass may be PARTIALLY tabled, provided
the residue is NAMED.** "Adopt this" is asked about a file, and the answer is almost never all of it.
Asked file-wide the question gets declined on cost, which is the wrong reason and settles nothing for
the next round that asks it. Three shipped passes answer it three different ways, none of them a
defect — and a fourth entry says what tabling has to INCLUDE either way:

- **Partially tabled, residue named.** [`structure/hazards.ts`](../packages/core/src/structure/hazards.ts)
  holds five per-candidate rules in `PREUPDATE_SINK_GATES`. The two SET-level rules — two slots
  wanting one name, a slot that stays behind reading a sunk name — are deliberately outside it,
  because they are properties of the whole edge rather than of a candidate, and the table's own doc
  comment says both that they exist and where they live (`sinkablePreUpdateSlots`, "with the same
  refusal discipline"). That comment is the whole obligation. A partial table with the residue named
  is finished work; a partial table that reads as a complete one is the defect. Note what that
  exclusion is NOT: both rules judge one prepared edge
  (`grep -n "names.size !== cleared.size" packages/core/src/structure/hazards.ts`), so the
  next bullet's bar does not touch them. They are outside `PREUPDATE_SINK_GATES` because a
  `Gate<Ctx>` is per-candidate and these would need a SECOND table over a different `Ctx` — which the
  paragraph below says to build when a round has had to instrument them, and not before.
- **Not tabled, and the decline left in prose.** `pointeeElement` in
  [`structure/structure.ts`](../packages/core/src/structure/structure.ts) lists its refusals in
  prose and states that it is "NOT a `Gate` table … unlike `FRESH_MERGE_GATES` and
  `CARRIER_NAME_GATES` in this same file: those refusals are predicates over ONE prepared context,
  while these interleave with the computations that produce the values the later ones test […], so
  building that Ctx would run all of it on inputs the earlier gates reject." That reason is the EAGER
  reading of "prepared", which the same file answers in `CarrierName`: its fields are getters
  (`grep -n "THE FIELDS ARE LAZY" packages/core/src/structure/structure.ts`), so a later gate's input
  is computed only when the earlier ones let it be asked, and blame is unchanged.
  `pointeeElement` is pure, so each of its refusals is expressible that way too and its interleaving
  is a cost, not a bar. **The bar that IS structural is the lazy one: a refusal whose input cannot be
  prepared even as a memoized getter — because preparing it performs an effect, or depends on an
  order the pass itself establishes — is not a candidate for the table at any price.** Check it in
  that form, and only in that form; the eager form returns either verdict for the same pass. No pass
  here is a measured inhabitant of it, `pointeeElement` included: it stays untabled on the paragraph
  below, which is a reason that can change.
- **Fully tabled, and its inline conditions are not residue.**
  [`structure/namecoalesce.ts`](../packages/core/src/structure/namecoalesce.ts) has every refusal in
  `NAME_COALESCE_GATES`; the `continue`/`return`s left in `coalesceNames`' walk are the ENUMERATOR —
  which pairs exist to be judged at all — and enumeration is not residue. Nor is a rule DERIVED away:
  `mayMerge` records that "two loops' variables always escape each other … so the enclosing-loop rule
  needs no gate of its own", which is residue that no longer exists. Counting either as an untabled
  refusal invites a conversion that buys nothing.
- **Tabled AND REPORTED — the half that actually removes the loop.** A table on its own changes WHAT
  you patch (one call site instead of four `if`s), not WHETHER you patch. Of the 27 `firstRejection(`
  call sites outside `l3/gates.ts`, **21 compare the result to `null` on the spot and throw the id
  away**; six keep it, in the two shipped forms — a `refusals` map in the return value
  ([`l3/coalesce.ts`](../packages/core/src/l3/coalesce.ts),
  [`l3/scopebase.ts`](../packages/core/src/l3/scopebase.ts), `structure/namecoalesce.ts`), and a
  census EXPORT off the shipped table that the shipped path never calls (`arrayShapeRefusals` in
  [`raise/globalshape.ts`](../packages/core/src/raise/globalshape.ts), whose doc comment states the
  whole idea: "the one place an attribution is measured rather than asserted"). Both forms are the
  PASS's: each costs a signature the author has to want, so a pass whose return type nobody wants to
  widen has no cheap form of either. **Tabling a pass and reporting nothing is half the job**, and
  the missing half is small: a map, one `set` on the rejection, one field on the return type — six
  lines in `structure/namecoalesce.ts`.

  **The third form is the CALLER's, and it needs no signature at all.** `tallying(gates)`
  (`grep -n "export function tallying" packages/core/src/l3/gates.ts`) returns the same table with
  each `rejects` wrapped in a counter, so any pass that already accepts its table as a PARAMETER can
  be censused from outside `@asmlift/core`, with no edit and no revert. That is what a pass adopting
  the table should make possible: taking the tables as an optional argument is the whole cost, and
  `l3/unmerge.ts` is the worked example (five tables, one `UnmergeGates` parameter, and a test that
  reads the census back). It reports what `firstRejection` decides, so it carries the same reading
  as the two forms above — first rejecter only.

  **The parameter is necessary and not sufficient, and the gap is where a round loses its
  afternoon**: nothing exports a corpus of lifted trees, and a tabled pass's only shipped caller is
  normally inside core, so a census is taken off a REAL `enumerateRanked` with that caller's entry
  swapped — for `l3/unmerge.ts`, the `/unmerge` entry in `PRE_RESPELL_VARIATIONS`. **That is a subcommand,
  `pnpm bench gates --pass unmerge`, and not a script to write**: its numbers reproduce
  `unmerge.ts`'s instrumented 40/16 split with no patch, and it has none of the three hazards a
  script has (where it may live, that an untracked one makes the next `bench run` stamp itself
  dirty, and that a module duplicate censuses zero silently — all three measured in
  `apps/benchmark/src/run/gate-census.ts`'s header).

  **What makes a pass censusable is a fact about its CALLER.** Many passes in `packages/core/src`
  take their table as a parameter (`git grep -lE "gates\??: readonly Gate<" packages/core/src`);
  TWELVE have a caller held in a mutable record — `/unmerge` in `rank-variations.ts`'s
  `PRE_RESPELL_VARIATIONS`; the branch short-circuit fold, `truncload`, `member-arrays`,
  `narrowlocal` and `paramwidth` in `raise/pre-recovery.ts`'s `PRE_RECOVERY_PASSES`; the four loop
  folds `latchfold`, `trampoline`, `unthread` and `reroll` in `raise/pre-structure.ts`'s
  `PRE_STRUCTURE_FOLDS`; and `nameOffsetAddresses` and the frame-object audit in their own
  `OFFSET_NAME_PASS` and `FRAME_OBJECT_AUDIT`, records with no list around them because each seat
  in the tower is fixed rather than a position. Which of them are registered is the registry's to
  say, not this paragraph's (`CENSUSABLE_PASSES` in `apps/benchmark/src/run/gate-census.ts`;
  `pnpm bench gates --pass <id>`); its header carries the same list. A pass
  reached only through a static import has no seam — the binding is read-only
  (`retsink.sinkReturns = …` → _"Cannot assign to read only property"_) — and `raise/retsink.ts` is
  one: the seam is the record, not the directory. So for any other pass the cost of an entry in that
  registry is a seam, not a wrapper — and a pass that wants to be censusable should be given one
  when its caller is written, which is cheap then and a redesign later. A record with no list also
  gives up the invariant a list carries — `PRE_RECOVERY_PASSES` reaches every driver, three
  hand-written calls do not — so it owes a test that asserts each driver reaches it
  (`offset-names.test.ts`).

  **A census is FIRST REJECTIONS, which is not reach.** The other column is what an ablation MOVES,
  and the two disagree: of the six ablatable rules in `l3/unmerge.ts`, exactly one moves a row.
  Three of the other five refuse hundreds of times over the agbcc synthetic tier and move nothing,
  and two never fire at all. `raise/globalshape.ts` ships the
  convention for reporting both columns (`grep -n "ON ITS OWN" packages/core/src/raise/globalshape.ts`)
  and `l3/unmerge.ts` now carries the worked example
  (`grep -n "TWO COLUMNS, AND THEY DISAGREE HERE" packages/core/src/l3/unmerge.ts`). Measure the
  MOVED column before building a variation on a big refusal count.

**And converting a pass whose refusals nobody has had to instrument buys nothing.** What a table
removes is the edit-instrument-revert loop — patch a `return null` to log, re-run, revert — so the
trigger to table a pass is that someone has already paid that loop on it, not that the pass has many
refusals. `CARRIER_NAME_GATES` is the model: it was grafted by the round that needed a rejection
reason out of `canTakeName`, and it shipped as that round's own remediation — #164 (`428f5706`),
whose commit body records that the rules "were four `if`s inside a 5000-line function" and that
"naming which one fires on a given row took an instrumented patch and a revert".
`ENCLOSING_CARRIER_GATES`, beside it, is the same trigger firing inside one round: the admission
that lets a nested loop's carried value keep its enclosing loop's name was five `if`s, and the round
that built it paid the loop on them three times (the build's source ablations, its remediation's
clause ablations, and a review's environment switches) before tabling it in the remediation.

There is exactly one other admission, and it is the mirror of that one — read it together with **A
GATE CAN ALSO BE STARVED FROM ABOVE** below. Nobody can have paid instrument minutes on a rule
nothing reaches, so the trigger above would make a starved gate permanently ineligible. **Instrument
time is the trigger for refusals that fire; a refusal suspected of never firing at all is the other
admission.** Neither admission is "this file has a lot of `if`s". A round tabling a pass on THIS
admission builds the bullet above's `refusals` map in the same change, or it has proved nothing.

**That map is where the starvation proof STARTS, not where it ends.** `firstRejection` returns the
FIRST gate in table order that rejects, so a rule absent from the census is either starved or
SHADOWED by an earlier one — and `ADDRESS_GATES`' own dated census
(`grep -n "ON ITS OWN" packages/core/src/raise/globalshape.ts`) ships two of the second kind
(`no-subscript` rejects 21 symbols run alone and is first for none of them;
`stride-is-not-the-element` 25 and none). Telling the two apart takes the other experiment that
census records, the rule run with the rest of the table EMPTY. A rule that rejects nothing even then
is a question about what the upstream passes leave in the program, which the section below answers
with a reach test through the real pipeline, never with a count.

Refusal count predicts none of it, on any way of counting: `structure/switch-recover.ts` has 44
refusal-shaped exits (`grep -cE 'return (null|false)\b'`) and cost 6.5 instrument-minutes across
seven rounds, while `raise/const.ts` has **none** by that grep, four early exits in all, and exactly
ONE refusal by the rule above — the other three are the enumerator, and the file's own comment marks
the one ("THE REFUSAL: this shape is not a literal being materialised") — and it cost 38.6 minutes.
Nor does file size. Those minutes are from a 2026-09 retrospective over the CountCollectedGems
rounds, whose transcripts are not in this repo — treat them as an order of magnitude you cannot
re-run, not as a measurement you can cite back. The same retrospective priced the whole
edit-and-revert population of those rounds at ~69 minutes against ~764 minutes of measurement runs in
the same spans, which a table removes none of: you still run the bench to get the counts.

**So this section licenses converting the passes whose refusals a round has actually had to
instrument, one at a time, each naming its residue. It does not license a sweep**, and a proposal to
table N passes at once should be read as a proposal to table the one or two of them with measured
instrument time. In that retrospective that is `l3/unmerge.ts` (47.7 min, 12 refusal-shaped exits) —
the answer to "which pass next" for as long as nobody measures a third. `raise/const.ts` (38.6 min)
is NOT, and it is the standing warning about this selector: the recount above found three of its four
early exits are the enumerator, so a table over it would hold ONE gate — the conversion the bullet
above declines. **And a second reason, which is a fact about `Gate<Ctx>` rather than about that
file**: `firstRejection` reads the table as a DISJUNCTION of independent refusals, while that site
is a CONJUNCTION with two buy-backs (`edgeCarried && !hiLoPair && !memBases.has(…)`). "Refuse unless
exempted" has no decomposition into independent gates — every term would have to re-carry the whole
conjunction, which is not what a table means and not what a census reads back, so the id it reported
would be one opaque `not-a-literal-being-materialised` and silent about WHICH exemption fired. That
is the only question the file's 60 lines of measured commentary ask (`hiLoPair` carries the traffic;
`memBases` decides 0 folds over 806 rows). A refusal shaped like that is outside what this section
licenses, whatever its instrument minutes. The minutes are priced per FILE and this rule is consumed
per REFUSAL; re-read a candidate's refusals by the counting rule before selecting it, because
`const.ts` is where the two readings diverge. `raise/magicdiv.ts` — 18 refusal-shaped exits by that
same grep, and no instrument event anyone recorded — is the shape a sweep picks first and this rule
declines.

One corollary, same economy: a refusal already known and CONTAINED is recorded beside the gate
together with the argument that contains it, so the next round cites it instead of re-deriving it.
A containment argument nobody wrote down gets re-proved by every round that reads the gate. Two
instances of it ship, in the two files the bullets above cite: `structure/hazards.ts` on the third
parallel-copy question ("needs no rule … Every leaf such an expression could read is already refused
by a per-candidate gate", then naming all three), and `namecoalesce`'s enclosing-loop derivation.

**A gate's PREMISE can be a target capability, and when it is, that is where it belongs.**
`l3/unreduce.ts` deletes a loop-carried accumulator and re-spells each read as a closed form, which
means a memory read in the accumulator's init is evaluated at each read instead of once where the
init stood. Whether the loop's own writes can change what that read sees is the question
[`ir/alias.ts`](../packages/core/src/ir/alias.ts) exists for — but that predicate resolves NAMED
globals through the L2 def map, and the addresses here are raw constants on a tree with no `Value`s
left, so it answers "unknown" and bars everything. What decides it instead is
`TargetDescription.capabilities.deviceRegisters`: a write to a hardware register is not a write to
any object a C program declares, so no STORE THE C PERFORMS in such a loop can change an ordinary
read. That is a fact about the BOARD, not about C and not about the compiler, which is why it is a
capability rather than a rule inside either file — and it keeps alias.ts's asymmetry, since every
address the range cannot place still bars.

**A GATE CAN ALSO BE STARVED FROM ABOVE — right scope, right rule, no input.** Everything above is
about a gate's own predicate. But a gate reads a program, and the passes upstream of it decide what
that program contains. `raise/const.ts` — the L1 recognizer that folds the two-instruction 32-bit
literal a RISC target builds (`lui;ori`, `lis;ori`) into one `const`, and the pass the `idiom fold`
box above stands for alongside the pattern engine — folded ANY const/const `or`/`add`. That reached
agbcc's `s = 0; if (c) s += 1;` and rewrote the arm's `add(%s = const 0, const 1)` to `const 1`,
deleting the accumulator. (Not because the pass has no business on ARM: on Thumb the same
two-instruction materialisation is a pool word plus an immediate `add`, and ablating the whole pass
costs three agbcc byte-matches — `dmafield` MATCH -> diff:29, `fieldbase` MATCH -> diff:22,
`bgfixed` MATCH -> diff:2. A clientele is a SHAPE, not a target, and reading this one as "Thumb has
no such instruction pair" is what would lead the next reader to gate the pass off ARM and lose those
three.) The `/merge-home` variation that would have hoisted the init has a correct scope and a correct
`perLiftGate` — and the gate read FALSE on both owned rows, because the merge feed it looks for had
been deleted two levels below it. Nothing reported anything: a candidate that was never enumerated
is not a candidate that lost. **So a pass whose refusals are load-bearing states its CLIENTELE, not
only its rule** (`raise/const.ts` now refuses an operand a successor edge carries — a register held
across a branch is not a literal being materialised — unless the pair is a recognisable hi/lo
literal or its result is an address), **and the test that proves a gate's reach runs
the real upstream pipeline rather than parsing IR straight into the gate**
([`test/merge-home.test.ts`](../packages/core/test/merge-home.test.ts), "the accumulator's init
survives pre-recovery"). Otherwise the next widening of an unrelated fold takes the variation off the fan
again, silently.

**AND UN-STARVING A GATE COSTS THE FAN ITS FORK.** The paragraph above reads as a pure win, because
the reach census it rests on counts OUTCOMES: 4 rows of the 806 that lift can move, 3 better and 1
neutral. What that census does not say is that THREE of those rows now enumerate variations
they could not before (`/merge-home`, `/defsite`, `/loop-entry`) and pay for them:
`synthetic:sinkacc:agbcc` enumerates 36 -> 54 candidates and `kleod:CheckWorldCompletion:agbcc`
2.69x as many, which is roughly 2x the wall clock on each real row. The fourth,
`synthetic:fib:gcc2.7.2kmc`, is the two-sided control and gains NOTHING — 8 -> 8 candidates, the same
eight candidates, and its winner was already `signed/defsite/loop-entry` at 12 on main — so it is a
reached row and not a paying one, and a census of either kind must say which it counts. Bounded today,
but the triggering shape is `s = 0; ... if (c) s += 1;`, which is ordinary C, and candidate compiles
have no timeout. When a change unblocks a variation, report the fan beside the score: a reach census
answers "which rows can move" and says nothing about what they cost.

**A refusal at one level can owe a repair at another, and the tower is where that debt is written
down.** The L1 refusal above deliberately leaves `add(const 0, const 1)` standing so the enumeration
gate can see the merge feed — but a candidate that does NOT home the register inlines both operands,
and the winning source then ships `v = 0 + 1;`. So the pair is folded back at an L2 RENDERING site
(`structure.ts`, `lowerDef`'s arithmetic case) instead of in the IR: only at rendering is it settled
that this candidate named neither half. The fold there is `raise/const.ts`'s own `foldConstPair`, so
the two levels cannot disagree about which opcodes fold or how the result is normalised, and it
reads through its own opcodes so a CHAIN of refused pairs collapses rather than printing `1 + 2`.
A cross-level coupling like this is invisible at either site alone, which is why it belongs here.

**A SOUND GATE CAN BE SOUND ABOUT THE WRONG REGION, and nothing in this file's machinery notices.**
`sound: true` costs a `guardedBy` test, and a table where every entry has one still answers the
wrong question if the ctx it reads was built over the wrong span. Every gate above asked about the
LOOP; the transform moves the init across everything between where it STOOD and each read, and the
counter's start is a second anchor that can stand on either side of the init. Three shapes were
admitted and diverged on every input vector. Two rounds fixed the same defect one scope apart — the
first widened `loop.body` to `[loop]` to catch a `for`'s increment and stopped there — because a
gate table makes the RULES reviewable and says nothing about the extent they range over. So a pass
that MOVES code states its motion region as a named value the ctx is built from, and every gate that
asks "can anything change this" reads that one. `deviceMemoryWriters` is the exception that proves
it: an armed DMA writes for as long as it is enabled, so that scan is deliberately WIDER than the
motion region — the whole prefix — and the difference is written down where the two are built.

**And a premise about the board is still a premise.** That paragraph originally ended "so a loop
whose every write lands in that range cannot change an ordinary read", which is FALSE on this
board: a DMA controller reads a control word and then writes ordinary memory itself, so a loop
whose every write is a device-register write can rewrite the very cell the moved read reads.
Nothing caught it because nothing executed it — the claim was written as an aside and then copied
into four files. The fix splits the datum in two: `deviceRegisters` keeps the SPELLING question
("would a source have written `volatile` here"), where an approximation costs a candidate, and
`deviceMemoryWriters` carries the MEMORY-MODEL question, where an approximation costs a wrong
answer. **When neither datum settles it, the DIFFER can**: `Candidate.matchOnly` marks a spelling
publishable only at a byte-exact score, because a candidate whose object equals the target's IS the
program whatever a gate could have proved about it. That is the third admission ground and the
narrowest — it exists because the alternative, barring the spelling outright, deletes a real match
whose reference source has exactly that shape, and the sound alternative to it measures 16. The same field is the eligibility predicate for
`l3/volstore.ts` — a REACH gate there rather than a sound one, since a `volatile` qualifier only
restricts the compiler: widening the range to admit every constant address adds candidates on two
corpus rows and moves no score, so what the declaration buys is that `/vol-store` never claims
volatility of ordinary memory, which the differ could only referee by luck.

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

The compiler field of `TargetDescription` was earned the same way. Holding the ISA constant and
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
  the debt. Convert the REFUSALS a round has had to instrument, not the file: a partial table whose
  residue is named is the normal shipped shape here, and a pass whose refusals cannot be judged
  against one prepared context is not a candidate at all. That passage —
  `grep -n "THE UNIT OF THAT DECISION" docs/level-tower.md` — is this bullet's scope statement.
- Add a **new op / representation** only when a capability genuinely cannot be expressed in the
  current one _and_ the differ can prove the result matches. Constant-offset access did not clear
  that bar; variable indexing did. If the corpus stays leaf/arithmetic-heavy, the tower may never
  need to grow further — and that is a right-sized outcome, not a failure.
- Prefer **legalization over a new IR op** when the thing you are recognizing is a machine
  addressing/idiom shape; prefer a **new op** when downstream stages need to reason about the
  recovered concept as a first-class value.

### A case where the two halves of the bar were cleared a round apart: `undef`

`undef` (an uninitialised local, read on a path where nothing this function did wrote it) is the
only op that appears in emitted C without a byte match behind it, so it is worth being explicit
about how each half of the bar was cleared. (`opaque` also has none and never will, but it is the
loud-gap escape hatch — it exists to stop a function compiling, not to be recovered code.) "Nobody
wrote it" is established differently per coordinate, and neither is "this function owns the
storage": a FRAME SLOT needs its function to be the SOLE WRITER — ownership is not enough, because
an escaped address lets a callee write a frame the function owns, and the two came apart in review —
while a REGISTER needs no proof at all, only ENTITLEMENT: a caller cannot have handed a value over
in one the ABI does not pass arguments in.

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

It cleared "the differ can prove the result matches" a round LATER, and the distance between the two
is the part worth keeping. On the day the opcode landed, **exactly one row moved** across the whole
corpus — `synthetic:uninit_spill:agbcc`, `declined → nonmatch` — and this section concluded that half
the bar was unmet. What that measured was one coordinate: a frame SLOT. The same question in the
other one — the local the compiler put in a REGISTER — was written off here as a separate capability
"that cannot be classified without either prototype knowledge or prologue-save elision". Half of
that was wrong and half of it was right, and the round took two goes to find out which. Prototype
knowledge, no: a caller cannot hand a value over in a register the ABI does not pass arguments in,
so a def-less read of one owes no proof that nobody wrote it — which is exactly the mechanism
behind the `unaff_<reg>` this section already cited, and it is one list per target
(`target.nonArgRegs`). The prologue save, yes: that ABI fact describes the CALLER, and what makes a
def-less read a LOCAL is that the compiler was free to home one there, which it is only after
saving the register. So the classification is an intersection — the target's list against a save set
the frontend measures (`frontend/ssa.ts`'s `LiveInModel.uninitRegs`, fed by Thumb's `savedRegs` and
the `prologueSavedRegs` of PPC and MIPS; `registerLiveIns` composes it for all three, with the target's
`scratchRegs`, which need no save, less the `hiddenInputRegs` a runtime passes a value in, whose
entry value may reach the body only through a join) —
and it is not the elision the sentence feared, only a read of the prologue that was already
happening for the frame. The function's OWN declaration moves the same partition's edge: an argument
register at or past the words it fills (`proto.ts` `ownArgumentWords`, an upper bound that abstains
on anything it cannot bound) is one no caller fills, so `registerLiveIns` moves it to the
uninitialised side — KMC's `a2` past `uninit_spill(int, int *)`, agbcc's `r3`, mwcc 2.3.3's
`r5`..`r10`. The words a typed list may be handed ahead of its parameters count too: a struct's
hidden return pointer wherever the return is not shown to be a scalar, and a C++ method's `this`;
a bare count is the argument registers, read as a call reads it. A
stated declaration (`--proto`, a row's `proto`) or a mangled symbol's parameter codes bounds the
edge HARD, and an incoming stack argument past it refuses, since no local lives in the caller's
frame. The context's entry for the function itself bounds it SOFTLY, and only where it is a typed
list (`proto-context.ts` `ownContextEntry`, `pipeline.ts` `liftWithinContextBound`): the entry of a
function still `INCLUDE_ASM` was never checked against a definition, and one too short — sbk2's
`void f(void);` task callbacks, 407 of 525 short when their functions were decompiled — would turn
a real argument into `uninit_<reg>`. So a dropped register the finished lift still reads (an
`undef` of it, or of a join that absorbed it, that `dce` keeps, or one IDO -g3 homes to a slot
nothing reads) is lifted again as the parameter a
context-less lift makes it, with an `[own-arity]` note naming the declaration and the register; one
nothing reads is no parameter (sa3's `void Task_802F698(void)` lifted with four), and a lift that
refuses within the bound is lifted without it, with a note. The bench hands each row its own
context entry the same way (`withOwnContextMark`). Nor is
any declaration read for a hand-written body (PowerPC: one naming a callee-saved register it never
saved), whose declared type is no register interface.

With both coordinates spelled — and with the structurer no longer emitting an edge copy for an
argument that carries nothing — the differ agrees. Five rows move, `synthetic:loopfall:agbcc`
MATCHes (11 → 0), and the corpus goes 441 → 442 over 856 rows with nothing lost and nothing worse;
on the ranked real row `LoadBGTilemapData` the winner goes **473 → 419**. SIX rows that used to
match with an arity the source never had — the fabricated parameter landing in the register the
local occupied anyway — no longer need the coincidence, and all six now carry the arity their
reference does: `synthetic:armhomes` 5 → 4, `hipress` 3 → 2, `maskhome` 7 → 4, `nestinit` 5 → 4,
`sizehome` 4 → 3, and `kleod:UpdateHUDCounterDisplay` 2 → 0 against a reference that really is
`(void)`.

The lesson is not "measure again later". It is that the first measurement was taken against
asmlift's own output, where a fabricated parameter is cheap because everything downstream of it is
already wrong. What moved the number was pricing the same construct against a near-perfect
reference decomp of the same game, where it costs an order of magnitude more. A differ verdict is
only as strong as the baseline it is measured from.

Which cuts the other way too, and `LoadBGTilemapData` is where. Priced against the reference C the
construct is worth **354**; on this row it is worth **54**, and the difference is not a
disappointment but the same sentence read backwards. That reference decomp does not match this
function either: its C is `NONMATCH("asm/nonmatching/sub_0804B4B0.inc", …)` at a recorded 98.24%,
its build links the assembly instead, and its ROM is byte-identical to the base ROM only because it
does. LBG is the one function in a 4 MB decomp that is still open — so it is the last place a
capability's value can be read off, and the 419 that remains is the allocation and ordering residue
attributed long before this round, not one gap behind anything.

The envelope is narrow, and has one sentence per coordinate. In the FRAME: **on Thumb, a word-wide
slot strictly below the measured local area, which some store reaches but not on every path, in a
function where no frame address escapes to something that could write the frame.** The last clause
is a second function-wide condition, established after the fact by the frame-object audit rather
than at the mint site — an escaped address usually means a callee may write any frame offset, so "no
store of ours reaches it" stops implying "nobody wrote it". The qualifier on it is earned below. In
the REGISTER FILE: **any key the target lists as one its ABI does not pass arguments in, read on a
path that never wrote it, in a function whose prologue SAVED it.** The second clause is not about
who could have written the register — a register has no address, so nothing outside the function can
name it and there is nothing to retract — but about whether the answer's premise holds at all: the
compiler homes a local in a callee-saved register only after saving it, and asm that saves nothing
follows no such rule.

The second clause was not there when the register half landed, and the population that needed it is
small enough to name. Sweeping every Thumb function in the three vendored agbcc projects — klonoa,
sa3 and pokeemerald, **2962** functions; `af` is N64/MIPS, swept on its own below
— the ABI list on its own renders a register undef in 9 functions (13 (function, register) pairs),
and **3** of them are outside the model: the MP2K engine's hand-written `ChnVolSetAsm`, vendored
identically in all three, which receives two pointers in `r4`/`r5` with **no prologue at all** and
came out as `s32 ChnVolSetAsm(void)` storing through `uninit_r4`. That is a correct signature traded
for a silent wrong one, and the arity metric scored it as an improvement, because 2 → 0 is an arity
decrease.

Guessing which evidence separates the two populations got it wrong twice before the sweep settled
it. "Written somewhere in the function" refuses correct inhabitants: `r5` in sa3's `sub_809630C` and
`r6` in `sub_8024F84` are uninitialised locals the function pushes, reads and pops without ever
writing, and the push/pop pair is elided before the SSA builder sees it, so `writeVar` never fires.
"Not written and not saved" reads as the private-convention case but is not one:
`MP2K_event_xwave` pushes `r4` and read-modify-writes it, an ordinary uninitialised local like the
rest. What is left is the SAVE, alone, and one of the survivors is confirmed against a second decomp
of the same game whose C declares that local uninitialised (`CheckTileCollisionVertical`, `r4`).

Measuring the save costs one scan of the entry block's leading run, in the module that had already
walked that prologue for `localArea` — `mov rLow, rHi; push {rLow}` counts as a save of `rHi`, which
is how agbcc saves r8-sl and how every high-register inhabitant here is saved. Whole effect on the
corpus when it landed: 6 functions, 0 lift↔decline flips. The three `ChnVolSetAsm` got their
two-pointer signature back, and the three `SoundMainBTM` (`mov ip, r4`, no prologue either) went
back to the trailing parameter they had before. Both readings were later found wrong — the registers
they read there are no parameters at all — and the next paragraph says what they are now.

A `push` past that leading run is a save too, where nothing on any path uses the register before
it (`bodySavedRegs`): hand-written asm saves late (`beq .L1; push {r4}; …; pop {r4}`), and a `push`
is nothing but a save. Its `pop` ends the save: past the restore the register is the caller's again,
so a use there, a save whose word is popped into another register or dropped with `add sp`, and a
use ahead of the save on some path all leave a register that is neither a local nor a global, and
it refuses — the prologue's save included. Which `pop` restores is a question about WORDS, not
names: the walk tracks whose entry value each pushed word holds, so `push {r4, r5}; pop {r5}; pop
{r4}` — both names popped, the caller's r4 and r5 swapped — restores neither, and a callee-saved
register a pop fills with another register's word and carries to a return refuses outright (the
fill reads the `pop` as transparent, so no write of the body would show it). Matched by name, that
shape and agbcc's r8/sl staging with its two `mov`s crossed lifted as if restored. The O32 and PowerPC frontends keep the entry-block
reading, because their save is an ordinary store: gcc 2.7.2 passes a global register variable on
the stack as `sw s0,16(sp)`, and mwcc as `stw r14,8(r1)`, in the entry block itself. So there a
store is a save only where some reload of the register from the stack answers it, and never for
a register the function reads as a global register variable; and a save holds only while every
path restores it after its last write (`refuseSavedRegisterLeaks`), the counterpart of the `pop`
that ends a Thumb save: a write past the restore, a reload from another word, or a return the
restore never reaches leaves the caller a value the C never assigns, and refuses. And the register is keyed by its spelling throughout, so a function
that writes one register two ways (`sl` and `r10`, `s8` and `fp`) is read in one of them
(`unifyRegisterSpellings`); saved as one and used as the other, it read as never saved.

A register in the ABI list that the prologue did not save is no argument either: a C caller passes
nothing there, so naming it a parameter puts a value in the signature the caller would hand over in
`r0`-`r3`. Compiled code reaches that shape one way, a FILE-SCOPE GLOBAL REGISTER VARIABLE
(`register int g __asm__("r8");` — gcc's `globalize_reg`, regclass.c:587-611, makes the register
fixed and call-used, so no prologue saves it), and `return g;` / `g = a;` compile to exactly the
unsaved read and write. So the model's third list is that register: where the compiler can declare
one (`globalRegisterVariables` — agbcc r4-r11, gcc 2.7.2 and KMC s0-s8, mwcc 2.4.2/2.4.7 r14-r28 as
a run from r14), every read of it is a load of that global and every write a store, which a call in
between may change like any global's; `ChnVolSetAsm` lifts to `((u8 *)greg_r4)[18]`, byte-exact
against agbcc's own compile of `register u8 *ra __asm__("r4")`. Where it cannot (IDO 7.1, mwcc
2.3.3, PowerPC r29-r31), the read and the write refuse (`unsavedCalleeSavedRegs`).

O32 needs the same clause for the opposite reason. Its scratch set is thirteen registers (`at`,
`v0`/`v1`, `t0`-`t9`) where Thumb's is `ip` alone, so the save is no evidence there, and hand-written
MIPS asm is handed live values in them: af's famicom_emu routines store a `t0` or `v1` they never
wrote, and lifted with the scratch exemption alone they came out storing `uninit_t0`. The evidence
O32 has is a JOIN. A local the compiler homed in a scratch register is assigned on some path, so its
entry value meets that definition as a join's edge argument, and an entry value no such join takes
is an input (`hiddenInputRegs`, the rule mwcc's r11/r12 follow too). Meeting a join is not by
itself meeting a definition: a hand-written routine that carries a count round a loop in `t0` sends
the entry value into the loop header's join, whose back-edge argument is only that count's next
value. So the join must also take a definition the entry value does not feed — directly, or
through an inner join one of whose arguments is one (`for (…) if (c) x = i;`, and a bit reader's
`if (!bits) code = *src++; … code <<= 1;`, whose shift reaches the entry value only through that
inner join). Independence is a least fixpoint grown from nothing, so no join counts as independent on
the strength of its own back edge. Sweeping every
function and label symbol in the vendored snowboardkids2, marioparty3 and af objects, **29,399**,
that refusal fires on 17 and on no compiled function: twelve labels, three hand-written routines
and two data symbols disassembled as code. (famicom_emu's hand-written Yaz0 reader is the
bit-reader shape and lifts.) What it
cannot describe is a local no path assigns at all, which declines; none of the 29,399 is one.

`int x, y; if (c) x = y;` joins two undefined values, and the structurer drops an undefined edge
copy — right for the join's OWN storage, which that path left unassigned, and wrong for another's,
where the machine ran a move. In frame words (ido7.1 copies 0(sp) into 4(sp)) two words are two
locals, so the frontend gives such an edge its own undefined value marked `copied`, which the
structurer spells as `x = uninit_sp0`. Registers carry no such identity — agbcc moves one local from
r8 to a low register, and a spill writes a register's local to a word — so a join whose every
argument is undefined there is collapsed into one uninitialised value before the structurer sees it
(left standing it would lose every assignment to its local, which the structurer's postcondition
reports as read but never assigned). In saved registers (agbcc) that lifts, with the move lost; in
two O32 scratch registers the hidden-input rule above refuses first, since neither entry value meets
a definition.

The reusable lesson is where the decision lives, not the op, and it is easier to state as the two
arrangements that do not work.

**The shared pass cannot decide.** The builder classified a def-less read by the key's
spelling (`sp@…`). That is the "arch check inside a shared pass" this document warns about, one
layer down — it reads as data rather than as a branch on target, which is exactly why it slipped
through. The answer depends on the _frame model_, and the frame model is per-ISA: Thumb bounds a
slot to `off + 4 <= localArea` and keys incoming stack arguments separately, so nothing incoming can
reach a `sp@` key there; MIPS then applied no frame bound at all, and its `sp@` reached O32's
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
`LiveInModel` carries byte ranges — `ownedLocals`, `callerParams` — and one generic rule classifies
an offset against them, refusing anything that falls in neither. The register coordinate joined it
as a second declarative member (`uninitRegs`, a LIST rather than a range, because the complement of
the argument registers also holds the frontends' virtual keys) under the same generic rule. The dependency became an argument
instead of a promise: Thumb passes `{ from: 0, to: localArea }`, so when the prologue walk cannot
measure the frame that range collapses to empty and every slot refuses on its own. MIPS claims only
the words of the one frame it pushed that nothing else can write (`ownedFrame` in
`frontend/mips.ts`: a leaf's whole frame, or what lies past the widest declared call's outgoing
area, and nothing once a frame address is taken), so any other def-less `sp@` read there still
refuses; what reaches the model instead is an
incoming stack word under its own key, `@sarg<k>`, which the frontend places by the frame depth
(`frameDepths`) as Thumb keys its incoming words, for its stores as well as its loads, so nothing
incoming reaches a `sp@` key on MIPS either where the depth is measured (and where it is not, a read
no store reaches refuses). A store is an assignment to that parameter, as IDO makes one when it
writes an assigned stack parameter back in place: a read that store does not reach is still the
caller's word, and Braun's merge joins the two.

The same split has a second instance on this very capability. The envelope's last clause was first
written as plain "no frame address escapes", and the first inhabitant to reach it was a klonoa DMA
fill where the address goes to a transfer's SOURCE register: the device reads the object, and the
register is write-only, so nobody can read the address back out and turn it into a destination. The
premise the guard _stated_ was false there. The fix was to ask the question the premise names — can
anything write? — rather than the one that was easy to compute, and the addresses are target data
(`capabilities.readOnlyAddressSinks`) so no shared pass learns a platform. A store through a
register's literal address plus a runtime index — a channel chosen at run time — hands the address
to every one of those registers the index's stride reaches, when that stride is a multiple of
their spacing, so no index lands on a destination register between them. The accepting half is
pinned as `synthetic:dma_fill_uninit:agbcc`. The sibling rule refusing a SECOND address-taken
object keys on what the escape may REACH rather than on whether it writes, because its argument is
about frame LAYOUT: a device reading past the object it was given is as wrong as a callee writing
past it. How far a device reads is target data too (`capabilities.readSourceControl`, the channel's
control halfword), read per transfer, and an unresolved store after the transfer is handed the
address — through a pointer, or to a name no symbol map places — leaves the read unbounded. What
no fact about one function can check is stated as a premise instead: a callee or an interrupt
handler arms only a transfer it set up itself, source register first, so neither a call on the
path nor an interrupt at any instruction re-arms this frame's transfer. Where the reach is still
unbounded — a device's read or a callee's write — and every writer of the frame is one the
whole-area argument holds (none at all, or a callee handed the address as an argument that may
write through it, which a block transfer reading its source is not, with any store of the address
beside that call), the audit does not refuse: it answers with the local area, the frontend lifts
once more with every word of it routed through `laddr`, and the second audit declares those bytes
one `u8` array in memory, so every store the machine made there is a store the recompile makes.
The asm cannot tell a member the device reads from a spill nobody reads, and keeping both in
memory is right for both. Every member
is spelled through a cast, whose pointee would drop a qualifier on the array, so the array carries
none, and where the address was stored somewhere a writer may hold it — a global an interrupt
reads, a device's destination — each access carries the qualifier itself, whether it reaches the
object through a member, a runtime index or a phi that carries one (`p = c ? buf : gOther`): a
spin on a byte that holder sets is otherwise compiled to a loop that never reads it again. An
object kept object by object qualifies its declaration, which a phi's pointer local does not
inherit, so an access through such a phi carries the qualifier too. The transfer
has to run too, so the device pin ([`frontend/device-pins.ts`](../packages/core/src/frontend/device-pins.ts),
applied by the frontend from the policy the audit answers) makes every device access of a function
kept this way `volatile` — at a register's literal address, that address plus a runtime index, a
pointer stepped from one by a constant, or a phi of those: agbcc deletes a plain store to an address
a later store overwrites, so of two transfers armed back to back through one channel the first
would never start, and it hoists a plain load out of a loop that stores nothing it may alias, so a
poll of `REG_VCOUNT` would never see the register change. A function accepted object by object
pins every device read, and of its stores only the first kind, a device store a later store in its
own block overwrites; its other device stores are left to the `/vol-store` candidate, because a
qualified base in the structured tree refuses the variations that home it. The two policies are two
rows of one table, `DEVICE_PIN_POLICIES`. Under either, a narrow read the machine sign-extended in
the load (`ldrsh`, `ldrsb`) stays plain: agbcc loads a `volatile` narrow read zero-extended and
shifts it, so such a read was plain in the source (`volatileReadsExtendInRegister`).

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
