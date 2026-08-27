// asmlift — THE THREE READINGS OF A CONSTANT ADDRESS, in one place because they are three and not
// one, and because the same four lines had been re-typed into five files at three strengths.
//
// A raw address reaches L3 as a cast chain over a `const`, and "which numeric cell is this" has
// three different right answers depending on what the caller intends to DO with the answer. The
// readings are deliberately not merged; what this module supplies is names for them, so a pass
// declares which one it means instead of restating four lines and drifting.
//
//   • baseConst   — a deref BASE, through SCALAR pointer casts only. A cast to a STRUCT pointer is
//     the dot-form's base and is refused, because a lever that re-spells THROUGH it collapses the
//     stride (`((struct S *)K)[i].f` is not `((u8 *)K)[…]`). This is the reading a lever that
//     REWRITES the base needs: l3/nearbase.ts's clusters, l3/volstore.ts's qualifier.
//   • addrConst   — the address an expression IS, through ANY pointer cast. Wider, and safe
//     because nothing re-spells through it: l3/volatileptr.ts counts volatility claims with it.
//   • rootConst   — the constant an ACCESS CHAIN is rooted at, through any cast and any number of
//     subscripts and field selections. Wide enough to place an object whose element is not known,
//     which is what a read with a runtime subscript needs (l3/unreduce.ts's aliasing gate).
//
// And `cellAddress`, which is not a fourth reading of a base but the WHOLE address an `index`
// denotes — base plus subscript × width — or null when any part of it is not constant.
//
// A CAUTION THE HISTORY EARNED: `rootConst` and `cellAddress` disagree, and a predicate that uses
// one on its write side and the other on its read side is not the same predicate on both. A read
// rooted at 0x03FFFFF0 whose element is `[8]` denotes 0x04000010 — a device register the root
// reports as EWRAM. Ask for both where both can be had.
import type { Expr } from './ast';

/** the numeric address behind a deref base, through SCALAR pointer casts only */
export const baseConst = (e: Expr): number | null =>
  e.k === 'const'
    ? e.value
    : e.k === 'cast' && !(e.to.kind === 'ptr' && e.to.to.kind === 'struct')
      ? baseConst(e.e)
      : null;

/** the numeric address an expression IS, through any number of pointer casts */
export const addrConst = (e: Expr): number | null =>
  e.k === 'const' ? e.value : e.k === 'cast' && e.to.kind === 'ptr' ? addrConst(e.e) : null;

/** the constant an ACCESS CHAIN is rooted at, through any cast, subscript and field selection */
export const rootConst = (e: Expr): number | null =>
  e.k === 'const'
    ? e.value
    : e.k === 'cast'
      ? rootConst(e.e)
      : e.k === 'index' || e.k === 'field'
        ? rootConst(e.base)
        : null;

/** The WHOLE address an `index` access denotes, or null when any part of it is not constant. A
 *  `field` never resolves here: its offset is the struct's, which this module has no layout for. */
export function cellAddress(e: Expr): number | null {
  if (e.k !== 'index' || e.lead !== undefined || e.idx.k !== 'const') {
    return null; // a `lead` is a multidimensional global's leading dimension, not a numeric address
  }
  const base = baseConst(e.base);
  return base === null ? null : base + e.idx.value * e.width;
}

/** is `a` inside the half-open range `w`? A null address, or no declared range, is never inside. */
export const inRange = (a: number | null, w?: readonly [number, number]): boolean =>
  w !== undefined && a !== null && a >= w[0] && a < w[1];
