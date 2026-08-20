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
import type { Expr, SFn, Stmt } from './ast';
import { exprChildren, mapExprChildren } from './ast';

const isProduct = (e: Expr): boolean =>
  e.k === 'bin' && e.op === '*' ? true : e.k === 'cast' ? isProduct(e.e) : false;

const hasCall = (e: Expr): boolean => e.k === 'call' || exprChildren(e).some(hasCall);

export function mulFirstSums(sfn: SFn): SFn | null {
  let changed = false;
  const rewrite = (e: Expr): Expr => {
    const m = mapExprChildren(e, rewrite);
    if (m.k === 'bin' && m.op === '+' && isProduct(m.r) && !isProduct(m.l) && !hasCall(m.l) && !hasCall(m.r)) {
      changed = true;
      return { ...m, l: m.r, r: m.l };
    }
    return m;
  };
  const mapS = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'assign':
        return { ...s, value: rewrite(s.value) };
      case 'store':
        return { ...s, lval: rewrite(s.lval), value: rewrite(s.value) };
      case 'exprstmt':
        return { ...s, value: rewrite(s.value) };
      case 'return':
        return s.value ? { ...s, value: rewrite(s.value) } : s;
      case 'if':
        return { ...s, cond: rewrite(s.cond), then: s.then.map(mapS), else: s.else.map(mapS) };
      case 'while':
      case 'dowhile':
        return { ...s, cond: rewrite(s.cond), body: s.body.map(mapS) };
      case 'for':
        return { ...s, init: mapS(s.init), cond: rewrite(s.cond), inc: mapS(s.inc), body: s.body.map(mapS) };
      case 'switch':
        return {
          ...s,
          scrutinee: rewrite(s.scrutinee),
          cases: s.cases.map((c) => ({ ...c, body: c.body.map(mapS) })),
          default: s.default?.map(mapS),
        };
      case 'break':
      case 'continue':
        return s;
    }
  };
  const body = sfn.body.map(mapS);
  return changed ? { ...sfn, body } : null;
}
