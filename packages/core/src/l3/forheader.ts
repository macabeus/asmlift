// asmlift — the one rule for folding a loop's init and step into a `for` header.
//
// Two readings print a `for`: the structurer's `while` re-bracketing over the finished body
// (structure/ast-rewrites.ts `recognizeForLoops`) and the `/for-read` respell of a `do`/`while`
// whose first test is known to pass (l3/forread.ts). Both ask this, so one loop is never a `for` to
// one of them and a `while` to the other. The header is what a reader writes, and what moves NO op:
//   • the init is the plain assignment right before the loop (`v = e0;`, not a compound);
//   • the test reads `v`;
//   • the body's LAST statement assigns `v` from a value that reads `v` — a genuine self-update,
//     not an unrelated trailing write (`v = h()` would be sound C, and a `for` no one writes);
//   • no `continue` in the rest of the body binds to this loop — a `continue` runs the step under
//     `for` and skips it under `while`/`do`, the one hazard of the re-bracketing.
// What the `do`/`while` arm needs on top (that its first test passes) is forread.ts's alone.
import type { Expr, Stmt } from './ast';
import { exprChildren, isLoop, stmtLists } from './ast';

type Assign = Extract<Stmt, { k: 'assign' }>;

/** Does `e` read the variable `name` (a bare `var` leaf, as `exprVars` counts it)? */
function readsVar(e: Expr, name: string): boolean {
  return (e.k === 'var' && e.name === name) || exprChildren(e).some((c) => readsVar(c, name));
}

/** Does a `continue` in `body` bind to the loop that holds it? One inside a nested loop binds to
 *  THAT loop, so the walk does not descend into loops; `if` and `switch` do not capture it. */
export function continuesLoop(body: readonly Stmt[]): boolean {
  return body.some((s) => s.k === 'continue' || (!isLoop(s) && stmtLists(s).some(continuesLoop)));
}

/** The `for` header of a loop testing `cond` over `body`, right after `init`, or null where the
 *  rule above refuses it: the init, the step (the body's last statement) and the body without it. */
export function forHeaderOf(
  init: Stmt | undefined,
  cond: Expr,
  body: readonly Stmt[],
): { init: Assign; inc: Assign; body: Stmt[] } | null {
  if (init?.k !== 'assign' || init.compound === true) {
    return null;
  }
  const iv = init.name;
  const inc = body[body.length - 1];
  if (inc?.k !== 'assign' || inc.name !== iv || !readsVar(inc.value, iv) || !readsVar(cond, iv)) {
    return null;
  }
  const rest = body.slice(0, -1);
  return continuesLoop(rest) ? null : { init, inc, body: rest };
}
