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
 *   4. `frame` and `uninit` locals are never sortable, because the structurer never stamps a
 *      `slot` on them — the refusal, and the measurement behind it, live at that stamp site.
 *   5. Parameters are never touched: their storage is the caller's question.
 *   6. Two locals homed at the SAME slot keep their relative order (the sort is stable). One slot
 *      under two declared names is a slot the compiler REUSED, which is not evidence about either
 *      one's rank, so the ordering declines to invent one.  */
export function orderSlotLocals(fn: SFn): SFn {
  const dir = fn.slotOrder;
  if (dir === undefined) {
    return fn;
  }
  const at: number[] = [];
  fn.locals.forEach((l, i) => {
    if (l.slot !== undefined) {
      at.push(i);
    }
  });
  if (at.length < 2) {
    return fn;
  }
  const inFrameOrder = at
    .map((i) => fn.locals[i])
    .sort((a, b) => (dir === 'ascending' ? a.slot! - b.slot! : b.slot! - a.slot!));
  const locals = [...fn.locals];
  at.forEach((i, k) => {
    locals[i] = inFrameOrder[k];
  });
  return { ...fn, locals };
}
