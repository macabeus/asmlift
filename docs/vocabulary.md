# Vocabulary

The words asmlift uses for candidate enumeration. Each word below has one meaning. Where a word
also has an ordinary meaning elsewhere in this repository, the last section says which sense is
the dominant one.

## The seven words a reader needs

| Word             | Meaning                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **candidate**    | One complete C source asmlift emits for a function. Each is compiled and scored against the target object.                                                                             |
| **fan**          | Every candidate asmlift enumerated for one function, whether it built or not. `pnpm bench fan <row>` lists it.                                                                         |
| **winner**       | The best-scoring candidate among those that may be published. Its source is the function's result. `pnpm bench fan <row> --show winner` prints it.                                     |
| **variation**    | One way asmlift can write a function differently, e.g. `defsite`, `unmerge`, `raw-globals`. Signedness (`unsigned` / `signed`) is a variation too.                                     |
| **dropped**      | A candidate the scorer refused: its source did not build.                                                                                                                              |
| **withheld**     | A candidate that compiled and scored, but was refused publication for want of a byte-exact proof.                                                                                      |
| **not compiled** | A candidate never handed to the scorer: its fan was stillborn — the default candidate and one probe per variation were all rejected for the same reason, so the rest was not compiled. |

A fan is **stillborn** when no variation can reach what refuses it: the default candidate fails
to build, and so does the smallest candidate carrying each variation, every one with the same
compiler errors. The rule, and the case it does not close, are in
`packages/core/src/stillborn.ts`.

A candidate's name is its **variations**: the ordered list of variations it applied, e.g.
`["unsigned", "defsite", "raw-globals"]`. Every command prints that list joined with `/`, as
`unsigned/defsite/raw-globals`, and `pnpm bench fan <row> --show` takes it back in that form.

In prose and comments a variation is often written with a leading `/`, the way it follows another
entry in a printed name: `` `/unmerge` `` is the variation `unmerge`.

**Say which "variations" you mean.** The word names either the variations asmlift has, or the ones
a single candidate applied. Write "the winner's variations" or "the variation `unmerge`" wherever a
bare "the variations" could be read both ways.

## A candidate's name

- The first entry is its signedness, `unsigned` or `signed`, because both are tried.
- Each later entry names exactly one variation, in the order of the kinds below.
- No entry is empty or holds a `/`, so the `/` join names exactly one list: `joinVariations` and
  `splitVariations` ([`packages/core/src/variation-tokens.ts`](../packages/core/src/variation-tokens.ts))
  throw rather than join or split anything else. Where a name is hashed or used as a key, it is the
  join that is hashed.
- A few variations name what they were applied to after a `-`: `coalesce-v0-v1` merges `v0` into
  `v1`, and `volatile-p1` qualifies `p1`. That trailing part is the variation's **subject**. In a
  variation that takes no subject, a `-` is part of the name (`livebase-block`, `vol-slot`,
  `orderbase-scoped`).
- A variation that places something is named by the hoist it is: `orderbase` and `orderbase-scoped`
  are one eligibility rule at two placements, each its own hoist. `basefold/sinkinit` is also one
  hoist, `basefold`'s rule at first-use placement, but it is named as two variations: its result is
  the one `sinkinit` makes when applied to `basefold`'s output, and `sinkinit` is a variation of its
  own.
- `sense-N` is a registered structure variation that is enumerated only when a caller sets
  `perSiteSenseBits` (the CLI reads it from `ASMLIFT_PERSITE_SENSE`), to measure the per-site branch
  sense; no default fan carries it.
- Every variation, with its kind and its subject pattern, is registered in `VARIATION_TOKENS`
  ([`packages/core/src/variation-tokens.ts`](../packages/core/src/variation-tokens.ts)). A test asks
  whether a candidate carries one through `hasVariation` or `hasVariations`, both of which throw on a
  name the registry does not hold.
- Every registered variation has one reader definition in `VARIATION_DEFINITIONS`
  ([`packages/core/src/variation-definitions.ts`](../packages/core/src/variation-definitions.ts)),
  keyed by the registry's names: what it changes in the C, a before/after pair, and what its subject
  means. The seven words and the kinds below are data there too, and a test holds these tables to it.
- When several combinations of variations produce the same source, only the first combination's
  variations are kept. **A candidate's variations name what was applied, not every route to its
  source, and not a route a deletion must remove.** Price a variation by ablating it, never by
  counting the winners that carry it.

## Variation kinds

A candidate's variations appear in this order.

| Kind           | What it changes                                                                                                                                                                                            | Examples                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Signedness** | Whether the function's parameters are read as signed or unsigned. Every candidate carries one, as its first variation.                                                                                     | `unsigned`, `signed`                                                |
| **Lift**       | How the instructions are read before any C is built: which moves set up a call, how a chain of tests joins, whether paths share a return.                                                                  | `setup-args`, `connective`, `shared-ret`, `shared-tail`             |
| **Structure**  | How the checked control flow becomes C: which way a test reads, where a loop starts, what reaches a merge (the point where two paths meet), where a value is kept, and how a read or a compare is spelled. | `flip-branch`, `defsite`, `loop-entry`, `reread-globals`, `uns-cmp` |
| **Respell**    | A rewrite of the finished C that keeps what it does: where a value lives, whether an address is held in a pointer, how statements are ordered.                                                             | `unmerge`, `offmember`, `livebase`, `coalesce-v0-v1`, `volatile`    |
| **Symbol map** | Globals are written as raw addresses instead of the names the project's symbol map gives them. Always the last variation.                                                                                  | `raw-globals`                                                       |

For a reader, what happened to one variation on one function is one of two states: it **carried N
candidates**, or it **threw**. N can be 0: the variation did not apply, or an earlier combination
already produced every source it made. A variation that threw prints an `asmlift: [threw] …` line from
`pnpm bench fan` and `pnpm asmlift --score-against`.

## Fields of the benchmark artifact

| Field                                                                               | Meaning                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asmlift.winnerVariations`                                                          | The winner's variations, a list, e.g. `["unsigned", "defsite"]`. Present on every row that has a winner.                                                                          |
| `asmlift.fanSize`                                                                   | How many candidates the row's fan holds: scored, dropped, withheld and not compiled. Present on every ranked row.                                                                 |
| `asmlift.fanNotCompiled`                                                            | How many of `fanSize` were never compiled, on a row whose fan was stillborn. Absent on every other row.                                                                           |
| `asmlift.fanVariations`                                                             | Every variation the fan carried, by registered name, with how many candidates carry it and how many of those were dropped, withheld or not compiled. Present on every ranked row. |
| `asmlift.droppedCandidates[].variations`, `asmlift.withheldCandidates[].variations` | Each refused candidate's variations, a list.                                                                                                                                      |

## Words the enumeration code uses

| Word                            | Meaning                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **default**                     | No variation of that kind is applied. It adds no part to a candidate's name.                                                                                                                                                                             |
| **alternative**                 | A variation applied in place of the default.                                                                                                                                                                                                             |
| **setting**                     | The variations one lift or one `structure()` call is given.                                                                                                                                                                                              |
| **compiler behavior**           | A question answered once per target by a `compilerBehaviors` field (`packages/core/src/target.ts`), never enumerated. It is right where the assembly determines the source; a variation is right where it does not ([`level-tower.md`](level-tower.md)). |
| **tree source**                 | A source emitted from one structured tree before the lift, structure and symbol-map parts of its name are attached. Never compiled or scored, so not a candidate.                                                                                        |
| **respell set**                 | Every respell variation, run over one structured tree.                                                                                                                                                                                                   |
| **stacked variation**           | A statement-order respell variation applied on top of every other respell variation's output, each alone and all together.                                                                                                                               |
| **pre-respell variation**       | A tree rewrite applied before the respell set, which then runs on its output (`unmerge`).                                                                                                                                                                |
| **composition**                 | A variation applied to another variation's output rather than to the structured tree; the candidate's name lists both. `composeRespellVariations` builds one. The stacked variations, the pre-respell variations and the pairings are compositions.      |
| **pairing**                     | A composition of two or three respell variations, enumerated only because a row demanded the joint spelling.                                                                                                                                             |
| **multi-result variation**      | A respell variation whose single application has several results, each its own candidate, told apart by subject (`coalesce`, `volatile`, `regcopy`).                                                                                                     |
| **subject**                     | The trailing `-…` part of a variation that takes one.                                                                                                                                                                                                    |
| **hoist**                       | One entry of a base-hoist roster: which bases it binds, at which placement, and whether it joins the pairings.                                                                                                                                           |
| **shared gate / per-lift gate** | A structure variation's enumeration gate, asked once on the shared lift, or again on each lift's own raised function.                                                                                                                                    |
| **shared lift**                 | The one lift and type recovery run with no signedness pin, which learns the parameter kinds and answers the shared gates.                                                                                                                                |
| **preference**                  | Which symbol-map setting a candidate carries. The lower one wins a score tie.                                                                                                                                                                            |
| **route**                       | A derivation path that reaches a source. The first route to a source keeps its variations.                                                                                                                                                               |
| **admission**                   | The row or measurement that justifies enumerating a variation, a hoist or a pairing. An admitted variation is one the enumeration runs.                                                                                                                  |
| **enumeration order**           | The order candidates are enumerated in. `compareScored` breaks a score tie by it last, so moving where a variation is enumerated can change a published winner.                                                                                          |
| **fan hashes**                  | `bench sweep --fan`'s three digests of a fan, each in enumeration order: `fanHash` over each candidate's variations and source, `fanSourceHash` over the sources alone, `fanNamesHash` over the names alone.                                             |
| **map mode**                    | One of the two ways `bench sweep` lifts a row: `harness`, as the row is configured, or `nomap`, the same without its symbol map. `--map-modes` selects them.                                                                                             |
| **shards**                      | A tier's run spread across worker processes.                                                                                                                                                                                                             |

## Compiler flags

| Word                | Meaning                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **profile**         | What one flag set makes the compiler do, parsed by `parseFlags` (`packages/core/src/codegen-flags.ts`): the value of each slot, the build's own words for it, and the unclassified words. Every profile of a toolchain decompiles against that toolchain's compiler behaviors. |
| **slot**            | One option of the compiler, holding the value the compiler acts on: `O` holds `1` for agbcc's `-O2 -O1`, and for IDO's `-O2 -g`.                                                                                                                                               |
| **canonical flags** | The codegen flags a toolchain's committed probes were compiled with (`TOOLCHAIN_TARGETS[id].canonicalFlags`), and the flags a synthetic row compiles at unless that row spells its own (`SynthSpec.cflags`).                                                                   |
| **unclassified**    | A codegen word no flag table names. The compiler still receives it, and it is never assumed inert.                                                                                                                                                                             |
| **inert**           | A word that cannot change what the compiler emits for a preprocessed translation unit: an include path, a define, a diagnostic. A flag set in normal form (`storedFlags`) leaves it out.                                                                                       |

A flag is never **withheld**: that word names a refused candidate.

## Words with more than one sense

| Word         | Dominant sense                                                                                     | Other senses you will meet                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **spelling** | How a piece of C writes something, and so why two sources compile differently.                     | —                                                                                                                                                                              |
| **decline**  | A pass or a row refusing to act rather than emitting something wrong. `declined` is a row outcome. | —                                                                                                                                                                              |
| **gate**     | A predicate deciding whether a rewrite or a variation fires.                                       | A check a round must pass before it merges.                                                                                                                                    |
| **base**     | A base pointer (`livebase`, `BaseKey`).                                                            | A git ref (`--base`).                                                                                                                                                          |
| **arm**      | A branch or `switch` arm of recovered C (`switch-arms`).                                           | The ARM instruction set.                                                                                                                                                       |
| **label**    | An assembly label or a C `goto` target. Never a candidate's name, which is its variations.         | A display label in the webapp or a chart.                                                                                                                                      |
| **token**    | In code, a variation's registered spelling (`VARIATION_TOKENS`).                                   | Lexer, cache and objdiff tokens.                                                                                                                                               |
| **hoist**    | One entry of a base-hoist roster (above).                                                          | The L3 act of moving a local's declaration or init upward (`l3/hoist.ts`, `hoistBaseLocals`); a compiler moving code out of a branch (`compilerBehaviors.hoistsSingleSetArm`). |
