// L3 re-spelling lever: hoist a reused global base into a pointer local at the INNERMOST scope
// that contains all of its uses.
//
// The lever earns its place: returning `null` from `hoistScopedBases` costs
// kleod:UpdateHUDCounterDisplay its match, so the benchmark's zero-lost gate guards this file.
//
// `l3/basecse.ts` already hoists a reused leaf base — but only into the TOP-LEVEL statement list
// (the function top, or an init's first use where a roster row asks `l3/hoist.ts` for that), never
// into a nested scope, and only for an `addr`/`const` base. Both limits are load-bearing here, and
// each costs a real row:
//
//   PLACEMENT. A base used only inside one `if` arm is live across everything before that arm
//   under either of basecse's positions — a live range the original never had, which is the
//   register-pressure failure basecse's own loop gate exists for. First-use placement narrows that
//   range and does not close it: the init still lands ABOVE the `if`, because sinking INTO the arm
//   is what needs the domination work this pass does. That argument is why the lever is
//   scope-aware; it is NOT a claim about what the lever achieves, and no committed measurement
//   separates the two placements (the one that did edited a reference source by hand and cannot
//   be re-run). On kleod:UpdateHUDCounterDisplay the primary path declines outright (a later pass
//   retired the phi it keyed on, so the base's uses span the function body), and the cluster
//   fallback below is what recovers it. basecse's header already names the gap — "a loop-body
//   base is left inline for a future scope-aware hoist" — and this is that hoist.
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
// ORDERING: `hoistBaseLocals` (basecse) runs unconditionally in `structureChecked`, BEFORE
// rank's levers see the tree. So this pass's `addr`/`const` input is what basecse's DEFAULT table
// refused — EVERY gate in it, single-use bases as much as loop and repeated-constant-offset ones —
// which is why the two refusals below re-state basecse's rather than assuming those bases never
// arrive.
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtExprs } from './ast';
import { nameAllocator } from './hoist';
import { addressableGlobals } from './storage';

/** A base this lever may name: a leaf whose value is a fixed address.
 *
 *  `var` is included ONLY for a name in `SFn.globals`. That list is populated by `noteGlobal` alone
 *  (two call sites in structure.ts, both on the `bareArrayLead` path, which requires
 *  `shape === 'array'`) — so a `var` base here is always an ARRAY-declared global and `(T *)&gSym`
 *  is its start address under any declaration. The invariant is worth stating because it is what
 *  keeps a POINTER-shaped global out: for one of those, `(T *)&gPtr` names the pointer CELL rather
 *  than the object it points at, which would be silently the wrong address. A local `var` is
 *  excluded for the ordinary reason: it can be assigned between the hoist point and a use. */
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
  /** `idx[i]` is the index, within `path[i]`, of the statement this use sits under. Used to place
   *  the hoist immediately before the FIRST statement that needs it rather than at the list head:
   *  a call between the assignment and the first use is exactly what forces the pointer into a
   *  CALLEE-SAVED register and adds the prologue push/pop the original avoided — the same failure,
   *  one level smaller, that this module exists to fix. argbase.ts places by the same rule. */
  idx: number[];
  /** the use runs EVERY ITERATION of a loop whose body is not on `path` — a loop's own condition,
   *  or a `for`'s increment. No scope reachable from `path` runs at that cadence, so a key with any
   *  such use is refused outright rather than hoisted to a point that runs once. */
  perIteration: boolean;
}

/** Set when the tree holds a shape `collect` and `rewriteStmt` would disagree about — see the
 *  `for`-part note below. The pass then declines outright. */
let compound = false;

/** Walk every expression in the tree, recording each eligible access's key and its scope path. */
function collect(
  body: Stmt[],
  globals: ReadonlySet<string>,
  out: Map<string, { uses: Site[]; sample: Extract<Expr, { k: 'index' }>; constOff: Map<number, number> }>,
  path: Stmt[][],
  loop: boolean[],
  idxPath: number[],
): void {
  let at = 0;
  const visit = (e: Expr, perIteration: boolean): void => {
    const ix = eligible(e, globals);
    if (ix) {
      const k = keyOf(ix);
      const rec = out.get(k) ?? { uses: [], sample: ix, constOff: new Map<number, number>() };
      rec.uses.push({ path, loop, perIteration, idx: [...idxPath, at] });
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
  for (const [i, s] of body.entries()) {
    at = i;
    const isLoop = s.k === 'while' || s.k === 'dowhile' || s.k === 'for';
    // A loop's OWN condition runs every iteration — a base there is loop-invariant exactly as a
    // body use is, and it lives at THIS list, which does not. basecse.ts and argbase.ts treat the
    // CONDITION the same way. They do NOT agree about a `for`'s `init`: basecse counts it in-loop
    // (its `stmtChildren('for')` is `[init, inc, …body]`, recursed with `nested`), this pass counts
    // it at the enclosing cadence, which is the truthful reading — it runs once. Recorded because
    // the divergence is real and an extraction has to pick one; both readings are pinned in
    // test/addr-placement.test.ts so the pick is deliberate rather than whichever survives.
    stmtExprs(s).forEach((e) => visit(e, isLoop));
    if (s.k === 'for') {
      // `init`/`inc` are typed as the full Stmt union, so a COMPOUND one is type-legal. `stmtExprs`
      // reaches only its own expressions while `rewriteStmt` descends into any nested list — the
      // round-1 walker asymmetry, one node kind deeper, and the fuzz reproduces it (a use inside
      // `for (if (1) i = g[3]; …)` gets repointed at a local the `if` arm may never have assigned).
      // No producer emits a compound part today (structure.ts and reindex.ts both emit `assign`), so
      // rather than grow a second recursion this REFUSES the whole function — loud decline over a
      // silently unreachable definition. Delete this when `stmtLists` makes collect/rewrite share
      // one traversal.
      if (childLists(s.init).length > 0 || childLists(s.inc).length > 0) {
        compound = true;
      }
      // `init` and `inc` are STATEMENTS, so their expressions are reached by neither `stmtExprs`
      // nor `childLists` — yet `rewriteStmt` rewrites them. Collect and rewrite MUST see the same
      // tree: an access the planner never counted would still be repointed, at a local whose
      // assignment need not dominate it (`for (i = p0[3]; …)` after an `if` arm that defines p0).
      // `init` runs once, at this list's cadence; `inc` runs every iteration, like the condition.
      stmtExprs(s.init).forEach((e) => visit(e, false));
      stmtExprs(s.inc).forEach((e) => visit(e, true));
    }
    for (const child of childLists(s)) {
      collect(child, globals, out, [...path, child], [...loop, isLoop], [...idxPath, i]);
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
 *  Null is NOT a decline any more: the caller falls through to `deepestCluster`. Kept as a distinct
 *  answer because "one scope holds everything" is the better shape when it exists — every use is
 *  named, not just a cluster. The consolidation this file still owes would make both of these one
 *  selector parameter over a single collected index. */
function commonScope(uses: Site[]): { scope: Stmt[]; depth: number } | null {
  const first = uses[0].path;
  let depth = 0;
  while (depth < first.length && uses.every((u) => u.path[depth] === first[depth])) {
    depth++;
  }
  return depth === 0 ? null : { scope: first[depth - 1], depth };
}

/** The DEEPEST statement list holding 2+ uses, with just those uses — the fallback when no single
 *  scope holds them all.
 *
 *  Ties are broken by first appearance, so emission stays deterministic. Returning a SUBSET is the
 *  whole point: the uses outside the cluster keep their original spelling, which is exactly the
 *  mixed form the compiler produces when it materializes an address in one arm and re-derives it
 *  elsewhere. */
function deepestCluster(all: Site[]): { scope: Stmt[]; depth: number; uses: Site[] } | null {
  const byList = new Map<Stmt[], { depth: number; uses: Site[] }>();
  for (const u of all) {
    u.path.forEach((list, i) => {
      const e = byList.get(list) ?? { depth: i + 1, uses: [] };
      e.uses.push(u);
      byList.set(list, e);
    });
  }
  let best: { scope: Stmt[]; depth: number; uses: Site[] } | null = null;
  for (const [scope, e] of byList) {
    if (e.uses.length >= 2 && (best === null || e.depth > best.depth)) {
      best = { scope, depth: e.depth, uses: e.uses };
    }
  }
  return best;
}

/** Does any use sit inside a LOOP nested below the chosen scope?
 *
 *  OVER-REFUSES in two shapes, deliberately: a `do { … } while (g[1]) ;` body head and a
 *  `for (…; …; i = g[5])` body head both DO run at the flagged cadence, so a hoist there would be
 *  legal. Refusing them costs a missed spelling and nothing else (bench: 0 lost, 0 gained), and the
 *  precise rule needs the loop-DEPTH model an extraction would bring. Otherwise:
 *  the hoist would be loop-invariant code motion to a point the original never had — the
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
  compound = false;
  const globals = addressableGlobals(sfn);
  const found = new Map<
    string,
    { uses: Site[]; sample: Extract<Expr, { k: 'index' }>; constOff: Map<number, number> }
  >();
  collect(sfn.body, globals, found, [], [], []);
  if (compound) {
    return null;
  }

  const fresh = nameAllocator(sfn);
  // key → (scope list identity, local name)
  const plan: { scope: Stmt[]; key: string; name: string; type: IrType; base: LeafBase; before: number }[] = [];
  for (const [key, rec] of found) {
    if (rec.uses.length < 2) {
      continue; // one access re-materializes as cheaply as a named local
    }
    // A constant offset touched 2+ times is a SCALAR re-access at one fixed location (an MMIO
    // read-modify-write, a repeated `*p`), which the compiler re-materializes rather than
    // register-holds. basecse.ts learned this by LOSING the ProcessHBlankWait match to it. Inherited
    // here rather than re-lost — but honestly: the evidence is a `const` MMIO address, and it
    // applies cleanly only to the `addr`/`const` half of this pass's input, which is exactly what
    // basecse refused and left behind. For the `var` (array-global) half basecse never ran, so this
    // is an EXTRAPOLATION, not an inheritance. Conservative direction, so the cost is a missed
    // hoist rather than a wrong one. It also SLIPS on a fixed offset not spelled as a literal —
    // two identical `g[i]` accesses are not tallied — which basecse acknowledges in its own comment
    // and which this pass is MORE exposed to, since it deliberately admits loop-body uses, exactly
    // the input basecse's `inLoop` gate kept away from that hole. rank's `/livebase` takes the
    // OPPOSITE side — it ablates this same rule (LIVEBASE_GATES) for the poll shapes the rule
    // mispredicts — and the differ arbitrates between the two spellings; a decision, not a drift.
    if ([...rec.constOff.values()].some((n) => n >= 2)) {
      continue;
    }
    let at = commonScope(rec.uses);
    let uses = rec.uses;
    if (!at) {
      // The uses span the FUNCTION BODY, so no single scope holds them. Rather than decline, take a
      // scope that holds two or more and name the base for THOSE only, leaving the rest as they
      // were.
      //
      // The selection rule is DEEPEST, with no size term, and that is a real limitation rather than
      // a model of the compiler: a scope with four uses enclosing a nested scope with two will name
      // the TWO and leave the four re-deriving the address. Only ONE cluster is ever served, and
      // when two siblings tie on depth the first-appearing wins — arbitrary, not principled.
      // Largest-cluster-with-deepest-as-tie-break is the better rule; it is a behaviour change and
      // belongs with the placement-selector consolidation, not bolted on here.
      //
      // NOTE this fires for an `addr`/`const` base too — nothing here tests the base kind. That is
      // not a duplicate of basecse's hoist: basecse runs FIRST (see the ordering note in the file
      // header), so any `addr`/`const` base reaching this pass is one basecse already REFUSED.
      const cluster = deepestCluster(rec.uses);
      if (!cluster) {
        continue;
      }
      at = { scope: cluster.scope, depth: cluster.depth };
      uses = cluster.uses;
    }
    if (underNestedLoop(uses, at.depth)) {
      continue;
    }
    const type = T.ptr(scalarTypeForAccess(rec.sample.width, rec.sample.signed));
    // the earliest statement of the scope list that (transitively) holds a use
    // `path` starts EMPTY, so `idx` carries one entry more than `path`: idx[j+1] is the index
    // within path[j]. The scope is path[depth-1], so its index is idx[depth].
    const before = Math.min(...uses.map((u) => u.idx[at.depth]));
    plan.push({ scope: at.scope, key, name: fresh(), type, base: rec.sample.base as LeafBase, before });
  }
  if (plan.length === 0) {
    return null;
  }

  // A plan entry may own only a SUBSET of its key's uses (see deepestCluster), so repointing is
  // scoped: a key becomes active when the rewrite enters its scope and inactive on the way out.
  // Repointing by key alone would rewrite uses the hoist does not dominate.
  // SAFE ONLY because `plan` holds at most one entry per key, so `delete` on the way out cannot
  // discard an outer binding. Serving a second cluster for one key — the obvious next step — makes
  // that false, and an inner delete would silently unbind the outer one for the rest of its scope:
  // a use of an unassigned pointer, the defect class this module has already shipped twice. Switch
  // to save/restore (or pass the bindings as an argument) before serving more than one cluster.
  const active = new Map<string, string>();
  const point = (e: Expr): Expr => {
    const ix = eligible(e, globals);
    if (ix) {
      const nm = active.get(keyOf(ix));
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
    // SAVE/RESTORE, not set/delete. A plain delete on the way out is correct only while `plan`
    // holds one entry per key; the moment a second cluster for one key is served, an inner exit
    // would unbind an OUTER hoist for the rest of its scope — under-repointing silently. Restoring
    // makes the nesting correct by construction instead of by an unguarded invariant.
    const saved = here.map((p) => [p.key, active.get(p.key)] as const);
    for (const p of here) {
      active.set(p.key, p.name);
    }
    const rewritten = list.map(rewriteStmt);
    for (const [key, prev] of saved) {
      if (prev === undefined) {
        active.delete(key);
      } else {
        active.set(key, prev);
      }
    }
    // Insert each hoist immediately before the first statement that uses it. Descending by index so
    // earlier insertions do not shift the positions later ones were computed against. NOTE that two
    // hoists sharing a `before` come out REVERSED relative to `plan` order — the sort is stable and
    // descending, so both splice at the same index and the later one ends up first. Deterministic
    // and semantically irrelevant, but it is not first-appearance order, which this comment used to
    // claim.
    for (const p of [...here].sort((a, b) => b.before - a.before)) {
      rewritten.splice(p.before, 0, {
        k: 'assign',
        name: p.name,
        // The always-valid form: `(T *)&gSym` is byte-identical under ANY declaration of gSym, which
        // is why it is also what `bareArrayLead` falls back to. A `const` base keeps its literal.
        value: { k: 'cast', to: p.type, e: p.base.k === 'const' ? p.base : { k: 'addr', name: p.base.name } },
      });
    }
    return rewritten;
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
  // Declared from `plan`, one per hoist — NOT accumulated inside `rewriteList`, which would emit a
  // duplicate declaration (non-compiling C) if a `Stmt[]` were ever structurally shared by two tree
  // positions.
  return { ...sfn, body, locals: [...sfn.locals, ...plan.map((p) => ({ name: p.name, type: p.type }))] };
}
