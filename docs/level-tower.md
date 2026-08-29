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
    tree (e.g. `/argbase`, `/scopebase`, `/indexed`, `/livebase`, `/volatile`, `/vol-store`,
    `/unreduce`, `/ptr-field`, `/mulfirst`, `/regcopy`, `/coalesce`) and STRUCTURING axes, which re-run `structure()` under a different
    lever (e.g. `/flip-branch`, `/defsite`, `/inplace`, `/no-bitfield`, `/reread-globals`,
    `/merge-names`, `/fresh-merge`) — plus `/raw-globals`, the signedness pin, `/setup-args` and
    `/connective`, which re-run the lift itself.
    The roster is illustrative; `rank.ts` is the source of truth.
    Each emits an _alternative candidate_ rather than replacing the primary, and the differ
    referees — the
    [ranked-candidate idea](asmlift-101.md#26-types-as-ranked-candidates-judged-by-the-differ)
    applied to spelling instead of types.

  A third population sits underneath both: **per-compiler defaults**, declared as data in
  `TargetDescription.compilerBehaviors` ([`target.ts`](../packages/core/src/target.ts)) and spread
  onto `StructureOptions` by `structureOptionsFor`, so a compiler fact is one field rather than an
  `arch ==` branch. The line between one of these and a ranked axis is not how confident the author
  feels — it is whether the ASM UNDERDETERMINES THE SOURCE. An axis is right when some pass
  genuinely collapses two source spellings onto one output, so nothing but the differ can tell them
  apart (`/uns-cmp`: a signed compare emits the unsigned branch only once the compiler has PROVED
  the operand non-negative, and emission's provable set is smaller than the compiler's). A default
  is right when the mapping is a function — `readsStayWhereWritten` says a compiler with neither an
  instruction scheduler nor a code hoister emits a memory read in the block the source spelled it
  in, so re-spelling a read at the block the asm performed it in reproduces that asm, while the sunk
  per-arm spelling is one this compiler emits only for a source that read per arm. Note which way
  that claim runs: it is emission-from-spelling, not spelling-from-emission. The converse would be
  false even here (agbcc's PRE does move a load into a block the source never read in), and a
  default read backwards is how a compiler fact turns into a wrong answer — so a per-compiler
  default owes an explicit refusal for every pass that moves the thing it is placing, and for every
  IR boundary the frontend invents where the machine had none (a block starts at every label, so a
  label nothing branches to makes one straight line of asm look like a dominating pair of blocks).
  Getting the population backwards is expensive in both directions: an axis where a default belongs
  doubles every enumeration to referee a question with one answer, and a default where an axis
  belongs quietly degrades every function the differ would have rescued.

  A **third fork sits inside the ranked population**, and the underdetermination criterion does not
  decide it: a question the asm underdetermines can be answered by RE-RUNNING `structure()` under a
  different lever (a structuring axis) or by RE-SPELLING the tree `structure()` already produced.
  Both are ranked, both are refereed by the differ, so the deciding terms are COST and REACH. An
  axis doubles the enumeration wherever it CHANGES THE TREE, and costs one more `structure()` call
  and nothing else wherever it does not — `rank.ts` fans a structured tree once and skips a tree an
  earlier axis point already spelled, so an inert axis pays no re-spellings and no compiles. What is
  expensive is therefore an axis that fires broadly, and a ranked run is already minutes:
  `/inlinebase` inverts `structure/analysis.ts`'s const value-home decision — the same question
  `/reread-globals`, `/addr-home`, `/expr-home` and `/derived-home` each answer as a
  `STRUCTURING_AXES` entry — and answering it by substitution instead costs **766 extra candidates
  over 47058, +1.6%**, on the 33 of 69 klonoa functions that lift with no symbol map, where an axis
  over the same population would have doubled every candidate on each of those 33. What a
  substitution pays for that is REACH: it can only rewrite the use shapes it can reach
  (`/inlinebase` re-spells `index` bases, so a home passed to a callee or standing as a `field` base
  is out of its grasp), where the axis would never have created the local at all. So re-spell while
  the shapes the substitution cannot reach have no row demanding them, take the axis when one
  appears — and name the fork in the lever's header, because otherwise the gap left behind reads as
  an oversight rather than as the price of the mechanism.

  **Before either, ask whether the DEFAULT can already spell it — and prove the answer by
  compiling.** `/connective` was shipped on the premise that `x == 0 || x == 2` and
  `switch (x) { case 0: case 2: … }` are two spellings of one asm shape that only a differ can
  choose between, and the row it was built for turned out to want neither: what was missing was a
  ten-line grouping in the structurer, which took
  `kleod:ProcessInputAndUpdateEntities:agbcc` from 367 to 306 with the axis ON and to 306 with it
  OFF — same breakdown, half the wall clock.

  The rule that follows is cheap: **an underdetermination claim about two source spellings is a
  COMPILER claim, so compile both and diff the objects before building anything.** A score table
  cannot make it for you — the cheaper spelling was never in the fan to lose. And the compile has a
  second half, which two attempts here got wrong in the same way: **compile the shape you are
  generalizing over, not the first shape that fits in a test file, and record the flags.** The
  measurements, all at `TOOLCHAIN.agbccFlags` and `IDO_TOOLCHAIN.ccFlags`:

  | shape                            | grouped vs `\|\|`                                                        | duplicated body vs grouped                                                                                                                                 |
  | -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | agbcc, 1 case group + `default:` | 12 insns each, **one object**                                            | agbcc MERGES the copies                                                                                                                                    |
  | agbcc, 2 groups                  | 20 vs 16 — **different** (balanced `bgt` dispatch vs a sequential chain) | merged block keeps the LAST copy's position, so it equals the grouped arm placed THERE (md5 555abb1a) and not the one placed at the first value (fe4d7d35) |
  | agbcc, 3 groups                  | 24 vs 20 — **different**                                                 | —                                                                                                                                                          |
  | IDO, 1 group + `default:`        | 64 bytes each, **one object**                                            | IDO does **not** merge: 224 bytes against 144                                                                                                              |
  | IDO, 2 groups                    | 80 bytes each, **different bytes**                                       | the two placements also differ (689f34ec vs ec39af99)                                                                                                      |

  So the identity is a property of the DEGENERATE shape, on both compilers, and the axis is a real
  second spelling on every recovered multi-group switch. What makes the grouping right is an
  argument about the ROM rather than about which source is prettier: under agbcc the duplicated
  source is unreachable as a ROM shape, and under IDO it is a different ROM, so a shared block means
  stacked labels on either compiler.

  **And 2× is a LOWER bound, not the price.** A new axis doubles its own admitting rows, and it
  also UN-COLLAPSES sibling axes that `seenTrees` was deduping away on the base tree: a sibling
  whose re-spelling was inert on the old tree can be distinct on the new one, and then it enumerates
  where it did not before. So the real multiplier is 2 × (siblings the new tree makes non-inert),
  and it is measured, never assumed. `/fresh-merge` (structure.ts `freshParamMerge`, the parameter's
  merge home) is the counterexample that fixes this: `synthetic:max3:agbcc` goes **2 candidates to
  10, ×5** — `signed/flip-join` and `signed/merge-names` do not appear at all on the base tree, both
  deduped as identical to `signed`, while `signed/flip-join/fresh-merge` and
  `signed/merge-names/fresh-merge` are distinct spellings. Over the 39 map-less corpus rows the axis
  admits, distinct sources go 5449 → 10028 (mean ×1.84, histogram {×1.5:1, ×1.8:1, ×2:12, ×2.33:2,
  ×3:17, ×4:1, ×4.5:1, ×5:4}); below 2× where the new tree instead makes a sibling inert, above it
  where it wakes one. Priced in the unit that costs compiles — surviving candidates over every row's
  own `targetAsm`, map-less — `/fresh-merge` is **+4579 over an axis-free fan of 18106, +25.3%**,
  and **94% of that is two klonoa functions**: `kleod:ProcessInputAndUpdateEntities:agbcc` 4800 →
  8640 and `kleod:ConfigureEntityBehavior:agbcc` 480 → 960. Quote the concentration, not just the
  total: a row count ("105 rows pay ×2") understates the dominant row by two orders of magnitude,
  because rows are not the unit that compiles.

  **And an axis can widen a gate it never mentions — price that too.** The un-collapse above is an
  ENUMERATION cost; the same tree change can also satisfy an existing rule's precondition and admit
  where that rule used to refuse. `anchorConstCopies` declines a merge whose variable names another
  SSA value, so a merge that adopted its parameter is never anchored — and `/fresh-merge`, which
  mints a home for exactly those merges, makes them sole claimants by construction: sole-claimant
  admissions go **196 → 245** over 679 corpus rows, 34 rows gaining 49 merges, and
  `synthetic:clampu8:mwcc_242_81` reaches MATCH through the pair (`signed/defsite` is inert on the
  base tree and absent from its fan). So a new axis is priced over its own refusals AND over the
  refusals it removes elsewhere; the second is the one nothing reports, because the widened gate
  does not know it was widened.

  **An axis's 2× is intrinsic, and cannot be bought back by predicting which half is redundant.**
  The signedness pin is the worked example, because it is the axis that fires most broadly:
  `LoadBGTilemapData`'s 40320 candidates are 20160 twin pairs, every one of which ties in score. The
  fan grows with every axis admitted, so quote your own `[ranked]` line. The recurring proposal is to drop the
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
  [`test/sign-axis.test.ts`](../packages/core/test/sign-axis.test.ts). What IS removable is removed
  by OBSERVATION rather than prediction, and belongs in the scorer, not the enumerator: identical
  candidate objects have one score by definition, which is where
  [`cli/src/objdiff.ts`](../packages/cli/src/objdiff.ts) collects the 20880 repeats.

  **A PARAMETER'S POINTEE is refused one step earlier than that: the fact has no reader at all.**
  The recurring proposal is to carry a struct pointee on `SymbolTypeFacts` so a project's DWARF
  `Sprite *` argument stops arriving at `proto.ts` `typeSpelling` and leaving it as `void *`. But a
  declared parameter type is consulted for exactly two things, and neither asks what a `*` points
  at: `declaredWidth` answers **32 for every pointer**, and its ONE call site
  (`raise/paramwidth.ts`) reads only the function's OWN list; a callee's list is read by
  `protoArity` for its LENGTH. So the thread would add a fact nothing consumes — the signedness
  twin's shape, one level down. Nor is the capability missing: asmlift already recovers a
  parameter's pointee FROM THE ASM, synthesizing `struct Struct0 *` and spelling `a1->field_6`
  off the access widths alone, and what DWARF would add is field NAMES — which `declare.ts`'s
  pointer arm already states cannot move bytes, because the cell is 4 bytes whatever it addresses
  and every stride is explicit.

  The reach bounds it twice more. `asIfUndecompiled` redacts the row's own signature BY DESIGN
  (a compiler emits one only for a function it compiled), so the transferable half is the
  CALLEES — and of 252 real rows, 109 call anything, 25 call something whose vendored signature
  is present, and **10 call one with a pointer parameter**; 6 of those already MATCH, 1 is a
  noncompile, and the 3 open ones are byte-identical under every pointee spelling fed to them, in
  both symbol-map configurations. Only two of the six projects vendor function signatures at all
  (pokeemerald 15678, kleod 210; af, marioparty3, sa3 and snowboardkids2 vendor zero), and **no
  signature parameter in any of the six carries a pointee**, because `@gba-kit/debug-info`'s
  `TypeFacts` is `{size, signed, pointer?}` — the absence is upstream's, so the round's first
  commit is an upstream release and a re-vendor before any threading. Pinned in
  [`test/param-pointee-axis.test.ts`](../packages/core/test/param-pointee-axis.test.ts).

  THE NEXT STEP THIS MEASUREMENT NAMES IS NOT THIS AXIS. There is one shape where a pointee is
  byte-load-bearing — a whole-struct assignment, `*dst = *src` through two `struct S *`, which
  agbcc emits as one `ldmia`/`stmia` pair while asmlift lifts it to three word copies and scores
  **7** against the real object, identically under `void *` and `struct S *`. It needs a SIZED
  struct type, which asmlift already synthesizes from the access pattern, not a declared pointee;
  and it has **0 inhabitants in the real tier** — no row's `targetAsm` carries the pair. Build it
  as a synthetic row before anyone prices it.

  Which population a pass belongs to decides how much its opinions cost. Several passes answer
  "is this address a local?", and what separates them is PLACEMENT: never (`raise/gvn.ts`), a
  position in the top-level statement list — the function top, the minted inits above a run already
  there, or each init at its first use (`l3/basecse.ts`, `l3/nearbase.ts`, `l3/sinkinit.ts`) — the
  innermost enclosing scope (`l3/scopebase.ts`), immediately before the call (`l3/argbase.ts`).
  `l3/scopebase.ts` also answers a SECOND question the others do not have, and it is a different
  axis from placement: HOW MANY locals one address gets. Its `REGION_RULES` carry both readings —
  `'whole'` gives a key one local (`/scopebase`), `'per-region'` one per disjoint region
  (`/regionbase`) — and the count, not the declaration scope, is what agbcc discriminates on
  ([`decl-scope-axis.test.ts`](../packages/cli/test/matching/decl-scope-axis.test.ts) compiles both
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
  the rebuild. `head` and `first-use` are two positions for a run this file has already ordered —
  that is `HoistPlacement`, the only thing `l3/basecse.ts` accepts and the only thing a roster
  admission may state, so a row in `rank.ts` says WHERE its locals go beside WHICH bases it binds.
  `l3/nearbase.ts`'s `prepend` is not a third position: it returns before the query and the sort,
  so it is `[...minted, ...body]` and shares the rebuild only. It is a separate type and not a
  third value of one — handing it to `hoistBaseLocals` spells a minted base's pool load above the
  base the compiler loads first, the exact hazard that file's own header forbids, so the boundary
  has to be something a caller cannot spell rather than something a comment asks it not to.

  Placement being an ARGUMENT is worth stating carefully, because two things about it are easy to
  overclaim. It is not what a single row needed, and it is not what made one reachable:
  `sinkInitsToFirstUse(hoistBaseLocals(sfn, g, 'head'))` and `hoistBaseLocals(sfn, g, 'first-use')`
  emit the same C on `sa3:sub_803213C`'s own tree and on all 105 (observation, gate table) pairs
  where any base binds over the artifact's agbcc rows in both symbol-map configurations — 74 of
  them with something actually moving. That is a lemma about the two SPELLINGS and nothing more.
  It does not say the row was already reachable: the `/sinkinit` pairing loop fans only over rows
  carrying `pairings`, which is `/livebase` and `/livebase-block`, and neither admits this row's
  base — run `origin/main`'s core on `test/corpus/agbcc-tailmerge.s` and every gate table admits
  `[]`, the standalone lever declines, and 0 of 12 candidates carry a `/sinkinit` or `/basefold`
  label. What made the row reachable is the SYMBOL half of `unfoldedOffset`; reaching it then cost
  a roster line, spelled as a placement argument here and spellable as `pairings: true` instead.
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
  about the passes: a lever that emits one tree referees nothing, and its ordering then decides a
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
  isolate. So the roster offers both and the differ referees. The SUNK row is bracketed (delete it
  and both those rows drop to diff:2); the HEAD row is not bracketed by anything in this corpus.
  `synthetic:basecell` looks like its bracket and is not — both rows emit the identical source
  there and `seen` collapses the sunk one, so the head row wins that label by being enumerated
  first. Its measured return is 2 points on one nonmatch row, for 1432 of the 2878 candidate
  sources the pair adds; `rank.ts`'s BASEFOLD_ADMISSIONS note carries the ablation.

  A second consolidation is BOOKED and deliberately unpaid: the FOUR home scopes in
  `structure/analysis.ts` (`homeSharedAddresses`, `homeLoopExprs`, `homeDerivedReads`,
  `homeMergeFeeds`) are one `materialize.add(op)` behind shared refusals, differing only in an
  eligibility predicate, and `rank.ts` already holds them as a data table (`STRUCTURING_AXES`) —
  only the consumer side is un-consolidated. What it can NOT absorb is `l3/basecse.ts`, on one
  premise: `coneHoldsAddr` excludes basecse's symbol bases through a refusal `analysis.ts` calls
  the soundness half of its own claim, and all four scopes carry it. The const exclusion is NOT a
  second premise — `homeMergeFeeds` deliberately admits a `const`, because a const two arms of one
  merge carry is a register the compiler reserved across the branch rather than a
  re-materialization. So "one `homeSharedValues(eligibility, placement)`" is two changes, not one:
  the analysis.ts half is available, the basecse half would require deleting a sound refusal.

  The PRICE of that half is gate duplication. `mergeFeedHomes` is the only one of the four already
  a standalone function with an explicit parameter list, so it is the shape the fold would take —
  and the only one whose enumeration gate (`hasMergeFeedHome`) RUNS the scope instead of
  re-implementing it. Its three siblings' gates (`hasHomeableSharedAddress`,
  `hasLoopSharedPureValue`, `hasDerivedReadHome`) each restate their scope's predicate by hand,
  ~200 lines whose safety rests on every copy staying no stricter than the scope it mirrors, with
  nothing checking that and nothing in the harness reporting a candidate that was never
  enumerated.

  `/connective`'s `onTreeOwned` is the SHAPE that blocker wants, one level down: the enumeration
  gate is a callback the pass fires from its own refusal (`raise/shortcircuit.ts`), so there is no
  second copy of the matcher to keep in step and the "no stricter than the scope it mirrors"
  obligation is vacuous — and `PreRecoveryOptions` is the steering channel that makes it reusable,
  one field per pass, the L1 analogue of `AnalyzeOptions`. Absorbing it into `STRUCTURING_AXES`
  still needs one more gate KIND, since what is shipped is a side-effecting report rather than a
  `variantGate` predicate; that step is smaller than the ~200 lines above and is not paid here.

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
corpus rows and moves no score, so what the declaration buys is that the lever never claims
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
the frontend measures (`frontend/ssa.ts`'s `LiveInModel.uninitRegs`, fed by Thumb's `savedRegs`) —
and it is not the elision the sentence feared, only a read of the prologue that was already
happening for the frame.

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
sa3 and pokeemerald, **2962** functions; `af` is N64/MIPS and declares no register partition at all
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
corpus: 6 functions, 0 lift↔decline flips. The three `ChnVolSetAsm` get their signature back; the
three `SoundMainBTM` (`mov ip, r4`, no prologue either) go back to the fabricated trailing parameter
they had before this capability existed, which is an over-count and not a wrong answer.

The gap this leaves is one direction only. A register in the ABI list that the prologue did not save
falls back to being a parameter — the treatment a target declaring no partition gets — so what the
model cannot describe costs an invented argument, never an invented local.

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
`LiveInModel` carries byte ranges — `ownedLocals`, `callerParams` — and one generic rule classifies
an offset against them, refusing anything that falls in neither. The register coordinate joined it
as a second declarative member (`uninitRegs`, a LIST rather than a range, because the complement of
the argument registers also holds the frontends' virtual keys) under the same generic rule. The dependency became an argument
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
