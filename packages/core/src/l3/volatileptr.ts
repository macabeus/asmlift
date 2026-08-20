// L3 re-spelling lever: declare a pointer local that holds a NUMERIC address as pointing to
// volatile data (`volatile u16 *p = (u16 *)0x3000010;`).
//
// A numeric address has no declaration anywhere — the project maps a symbol's volatility, but a
// raw constant is exactly the case with no symbol — so whether the original source read it
// through a `volatile` pointer is not derivable from the asm. It is codegen-visible all the
// same: a volatile MEM is barred from motion and combination, which reorders the loop
// optimizer's pseudos and lands the register allocator on different homes (on the row this was
// built for, the counter is copied out of r0 so the loaded value can have it — the target's
// allocation). So both spellings are emitted (rank.ts `/volatile`) and the differ referees.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION: `volatile` only RESTRICTS what a compiler may do
// with the accesses; every execution of the qualified spelling is an execution of the plain
// one. C89 also admits the assignment without a cast change — the qualifier is added on the
// pointee, and assignment may add pointee qualifiers.
//
// GATE: only a local of pointer type assigned a bare numeric constant (or a cast of one)
// somewhere in the body. A local fed by a global's address (`addr`) is excluded — the symbol
// map owns that declaration's volatility, and this lever must not contradict it. No qualifying
// local ⇒ decline (null), so the lever never emits a duplicate of the primary.
import { type Expr, type SFn, type Stmt } from './ast';

const isNumericAddr = (e: Expr): boolean =>
  e.k === 'const' || (e.k === 'cast' && e.to.kind === 'ptr' && isNumericAddr(e.e));

function collectConstAssigned(stmts: Stmt[], out: Set<string>): void {
  for (const s of stmts) {
    switch (s.k) {
      case 'assign':
        if (isNumericAddr(s.value)) {
          out.add(s.name);
        }
        break;
      case 'if':
        collectConstAssigned(s.then, out);
        collectConstAssigned(s.else, out);
        break;
      case 'while':
      case 'dowhile':
        collectConstAssigned(s.body, out);
        break;
      case 'for':
        collectConstAssigned([s.init, s.inc], out);
        collectConstAssigned(s.body, out);
        break;
      case 'switch':
        for (const c of s.cases) {
          collectConstAssigned(c.body, out);
        }
        collectConstAssigned(s.default ?? [], out);
        break;
      default:
        break;
    }
  }
}

/** The `/volatile` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  sharing the (unmodified) body. */
export function volatilePtrLocals(sfn: SFn): SFn | null {
  const constAssigned = new Set<string>();
  collectConstAssigned(sfn.body, constAssigned);
  const qualifies = (l: SFn['locals'][number]): boolean =>
    l.type.kind === 'ptr' && l.volatile === undefined && constAssigned.has(l.name);
  if (!sfn.locals.some(qualifies)) {
    return null;
  }
  return { ...sfn, locals: sfn.locals.map((l) => (qualifies(l) ? { ...l, volatile: true } : l)) };
}
