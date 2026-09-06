// L3 — the MECHANISMS a pass needs to place a hoisted local: how a fresh name is chosen, where the
// leading run of base inits starts and ends, and where in the body that run goes.
//
// Their users differ. Every pass that mints a local takes `nameAllocator` (or `takenNames`, to
// number its own); the three that touch basecse's leading init run read the rest — basecse and
// nearbase mint into it, sinkinit moves statements out of it, and all three have to agree on where
// it stops and how a body carrying it is rebuilt. What stays with each caller is ELIGIBILITY:
// which values become a local at all, and when it is worth doing. WHERE the run goes is
// `placeBaseLocals`'s `placement` argument, and that argument is two questions rather than one —
// see `HoistPlacement` and `BaseInitPlacement`. Everything lives in one file because each half was
// a per-caller copy once and every copy drifted from its original.
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, mapStmtLists, stmtChildren, stmtExprs, stmtLists } from './ast';
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

/** Does `s` mention `name` in its OWN expressions or as its assignment target — nothing nested?
 *  `mentions.ts`'s notion of a mention (`&p` counts), asked of one statement rather than of a
 *  top-level index. */
function mentionsHere(s: Stmt, name: string): boolean {
  if (s.k === 'assign' && s.name === name) {
    return true;
  }
  let found = false;
  const visit = (e: Expr): void => {
    if ((e.k === 'var' || e.k === 'addr') && e.name === name) {
      found = true;
    }
    mapExprChildren(e, (c) => {
      visit(c);
      return c;
    });
  };
  stmtExprs(s).forEach(visit);
  return found;
}

/** …and the same question of the whole subtree. */
function mentionsStmt(s: Stmt, name: string): boolean {
  return mentionsHere(s, name) || stmtChildren(s).some((c) => mentionsStmt(c, name));
}

/** `{ list, at }` for a top-level first-use index, or null when there is none — the `first-use`
 *  answer in the shape the `scope` one comes back in. */
function mapTo(list: Stmt[], at: number | undefined): { list: Stmt[]; at: number } | null {
  return at === undefined ? null : { list, at };
}

/** The innermost statement list holding EVERY mention of `name`, and the index in it of the first
 *  statement that mentions it. This is `firstUseIn` continued downward, and it descends only on
 *  three facts: exactly one statement of this list mentions the name, that statement mentions it
 *  nowhere OUTSIDE the lists it opens (its own condition, or a `for`'s `init`/`inc` — which are
 *  statements no list holds), and exactly one of those lists holds it. Any of the three failing
 *  means a nested list does not hold every mention, so this list is as deep as the init may go.
 *  Stopping at the top level reproduces `first-use` exactly, which is what lets `scope` be a
 *  placement rather than a second policy.
 *
 *  DOMINATION IS THE DESCENT'S OWN INVARIANT: every mention is at or after the returned index
 *  within the returned list, so the init reaches all of them — including from inside a loop body,
 *  where it simply re-assigns the same link-time constant. `hoistBaseLocals` still CHECKS it
 *  (`assertHoistsDominate`), because an argument is not a check.
 *
 *  A LOOP BODY IS ALSO A LIST NO SHIPPED CANDIDATE CAN REACH, which is a stronger statement than
 *  the safety argument above and the one that keeps re-assigning a base per iteration out of
 *  published C. Every gate table any caller pairs with `scope` keeps `BASECSE_GATES`' `loop` rule —
 *  `ORDERBASE_GATES`, the only roster table at this placement, ablates `cast-base` and `single-use`
 *  and nothing else — so a base with ANY use inside a loop is refused before a placement is
 *  consulted. Both halves are pinned in test/sinkinit.test.ts: neither table admits one, and where
 *  the mechanism is handed such a base directly the tree it emits still dominates. Loop-body bases
 *  are `l3/scopebase.ts`'s, which plans its own local rather than moving this run. */
function scopeSite(list: Stmt[], name: string): { list: Stmt[]; at: number } | null {
  const idxs = list.flatMap((s, i) => (mentionsStmt(s, name) ? [i] : []));
  if (idxs.length === 0) {
    return null;
  }
  const here = { list, at: idxs[0] };
  if (idxs.length > 1) {
    return here;
  }
  const s = list[idxs[0]];
  const lists = stmtLists(s);
  const inner = lists.filter((l) => l.some((x) => mentionsStmt(x, name)));
  if (inner.length !== 1) {
    return here;
  }
  const opened = new Set(lists.flat());
  const outside = mentionsHere(s, name) || stmtChildren(s).some((c) => !opened.has(c) && mentionsStmt(c, name));
  return outside ? here : (scopeSite(inner[0], name) ?? here);
}

/** WHERE a run of base inits sits, once this file has put it in FIRST-USE order — the order the
 *  compiler loads the pool words in (`l3/basecse.ts`'s `collect`), so it is the order a reference
 *  spelling that named these bases would have.
 *
 *  `head` keeps the whole ordered run at the top of the body.
 *  `first-use` then moves each init down to immediately before the statement that first mentions
 *  it, which is where a base reached ONCE was loaded and which keeps a base first touched halfway
 *  down the body out of the live range above it.
 *  `scope` reads that same query one nesting level at a time: an init whose every mention lives
 *  inside ONE nested list goes inside that list, at the first mention there. `first-use` stops at
 *  the top-level statement — a base used only inside an `if` arm still has its pool word loaded
 *  above the branch — and on agbcc, whose statement order survives into the object, the two are
 *  different bytes. Where no nested list holds every mention this IS `first-use`, which is what
 *  makes it a placement rather than a second policy.
 *
 *  These three are the axis a roster admission may state (rank.ts) and the only values
 *  `hoistBaseLocals` accepts. */
export type HoistPlacement = 'head' | 'first-use' | 'scope';

/** `HoistPlacement` plus the ABSTENTION: `prepend` puts the minted inits above a run that keeps
 *  the order it arrived in, consulting neither the first-use query nor the sort. A third VALUE and
 *  not a third position, passed only by `l3/nearbase.ts`, whose header carries the argument for it.
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
 *  suffix names one thing wherever it appears. Order the run only on the `head` branch and they
 *  part company on the inits that CANNOT move, which is the half of the run whose order the
 *  compiler still reads. Pinned in test/sinkinit.test.ts. `prepend` opts out of all of it.
 *
 *  Ties keep list order — existing inits before minted ones, and two inits assigning the SAME
 *  local in their original sequence, which a stable sort is what guarantees: they write one cell,
 *  so their order is the only thing that says which value it ends up holding. Two that SINK to the
 *  same statement keep it too, which is what the splice loop's second sort key is for.
 *
 *  Under `first-use`, an init then moves down if the function assigns its local exactly ONCE (the
 *  move would otherwise cross that other write), something in the remaining body mentions it, and
 *  it is not already sitting at the first such statement.
 *
 *  IT REPORTS THE MOTION rather than its size, and its callers judge those lists instead of arguing
 *  about them. `moved` names every init that left the leading run; `nested` is the subset that
 *  landed in a list OTHER than the top-level one, which only `scope` can produce.
 *
 *  `nested` empty under `scope` means the placement DEGENERATED — every init went exactly where
 *  `first-use` would have put it, so the emitted tree is that placement's spelling under a second
 *  name. A caller offering placements as candidates has to know, or it enumerates one spelling
 *  twice (l3/basecse.ts's `hoistBaseLocals`).
 *  `moved` stays a count: how many inits left the run. */
export function placeBaseLocals(
  sfn: SFn,
  minted: readonly BaseInit[],
  placement: BaseInitPlacement,
): { body: Stmt[]; moved: readonly string[]; nested: readonly string[] } {
  const still = { moved: [], nested: [] };
  const body = sfn.body;
  const { inits: head, rest } = splitLeadingBaseInits(sfn, body);
  if (head.length + minted.length === 0) {
    return { body: [...body], ...still };
  }
  if (placement === 'prepend') {
    return { body: [...minted, ...head, ...rest], ...still };
  }
  const firstUse = firstUseIn(sfn, rest);
  const at = (s: BaseInit): number => firstUse.get(s.name) ?? rest.length;
  const all = [...head, ...minted].sort((a, b) => at(a) - at(b));
  if (placement === 'head') {
    return { body: [...all, ...rest], ...still };
  }
  const whole = localMentions({ ...sfn, body: [...all, ...rest] });
  const stay: BaseInit[] = [];
  const sunk: { site: Stmt[]; at: number; init: BaseInit; i: number }[] = [];
  for (const [i, init] of all.entries()) {
    // Assigned exactly once, or the move would cross the other write.
    const site =
      whole.get(init.name)?.assigns === 1
        ? placement === 'scope'
          ? scopeSite(rest, init.name)
          : mapTo(rest, firstUse.get(init.name))
        : null;
    // Nothing mentions it, or it is already sitting at the first statement of the top-level list:
    // there is no move to make and the init stays in the leading run.
    if (site === null || (site.list === rest && site.at === 0)) {
      stay.push(init);
    } else {
      sunk.push({ site: site.list, at: site.at, init, i });
    }
  }
  // Rebuild `rest` around the sink sites, matching each list by IDENTITY against the tree the sites
  // were computed on — so the walk emits a fresh list only along the path to a site and hands every
  // other statement back unchanged.
  const bySite = new Map<Stmt[], typeof sunk>();
  for (const s of sunk) {
    bySite.set(s.site, [...(bySite.get(s.site) ?? []), s]);
  }
  const rebuild = (list: Stmt[]): Stmt[] => {
    const here = bySite.get(list);
    // CONSUMED: one `Stmt[]` object sitting at two tree positions takes the init at the FIRST of
    // them, never at both, where a second splice would write the same local twice. `scopeSite`
    // cannot return such a list — sharing means two statements mention the local, which stops the
    // descent at their common list — so this restates that invariant where breaking it would be
    // silent. Nothing in the L3 contract forbids the sharing itself (l3/scopebase.ts records a
    // producer that shares an expression node).
    bySite.delete(list);
    let changed = here !== undefined;
    const mapped = list.map((s) => {
      let inner = false;
      const out = mapStmtLists(s, (l) => {
        const r = rebuild(l);
        inner ||= r !== l;
        return r;
      });
      changed ||= inner;
      return inner ? out : s;
    });
    if (!changed) {
      return list;
    }
    // Descending by target index, so an earlier insertion does not shift the position a later one
    // was computed against — and descending among the inits SHARING a target too, because splicing
    // each at the same index puts the last one spliced on top. Without that second key a run that
    // sinks together comes out REVERSED, which is the one order this function exists to avoid: it
    // is pool-load order the sort above is spelling, and `head` would have kept it.
    for (const { at: to, init } of [...(here ?? [])].sort((a, b) => b.at - a.at || b.i - a.i)) {
      mapped.splice(to, 0, init);
    }
    return mapped;
  };
  // `site !== rest` is the whole nesting question: every site is a list of the tree the sites were
  // computed on, and the top-level one is `rest` by identity.
  return {
    body: [...stay, ...rebuild(rest)],
    moved: sunk.map((s) => s.init.name),
    nested: sunk.filter((s) => s.site !== rest).map((s) => s.init.name),
  };
}
