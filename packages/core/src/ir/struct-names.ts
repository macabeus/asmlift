// THE STRUCT-NAME ALLOCATOR, in one place because there are now three minters of synthesized
// struct names and each had rolled its own scan.
//
// `l3/hoist.ts`'s header states the rule for LOCALS — "every pass that mints a local takes
// `nameAllocator`" — and five passes obey it. Structs had no owner: raise/structs.ts scanned for
// `Struct<N>`, raise/struct-arrays.ts counted `Elem<N>` from zero with no scan at all, and
// l3/offmember.ts scanned for `Off<N>` by walking UP FROM ZERO over the taken set.
//
// That last shape is the one this exists to delete. Skipping a CONTIGUOUS PREFIX is not the same
// guarantee as being free: a tree carrying `Off0` and `Off2` stops the walk at 1, and the second
// name minted after it is `Off2` again — one layout declared twice under one name, which is
// invisible in the tree (`structs` is a list, not a map) and surfaces either as a compile error or,
// through a name-deduping consumer, as one access reading another layout's member. That is the
// class of silent loss PR #127 named for `localNames`.
//
// The contract is therefore MONOTONE, never first-free: the next index is past EVERY taken one.
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
