// L3 re-spelling lever: hoist a reused global base into a pointer local at the INNERMOST scope
// that contains all of its uses.
//
// `l3/basecse.ts` already hoists a reused leaf base — but always to the FUNCTION TOP, and only for
// an `addr`/`const` base. Both limits are load-bearing here, and each costs a real row:
//
//   PLACEMENT. A base used only inside one `if` arm, hoisted to the function top, is live across
//   everything before that arm — a live range the original never had, which is the register-pressure
//   failure basecse's own loop gate exists for. Measured on kleod:UpdateHUDCounterDisplay by
//   hand-editing the REFERENCE source: naming the `gBgTilemapBufs` store base inside the arm that
//   uses it is byte-exact, and moving that same declaration to the function top costs 24. What THIS
//   lever does to that row is smaller — 81 to 70, still a nonmatch — because the row needs several
//   other capabilities too; the placement figure is the reason the lever is scope-aware, not a claim
//   about what it achieves alone. basecse's header already names the gap — "a loop-body base is left
//   inline for a future scope-aware hoist" — and this is that hoist.
//
//   ELIGIBILITY. With a symbol map that states an array's RANK, the access renders as the bare
//   `gSym[0][i]`, whose base node is a `var` naming the global, not an `addr`. basecse's
//   `isHoistableBase` takes only `addr`/`const`, so the rank-aware spelling — the one a project with
//   real headers actually gets — is invisible to it.
//
// WHY IT MATCHES, and it is not a readability preference: a store whose destination address the
// compiler materialized into a register before computing the source reads back as exactly this
// shape. The decomp author's alternative is a no-op read-modify-write (`g[0][K] += 0;`) purely to
// force that materialization; naming the base is the same codegen without the quirk.
//
// A LEVER, not a rewrite: emitted as an ADDITIONAL candidate (rank.ts `/scopebase`) with the
// differ refereeing, so the un-hoisted spelling is always still in the list and this can never cost
// a match.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION. The hoisted value is a pure ADDRESS of a global — no
// load, nothing observable, nothing that can fault — so evaluating it earlier in a scope that
// DOMINATES every use is invisible. The rewritten accesses keep their own width/signedness, so
// every stride is unchanged. Domination is the load-bearing half: `collect` and `rewriteStmt` must
// walk the SAME tree, or an access the planner never placed gets repointed at a local whose
// assignment does not reach it — compiling C that reads an uninitialized pointer, which neither
// boundary contract catches (they check resolution and deref typing, not definite assignment).
//
// ORDERING: `hoistReusedGlobalBases` (basecse) runs unconditionally in `structureChecked`, BEFORE
// rank's levers see the tree. So this pass's `addr`/`const` input is only what basecse REFUSED —
// loop uses and repeated-constant-offset uses — which is why it carries basecse's const-offset gate
// rather than assuming those bases never arrive.
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtExprs } from './ast';
import { nameAllocator } from './hoist';

/** A base this lever may name: a leaf whose value is a fixed address.
 *
 *  `var` is included ONLY for a name the tree itself declares as an array-shaped global (SFn.globals
 *  — populated by the structurer for exactly those). A local `var` is excluded: it can be assigned
 *  between the hoist point and a use, which would change what is dereferenced. */
type LeafBase = Extract<Expr, { k: 'addr' } | { k: 'const' } | { k: 'var' }>;
const isLeaf = (e: Expr, globals: ReadonlySet<string>): e is LeafBase =>
  e.k === 'addr' || e.k === 'const' || (e.k === 'var' && globals.has(e.name));

/** THE identity of a base — what makes two accesses "the same address".
 *
 *  A global reaches L3 under two spellings, `addr g` and the bare `var g`, and they denote the same
 *  cell; keying on the NAME alone means a function that mixes them still sees one base. */
const baseId = (b: LeafBase): string => (b.k === 'const' ? `c:${b.value}` : `n:${b.name}`);

/** An access this lever may re-point, or null.
 *
 *  REFUSES a non-zero `lead`. `lead` pins the leading subscripts of a multidimensional array, so
 *  `g[1][i]` is a whole ROW past `g[0][i]`. The hoisted local points at the START of the object, and
 *  the rewrite DROPS the lead — sound only when every leading subscript is 0. A non-zero lead would
 *  silently address the wrong row, which no contract checks: the tree stays well-typed and
 *  spellable, it just names different bytes. (Today `bareArrayLead` only ever emits zeros; this
 *  guard is what keeps that an implementation detail rather than a correctness dependency.) */
function eligible(e: Expr, globals: ReadonlySet<string>): Extract<Expr, { k: 'index' }> | null {
  if (e.k !== 'index' || !isLeaf(e.base, globals)) {
    return null;
  }
  return (e.lead ?? []).every((n) => n === 0) ? e : null;
}

/** The (base, access-shape) key an access shares with its reuse siblings. Width and signedness are
 *  part of it because the hoisted local carries the access's pointer type — two widths through one
 *  base are two different locals, exactly as in basecse. */
const keyOf = (n: Extract<Expr, { k: 'index' }>): string => `${baseId(n.base as LeafBase)} ${n.width} ${n.signed}`;

/** One use, located by its chain of enclosing statement LISTS (outermost first).
 *
 *  `loop[i]` says whether `path[i]` is a LOOP BODY. Recorded here, at the only point the tree walk
 *  actually knows it, so the loop question below is a lookup rather than a second traversal that
 *  could disagree with this one. */
interface Site {
  path: Stmt[][];
  loop: boolean[];
  /** the use runs EVERY ITERATION of a loop whose body is not on `path` — a loop's own condition,
   *  or a `for`'s increment. No scope reachable from `path` runs at that cadence, so a key with any
   *  such use is refused outright rather than hoisted to a point that runs once. */
  perIteration: boolean;
}

/** Walk every expression in the tree, recording each eligible access's key and its scope path. */
function collect(
  body: Stmt[],
  globals: ReadonlySet<string>,
  out: Map<string, { uses: Site[]; sample: Extract<Expr, { k: 'index' }>; constOff: Map<number, number> }>,
  path: Stmt[][],
  loop: boolean[],
): void {
  const visit = (e: Expr, perIteration: boolean): void => {
    const ix = eligible(e, globals);
    if (ix) {
      const k = keyOf(ix);
      const rec = out.get(k) ?? { uses: [], sample: ix, constOff: new Map<number, number>() };
      rec.uses.push({ path, loop, perIteration });
      if (ix.idx.k === 'const') {
        rec.constOff.set(ix.idx.value, (rec.constOff.get(ix.idx.value) ?? 0) + 1);
      }
      out.set(k, rec);
    }
    mapExprChildren(e, (c) => {
      visit(c, perIteration);
      return c;
    });
  };
  for (const s of body) {
    const isLoop = s.k === 'while' || s.k === 'dowhile' || s.k === 'for';
    // A loop's OWN condition runs every iteration — a base there is loop-invariant exactly as a
    // body use is, and it lives at THIS list, which does not. basecse.ts and argbase.ts both make
    // the same call; this pass used to attribute it to the enclosing list with loop=false and would
    // hoist above the loop, contradicting its own stated invariant.
    stmtExprs(s).forEach((e) => visit(e, isLoop));
    if (s.k === 'for') {
      // `init` and `inc` are STATEMENTS, so their expressions are reached by neither `stmtExprs`
      // nor `childLists` — yet `rewriteStmt` rewrites them. Collect and rewrite MUST see the same
      // tree: an access the planner never counted would still be repointed, at a local whose
      // assignment need not dominate it (`for (i = p0[3]; …)` after an `if` arm that defines p0).
      // `init` runs once, at this list's cadence; `inc` runs every iteration, like the condition.
      stmtExprs(s.init).forEach((e) => visit(e, false));
      stmtExprs(s.inc).forEach((e) => visit(e, true));
    }
    for (const child of childLists(s)) {
      collect(child, globals, out, [...path, child], [...loop, isLoop]);
    }
  }
}

/** The nested statement LISTS of a statement — the scopes a hoist could land in.
 *
 *  Deliberately not `stmtChildren`, which flattens a `for`'s `init`/`inc` in with its body: those
 *  are single statements, not lists, and a hoist has nowhere legal to go in either (before the loop
 *  changes when it runs, inside the body repeats it). A `for`'s body IS a list and is included. */
function childLists(s: Stmt): Stmt[][] {
  switch (s.k) {
    case 'if':
      return [s.then, s.else];
    case 'while':
    case 'dowhile':
    case 'for':
      return [s.body];
    case 'switch':
      return [...s.cases.map((c) => c.body), ...(s.default ? [s.default] : [])];
    // Exhaustive on purpose — no `default`. A future Stmt kind carrying a nested list must be a
    // COMPILE error here, exactly as it is in `stmtChildren`: a silent `[]` would collect that
    // kind's uses at the wrong scope while `rewriteStmt`, which IS exhaustive, still rewrote them.
    case 'assign':
    case 'store':
    case 'exprstmt':
    case 'return':
    case 'break':
    case 'continue':
      return [];
  }
}

/** The innermost statement list common to every use, or null when they span the function body.
 *
 *  Null is not a failure to fix — it is precisely the case `basecse.ts` already hoists at the
 *  function top, so emitting it here would only duplicate the primary spelling. */
function commonScope(uses: Site[]): { scope: Stmt[]; depth: number } | null {
  const first = uses[0].path;
  let depth = 0;
  while (depth < first.length && uses.every((u) => u.path[depth] === first[depth])) {
    depth++;
  }
  return depth === 0 ? null : { scope: first[depth - 1], depth };
}

/** Does any use sit inside a LOOP nested below the chosen scope?
 *
 *  Then the hoist would be loop-invariant code motion to a point the original never had — the
 *  register-pressure failure `basecse.ts`'s own `inLoop` gate refuses, and the reason that gate
 *  exists. When EVERY use is inside the loop, the common scope IS the loop body: the assignment
 *  then runs per iteration exactly as the inline spelling did, and there is nothing to refuse. */
function underNestedLoop(uses: Site[], depth: number): boolean {
  return uses.some((u) => u.perIteration || u.loop.slice(depth).some(Boolean));
}

/**
 * The `/scopebase` re-spelling, or null when nothing qualifies (the caller then adds no candidate
 * rather than a duplicate of the primary).
 */
export function hoistScopedBases(sfn: SFn): SFn | null {
  const globals = new Set((sfn.globals ?? []).map((g) => g.name));
  const found = new Map<
    string,
    { uses: Site[]; sample: Extract<Expr, { k: 'index' }>; constOff: Map<number, number> }
  >();
  collect(sfn.body, globals, found, [], []);

  const fresh = nameAllocator(sfn);
  const newLocals: { name: string; type: IrType }[] = [];
  // key → (scope list identity, local name)
  const plan: { scope: Stmt[]; key: string; name: string; type: IrType; base: LeafBase }[] = [];
  for (const [key, rec] of found) {
    if (rec.uses.length < 2) {
      continue; // one access re-materializes as cheaply as a named local
    }
    // A constant offset touched 2+ times is a SCALAR re-access at one fixed location (an MMIO
    // read-modify-write, a repeated `*p`), which the compiler re-materializes rather than
    // register-holds. basecse.ts learned this by LOSING the ProcessHBlankWait match to it; the gate
    // is inherited here rather than re-lost, and it governs a large share of this lever's reachable
    // input because basecse runs first and refuses these bases, leaving them to be seen here.
    if ([...rec.constOff.values()].some((n) => n >= 2)) {
      continue;
    }
    const found = commonScope(rec.uses);
    if (!found || underNestedLoop(rec.uses, found.depth)) {
      continue;
    }
    const type = T.ptr(scalarTypeForAccess(rec.sample.width, rec.sample.signed));
    plan.push({ scope: found.scope, key, name: fresh(), type, base: rec.sample.base as LeafBase });
  }
  if (plan.length === 0) {
    return null;
  }

  const nameFor = new Map<string, string>(plan.map((p) => [p.key, p.name]));
  const point = (e: Expr): Expr => {
    const ix = eligible(e, globals);
    if (ix) {
      const nm = nameFor.get(keyOf(ix));
      if (nm) {
        // `lead` is DROPPED — the local already points at the object start, and `eligible` has
        // established every leading subscript is 0.
        const { lead: _drop, ...rest } = ix;
        return { ...rest, base: { k: 'var', name: nm }, idx: point(ix.idx) };
      }
    }
    return mapExprChildren(e, point);
  };

  // Rebuild the tree, inserting each hoist at the head of its own scope list. Statement lists are
  // matched by IDENTITY against the ORIGINAL tree, so the rewrite walks the original and emits a
  // fresh tree in one pass — a two-pass version would compare rebuilt lists that no longer match.
  const rewriteList = (list: Stmt[]): Stmt[] => {
    const here = plan.filter((p) => p.scope === list);
    const pre: Stmt[] = here.map((p) => ({
      k: 'assign',
      name: p.name,
      // The always-valid form: `(T *)&gSym` is byte-identical under ANY declaration of gSym, which
      // is why it is also what `bareArrayLead` falls back to. A `const` base keeps its literal.
      value: { k: 'cast', to: p.type, e: p.base.k === 'const' ? p.base : { k: 'addr', name: p.base.name } },
    }));
    for (const p of here) {
      newLocals.push({ name: p.name, type: p.type });
    }
    return [...pre, ...list.map(rewriteStmt)];
  };
  const rewriteStmt = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'assign':
        return { ...s, value: point(s.value) };
      case 'store':
        return { ...s, lval: point(s.lval), value: point(s.value) };
      case 'exprstmt':
        return { ...s, value: point(s.value) };
      case 'return':
        return s.value === undefined ? s : { ...s, value: point(s.value) };
      case 'if':
        return { ...s, cond: point(s.cond), then: rewriteList(s.then), else: rewriteList(s.else) };
      case 'while':
      case 'dowhile':
        return { ...s, cond: point(s.cond), body: rewriteList(s.body) };
      case 'for':
        return {
          ...s,
          init: rewriteStmt(s.init),
          cond: point(s.cond),
          inc: rewriteStmt(s.inc),
          body: rewriteList(s.body),
        };
      case 'switch':
        return {
          ...s,
          scrutinee: point(s.scrutinee),
          cases: s.cases.map((c) => ({ ...c, body: rewriteList(c.body) })),
          ...(s.default ? { default: rewriteList(s.default) } : {}),
        };
      case 'break':
      case 'continue':
        return s;
    }
  };

  const body = rewriteList(sfn.body);
  return { ...sfn, body, locals: [...sfn.locals, ...newLocals] };
}
