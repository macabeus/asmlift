// L3 — the naming MECHANISM shared by every pass that hoists a value into a fresh local.
//
// Two passes name bases today (`basecse.ts` hoists a REUSED base; `argbase.ts` names a call's
// argument bases), and they differ in POLICY — which bases are eligible, and when it is worth
// doing — but not in how a name is chosen. That half was copied, and the copy silently lost a
// safety guard: basecse added the callee-name exclusion in its own audit precisely so a hoist
// local could not shadow a called function, and the second implementation did not have it. A third
// hoisting pass would lose it again, so the mechanism lives here and the policy stays with each
// caller.
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtChildren, stmtExprs } from './ast';

/** Every identifier a hoist name must not collide with, anywhere in `sfn`.
 *
 *  Wider than "the declared locals" on purpose, and each addition is a real collision:
 *   - params and locals, obviously;
 *   - every `var`/`addr` mentioned — a GLOBAL is referenced by bare name, so a local shadowing one
 *     silently redirects every later mention of it;
 *   - every CALL TARGET — a local named like a callee shadows the function;
 *   - every assignment target, which includes names no declaration list carries. */
function takenNames(sfn: SFn): Set<string> {
  const taken = new Set<string>([...sfn.params.map((p) => p.name), ...sfn.locals.map((l) => l.name)]);
  const visit = (e: Expr): void => {
    if (e.k === 'var' || e.k === 'addr') {
      taken.add(e.name);
    }
    if (e.k === 'call') {
      taken.add(e.fn);
    }
    mapExprChildren(e, (c) => {
      visit(c);
      return c;
    });
  };
  const walk = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      if (s.k === 'assign') {
        taken.add(s.name);
      }
      stmtExprs(s).forEach(visit);
      walk(stmtChildren(s));
    }
  };
  walk(sfn.body);
  return taken;
}

/**
 * A generator of fresh `p<n>` hoist names for `sfn`, colliding with nothing already in it.
 *
 * Returned as a closure over one `taken` set so successive calls cannot collide with each OTHER
 * either — the failure a caller re-deriving the set per name would hit.
 */
export function nameAllocator(sfn: SFn): () => string {
  const taken = takenNames(sfn);
  return () => {
    let n = 0;
    while (taken.has(`p${n}`)) {
      n++;
    }
    const nm = `p${n}`;
    taken.add(nm);
    return nm;
  };
}
