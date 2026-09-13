# Vocabulary

The words asmlift uses for candidate enumeration. Each word below has one meaning. Where a word
also has an ordinary meaning elsewhere in this repository, the last section says which sense is
the dominant one.

## The six words a reader needs

| Word          | Meaning                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **candidate** | One complete C source asmlift emits for a function. Each is compiled and scored against the target object.                                         |
| **fan**       | Every candidate asmlift enumerated for one function, whether it built or not. `pnpm bench fan <row>` lists it.                                     |
| **winner**    | The best-scoring candidate that may be published. Its source is the function's result. `pnpm bench fan <row> --show winner` prints it.             |
| **variation** | One way asmlift can write a function differently, e.g. `defsite`, `unmerge`, `raw-globals`. Signedness (`unsigned` / `signed`) is a variation too. |
| **dropped**   | A candidate the scorer refused: its source did not build.                                                                                          |
| **withheld**  | A candidate that compiled and scored, but was refused publication for want of a byte-exact proof.                                                  |

A candidate's name is its **variations**: the ordered list of variations it applied, e.g.
`["unsigned", "defsite", "raw-globals"]`. Every command prints that list joined with `/`, as
`unsigned/defsite/raw-globals`, and `pnpm bench fan <row> --show` takes it back in that form.

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
  are one eligibility rule at two placements, each its own hoist. `basefold/sinkinit` is two
  variations because `sinkinit` is one of its own, applied after `basefold`.
- Every variation, with its kind and its subject pattern, is registered in `VARIATION_TOKENS`
  ([`packages/core/src/variation-tokens.ts`](../packages/core/src/variation-tokens.ts)). A test asks
  whether a candidate carries one through `hasVariation` or `hasVariations`, both of which throw on a
  name the registry does not hold.
- When several combinations of variations produce the same source, only the first combination's
  variations are kept. **A candidate's variations name what was applied, not every route to its
  source, and not a route a deletion must remove.** Price a variation by ablating it, never by
  counting the winners that carry it.

## Variation kinds

A candidate's variations appear in this order.

| Kind           | What it changes                                                                                | Examples                                                         |
| -------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Signedness** | The signedness pinned on the entry parameters before type recovery. Always the first part.     | `unsigned`, `signed`                                             |
| **Lift**       | The assembly is lifted or raised again under a different reading.                              | `setup-args`, `connective`, `shared-ret`, `shared-tail`          |
| **Structure**  | `structure()` is run again with different options.                                             | `flip-branch`, `defsite`, `loop-entry`, `flip-join`, `uns-cmp`   |
| **Respell**    | The tree `structure()` produced is rewritten.                                                  | `unmerge`, `offmember`, `livebase`, `coalesce-v0-v1`, `volatile` |
| **Symbol map** | The symbol map's shaped spellings are withheld, so globals are spelled as raw addresses. Last. | `raw-globals`                                                    |

For a reader, what happened to one variation on one function is one of two states: it **carried N
candidates**, or it **threw**. N can be 0: the variation did not apply, or an earlier combination
already produced every source it made. A variation that threw prints an `asmlift: [threw] …` line from
`pnpm bench fan` and `pnpm asmlift --score-against`.

## Fields of the benchmark artifact

| Field                                                                               | Meaning                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `asmlift.winnerVariations`                                                          | The winner's variations, a list, e.g. `["unsigned", "defsite"]`. Present on every row that has a winner. |
| `asmlift.fanSize`                                                                   | How many candidates the row's fan holds: scored, dropped and withheld. Present on every ranked row.      |
| `asmlift.droppedCandidates[].variations`, `asmlift.withheldCandidates[].variations` | Each refused candidate's variations, a list.                                                             |

## Words the enumeration code uses

| Word                            | Meaning                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **default**                     | The answer taken when no alternative is applied. It adds no part to a candidate's name.                                                                                                                                                                  |
| **alternative**                 | One non-default answer, named by its variation.                                                                                                                                                                                                          |
| **setting**                     | One combination of answers given to one lift or to one `structure()` call.                                                                                                                                                                               |
| **compiler behavior**           | A question answered once per target by a `compilerBehaviors` field (`packages/core/src/target.ts`), never enumerated. It is right where the assembly determines the source; a variation is right where it does not ([`level-tower.md`](level-tower.md)). |
| **tree source**                 | A source emitted from one structured tree before the lift, structure and symbol-map parts of its name are attached. Never compiled or scored, so not a candidate.                                                                                        |
| **respell set**                 | Every respell variation, run over one structured tree.                                                                                                                                                                                                   |
| **stacked variation**           | A statement-order respell variation applied on top of every other respell variation's output, each alone and all together.                                                                                                                               |
| **pre-respell variation**       | A tree rewrite applied before the respell set, which then runs on its output (`unmerge`).                                                                                                                                                                |
| **pairing**                     | Two or three respell variations applied together as one candidate, enumerated only because a row demanded the joint spelling.                                                                                                                            |
| **multi-result variation**      | A respell variation whose single application has several results, each its own candidate, told apart by subject (`coalesce`, `volatile`, `regcopy`).                                                                                                     |
| **subject**                     | The trailing `-…` part of a variation that takes one.                                                                                                                                                                                                    |
| **hoist**                       | One entry of a base-hoist roster: which bases it binds, at which placement, and whether it joins the pairings.                                                                                                                                           |
| **shared gate / per-lift gate** | A structure variation's enumeration gate, asked once on the shared lift, or again on each lift's own raised function.                                                                                                                                    |
| **shared lift**                 | The one lift and type recovery run with no signedness pin, which learns the parameter kinds and answers the shared gates.                                                                                                                                |
| **preference**                  | Which symbol-map setting a candidate carries. The lower one wins a score tie.                                                                                                                                                                            |
| **route**                       | A derivation path that reaches a source. The first route to a source keeps its variations.                                                                                                                                                               |
| **map mode**                    | One of the two ways `bench sweep` lifts a row: `harness`, as the row is configured, or `nomap`, the same without its symbol map. `--map-modes` selects them.                                                                                             |
| **shards**                      | A tier's run spread across worker processes.                                                                                                                                                                                                             |

## Words with more than one sense

| Word         | Dominant sense                                                                                     | Other senses you will meet                  |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **spelling** | How a piece of C writes something, and so why two sources compile differently.                     | —                                           |
| **decline**  | A pass or a row refusing to act rather than emitting something wrong. `declined` is a row outcome. | —                                           |
| **gate**     | A predicate deciding whether a rewrite or a variation fires.                                       | A check a round must pass before it merges. |
| **base**     | A base pointer (`livebase`, `BaseKey`).                                                            | A git ref (`--base`).                       |
| **arm**      | A branch or `switch` arm of recovered C (`switch-arms`).                                           | The ARM instruction set.                    |
| **label**    | An assembly label or a C `goto` target. Never a candidate's name, which is its variations.         | A display label in the webapp or a chart.   |
| **token**    | In code, a variation's registered spelling (`VARIATION_TOKENS`).                                   | Lexer, cache and objdiff tokens.            |
