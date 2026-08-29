// L3 re-spelling lever: name a reused global base in a pointer local placed by SCOPE rather than at
// the function top. Two region rules ship, one pass and one collected index behind them:
//
//   `/scopebase`   ONE local for a key, at the innermost list holding all of its uses (else the
//                  deepest cluster of two).
//   `/regionbase`  ONE LOCAL PER REGION — a base the source spells inside N disjoint regions is N
//                  locals. agbcc discriminates on how many distinct locals with disjoint live
//                  ranges exist, NOT on where they are declared: the three-at-function-top spelling
//                  and the three-block-scoped one assemble byte-identically. So there is no nested
//                  declaration block here and none is needed — the locals are declared at function
//                  top and only their ASSIGNMENTS are placed per region.
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
// A LEVER, not a rewrite: both region rules are emitted as ADDITIONAL candidates (rank.ts
// `/scopebase`, `/regionbase`) with the differ refereeing, so the un-hoisted spelling is always
// still in the list and neither can cost a match.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION. The hoisted value is a pure ADDRESS of a global — no
// load, nothing observable, nothing that can fault — so evaluating it earlier in a scope that
// DOMINATES every use is invisible. The rewritten accesses keep their own width/signedness, so
// every stride is unchanged. Domination is the load-bearing half, and it is CHECKED rather than
// argued: `assertHoistsDominate` re-walks the emitted tree, because an access repointed at a local
// whose assignment does not reach it compiles, scores, and can WIN, and no stage-boundary contract
// sees it (they check resolution, deref typing, and whether a local is written ANYWHERE).
//
// ORDERING: `hoistBaseLocals` (basecse) runs unconditionally in `structureChecked`, BEFORE
// rank's levers see the tree. So this pass's `addr`/`const` input is what basecse's DEFAULT table
// refused — EVERY gate in it, single-use bases as much as loop and repeated-constant-offset ones —
// which is why `SCOPEBASE_GATES` re-states basecse's rules rather than assuming those bases never
// arrive.
import { ContractError } from '../contracts';
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtExprs } from './ast';
import { type Gate, firstRejection } from './gates';
import { nameAllocator } from './hoist';
import { addressableGlobals } from './storage';

/** A base this lever may name: a leaf whose value is a fixed address. */
type LeafBase = Extract<Expr, { k: 'addr' } | { k: 'const' } | { k: 'var' }>;

/** THE identity of a base — what makes two accesses "the same address".
 *
 *  A global reaches L3 under two spellings, `addr g` and the bare `var g`, and they denote the same
 *  cell; keying on the NAME alone means a function that mixes them still sees one base. */
const baseId = (b: LeafBase): string => (b.k === 'const' ? `c:${b.value}` : `n:${b.name}`);

/** One candidate ACCESS, as the eligibility rules see it. */
export interface AccessCtx {
  readonly base: LeafBase;
  readonly lead: readonly number[] | undefined;
  /** the names declared as GLOBALS in this function — a local or param of the same name is absent */
  readonly addressable: ReadonlySet<string>;
}

/** Which accesses this lever may re-point. BOTH rules are SOUND: each one, removed, makes the
 *  rewrite name DIFFERENT BYTES — C that compiles, type-checks and scores, which is the failure
 *  mode nothing downstream catches.
 *
 *  `lead` pins the leading subscripts of a multidimensional array, so `g[1][i]` is a whole ROW past
 *  `g[0][i]`; the hoisted local points at the START of the object and the rewrite DROPS the lead.
 *  (Today `bareArrayLead` only ever emits zeros; the guard is what keeps that an implementation
 *  detail rather than a correctness dependency.)
 *
 *  A `var` base is admitted ONLY for a name in `SFn.globals`. That list is populated by `noteGlobal`
 *  alone (two call sites in structure.ts, both on the `bareArrayLead` path, which requires
 *  `shape === 'array'`) — so a `var` base here is always an ARRAY-declared global and `(T *)&gSym`
 *  is its start address under any declaration. For a POINTER-shaped global `(T *)&gPtr` names the
 *  pointer CELL rather than the object it points at; for a LOCAL it names a cell something may
 *  assign between the hoist point and a use. */
export const SCOPEBASE_ELIGIBILITY: readonly Gate<AccessCtx>[] = [
  {
    id: 'nonzero-lead',
    why: 'the rewrite drops `lead`, so a non-zero one would name a different array row',
    sound: true,
    guardedBy: 'scopebase.test.ts: a NON-ZERO lead is refused',
    rejects: (c) => (c.lead ?? []).some((n) => n !== 0),
  },
  {
    id: 'shadowed-or-nonarray-base',
    why: '`&name` on a local or a pointer-shaped global names a different object',
    sound: true,
    guardedBy: 'addr-placement.test.ts: scopebase declines the shadowed name rather than take its address',
    rejects: (c) => c.base.k === 'var' && !c.addressable.has(c.base.name),
  },
];

/** An access this lever may re-point, or null. */
function eligible(
  e: Expr,
  globals: ReadonlySet<string>,
  rules: readonly Gate<AccessCtx>[],
): Extract<Expr, { k: 'index' }> | null {
  if (e.k !== 'index') {
    return null;
  }
  const b = e.base;
  if (b.k !== 'addr' && b.k !== 'const' && b.k !== 'var') {
    return null;
  }
  return firstRejection(rules, { base: b, lead: e.lead, addressable: globals }) === null ? e : null;
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
  /** the access node itself — what the rewrite repoints, so `collect` and the rewrite cannot
   *  disagree about which uses a plan entry owns */
  node: Extract<Expr, { k: 'index' }>;
}

/** Set when the tree holds a shape `collect` and `rewriteStmt` would disagree about — see the
 *  `for`-part note below. The pass then declines outright. */
let compound = false;

/** Set when one `index` OBJECT sits at two tree positions. The rewrite repoints by node identity,
 *  so a shared node is one plan entry claiming two uses it need not dominate; nothing in the L3
 *  contract forbids the sharing and no producer emits it, so the pass declines the whole function.
 *  Not a `Gate`: it refuses the FUNCTION, and `firstRejection` has no ctx for that. */
let sharedNode = false;

/** Walk every expression in the tree, recording each eligible access's key and its scope path. */
function collect(
  body: Stmt[],
  globals: ReadonlySet<string>,
  out: Map<string, { uses: Site[]; sample: Extract<Expr, { k: 'index' }> }>,
  path: Stmt[][],
  loop: boolean[],
  idxPath: number[],
  rules: readonly Gate<AccessCtx>[],
  seenNodes: Set<Expr>,
): void {
  let at = 0;
  const visit = (e: Expr, perIteration: boolean): void => {
    const ix = eligible(e, globals, rules);
    if (ix) {
      if (seenNodes.has(ix)) {
        sharedNode = true;
      }
      seenNodes.add(ix);
      const k = keyOf(ix);
      const rec = out.get(k) ?? { uses: [], sample: ix };
      rec.uses.push({ path, loop, perIteration, idx: [...idxPath, at], node: ix });
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
      collect(child, globals, out, [...path, child], [...loop, isLoop], [...idxPath, i], rules, seenNodes);
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

/** `'whole'`'s fallback: the DEEPEST statement list holding 2+ uses, with just those uses.
 *
 *  Ties are broken by first appearance, so emission stays deterministic. Returning a SUBSET is the
 *  whole point: the uses outside the cluster keep their original spelling, which is exactly the
 *  mixed form the compiler produces when it materializes an address in one arm and re-derives it
 *  elsewhere.
 *
 *  DEEPEST with no size term, and that is a limitation rather than a model of the compiler: a scope
 *  with four uses enclosing a nested scope with two names the TWO and leaves the four re-deriving
 *  (pinned in test/scopebase.test.ts). Only ONE cluster is ever served here — serving all of them
 *  is what `'per-region'` does, under its own admission table.
 *
 *  Its uses are RESIDUAL — a list's entry holds every use beneath it, not just its direct ones —
 *  which is why `regionsOf` builds its partition itself rather than reusing this. */
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

/** How a key's uses are cut into REGIONS — the one axis this pass now varies.
 *
 *  `'whole'` names a key ONCE: the innermost list holding every use, else the deepest cluster of
 *  two. `'per-region'` partitions the uses by their INNERMOST ENCLOSING LIST and serves every
 *  surviving partition, which is what a source spelling the same base inside N disjoint regions
 *  looks like. */
export type RegionSelector = 'whole' | 'per-region';

interface Region {
  scope: Stmt[];
  depth: number;
  uses: Site[];
}

/** DIRECT uses only, and the FUNCTION BODY is a region like any other.
 *
 *  Not the residual-subtree rule (a list's entry holding every use beneath it, which is what
 *  `deepestCluster` builds): under that rule the body region holds the arms' uses too, and the
 *  loop and offset rules then judge a region on uses that are not in it. Not an ANTICHAIN of
 *  scope-disjoint regions either — the body list encloses both arms and is served anyway. What
 *  separates a region from the ones nested in it is only which uses are direct.
 *
 *  The synthetic depth-0 entry is why `collect`'s `path` is NOT seeded with `sfn.body`: `idx`
 *  carries one entry more than `path` and `before` reads `idx[depth]` through that invariant, so
 *  re-seeding would shift it for every key in every function. A region at depth 0 reads `idx[0]`,
 *  which is already the index within the body. */
function regionsOf(all: Site[], body: Stmt[], selector: RegionSelector): Region[] {
  if (selector === 'whole') {
    const at = commonScope(all);
    if (at) {
      return [{ scope: at.scope, depth: at.depth, uses: all }];
    }
    const cluster = deepestCluster(all);
    return cluster ? [cluster] : [];
  }
  const byList = new Map<Stmt[], Region>();
  for (const u of all) {
    const depth = u.path.length;
    const scope = depth === 0 ? body : u.path[depth - 1];
    const e = byList.get(scope) ?? { scope, depth, uses: [] };
    e.uses.push(u);
    byList.set(scope, e);
  }
  // insertion order — first appearance of each region, so emission stays deterministic
  return [...byList.values()];
}

/** The two loop facts, split apart because they are two different rules with two different
 *  arguments — see the gate table.
 *
 *  `perIteration` OVER-REFUSES in two shapes, deliberately: a `do { … } while (g[1]) ;` body head
 *  and a `for (…; …; i = g[5])` body head both DO run at the flagged cadence, so a hoist there
 *  would be legal. Refusing them costs a missed spelling and nothing else (bench: 0 lost, 0
 *  gained), and the precise rule needs a loop-DEPTH model. When EVERY use is inside the loop the
 *  scope IS the loop body: the assignment then runs per iteration exactly as the inline spelling
 *  did, and `nestedLoop` is false — there is nothing to refuse. */
/** Is some literal offset reached twice among these uses? Tallied from the SITES, so the answer is
 *  scoped by whichever set the caller judges — the key's, or one region's. */
function repeatsAConstOffset(uses: Site[]): boolean {
  const seen = new Set<number>();
  for (const u of uses) {
    const i = u.node.idx;
    if (i.k === 'const') {
      if (seen.has(i.value)) {
        return true;
      }
      seen.add(i.value);
    }
  }
  return false;
}

/** Base ids a FUNCTION-TOP statement already assigns to a local — `q = (T *)&g;`. A region local
 *  for one of these is a second name for an address the function already holds. */
function homedBases(body: Stmt[]): Set<string> {
  const out = new Set<string>();
  for (const st of body) {
    if (st.k === 'assign' && st.value.k === 'cast') {
      const e = st.value.e;
      if (e.k === 'const' || e.k === 'addr' || e.k === 'var') {
        out.add(baseId(e));
      }
    }
  }
  return out;
}

const runsPerIteration = (uses: Site[]): boolean => uses.some((u) => u.perIteration);
const underNestedLoop = (uses: Site[], depth: number): boolean => uses.some((u) => u.loop.slice(depth).some(Boolean));

/** One candidate REGION, as the admission rules see it. */
export interface RegionCtx {
  /** how many uses the local would serve */
  readonly uses: number;
  /** some constant offset is reached twice through this base */
  readonly repeatedConstOffset: boolean;
  /** some use runs at a cadence no reachable scope has — a loop's own condition, a `for`'s inc */
  readonly perIteration: boolean;
  /** some use sits inside a loop nested BELOW the region */
  readonly nestedLoop: boolean;
  /** a FUNCTION-TOP statement already assigns this base to a local */
  readonly keyHomed: boolean;
  /** how many of this key's regions hold two or more direct uses */
  readonly siblingRegions: number;
}

/** The admission rules. NONE is sound: a wrong choice here names the same address in a different
 *  place, so it costs bytes and a match, never meaning — the eligibility table above is where
 *  meaning is at stake, and `rank.ts` keeps the un-hoisted spelling beside every candidate.
 *
 *  `repeated-const-offset` and `nested-loop-use` are inherited from `BASECSE_GATES`, which learned
 *  them by losing the ProcessHBlankWait match and by forcing a callee-saved register across a loop.
 *  `per-iteration-use` is the half of the loop question basecse never faces: this pass places into
 *  a NESTED list, and no reachable list runs at a loop condition's cadence.
 *
 *  `repeated-const-offset` is an EXTRAPOLATION on half this pass's input, and honestly so: the
 *  evidence is a `const` MMIO address, and the `var` (array-global) half is input basecse never
 *  saw. It also SLIPS on a fixed offset not spelled as a literal — two identical `g[i]` accesses
 *  are not tallied. rank's `/livebase` takes the OPPOSITE side, ablating the same rule in
 *  `LIVEBASE_GATES` for the poll shapes it mispredicts, and the differ arbitrates. */
export const SCOPEBASE_GATES: readonly Gate<RegionCtx>[] = [
  {
    id: 'single-use',
    why: 'one access re-materializes as cheaply as a named local',
    sound: false,
    rejects: (c) => c.uses < 2,
  },
  {
    id: 'repeated-const-offset',
    why: 'a fixed offset touched twice is a scalar RMW, which the compiler re-materializes',
    sound: false,
    rejects: (c) => c.repeatedConstOffset,
  },
  {
    id: 'per-iteration-use',
    why: 'no scope reachable from the use runs at a loop condition or `for` inc cadence',
    sound: false,
    rejects: (c) => c.perIteration,
  },
  {
    id: 'nested-loop-use',
    why: 'hoisting out of a nested loop is code motion to a point the original never had',
    sound: false,
    rejects: (c) => c.nestedLoop,
  },
];

/** `/regionbase`'s admission (rank.ts): `SCOPEBASE_GATES` plus two rules that exist only once a key
 *  can hold MORE THAN ONE local. Both are honest fan savings, not codegen models — measured at zero
 *  on the rows they were written against — and both are stated that way rather than credited with a
 *  match they do not protect.
 *
 *  `regions-degenerate` counts regions holding two or more DIRECT uses, which is exactly
 *  `single-use` applied region-wise and so is computable before any gate runs. One such region is
 *  the function-top question `basecse`/`/livebase`/`/scopebase` already answer, so serving it here
 *  adds a spelling those levers already offer.
 *
 *  `key-already-homed` is NOT in `SCOPEBASE_GATES`, deliberately: it would change what `/scopebase`
 *  emits, and a rule worth zero points may not risk a shipped match to say so. */
export const REGIONBASE_GATES: readonly Gate<RegionCtx>[] = [
  ...SCOPEBASE_GATES,
  {
    id: 'regions-degenerate',
    why: 'one region is the function-top hoist basecse and /livebase already offer',
    sound: false,
    rejects: (c) => c.siblingRegions < 2,
  },
  {
    id: 'key-already-homed',
    why: 'region locals buy nothing while a function-scope local still holds the same base',
    sound: false,
    rejects: (c) => c.keyHomed,
  },
];

/** `regions` picks the region rule and is the only field a caller passes in production
 *  (`'per-region'` is `/regionbase`). The two tables are for ABLATION — the differentials in
 *  test/scopebase.test.ts re-run the real pass with one rule dropped — and default to the pair the
 *  selector implies. */
export interface ScopeBaseOpts {
  readonly regions?: RegionSelector;
  readonly eligibility?: readonly Gate<AccessCtx>[];
  readonly gates?: readonly Gate<RegionCtx>[];
}

/** Every read of a minted local must sit where that local's assignment has already run.
 *
 *  THE failure this pass can ship, and the only one the byte differ rewards: a base local whose
 *  assignment does not reach a use is a DIFFERENT VARIABLE — C that compiles, scores, and can win
 *  (the shape #106 shipped). `contracts.ts`'s `assertLocalsWritten` does not see it: it accumulates
 *  reads and writes as SETS over the whole body, so a local assigned in one arm and read after the
 *  `if` is written somewhere and passes.
 *
 *  Checked on the EMITTED tree rather than argued from the plan, because the plan is what a bug
 *  would be in. `rank.ts`'s `respell` catches the throw and drops the candidate, so the wrong
 *  answer becomes a reported lever error instead of a scored spelling. It lives here and not in
 *  `contracts.ts` because a general dominance contract has no other inhabitant: every other L3 pass
 *  places its defs in the list it reads them from.
 *
 *  A nested list gets a COPY of the reaching set, so an assignment inside one arm does not count as
 *  reaching anything after the `if`. */
export function assertHoistsDominate(sfn: SFn, minted: ReadonlySet<string>): void {
  if (minted.size === 0) {
    return;
  }
  const readUndominated = (e: Expr, live: ReadonlySet<string>): string | null => {
    if (e.k === 'var' && minted.has(e.name) && !live.has(e.name)) {
      return e.name;
    }
    let bad: string | null = null;
    mapExprChildren(e, (c) => {
      bad ??= readUndominated(c, live);
      return c;
    });
    return bad;
  };
  const walk = (list: Stmt[], live: Set<string>): void => {
    for (const st of list) {
      const heads = st.k === 'for' ? [...stmtExprs(st.init), ...stmtExprs(st), ...stmtExprs(st.inc)] : stmtExprs(st);
      for (const e of heads) {
        const bad = readUndominated(e, live);
        if (bad) {
          throw new ContractError(
            `scopebase read '${bad}' in '${sfn.name}' where its assignment does not reach — ` +
              `a hoist placed below a use it claims to serve`,
          );
        }
      }
      for (const child of childLists(st)) {
        walk(child, new Set(live));
      }
      if (st.k === 'assign' && minted.has(st.name)) {
        live.add(st.name);
      }
    }
  };
  walk(sfn.body, new Set());
}

/** The same guarantee across a STATEMENT-SHAPE re-spelling (`rank.ts`'s `/initfirst`,
 *  `/pollguard`, `/pollread`), which is derived onto every lever tree AFTER this pass has placed
 *  its defs and can therefore move one — `pollReads` folds a materialized re-read back into a loop
 *  condition, a move across the placement computed here.
 *
 *  A DIFFERENTIAL, and that is what makes it safe to apply to every lever rather than this one:
 *  the walk judges the reshaped tree only where it already described the unshaped one, so a
 *  placement it cannot model (a def inside a loop body read earlier in the same body is assigned
 *  on every iteration but the first) is not judged by it either way. */
export function assertPlacementSurvives(before: SFn, after: SFn, minted: ReadonlySet<string>): void {
  if (minted.size === 0) {
    return;
  }
  try {
    assertHoistsDominate(before, minted);
  } catch {
    return;
  }
  assertHoistsDominate(after, minted);
}

/**
 * The re-spelling `regions` asks for — `/scopebase` or `/regionbase` — or null when nothing
 * qualifies (the caller then adds no candidate rather than a duplicate of the primary).
 */
export function hoistScopedBases(sfn: SFn, opts: ScopeBaseOpts = {}): SFn | null {
  const rules = opts.eligibility ?? SCOPEBASE_ELIGIBILITY;
  const selector = opts.regions ?? 'whole';
  const gates = opts.gates ?? (selector === 'per-region' ? REGIONBASE_GATES : SCOPEBASE_GATES);
  compound = false;
  sharedNode = false;
  const globals = addressableGlobals(sfn);
  const found = new Map<string, { uses: Site[]; sample: Extract<Expr, { k: 'index' }> }>();
  collect(sfn.body, globals, found, [], [], [], rules, new Set());
  if (compound || sharedNode) {
    return null;
  }

  const fresh = nameAllocator(sfn);
  // one entry per (key, admitted region) — several for one key under `'per-region'`
  const plan: { scope: Stmt[]; key: string; name: string; type: IrType; base: LeafBase; before: number }[] = [];
  // access node → the local that replaces its base. Built from the SITES a plan entry was judged
  // on, so the set the planner counted and the set the rewrite repoints are the same set by
  // construction rather than by a second predicate that could disagree.
  const repoint = new Map<Expr, string>();
  const homed = homedBases(sfn.body);
  for (const [key, rec] of found) {
    const regions = regionsOf(rec.uses, sfn.body, selector);
    const siblingRegions = regions.filter((r) => r.uses.length >= 2).length;
    for (const r of regions) {
      // `'whole'` judges the count and the offset tally over the KEY and the loop facts over the
      // chosen region — the scoping this pass has always used, and the cluster case is why: its
      // region is a SUBSET of the key's uses. `'per-region'` judges every rule over the region's
      // own direct uses, a REFINEMENT and not a relaxation — an offset repeated INSIDE one region
      // is still repeated. Nothing here tests the base kind: an `addr`/`const` base reaching this
      // pass is one basecse already REFUSED (see the ordering note in the file header).
      const judged = selector === 'per-region' ? r.uses : rec.uses;
      if (
        firstRejection(gates, {
          uses: judged.length,
          repeatedConstOffset: repeatsAConstOffset(judged),
          perIteration: runsPerIteration(r.uses),
          nestedLoop: underNestedLoop(r.uses, r.depth),
          keyHomed: homed.has(baseId(rec.sample.base as LeafBase)),
          siblingRegions,
        }) !== null
      ) {
        continue;
      }
      const type = T.ptr(scalarTypeForAccess(rec.sample.width, rec.sample.signed));
      // the earliest statement of the region list that (transitively) holds one of its uses.
      // `path` starts EMPTY, so `idx` carries one entry more than `path`: idx[j+1] is the index
      // within path[j]. The region is path[depth-1], so its index is idx[depth] — and idx[0] for
      // the depth-0 body region.
      const before = Math.min(...r.uses.map((u) => u.idx[r.depth]));
      const name = fresh();
      r.uses.forEach((u) => repoint.set(u.node, name));
      plan.push({ scope: r.scope, key, name, type, base: rec.sample.base as LeafBase, before });
    }
  }
  if (plan.length === 0) {
    return null;
  }

  const point = (e: Expr): Expr => {
    const nm = repoint.get(e);
    if (nm) {
      // `lead` is DROPPED — the local already points at the object start, and `nonzero-lead` has
      // established every leading subscript is 0.
      const { lead: _drop, ...rest } = e as Extract<Expr, { k: 'index' }>;
      return { ...rest, base: { k: 'var', name: nm }, idx: point(rest.idx) };
    }
    return mapExprChildren(e, point);
  };

  // Rebuild the tree, inserting each hoist at the head of its own scope list. Statement lists are
  // matched by IDENTITY against the ORIGINAL tree, so the rewrite walks the original and emits a
  // fresh tree in one pass — a two-pass version would compare rebuilt lists that no longer match.
  const rewriteList = (list: Stmt[]): Stmt[] => {
    const here = plan.filter((p) => p.scope === list);
    const rewritten = list.map(rewriteStmt);
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
  const out = { ...sfn, body, locals: [...sfn.locals, ...plan.map((p) => ({ name: p.name, type: p.type }))] };
  assertHoistsDominate(out, new Set(plan.map((p) => p.name)));
  return out;
}
