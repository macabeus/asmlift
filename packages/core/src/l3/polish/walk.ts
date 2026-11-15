// The one deep expression rewrite the polish modules share: every expression of every statement,
// children first, through the traversal vocabulary of l3/ast.ts.
import { type Expr, type SFn, mapExprChildren, mapStmtExprs } from '../ast';

/** `e` with every node mapped by `f`, children before their parent. */
export function mapExprDeep(e: Expr, f: (x: Expr) => Expr): Expr {
  return f(mapExprChildren(e, (c) => mapExprDeep(c, f)));
}

/** `fn` with every expression node of its body mapped by `f` (`mapExprDeep`). */
export function mapFnExprs(fn: SFn, f: (x: Expr) => Expr): SFn {
  return { ...fn, body: fn.body.map((s) => mapStmtExprs(s, (e) => mapExprDeep(e, f))) };
}
