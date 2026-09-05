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
 *   3. A local with NO `slot` keeps its position exactly. Only the positions the sortable locals
 *      already occupy are refilled, so an unslotted local never moves and no local is ever
 *      inserted or removed.
 *   4. `frame` and `uninit` locals are never sortable, because the structurer never stamps
 *      `slots` on them — the refusal, and the measurement behind it, live at that stamp site.
 *   5. Parameters are never touched: their storage is the caller's question.
 *   6. Two locals whose RANK works out the same keep their relative order (the sort is stable).
 *      One slot under two declared names is a slot the compiler REUSED, which is not evidence
 *      about either one's rank, so the ordering declines to invent one.
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
 *  function permutes, and its slots are four words of a single declared stack array rather than
 *  two spilled scalars — see the stamp site's refusal list for that class. The blocker is not the
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
  const inFrameOrder = at
    .map((i) => fn.locals[i])
    .sort((a, b) => (dir === 'ascending' ? rank(a) - rank(b) : rank(b) - rank(a)));
  const locals = [...fn.locals];
  at.forEach((i, k) => {
    locals[i] = inFrameOrder[k];
  });
  return { ...fn, locals };
}
