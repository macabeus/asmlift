// L3 — the MECHANISMS a pass needs to place a hoisted local: how a fresh name is chosen, where the
// leading run of base inits starts and ends, and where in the body that run goes.
//
// Their users differ. Every pass that mints a local takes `nameAllocator` (or `takenNames`, to
// number its own); only the two that touch basecse's leading init run read the rest — basecse
// mints into that run, sinkinit moves statements out of it, and both have to agree on where it
// stops and how a body carrying it is rebuilt. What stays with each caller is ELIGIBILITY: which
// values become a local at all, and when it is worth doing. WHERE the init goes is `placeBaseLocals`'s
// `placement` argument, so the two answers are two values of one parameter rather than two
// implementations. Everything here lives in one file because each half was a per-caller copy once
// and each copy drifted from its original — the naming one by losing the callee-name exclusion
// below, the init one by asking a different first-use question.
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
function isBaseInit(s: Stmt, plainLocals: ReadonlySet<string>): s is BaseInit {
  return (
    s.k === 'assign' &&
    plainLocals.has(s.name) &&
    s.value.k === 'cast' &&
    s.value.to.kind === 'ptr' &&
    (s.value.e.k === 'addr' || s.value.e.k === 'const')
  );
}

/** `body` split at the end of its LEADING run of base inits — the run `placeBaseLocals` places. */
function splitLeadingBaseInits(sfn: SFn, body: readonly Stmt[]): { inits: BaseInit[]; rest: Stmt[] } {
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
function firstUseIn(sfn: SFn, rest: readonly Stmt[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, m] of localMentions({ ...sfn, body: [...rest] })) {
    if (m.firstAt !== null) {
      out.set(name, m.firstAt);
    }
  }
  return out;
}

/** WHERE a run of base inits sits — the one question the three passes that place into that run
 *  (`l3/basecse.ts`, `l3/sinkinit.ts`, `l3/nearbase.ts`) answer differently, and the reason they
 *  used to rebuild the body three times.
 *
 *  `head` keeps the whole run at the top of the body, ordered by first use: the compiler loads the
 *  pool words in the order the bases are first touched, so that order is the one the reference
 *  spelling has.
 *  `first-use` moves each init down to immediately before the statement that first mentions it,
 *  which is where a base reached ONCE was loaded and which keeps a base first touched halfway down
 *  the body out of the live range above it.
 *  `prepend` puts the MINTED inits above an existing run that keeps its own order. It is not a
 *  worse `head` and it is not an oversight: `l3/nearbase.ts` wants it, and the row that demands
 *  that lever is what says so — re-placing its cluster bases in first-use order turns
 *  `synthetic:dmafield` from a MATCH into diff:5 (measured, 2026-08-26). A cluster base is reached
 *  at 2+ addresses by construction, so nothing about it is "first touched late"; what the bytes
 *  say is that its pool word was loaded before the run already there. Placement is a POLICY the
 *  differ referees per pass, not an invariant one pass can be corrected against another. */
export type BaseInitPlacement = 'head' | 'first-use' | 'prepend';

/** `body` rebuilt with `minted` added to its leading base-init run and the whole run placed per
 *  `placement`, plus how many inits ended up away from the head.
 *
 *  `sfn` supplies the locals and is NOT read for its body — the caller may have rewritten it — so
 *  a caller that mints must pass an `sfn` already declaring the new names, or the first-use and
 *  mention queries would not know them.
 *
 *  ONE ORDER, THEN THE POLICY. The run is put in FIRST-USE order under both policies before
 *  `placement` is consulted: that order is pool-load order, and it is what makes the two policies
 *  COMPOSABLE rather than merely adjacent — `first-use` applied to a `head` result is `first-use`
 *  applied to the input, so `/livebase/sinkinit` (a hoist at the head that a second pass then
 *  sinks) and `/basefold/sinkinit` (one hoist placed at first use) are the same transform and the
 *  `/sinkinit` suffix names one thing wherever it appears. Ordering the run only on the `head`
 *  branch made them differ on exactly the inits that CANNOT move, which is the half of the run
 *  whose order the compiler still reads. Pinned in test/sinkinit.test.ts.
 *
 *  Ties keep list order — existing inits before minted ones, and two inits assigning the SAME
 *  local in their original sequence, which a stable sort is what guarantees: they write one cell,
 *  so their order is the only thing that says which value it ends up holding.
 *
 *  Under `first-use`, an init then moves down if the function assigns its local exactly ONCE (the
 *  move would otherwise cross that other write), something in the remaining body mentions it, and
 *  it is not already sitting at the first such statement. */
export function placeBaseLocals(
  sfn: SFn,
  body: readonly Stmt[],
  minted: readonly BaseInit[],
  placement: BaseInitPlacement,
): { body: Stmt[]; moved: number } {
  const { inits: head, rest } = splitLeadingBaseInits(sfn, body);
  if (head.length + minted.length === 0) {
    return { body: [...body], moved: 0 };
  }
  if (placement === 'prepend') {
    return { body: [...minted, ...head, ...rest], moved: 0 };
  }
  const firstUse = firstUseIn(sfn, rest);
  const at = (s: BaseInit): number => firstUse.get(s.name) ?? rest.length;
  const all = [...head, ...minted].sort((a, b) => at(a) - at(b));
  if (placement === 'head') {
    return { body: [...all, ...rest], moved: 0 };
  }
  const whole = localMentions({ ...sfn, body: [...all, ...rest] });
  const stay: BaseInit[] = [];
  const sunk: { at: number; init: BaseInit }[] = [];
  for (const init of all) {
    const to = whole.get(init.name)?.assigns === 1 ? firstUse.get(init.name) : undefined;
    if (to === undefined || to === 0) {
      stay.push(init);
    } else {
      sunk.push({ at: to, init });
    }
  }
  const out = [...rest];
  // Descending by index, so an earlier insertion does not shift the position a later one was
  // computed against. Two inits sharing a target come out reversed; both are pure address assigns,
  // so the order among them means the same thing.
  for (const { at: to, init } of [...sunk].sort((a, b) => b.at - a.at)) {
    out.splice(to, 0, init);
  }
  return { body: [...stay, ...out], moved: sunk.length };
}
