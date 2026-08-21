// L3 re-spelling lever: declare a pointer local that holds a NUMERIC address as pointing to
// volatile data (`volatile u16 *p = (u16 *)0x3000010;`).
//
// A numeric address has no declaration anywhere — the project maps a symbol's volatility, but a
// raw constant is exactly the case with no symbol — so whether the original source read it
// through a `volatile` pointer is not derivable from the asm. It is codegen-visible all the
// same: a volatile MEM is barred from motion and combination, which reorders the loop
// optimizer's pseudos and lands the register allocator on different homes (on the row this was
// built for, the counter is copied out of r0 so the loaded value can have it — the target's
// allocation). So the qualified spellings are emitted alongside the plain one — the all-locals
// form as rank.ts `/volatile`, per-local subsets as its `-name` variants — and the differ
// referees.
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

/** The locals the lever would qualify — the per-local SUBSET enumeration's input (below):
 *  which pointers the original declared volatile is per-pointer knowledge the asm does not
 *  carry (an MMIO block and a plain RAM table can sit side by side, and qualifying the table
 *  blocks the read collapse its region wants), so each non-empty subset is its own candidate
 *  when few enough locals qualify, and the differ referees. */
export function volatileEligibleLocals(sfn: SFn): string[] {
  return sfn.locals.filter(eligibility(sfn)).map((l) => l.name);
}

/** the shared eligibility predicate (the GATE in the header) for one function's locals */
function eligibility(sfn: SFn): (l: SFn['locals'][number]) => boolean {
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
  return (l) =>
    l.type.kind === 'ptr' &&
    l.volatile === undefined &&
    l.pointeeVolatile === undefined &&
    numericFed.has(l.name) &&
    !tainted.has(l.name);
}

/** The proper non-empty SUBSETS of the qualifying locals (within `within`, when given) as
 *  alternative outputs — one candidate per subset, labeled by its member names. Empty above
 *  three qualifiers: the arm is capped at 6 extra spellings, and the all-qualifiers form is the
 *  plain lever's own candidate. */
export function volatileSubsetCandidates(sfn: SFn, within?: ReadonlySet<string>): { merged: string; sfn: SFn }[] {
  const elig = volatileEligibleLocals(sfn).filter((n) => within === undefined || within.has(n));
  if (elig.length < 2 || elig.length > 3) {
    return [];
  }
  const out: { merged: string; sfn: SFn }[] = [];
  for (let mask = 1; mask < (1 << elig.length) - 1; mask++) {
    const subset = elig.filter((_, i) => (mask & (1 << i)) !== 0);
    const r = volatilePtrLocals(sfn, new Set(subset));
    if (r) {
      out.push({ merged: subset.join('-'), sfn: r });
    }
  }
  return out;
}

/** The `/volatile` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  sharing the (unmodified) body. `only` narrows the lever to the named locals — a /volatile
 *  PRODUCT (rank.ts) qualifies just the locals its first lever centres on (kept walk bases,
 *  created hoists), so the product never degenerates into a general /volatile composition over
 *  the function's other locals — and the subset enumeration re-uses the same door. */
export function volatilePtrLocals(sfn: SFn, only?: ReadonlySet<string>): SFn | null {
  const eligible = eligibility(sfn);
  const qualifies = (l: SFn['locals'][number]): boolean => eligible(l) && (only === undefined || only.has(l.name));
  if (!sfn.locals.some(qualifies)) {
    return null;
  }
  return { ...sfn, locals: sfn.locals.map((l) => (qualifies(l) ? { ...l, pointeeVolatile: true } : l)) };
}
