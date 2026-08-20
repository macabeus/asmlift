// L3 re-spelling lever: put the PRODUCT operand first in a commutative `+`.
//
// structure.ts's def-order rule spells commutative operands in EVALUATION order, which recovers
// gcc's left-to-right source order. IDO and mwcc break the correspondence for exactly one shape:
// in `a*b + c` they SCHEDULE the independent load of `c` above the product's `mflo`/`mullw`, so
// the machine add reads (c, product) and def order re-spells the source's product-first sum as
// c-first. Which order the source used is not recoverable from positions there — so this lever
// emits the product-first sibling and the differ referees (verified byte-identical against IDO
// on the bg_area row; the def-order spelling stays in the list for sources that really were
// c-first).
//
// SCOPE (decline over approximate): a `+` is flipped only when exactly ONE side is a product
// (`bin('*')` at the root, casts looked through) — two products or none leave nothing to anchor
// the flip on. A side containing a call never moves (evaluation order of the operands is what
// the lever edits). Declines (null) when no `+` changes, so no duplicate candidate.
import type { Expr, SFn } from './ast';
import { exprHasEffect, mapExprChildren, mapStmtExprs } from './ast';

const isProduct = (e: Expr): boolean =>
  e.k === 'bin' && e.op === '*' ? true : e.k === 'cast' ? isProduct(e.e) : false;

export function mulFirstSums(sfn: SFn): SFn | null {
  let changed = false;
  const rewrite = (e: Expr): Expr => {
    const m = mapExprChildren(e, rewrite);
    if (
      m.k === 'bin' &&
      m.op === '+' &&
      isProduct(m.r) &&
      !isProduct(m.l) &&
      !exprHasEffect(m.l) &&
      !exprHasEffect(m.r)
    ) {
      changed = true;
      return { ...m, l: m.r, r: m.l };
    }
    return m;
  };
  const body = sfn.body.map((s) => mapStmtExprs(s, rewrite));
  return changed ? { ...sfn, body } : null;
}
