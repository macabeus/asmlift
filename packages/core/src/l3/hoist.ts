// L3 — the MECHANISM shared by every pass that hoists a value into a fresh local: how a name is
// chosen, and where the run of base inits at the top of a body starts and ends.
//
// Three passes name bases today (`basecse.ts` hoists a leaf base; `argbase.ts` names a call's
// argument bases; `sinkinit.ts` re-places what basecse emitted), and they differ in POLICY — which
// bases are eligible, when it is worth doing, and where the init goes — but not in either
// mechanism. The naming half was copied once, and the copy silently lost a safety guard: basecse
// added the callee-name exclusion in its own audit precisely so a hoist local could not shadow a
// called function, and the second implementation did not have it. The init-run half was then
// copied too, with a first-use query that answered a different question from basecse's. Both live
// here now; the policy stays with each caller.
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtChildren, stmtExprs } from './ast';
import { localMentions } from './mentions';

/** Every identifier a MINTED name must not collide with, anywhere in `sfn` — the hoists below,
 *  and reindex's induction names.
 *
 *  Wider than "the declared locals" on purpose, and each addition is a real collision:
 *   - params and locals, obviously;
 *   - every `var`/`addr` mentioned — a GLOBAL is referenced by bare name, so a local shadowing one
 *     silently redirects every later mention of it;
 *   - every CALL TARGET — a local named like a callee shadows the function;
 *   - every assignment target, which includes names no declaration list carries. */
export function takenNames(sfn: SFn): Set<string> {
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

export type BaseInit = Extract<Stmt, { k: 'assign' }>;

/** Whether `s` is a BASE INIT: a ptr-cast of an `addr`/`const` leaf assigned into a declared
 *  NON-VOLATILE local. It reads nothing and writes its own plain cell, which is what makes the run
 *  of them re-orderable and each of them movable. The volatile exclusion is load-bearing — two
 *  writes to `volatile` locals are observably ordered, so one at the head simply ends the run. */
export function isBaseInit(s: Stmt, plainLocals: ReadonlySet<string>): s is BaseInit {
  return (
    s.k === 'assign' &&
    plainLocals.has(s.name) &&
    s.value.k === 'cast' &&
    s.value.to.kind === 'ptr' &&
    (s.value.e.k === 'addr' || s.value.e.k === 'const')
  );
}

/** `body` split at the end of its LEADING run of base inits. `basecse.ts` re-orders that run,
 *  `sinkinit.ts` sinks statements out of it, and they have to agree on where it stops. */
export function splitLeadingBaseInits(sfn: SFn, body: readonly Stmt[]): { inits: BaseInit[]; rest: Stmt[] } {
  const plain = new Set(sfn.locals.filter((l) => !l.volatile).map((l) => l.name));
  let n = 0;
  while (n < body.length && isBaseInit(body[n], plain)) {
    n++;
  }
  return { inits: body.slice(0, n) as BaseInit[], rest: body.slice(n) };
}

/** For each local, the index of the first TOP-LEVEL statement of `rest` that mentions it, absent
 *  when none does. `mentions.ts`'s notion of a mention, so `&p` counts: an init must precede the
 *  address being taken as surely as it must precede a read. */
export function firstUseIn(sfn: SFn, rest: readonly Stmt[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, m] of localMentions({ ...sfn, body: [...rest] })) {
    if (m.firstAt !== null) {
      out.set(name, m.firstAt);
    }
  }
  return out;
}
