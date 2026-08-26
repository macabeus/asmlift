// L3 — the MECHANISMS a pass needs to place a hoisted local: how a fresh name is chosen, where the
// leading run of base inits starts and ends, and where in the body that run goes.
//
// Their users differ. Every pass that mints a local takes `nameAllocator` (or `takenNames`, to
// number its own); the three that touch basecse's leading init run read the rest — basecse and
// nearbase mint into it, sinkinit moves statements out of it, and all three have to agree on where
// it stops and how a body carrying it is rebuilt. What stays with each caller is ELIGIBILITY:
// which values become a local at all, and when it is worth doing. WHERE the run goes is
// `placeBaseLocals`'s `placement` argument. That argument is not one axis: `head` and `first-use`
// are two POSITIONS for a run this file has ordered, and `prepend` is nearbase's abstention from
// the ordering altogether, which is why the two are separate types. Everything lives in one file
// because each half was a per-caller copy once and each copy drifted from its original — the
// naming one by losing the callee-name exclusion below, the init one by asking a different
// first-use question, nearbase's by never ordering at all.
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

/** WHERE a run of base inits sits, for a pass that puts the run in FIRST-USE order first — the
 *  order the compiler loads the pool words in (`l3/basecse.ts`'s `collect`), so it is the order a
 *  reference spelling that named these bases would have.
 *
 *  `head` keeps the whole ordered run at the top of the body.
 *  `first-use` then moves each init down to immediately before the statement that first mentions
 *  it, which is where a base reached ONCE was loaded and which keeps a base first touched halfway
 *  down the body out of the live range above it.
 *
 *  These two are the axis a roster admission may state (rank.ts) and the only values
 *  `hoistBaseLocals` accepts: applying `first-use` to a `head` result is `first-use` applied to
 *  the input, so the two compose and `/sinkinit` names one transform wherever it appears. */
export type HoistPlacement = 'head' | 'first-use';

/** `HoistPlacement` plus the ABSTENTION: `prepend` puts the minted inits above a run that keeps
 *  the order it arrived in, consulting neither the first-use query nor the ordering sort — it is
 *  `[...minted, ...body]` and nothing more, which a test pins.
 *
 *  It is a third VALUE, not a third position, and only `l3/nearbase.ts` passes it. That pass's
 *  cluster bases are reached at 2+ addresses by construction, so "first touched late" says nothing
 *  about them, and the row that demands the lever prefers the pool word above the run already
 *  there: re-placing them in first-use order turns `synthetic:dmafield` from a MATCH into diff:5
 *  (measured, 2026-08-26). That is a corpus row and not a compiler mechanism, which is why the
 *  other ordering rides beside it as `/nearbase/sinkinit` for the differ to settle.
 *
 *  `hoistBaseLocals` may NOT be handed this: prepending there spells a newly minted base's pool
 *  load above locals the compiler loads first (`l3/basecse.ts`'s own header), so the two passes
 *  take different types rather than the same type and a comment. */
export type BaseInitPlacement = HoistPlacement | 'prepend';

/** `sfn.body` rebuilt with `minted` added to its leading base-init run and the whole run placed
 *  per `placement`, plus how many inits ended up away from the head.
 *
 *  `sfn` is both the statements and the DECLARATION ENVIRONMENT the first-use and mention queries
 *  resolve against, so a caller that mints must pass a shell that already declares the new names
 *  AND carries the rewritten body. One argument rather than two is the point: a shell whose
 *  declarations and statements disagree is not expressible here.
 *
 *  ONE ORDER, THEN THE POLICY. Under both `HoistPlacement` values the run is put in FIRST-USE
 *  order before `placement` is consulted — pool-load order, and what makes the two COMPOSABLE
 *  rather than merely adjacent: `first-use` applied to a `head` result is `first-use` applied to
 *  the input, so `/livebase/sinkinit` (a hoist at the head that a second pass then sinks) and
 *  `/basefold/sinkinit` (one hoist placed at first use) are the same transform and the `/sinkinit`
 *  suffix names one thing wherever it appears. Ordering the run only on the `head` branch made
 *  them differ on exactly the inits that CANNOT move, which is the half of the run whose order the
 *  compiler still reads. Pinned in test/sinkinit.test.ts. `prepend` opts out of all of it and
 *  returns before the query — see `BaseInitPlacement`.
 *
 *  Ties keep list order — existing inits before minted ones, and two inits assigning the SAME
 *  local in their original sequence, which a stable sort is what guarantees: they write one cell,
 *  so their order is the only thing that says which value it ends up holding. Two inits that SINK
 *  to the same statement keep it too, which costs the splice loop below an explicit tie-break.
 *
 *  Under `first-use`, an init then moves down if the function assigns its local exactly ONCE (the
 *  move would otherwise cross that other write), something in the remaining body mentions it, and
 *  it is not already sitting at the first such statement. */
export function placeBaseLocals(
  sfn: SFn,
  minted: readonly BaseInit[],
  placement: BaseInitPlacement,
): { body: Stmt[]; moved: number } {
  const body = sfn.body;
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
  // Descending by target index, so an earlier insertion does not shift the position a later one
  // was computed against — and descending among the inits SHARING a target too, because splicing
  // each at the same index puts the last one spliced on top. Without that second key a run that
  // sinks together comes out REVERSED, which is the one order this function exists to avoid: it
  // is pool-load order the sort above is spelling, and `head` would have kept it.
  const descending = sunk.map((s, i) => ({ ...s, i })).sort((a, b) => b.at - a.at || b.i - a.i);
  for (const { at: to, init } of descending) {
    out.splice(to, 0, init);
  }
  return { body: [...stay, ...out], moved: sunk.length };
}
