// THE STRUCT-NAME ALLOCATOR, in one place because there are three minters of synthesized struct
// names (raise/structs.ts `Struct<N>`, raise/struct-arrays.ts `Elem<N>`, l3/offmember.ts `Off<N>`)
// and each had rolled its own scan, at two different strengths.
//
// `l3/hoist.ts`'s header states the rule for LOCALS — "every pass that mints a local takes
// `nameAllocator`" — and five passes obey it. This is that rule for structs.
//
// THE CONTRACT IS MONOTONE, never first-free: the next index is past EVERY taken one. Skipping a
// CONTIGUOUS PREFIX is a weaker guarantee than being free — a set holding `Off0` and `Off2` stops
// a first-free walk at 1, and the name minted after it is `Off2` again, one layout declared twice
// under one name, which is invisible in the tree (`structs` is a list, not a map) and surfaces
// either as a compile error or, through a name-deduping consumer, as one access reading another
// layout's member. That is the class of silent loss PR #127 named for `localNames`.
//
// AND AT BOTH SHIPPED CALL SITES THE SEED IS 0. Measured, not assumed: instrumenting both and
// lifting every corpus function gives 1498 `Elem` seeds and 1417 `Off` seeds map-less, 417 and 398
// map-ful, all zero. Each prefix has exactly one minter and each minter runs once per function
// (raise/pre-recovery.ts is a linear pass list, `/offmember` a single respell), so no tree either
// one is handed can already carry its own prefix.
//
// THAT IS NOT THE SAME AS A GUARD WITH NO INHABITANT, which this branch dropped one commit over
// (structure/analysis.ts's loop-header refusal). A refusal with no inhabitant still makes a claim
// about a hazard, and removes candidates the day its predicate widens; an allocator with no taken
// name is the IDENTITY — it returns exactly the 0 the hand-rolled counters returned, and what it
// buys is that the 0 is a computed fact rather than a caller invariant nothing checks. The price
// is one scan of the taken names per call, which at the `Elem` site is a type-graph walk.
export function nextStructIndex(taken: Iterable<string>, prefix: string): number {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let next = 0;
  for (const name of taken) {
    const m = re.exec(name);
    if (m) {
      next = Math.max(next, Number(m[1]) + 1);
    }
  }
  return next;
}
