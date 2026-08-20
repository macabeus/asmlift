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
// one) somewhere in the body — `0` is NULL, never an address. An `addr` assignment anywhere
// VETOES the local, qualifying assignments on other paths notwithstanding: the symbol map owns
// that declaration's volatility, and a mixed-feed local (`p = &gSym` in one arm, a raw address
// in another) would read the mapped global through a volatile view the map never granted. No
// qualifying local ⇒ decline (null), so the lever never emits a duplicate of the primary.
import { type Expr, type SFn, type Stmt } from './ast';

const isNumericAddr = (e: Expr): boolean =>
  (e.k === 'const' && e.value !== 0) || (e.k === 'cast' && e.to.kind === 'ptr' && isNumericAddr(e.e));

const feedsAddr = (e: Expr): boolean => e.k === 'addr' || (e.k === 'cast' && feedsAddr(e.e));

function collectFeeds(stmts: Stmt[], numeric: Set<string>, symbol: Set<string>): void {
  for (const s of stmts) {
    switch (s.k) {
      case 'assign':
        if (isNumericAddr(s.value)) {
          numeric.add(s.name);
        }
        if (feedsAddr(s.value)) {
          symbol.add(s.name);
        }
        break;
      case 'if':
        collectFeeds(s.then, numeric, symbol);
        collectFeeds(s.else, numeric, symbol);
        break;
      case 'while':
      case 'dowhile':
        collectFeeds(s.body, numeric, symbol);
        break;
      case 'for':
        collectFeeds([s.init, s.inc], numeric, symbol);
        collectFeeds(s.body, numeric, symbol);
        break;
      case 'switch':
        for (const c of s.cases) {
          collectFeeds(c.body, numeric, symbol);
        }
        collectFeeds(s.default ?? [], numeric, symbol);
        break;
      default:
        break;
    }
  }
}

/** The `/volatile` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  sharing the (unmodified) body. */
export function volatilePtrLocals(sfn: SFn): SFn | null {
  const numericFed = new Set<string>();
  const symbolFed = new Set<string>();
  collectFeeds(sfn.body, numericFed, symbolFed);
  const qualifies = (l: SFn['locals'][number]): boolean =>
    l.type.kind === 'ptr' &&
    l.volatile === undefined &&
    l.pointeeVolatile === undefined &&
    numericFed.has(l.name) &&
    !symbolFed.has(l.name);
  if (!sfn.locals.some(qualifies)) {
    return null;
  }
  return { ...sfn, locals: sfn.locals.map((l) => (qualifies(l) ? { ...l, pointeeVolatile: true } : l)) };
}
