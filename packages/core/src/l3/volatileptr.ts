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
// GATE: only a local of pointer type assigned a bare NONZERO numeric constant (or a cast of
// one) somewhere in the body — `0` is NULL, never an address. A value CONTAINING a global's
// address — `&gSym` at ANY depth: under a cast, inside interior-address arithmetic
// (`(u16 *)((u32)&gSym + 8)`) — VETOES the local, qualifying assignments on other paths
// notwithstanding, and the veto propagates through assignments to a FIXPOINT (`q` tainted,
// `p = q` taints `p`; conservatively, `p` assigned ANY expression mentioning a tainted name).
// The symbol map owns a declared global's volatility, and a mixed-feed local would read the
// mapped global through a volatile view the map never granted. No qualifying local ⇒ decline
// (null), so the lever never emits a duplicate of the primary.
import { type Expr, type SFn, type Stmt, mapExprChildren } from './ast';

const isNumericAddr = (e: Expr): boolean =>
  (e.k === 'const' && e.value !== 0) || (e.k === 'cast' && e.to.kind === 'ptr' && isNumericAddr(e.e));

const exprHas = (e: Expr, pred: (x: Expr) => boolean): boolean => {
  if (pred(e)) {
    return true;
  }
  let hit = false;
  mapExprChildren(e, (c) => {
    hit ||= exprHas(c, pred);
    return c;
  });
  return hit;
};

function collectAssigns(stmts: Stmt[], out: { name: string; value: Expr }[]): void {
  for (const s of stmts) {
    switch (s.k) {
      case 'assign':
        out.push({ name: s.name, value: s.value });
        break;
      case 'if':
        collectAssigns(s.then, out);
        collectAssigns(s.else, out);
        break;
      case 'while':
      case 'dowhile':
        collectAssigns(s.body, out);
        break;
      case 'for':
        collectAssigns([s.init, s.inc], out);
        collectAssigns(s.body, out);
        break;
      case 'switch':
        for (const c of s.cases) {
          collectAssigns(c.body, out);
        }
        collectAssigns(s.default ?? [], out);
        break;
      default:
        break;
    }
  }
}

/** The `/volatile` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  sharing the (unmodified) body. */
export function volatilePtrLocals(sfn: SFn): SFn | null {
  const assigns: { name: string; value: Expr }[] = [];
  collectAssigns(sfn.body, assigns);
  const numericFed = new Set<string>();
  const tainted = new Set<string>();
  for (const a of assigns) {
    if (isNumericAddr(a.value)) {
      numericFed.add(a.name);
    }
    if (exprHas(a.value, (x) => x.k === 'addr')) {
      tainted.add(a.name);
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const a of assigns) {
      if (!tainted.has(a.name) && exprHas(a.value, (x) => x.k === 'var' && tainted.has(x.name))) {
        tainted.add(a.name);
        grew = true;
      }
    }
  }
  const qualifies = (l: SFn['locals'][number]): boolean =>
    l.type.kind === 'ptr' &&
    l.volatile === undefined &&
    l.pointeeVolatile === undefined &&
    numericFed.has(l.name) &&
    !tainted.has(l.name);
  if (!sfn.locals.some(qualifies)) {
    return null;
  }
  return { ...sfn, locals: sfn.locals.map((l) => (qualifies(l) ? { ...l, pointeeVolatile: true } : l)) };
}
