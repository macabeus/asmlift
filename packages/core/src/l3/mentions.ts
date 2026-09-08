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

/** true when anything under `stmts` still NAMES one of `names` — as an assignment TARGET (which
 *  carries no expression, so no walk over values can see it), as a read, or as an address.
 *
 *  The predicate a pass that DELETES a declaration has to answer, and it lives here rather than in
 *  the deleting pass for the reason this file's header states about its own walk: a second walk
 *  over the node vocabulary is how a new node kind becomes a silent undercount, and beside
 *  `localMentions` a divergence is at least visible. This one is answered over a SUBTREE and asks
 *  only "any", so it cannot be derived from the counts above — `localMentions` is keyed to
 *  `sfn.locals` across the whole body, and l3/unmerge.ts's whole point is that those counts are
 *  sampled before any rewriting and go stale.
 *
 *  TOTAL over the vocabulary by construction: `assign` is the only `Stmt` carrying a bare name and
 *  `var`/`addr` the only `Expr`s, and both walks are derived from `stmtChildren`/`stmtExprs` — so a
 *  `for`'s init and inc, a `switch`'s scrutinee, its cases and its default are all covered. */
export function mentionsAnyLocal(stmts: readonly Stmt[], names: ReadonlySet<string>): boolean {
  // TWO FLAT SWEEPS, not one expression walk per nesting level. `walkExprs` already descends
  // `stmtChildren` (ast.ts), so calling it per statement from inside a recursion that ALSO
  // descends re-walks every nested expression once per enclosing level — d^2/2 `has` calls on a
  // chain of depth d, measured at 301 for depth 24 where one pass needs 25. It is small at
  // today's only call site (one rewritten subtree per un-merge site), but this is a SHARED helper
  // now and its cost belongs in its contract.
  const body = [...stmts] as Stmt[];
  const stack: Stmt[] = [...body];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (s.k === 'assign' && names.has(s.name)) {
      return true;
    }
    stack.push(...stmtChildren(s));
  }
  for (const e of walkExprs(body)) {
    if ((e.k === 'var' || e.k === 'addr') && names.has(e.name)) {
      return true;
    }
  }
  return false;
}
