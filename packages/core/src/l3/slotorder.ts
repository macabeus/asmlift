// asmlift — declare slot-homed locals in the TARGET'S OWN FRAME ORDER.
//
// THE LAW. gcc 2.9 hands a spilled user local its frame slot by DECLARATION RANK: reload walks
// pseudos in ascending number handing each global-allocation loser a fresh stack slot, a user
// local's pseudo number is fixed at its `expand_decl` — i.e. its position in the declaration list
// — and the Thumb frame grows upward. So under agbcc the earlier-declared spilled local takes the
// LOWER `[sp,#k]`, and a source whose two spilled locals are declared the other way round compiles
// to the same object with those two operands swapped and nothing else moved.
//
// WHY THIS IS A PER-COMPILER DEFAULT AND NOT A RANKED AXIS. The asm does not underdetermine the
// answer: a `[sp,#k]` operand NAMES the slot, and slot → declaration rank is a FUNCTION once the
// compiler is fixed. An axis exists where two source spellings collapse to the same object and
// only the differ can choose between them; here the object chooses. The fan cost is zero — this
// rewrites the one tree every candidate already carries, adding no candidate, no `structure()`
// call and no compile.
//
// WHY `emit` OWNS IT. Two reasons, and they point the same way. It must run AFTER every L3 lever,
// because each of those rebuilds the declaration list (appends: basecse, scopebase, argbase,
// nearbase, regspell, reindex; filters: unmerge, coalesce, dce, inlinebase, pollguard, unreduce),
// and `emit` is last by construction. And it must NOT run at a `.emit(` call site: there are seven
// of those, the web Playground reaches two of them for one function (the headline source and the
// Pipeline tab), and the score probe reaches a third — a call-site ordering would print an ordered
// headline beside an unordered pipeline dump and measure the probe's scoreDelta on a source the
// ranked path never compiles.
//
// WHAT DEPENDS ON THE ORDER THIS DOES NOT CHANGE. `l3/coalesce.ts` picks the arm-disjoint survivor
// by `declIdx` — the earlier declaration, matching how a shared source local reads. It runs before
// this and therefore reads the UNSORTED list, which is exactly right and is what the emit-time
// placement preserves. Sorting any earlier would silently change which local survives every
// arm-disjoint merge.
import type { SFn } from './ast';

/** Refill the positions held by slot-carrying locals with those same locals in frame order.
 *
 *  PURE: the structurer's own list is never mutated, so `emit` cannot leak an ordered list back to
 *  a caller that expects the structurer's order.
 *
 *  REFUSAL CONDITIONS, all of them:
 *   1. `fn.slotOrder` absent — the direction is unknown for this target (or the target ships
 *      `'unknown'`) — the ordering is the IDENTITY. There is no default direction.
 *   2. Fewer than two sortable locals: nothing to order.
 *   3. A local with NO `slots` keeps its position exactly. Only the positions the sortable locals
 *      already occupy are refilled, so an unslotted local never moves and no local is ever
 *      inserted or removed.
 *   4. `frame` and `uninit` locals are never sortable, because the structurer never stamps
 *      `slots` on them — the refusal, and the measurement behind it, live at that stamp site.
 *   5. Parameters are never touched: their storage is the caller's question.
 *   6. TWO DECLARED LOCALS SHARING ONE OFFSET REFUSE THE WHOLE FUNCTION. Reload hands each
 *      spilled pseudo a FRESH slot (`reload1.c:769-770`, the premise this file's law rests on),
 *      so a frame in which the slot -> local map is not injective is not a frame this law
 *      describes at all: something upstream — a decomposed stack aggregate, a coalesce, a naming
 *      walk that put two spilled values under two names at one address — produced the evidence,
 *      and none of those is a declaration rank. It is NOT enough to leave that PAIR alone: the
 *      shared offset is still used to rank both of them against every other sortable local, so
 *      the whole ordering is unlicensed and the identity is the only sound answer.
 *
 *      MEASURED, both sides. Cost: zero on every shipped inhabitant — `spillorder` (v6@4 v12@0),
 *      `uninit_spill` (v4@0 v5@4 v6@8), `dma_fill_uninit` (v2@16 v4@4 v6@8 v8@12) and the
 *      `agbcc-u8spill.s` fixture (v0@4 v10@8 v11@12) are all injective, so both predicted flips
 *      keep their ordering. Reach: over the wide agbcc corpus exactly ONE function has two
 *      slot-carrying locals at all, and it is non-injective — `sa3 enemies/hariisen_proj.s`
 *      `sub_80617E0` carries `v8@12 v12@8 v13@12` and, without this refusal, emitted `… v7 v12
 *      v9 v10 v11 v8 v13 …` against the declaration order `… v7 v8 v9 v10 v11 v12 v13 …`. So 1
 *      of 1 real functions this default actually changed was one whose evidence contradicts its
 *      own premise; with the refusal the wild reach is zero-changed rather than one-changed-
 *      wrongly. (Its slots are four words of one declared stack array — see the stamp site's
 *      aggregate note — which is exactly the class that mints a duplicate.)
 *
 *      A consequence, so nothing downstream relies on the sort's stability: with this refusal
 *      two sortable locals can no longer TIE. Equal ranks under `ascending` means an equal
 *      minimum offset and under `descending` an equal maximum, and either is a shared offset,
 *      which this refuses first.
 *
 *  AND THIS IS THE ONE PLACE A SET OF HOMES IS REDUCED TO A RANK. A local can carry several
 *  offsets — several spilled values under one name, or a coalesce that absorbed a second homed
 *  local — and every site that merged them took the union and chose nothing, because the choice
 *  is direction-dependent and none of them holds a target (ir/core.ts `SlotHomes`). The earliest
 *  declaration rank is the LOWEST offset under an ascending frame and the HIGHEST under a
 *  descending one: one comparator, applied where `slotOrder` is in hand.
 *
 *  The `descending` half of that comparator has NO SHIPPED INHABITANT: agbcc is the only target
 *  that ships a direction and it is `ascending`. It is reached only through the public
 *  `StructureOptions.spillSlotOrder` and by the tests, and it exists because two of the four
 *  `TargetDescription`s carry a MEASURED `descending` with a written flip condition (target.ts).
 *
 *  REACH, measured on this branch, so the next round starts at the blocker and not at the census.
 *  The two synthetic inhabitants are `spillorder` (6 → MATCH) and `dma_fill_uninit` (12 → MATCH,
 *  a row this capability did not author). On the REAL agbcc tier the reach is ZERO and the cause
 *  is named: of 126 cases, four carry any L1 slot home, two carry a slot-carrying local at L3,
 *  and NONE carries two, so the ordering changes no real benchmark function's source. Over a
 *  wider corpus (2,463 real agbcc functions across 158 sa3 + klonoa listings) exactly one
 *  function had two slot-carrying locals at all, and its slots are four words of a single
 *  declared stack array rather than two spilled scalars — see the stamp site's refusal list for
 *  that class, and refusal 6 above, which now declines it, so the wild reach is ZERO functions
 *  changed rather than one changed wrongly. The blocker is not the
 *  frame order and not the census: the structurer's naming walk INLINES spilled values instead of
 *  declaring them (`PackSaveSector` spills to 18 distinct slots, 108 stamped values, and reaches
 *  L3 with zero slot-carrying locals). Counting stores is therefore a bad proxy for reach.  */
export function orderSlotLocals(fn: SFn): SFn {
  const dir = fn.slotOrder;
  if (dir === undefined) {
    return fn;
  }
  // the earliest declaration rank among a local's homes: the lowest offset if the frame hands
  // slots out ascending against rank, the highest if descending.
  const rank = (l: SFn['locals'][number]): number =>
    dir === 'ascending' ? Math.min(...l.slots!) : Math.max(...l.slots!);
  const at: number[] = [];
  fn.locals.forEach((l, i) => {
    if (l.slots !== undefined && l.slots.length > 0) {
      at.push(i);
    }
  });
  if (at.length < 2) {
    return fn;
  }
  // refusal 6: the slot -> local map must be INJECTIVE, or this frame is not one the law
  // describes and no local in it can be ranked. Over every offset of every sortable local, not
  // just their ranks: a duplicate anywhere means some slot was not a fresh reload assignment.
  const offsets = at.flatMap((i) => fn.locals[i].slots!);
  if (new Set(offsets).size !== offsets.length) {
    return fn;
  }
  const inFrameOrder = at
    .map((i) => fn.locals[i])
    .sort((a, b) => (dir === 'ascending' ? rank(a) - rank(b) : rank(b) - rank(a)));
  const locals = [...fn.locals];
  at.forEach((i, k) => {
    locals[i] = inFrameOrder[k];
  });
  return { ...fn, locals };
}
