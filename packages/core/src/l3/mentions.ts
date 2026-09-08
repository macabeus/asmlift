// What one L3 tree does to each of its locals, counted once.
//
// Levers ask overlapping versions of the question and would disagree if each walked the tree
// its own way: l3/inlinebase.ts needs the SHAPE of every use (only an `index` base is re-spellable,
// and the single assignment must be a top-level `const` nothing mentions earlier), while
// l3/volatileval.ts needs the COUNTS, to check the tree still performs every access the machine
// did before it declares them all observable. One walk answers both, and it has to: on the counting
// consumer a miscount is a wrong `volatile` claim, not a missed candidate.
//
// Derived from the ONE traversal vocabulary (exprChildren/stmtExprs/stmtChildren) for every node
// kind, so a new one is a compile error there rather than a silent undercount here — with `index`
// as the ONE hand-rolled case, because the callback needs to know which child stands as the base
// and `exprChildren` flattens that away. That hand-rolling is a standing hazard rather than an
// oversight: a POSITION added to `index` reaches the generic vocabulary for free and this walk not
// at all. Every position is enumerated below and pinned by
// test/array-rank-guards.test.ts, beside the generic helpers it cannot speak for.
import { type Expr, type SFn, type Stmt, exprChildren, stmtChildren, stmtExprs, walkExprs } from './ast';

export interface Mentions {
  /** assignments to the name, at any nesting */
  assigns: number;
  /** body-top-level index of its single top-level assignment, or null */
  topAssignAt: number | null;
  /** the bare-`const` value that assignment stores, or null if it stores anything else */
  constValue: number | null;
  addrTaken: number;
  /** uses as the `base` of an `index` node — the only use shape a base lever can re-spell */
  baseUses: number;
  /** every other read */
  otherUses: number;
  /** body-top-level index of the first statement mentioning the name at all */
  firstAt: number | null;
}

/** reads of the name, however spelled */
export function readsOf(m: Mentions): number {
  return m.baseUses + m.otherUses;
}

const blank = (): Mentions => ({
  assigns: 0,
  topAssignAt: null,
  constValue: null,
  addrTaken: 0,
  baseUses: 0,
  otherUses: 0,
  firstAt: null,
});

/** Visit every node, telling the callback whether it stands as an `index`'s base. */
function walkExpr(e: Expr, visit: (x: Expr, isIndexBase: boolean) => void, isIndexBase = false): void {
  visit(e, isIndexBase);
  if (e.k === 'index') {
    walkExpr(e.base, visit, true);
    // `lead` — a multidimensional global's LEADING subscripts — is an ordinary value position, so
    // a name mentioned there is a real read. Missing it does not cost a candidate: it lets a lever
    // DELETE a local the body still names.
    for (const l of e.lead ?? []) {
      walkExpr(l, visit, false);
    }
    walkExpr(e.idx, visit, false);
    return;
  }
  for (const c of exprChildren(e)) {
    walkExpr(c, visit, false);
  }
}

/** Every mention of every local, keyed by name. Locals only — a param or a global name is not in
 *  the map, and a lever asking about one gets `undefined` rather than a zeroed record. */
export function localMentions(sfn: SFn): Map<string, Mentions> {
  const t = new Map<string, Mentions>(sfn.locals.map((l) => [l.name, blank()]));
  const seen = (name: string, at: number): Mentions | undefined => {
    const m = t.get(name);
    if (m && m.firstAt === null) {
      m.firstAt = at;
    }
    return m;
  };
  const stmt = (s: Stmt, at: number, top: boolean): void => {
    if (s.k === 'assign') {
      const m = seen(s.name, at);
      if (m) {
        m.assigns++;
        if (top) {
          m.topAssignAt = at;
          m.constValue = s.value.k === 'const' ? s.value.value : null;
        }
      }
    }
    for (const e of stmtExprs(s)) {
      walkExpr(e, (x, isIndexBase) => {
        if (x.k === 'var' || x.k === 'addr') {
          const m = seen(x.name, at);
          if (m) {
            if (x.k === 'addr') {
              m.addrTaken++;
            } else if (isIndexBase) {
              m.baseUses++;
            } else {
              m.otherUses++;
            }
          }
        }
      });
    }
    for (const c of stmtChildren(s)) {
      stmt(c, at, false);
    }
  };
  sfn.body.forEach((s, i) => stmt(s, i, true));
  return t;
}

/** THE ONE WALK behind `mentionsAnyLocal` and `mentionedLocals` below: which of `names` anything
 *  under `stmts` still NAMES — as an assignment TARGET (which carries no expression, so no walk
 *  over values can see it), as a read, or as an address. `first` stops at the earliest hit, which
 *  is all the boolean caller needs.
 *
 *  The question a pass that DELETES a declaration has to answer, and it lives here rather than in
 *  the deleting pass for the reason this file's header states about its own walk: a second walk
 *  over the node vocabulary is how a new node kind becomes a silent undercount, and beside
 *  `localMentions` a divergence is at least visible. This one is answered over a SUBTREE, so it
 *  cannot be derived from the counts above — `localMentions` is keyed to `sfn.locals` across the
 *  whole body, and l3/unmerge.ts's whole point is that those counts are sampled before any
 *  rewriting and go stale.
 *
 *  TOTAL over the vocabulary by construction: `assign` is the only `Stmt` carrying a bare name and
 *  `var`/`addr` the only `Expr`s, and both walks are derived from `stmtChildren`/`stmtExprs` — so a
 *  `for`'s init and inc, a `switch`'s scrutinee, its cases and its default are all covered. */
function scanMentions(stmts: readonly Stmt[], names: ReadonlySet<string>, first: boolean): Set<string> {
  // TWO FLAT SWEEPS, not one expression walk per nesting level. `walkExprs` already descends
  // `stmtChildren` (ast.ts), so calling it per statement from inside a recursion that ALSO
  // descends re-walks every nested expression once per enclosing level — d^2/2 `has` calls on a
  // chain of depth d, measured at 301 for depth 24 where one pass needs 25. It is small at
  // today's call sites (one rewritten subtree per un-merge site; one dropped-locals set per lever
  // tree), but this is a SHARED helper and its cost belongs in its contract.
  const found = new Set<string>();
  const body = [...stmts] as Stmt[];
  const stack: Stmt[] = [...body];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (s.k === 'assign' && names.has(s.name)) {
      found.add(s.name);
      if (first) {
        return found;
      }
    }
    stack.push(...stmtChildren(s));
  }
  for (const e of walkExprs(body)) {
    if ((e.k === 'var' || e.k === 'addr') && names.has(e.name)) {
      found.add(e.name);
      if (first) {
        return found;
      }
    }
  }
  return found;
}

/** true when anything under `stmts` still names one of `names`. See `scanMentions` above. */
export function mentionsAnyLocal(stmts: readonly Stmt[], names: ReadonlySet<string>): boolean {
  return scanMentions(stmts, names, true).size > 0;
}

/** WHICH of `names` the tree still mentions — the same walk `mentionsAnyLocal` answers "any" over,
 *  without short-circuiting, for the caller that has to NAME the survivors.
 *
 *  It exists so that contracts.ts's `assertNoOrphanedLocals` — the loud backstop for exactly the
 *  mistake this predicate guards — does not carry a THIRD hand-rolled copy of the node vocabulary.
 *  The boolean cannot serve it (the diagnostic needs the set) and one call per dropped name would
 *  be a walk per name; this is the same sweep, told to keep going. */
export function mentionedLocals(stmts: readonly Stmt[], names: ReadonlySet<string>): Set<string> {
  return scanMentions(stmts, names, false);
}
