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
//                  top and only their ASSIGNMENTS are placed per region. That compiler fact is
//                  PINNED rather than asserted: packages/cli/test/matching/decl-scope-axis.test.ts
//                  compiles both spellings through the project's own agbcc and compares the object
//                  bytes, and compiles a count-collapsed third spelling to show the COUNT is not
//                  free either.
//
// The lever earns its place: returning `null` from `hoistScopedBases` costs
// kleod:UpdateHUDCounterDisplay its match, so the benchmark's zero-lost gate guards this file.
//
// `l3/basecse.ts` already hoists a reused leaf base — at three positions now, of which two are in
// the TOP-LEVEL statement list (the function top, or an init's first use where a roster row asks
// `l3/hoist.ts` for that) — and only for an `addr`/`const` base. What is left to this file is one
// half of the placement question and the whole of eligibility:
//
//   PLACEMENT — NARROWED, NOT OWNED. A base used only inside one `if` arm is live across everything
//   before that arm under either of basecse's FLAT positions — a live range the original never had,
//   which is the register-pressure failure basecse's own loop gate exists for. First-use placement
//   narrows that range and does not close it: the init still lands ABOVE the `if`. `l3/hoist.ts`'s
//   third placement, `scope`, now does close it for the run basecse places, so "into a nested list"
//   is no longer this file's alone; what stays here is the base this file can SEE (below) and the
//   COUNT question (`REGION_RULES`), which no placement answers. That argument is why the lever is
//   scope-aware; it is NOT a claim about what the lever achieves, and no committed measurement
//   separates basecse's two flat placements (the one that did edited a reference source by hand and
//   cannot be re-run). On kleod:UpdateHUDCounterDisplay the primary path declines outright (a later
//   pass retired the phi it keyed on, so the base's uses span the function body), and the cluster
//   fallback below is what recovers it. basecse's header names a LOOP-BODY base as left inline for
//   a future scope-aware hoist, and this is that hoist: `scope` cannot serve one, because every
//   gate table paired with it keeps the `loop` rule that refuses the base outright.
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
import { assertHoistsDominate } from '../contracts';
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtExprs, stmtLists } from './ast';
import { type Gate, ablateHeuristic, firstRejection } from './gates';
import { nameAllocator, takenNames } from './hoist';
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
  readonly lead: readonly Expr[] | undefined;
  /** the names declared as GLOBALS in this function — a local or param of the same name is absent */
  readonly addressable: ReadonlySet<string>;
}

/** Which accesses this lever may re-point. BOTH rules are SOUND: each one, removed, makes the
 *  rewrite name DIFFERENT BYTES — C that compiles, type-checks and scores, which is the failure
 *  mode nothing downstream catches.
 *
 *  `lead` pins the leading subscripts of a multidimensional array, so `g[1][i]` is a whole ROW past
 *  `g[0][i]`; the hoisted local points at the START of the object and the rewrite DROPS the lead.
 *  A subscript that is not the literal 0 — a recovered row index included — is therefore refused.
 *
 *  A `var` base is admitted ONLY for a name in `SFn.globals`. That list is populated by `noteGlobal`
 *  alone — three call sites in structure.ts (`declaredSubscripts`' recovered subscripts, and
 *  `bareArrayLead`'s rank-pinned form on each of the byte-address and element-index paths) — and
 *  the guarantee is not the count but what they SHARE: all three are gated on
 *  `structure/globalaccess.ts`'s `bareArrayElement`, which requires `shape === 'array'`. So a `var`
 *  base here is always an ARRAY-declared global and `(T *)&gSym` is its start address under any
 *  declaration, and a fourth spelling added there inherits that only by going through the same
 *  gate. For a POINTER-shaped global `(T *)&gPtr` names the
 *  pointer CELL rather than the object it points at; for a LOCAL it names a cell something may
 *  assign between the hoist point and a use. */
export const SCOPEBASE_ELIGIBILITY: readonly Gate<AccessCtx>[] = [
  {
    id: 'nonzero-lead',
    why: 'the rewrite drops `lead`, so a non-zero one would name a different array row',
    sound: true,
    guardedBy: 'scopebase.test.ts: a NON-ZERO lead is refused',
    rejects: (c) => (c.lead ?? []).some((n) => !(n.k === 'const' && n.value === 0)),
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
const keyOf = (n: Extract<Expr, { k: 'index' }>): string => scopedBaseKey(n.base as LeafBase, n.width, n.signed);

/** The same key, from a base a DIFFERENT pass is holding. `l3/basecse.ts` spells an `addr` base's
 *  identity `a:name` where this one spells it `n:name` (it shares that spelling with the bare `var`
 *  the rank-aware lift produces, which denotes the same cell), so a caller crossing between the two
 *  translates through this rather than comparing strings that can never match. */
export const scopedBaseKey = (b: LeafBase, width: number, signed: boolean): string => `${baseId(b)} ${width} ${signed}`;

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
  sharedKeys: Set<string>,
): void {
  let at = 0;
  const visit = (e: Expr, perIteration: boolean): void => {
    const ix = eligible(e, globals, rules);
    if (ix) {
      const k = keyOf(ix);
      if (seenNodes.has(ix)) {
        sharedKeys.add(k);
      }
      seenNodes.add(ix);
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
      if (stmtLists(s.init).length > 0 || stmtLists(s.inc).length > 0) {
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
    for (const child of stmtLists(s)) {
      collect(child, globals, out, [...path, child], [...loop, isLoop], [...idxPath, i], rules, seenNodes, sharedKeys);
    }
  }
}

/** The innermost statement list common to every use, or null when they span the function body.
 *
 *  Null is NOT a decline any more: the caller falls through to `deepestCluster`. Kept as a distinct
 *  answer because "one scope holds everything" is the better shape when it exists — every use is
 *  named, not just a cluster. The consolidation this file still owes would make both of these one
 *  selector parameter over a single collected index.
 *
 *  A THIRD ANSWER TO THE SAME QUESTION now exists and is booked here rather than left for a reader
 *  to collide with: `l3/hoist.ts`'s `scopeSite` finds the innermost list holding every MENTION of a
 *  minted local, top-down, with no cluster fallback. The two are not merged, and the reason is the
 *  domain rather than the algorithm — this one partitions the ACCESSES of a base key it is about to
 *  repoint, that one places a statement whose local already exists, so a shared implementation
 *  would take the collected index this file owes anyway. THE ONE DIVERGENCE TO CARRY INTO THAT
 *  EXTRACTION is the `for` reading recorded in `collect`: a `for`'s `init` counts at the enclosing
 *  cadence here and in-loop there (`stmtChildren`), and only the older pair's two readings are
 *  pinned (test/addr-placement.test.ts). The new one is pinned only for the answer it gives —
 *  `init`/`inc` are statements no list holds, so a mention in either stops the descent
 *  (test/sinkinit.test.ts) — which is the same conclusion by a different route and not a check that
 *  the two agree. */
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

/** How a key's uses are cut into REGIONS — the one axis this pass varies. Names a `REGION_RULES`
 *  entry; it is the only field a production caller passes. */
export type RegionSelector = 'whole' | 'per-region';

interface Region {
  scope: Stmt[];
  depth: number;
  uses: Site[];
}

/** `'whole'`'s partition: ONE region for the key — the innermost list holding every use, else the
 *  deepest cluster of two. `body` is unused; the signature is the RULE's, so both partitions are
 *  one type and the selector can be a value. */
function wholeRegion(all: Site[], _body: Stmt[]): Region[] {
  const at = commonScope(all);
  if (at) {
    return [{ scope: at.scope, depth: at.depth, uses: all }];
  }
  const cluster = deepestCluster(all);
  return cluster ? [cluster] : [];
}

/** `'per-region'`'s partition: one region per INNERMOST ENCLOSING LIST, and every partition is
 *  served. DIRECT uses only, and the FUNCTION BODY is a region like any other.
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
function perRegions(all: Site[], body: Stmt[]): Region[] {
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
  /** how many of this key's regions hold two or more direct uses */
  readonly siblingRegions: number;
}

/** The rules judged over a POPULATION OF USES — the half the region rule re-reads. Split out
 *  because that is what `perRegionReading` below renames, so a fourth counting rule is renamed by
 *  construction instead of by remembering to extend a list of ids. */
const COUNTING_RULES: readonly Gate<RegionCtx>[] = [
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
];

/** The rules judged over the REGION's own loop facts, which every region rule reads the same way
 *  (`RegionRule.judged` says why: no reachable scope answers for a use outside the region). */
const LOOP_RULES: readonly Gate<RegionCtx>[] = [
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
 *  `LIVEBASE_GATES` for the poll shapes it mispredicts, and the differ arbitrates.
 *
 *  MEASURED REACH, so a reader prices these from evidence rather than from the table's existence.
 *  Instrumented census over the klonoa corpus with no symbol map (469 `.s`, 257 lifting functions),
 *  every rule evaluated on every admission context the pass builds. `any` counts the contexts a
 *  rule rejects; `first` the ones where it is the DECIDING rejection, which is the only column that
 *  prices it — `firstRejection` short-circuits, so a rule that is never first changes no decision.
 *  `relaxed` re-asks `first` with the counting rules dropped, which is what separates a rule that
 *  decides nothing from one MASKED by the two that precede it:
 *
 *      table   contexts    rule                            any     first   relaxed
 *      SB        79880     single-use                    24268     24268         —
 *                          repeated-const-offset         54120     54120         —
 *                          per-iteration-use              8784         0      8784
 *                          nested-loop-use                6560       656      4768
 *      RB       512760     region-single-use            393153    393153         —
 *                          region-repeated-const-offset  94857     94857         —
 *                          per-iteration-use             32586         0     32586
 *                          regions-degenerate           353352       846    331530
 *
 *  So `per-iteration-use` decides nothing on this corpus in either table, and ablating it moves no
 *  gating row. It is kept, and the `relaxed` column is why: every context it rejects it would
 *  decide, the moment a counting rule stopped rejecting first. Dropping a masked rule is a change
 *  one corpus licenses; `nested-loop-use` left the region table on a proof that it CANNOT fire
 *  there, which is a different standard and the one this file holds. */
export const SCOPEBASE_GATES: readonly Gate<RegionCtx>[] = [...COUNTING_RULES, ...LOOP_RULES];

/** A counting rule's PER-REGION reading. Same predicate, different POPULATION — under `'whole'` it
 *  is judged over the KEY's uses (the cluster fallback serves a SUBSET of them, so the two really
 *  do differ), under `'per-region'` over one region's direct uses. One id naming two predicates
 *  makes `without(table, id)` two different ablations and a price table ambiguous about which
 *  reading it priced, so the per-region reading gets its own id. */
const perRegionReading = (g: Gate<RegionCtx>): Gate<RegionCtx> => ({
  ...g,
  id: `region-${g.id}`,
  why: `${g.why} — judged over ONE region's direct uses`,
});

/** `/regionbase`'s admission (rank.ts): the per-region readings of `SCOPEBASE_GATES`, MINUS the one
 *  rule the region rule makes vacuous, plus the one that exists only once a key can hold MORE THAN
 *  ONE local.
 *
 *  `nested-loop-use` CANNOT FIRE under `'per-region'` and is dropped rather than left in the table
 *  reading as safety. `perRegions` sets a region's `depth` to `u.path.length`, and a region is
 *  exactly the uses whose innermost enclosing list IS that region — so `u.loop.slice(depth)` is
 *  the empty slice for every use it judges, and "a use under a loop BELOW the region" is a shape
 *  the partition cannot produce. A use inside a nested loop is its own region, at its own depth.
 *  Measured on the PREDICATE, not on table membership, since a rule the table no longer holds
 *  cannot be censused through it: over the corpus census above, `underNestedLoop` is true on 0 of
 *  512760 `'per-region'` contexts and on 6560 of 79880 `'whole'` ones, where the rule stays in
 *  `SCOPEBASE_GATES` and is load-bearing.
 *
 *  `regions-degenerate` is a FAN SAVING, not a codegen model: it counts regions holding two or
 *  more DIRECT uses, which is `single-use` applied region-wise and so is computable before any
 *  gate runs. Its saving is USUALLY a duplicate — one such region is the function-top question
 *  `basecse`/`/livebase`/`/scopebase` already answer — but not always, and this pass produces the
 *  counterexample: one arm with three direct uses plus a nested loop holding a fourth is refused
 *  under `'whole'` by `nested-loop-use` and here by this rule, and ablating it alone is the only
 *  way to reach the hoist (test/regionbase.test.ts). A heuristic, and the differ referees what it
 *  admits.
 *
 *  ONE RULE HERE IS PRICED BY A ROW; three are not. Ablating `region-single-use` moves
 *  `synthetic:dmascope` — the lever's own row — from 9 to 30, so it is worth 21 there, while
 *  `region-repeated-const-offset`, `per-iteration-use` and `regions-degenerate` each leave all five
 *  gating rows exactly where they stand. The OVER-SCOPING controls (`synthetic:dmascope1`,
 *  `synthetic:offhi_fused`) must stay MATCH but can price nothing here: censused on their own
 *  disassembly, `dmascope1` enumerates 6 candidates with 0 carrying `/regionbase` and
 *  `offhi_fused` 12 with 0. The other three are guarded by unit fixtures in test/regionbase.test.ts
 *  and by the reach census above. */
export const REGIONBASE_GATES: readonly Gate<RegionCtx>[] = [
  ...COUNTING_RULES.map(perRegionReading),
  ...ablateHeuristic(LOOP_RULES, 'nested-loop-use'),
  {
    id: 'regions-degenerate',
    why: 'one region is the function-top hoist basecse and /livebase already offer',
    sound: false,
    rejects: (c) => c.siblingRegions < 2,
  },
];

/** THE REGION RULE, as a value. A third rule is one entry here — a partition, a gate table, and
 *  the population its counting rules are judged over — rather than three hand-edited branches in
 *  three functions, which is the same doctrine `rank.ts` states for its own admissions ("one entry
 *  here, one gate table, and that table's line in the gate-contract roster — not nine hand-edited
 *  sites that can drift"). */
export interface RegionRule {
  readonly id: RegionSelector;
  /** how a key's uses are cut into regions */
  readonly partition: (all: Site[], body: Stmt[]) => Region[];
  /** the admission table `hoistScopedBases` uses when no ablation is passed */
  readonly gates: readonly Gate<RegionCtx>[];
  /** the uses the COUNTING rules (`uses`, `repeatedConstOffset`) are tallied over. The loop facts
   *  are always the region's own — no reachable scope answers for a use outside it. */
  readonly judged: (region: Region, key: Site[]) => Site[];
}

export const REGION_RULES: Record<RegionSelector, RegionRule> = {
  // `'whole'` judges the count and the offset tally over the KEY and the loop facts over the
  // chosen region — the scoping this pass has always used, and the cluster case is why: its region
  // is a SUBSET of the key's uses.
  whole: { id: 'whole', partition: wholeRegion, gates: SCOPEBASE_GATES, judged: (_r, key) => key },
  // `'per-region'` judges every rule over the region's own direct uses — a REFINEMENT and not a
  // relaxation: an offset repeated INSIDE one region is still repeated.
  'per-region': { id: 'per-region', partition: perRegions, gates: REGIONBASE_GATES, judged: (r) => r.uses },
};

/** `regions` picks the region rule and is the only field a caller passes in production
 *  (`'per-region'` is `/regionbase`). The other three are for ABLATION and INJECTION — the
 *  differentials in test/scopebase.test.ts re-run the real pass with one rule dropped, and the
 *  ownership contract below is shown load-bearing by a `rule` no production caller passes. All
 *  three default to what the selector implies. */
export interface ScopeBaseOpts {
  readonly regions?: RegionSelector;
  readonly eligibility?: readonly Gate<AccessCtx>[];
  readonly gates?: readonly Gate<RegionCtx>[];
  readonly rule?: RegionRule;
}

/** One admitted region, as the applier and a gating caller both read it. `uses` are the ACCESS
 *  NODES the entry owns — the same set the counting rules were judged over, so the planner and the
 *  rewrite cannot disagree about them. */
export interface ScopedBaseEntry {
  readonly scope: Stmt[];
  readonly key: string;
  readonly name: string;
  readonly type: IrType;
  readonly base: LeafBase;
  /** index within `scope` the init is spliced at — the first statement that (transitively) uses it */
  readonly before: number;
  readonly uses: readonly Expr[];
}

/** What the pass DECIDED, before anything is applied. `applyScopedBasePlan` is the other half: a
 *  caller that has to both COUNT what a key got and rewrite the tree (l3/homesplit.ts) plans once
 *  and applies that same plan, rather than re-deriving the decision from the applied tree. */
export interface ScopedBasePlan {
  /** every eligible key `collect` found, in first-appearance order */
  readonly keys: readonly string[];
  readonly entries: readonly ScopedBaseEntry[];
  /** access node → the local that replaces its base */
  readonly repoint: ReadonlyMap<Expr, string>;
  /** for a key NO region admitted, the id of the rule that refused it first — `'shared-node'` for
   *  the pre-gate refusal `sharedKeys` makes. A key with an entry is absent. */
  readonly refusals: ReadonlyMap<string, string>;
  /** the tree holds the `for`-part shape collect and rewrite disagree about: the pass declines */
  readonly compound: boolean;
}

/** THE OWNERSHIP CONTRACT, and it is deliberately not a `Gate`: it is a property of the whole plan,
 *  decided after every `RegionCtx` has been judged, so there is no admission context to attach it
 *  to — the same reason `sharedKeys` and `compound` are not gates either.
 *
 *  Two properties, one failure each, and NEITHER is a compile error downstream:
 *
 *    • an access node claimed by two entries. `repoint` is a `Map`, so the second `set` WINS and the
 *      access is silently repointed at a local whose assignment need not dominate it — C that
 *      compiles, scores, and names a different variable.
 *    • a minted name that is not fresh. The applier appends `entries`' names to `sfn.locals`
 *      wholesale, so a duplicate emits a duplicate declaration — and freshness is `takenNames`'
 *      reading of it, which is what `nameAllocator` mints against: a name that only shadows a
 *      PARAMETER, or a body assignment no declaration list carries, is a different variable rather
 *      than a duplicate declaration, and that is the failure this contract exists for.
 *
 *  Both fire ZERO times under either shipped region rule (the partitions are node-disjoint, and
 *  `nameAllocator` re-derives its taken names from the tree it is handed — including across the
 *  rank.ts pipe, where the second pass sees the first's mints as taken). They are checks rather
 *  than arguments because a future rule, or a merge of two independently-planned runs, breaks
 *  either one without breaking a type. */
export function assertPlanOwnership(
  sfn: SFn,
  entries: readonly { name: string; key: string; uses?: readonly Expr[] }[],
): void {
  const taken = takenNames(sfn);
  const claimed = new Set<Expr>();
  for (const e of entries) {
    if (taken.has(e.name)) {
      throw new Error(`scopebase: the plan mints \`${e.name}\`, a name the tree already carries (key ${e.key})`);
    }
    taken.add(e.name);
    for (const u of e.uses ?? []) {
      if (claimed.has(u)) {
        throw new Error(`scopebase: an access is claimed by two plan entries (key ${e.key}, local ${e.name})`);
      }
      claimed.add(u);
    }
  }
}

/** What the pass DECIDES for `sfn` under `opts`, with nothing applied. `applyScopedBasePlan` is the
 *  applier and `hoistScopedBases` the two of them in order; a caller that gates a PAIRING on "how
 *  many locals did this key get?" reads the plan and applies THAT one (l3/homesplit.ts). */
export function planScopedBases(sfn: SFn, opts: ScopeBaseOpts = {}): ScopedBasePlan {
  const rules = opts.eligibility ?? SCOPEBASE_ELIGIBILITY;
  const rule = opts.rule ?? REGION_RULES[opts.regions ?? 'whole'];
  const gates = opts.gates ?? rule.gates;
  compound = false;
  const globals = addressableGlobals(sfn);
  const found = new Map<string, { uses: Site[]; sample: Extract<Expr, { k: 'index' }> }>();
  /** The KEYS whose tree holds one `index` OBJECT at two positions. The rewrite repoints by node
   *  identity, so a shared node is one plan entry claiming two uses it need not dominate.
   *
   *  PER KEY, not per function, and the difference is not hypothetical. Nothing in the L3 contract
   *  forbids the sharing — `l3/pollguard.ts` already emits it (`{ k: 'if', cond: s.cond, then: [s] }`
   *  puts one `cond` object at two tree positions), and it is harmless today only because the shapes
   *  are derived AFTER this lever in `rank.ts`, an ordering nothing pins. A whole-function decline
   *  would make a future producer that shares one node silently delete every base this pass names —
   *  including `kleod:UpdateHUDCounterDisplay`'s match, which returning `null` costs. Refusing the
   *  key that actually shares costs that key's spelling and nothing else, and the differ still has
   *  every other spelling in the list.
   *
   *  Not a `Gate`: it is decided during `collect`, before a `RegionCtx` exists. */
  const sharedKeys = new Set<string>();
  collect(sfn.body, globals, found, [], [], [], rules, new Set(), sharedKeys);
  if (compound) {
    return { keys: [...found.keys()], entries: [], repoint: new Map(), refusals: new Map(), compound: true };
  }

  const fresh = nameAllocator(sfn);
  // one entry per (key, admitted region) — several for one key under `'per-region'`
  const entries: ScopedBaseEntry[] = [];
  // INSTRUMENTATION, with no production reader (`grep -rn '\.refusals' packages apps` finds only
  // this constructor): the caller that gates on this pass counts the ENTRIES a key got, and a
  // decline tells it only `not split`. Recorded because the id separates a region that held too few
  // uses from a shape the pass refuses outright, which is what a probe of this pass has to know.
  // `firstRejection` short-circuits, so this is the DECIDING rule.
  const refusals = new Map<string, string>();
  for (const [key, rec] of found) {
    if (sharedKeys.has(key)) {
      refusals.set(key, 'shared-node'); // one node at two positions — see `sharedKeys`
      continue;
    }
    const regions = rule.partition(rec.uses, sfn.body);
    const siblingRegions = regions.filter((r) => r.uses.length >= 2).length;
    let served = false;
    for (const r of regions) {
      // WHICH USES the counting rules are tallied over is the RULE's answer, not a branch here —
      // see `REGION_RULES`. Nothing here tests the base kind: an `addr`/`const` base reaching this
      // pass is one basecse already REFUSED (see the ordering note in the file header).
      const judged = rule.judged(r, rec.uses);
      const refused = firstRejection(gates, {
        uses: judged.length,
        repeatedConstOffset: repeatsAConstOffset(judged),
        perIteration: runsPerIteration(r.uses),
        nestedLoop: underNestedLoop(r.uses, r.depth),
        siblingRegions,
      });
      if (refused !== null) {
        if (!refusals.has(key)) {
          refusals.set(key, refused);
        }
        continue;
      }
      const type = T.ptr(scalarTypeForAccess(rec.sample.width, rec.sample.signed));
      // the earliest statement of the region list that (transitively) holds one of its uses.
      // `path` starts EMPTY, so `idx` carries one entry more than `path`: idx[j+1] is the index
      // within path[j]. The region is path[depth-1], so its index is idx[depth] — and idx[0] for
      // the depth-0 body region.
      const before = Math.min(...r.uses.map((u) => u.idx[r.depth]));
      served = true;
      entries.push({
        scope: r.scope,
        key,
        name: fresh(),
        type,
        base: rec.sample.base as LeafBase,
        before,
        uses: r.uses.map((u) => u.node),
      });
    }
    if (served) {
      refusals.delete(key);
    }
  }
  assertPlanOwnership(sfn, entries);
  // access node → the local that replaces its base. Built from the SITES a plan entry was judged
  // on, so the set the planner counted and the set the rewrite repoints are the same set by
  // construction rather than by a second predicate that could disagree.
  const repoint = new Map<Expr, string>();
  for (const e of entries) {
    e.uses.forEach((u) => repoint.set(u, e.name));
  }
  return { keys: [...found.keys()], entries, repoint, refusals, compound: false };
}

/**
 * The re-spelling `regions` asks for — `/scopebase` or `/regionbase` — or null when nothing
 * qualifies (the caller then adds no candidate rather than a duplicate of the primary).
 */
export const hoistScopedBases = (sfn: SFn, opts: ScopeBaseOpts = {}): SFn | null =>
  applyScopedBasePlan(sfn, planScopedBases(sfn, opts));

/**
 * `plan` applied to the tree it was planned over — null when it decided nothing (the caller then
 * adds no candidate rather than a duplicate of the primary).
 *
 * IDENTITY-BOUND to that tree, and not by the type: `scope` is matched against statement LISTS and
 * `repoint` against access NODES, both by reference. A plan from a DIFFERENT tree therefore splices
 * nothing and repoints nothing while still declaring its locals; `assertLocalsWritten` (rank.ts's
 * `respell`) is what makes that loud rather than a silently wrong candidate.
 */
export function applyScopedBasePlan(sfn: SFn, { entries: plan, repoint, compound: bad }: ScopedBasePlan): SFn | null {
  if (bad || plan.length === 0) {
    return null;
  }
  // THE TWO FIELDS MUST AGREE, and they arrive as independent data. `assertPlanOwnership` runs in
  // the planner, so it cannot see an edit made between plan and apply — which is exactly the seam
  // exporting this applier opened. A `repoint` naming a local no entry mints is neither declared
  // nor assigned, and both boundary contracts pass it: `assertResolved` looks for absent names, not
  // for unwritten ones. Checked here, where the two halves meet.
  const minted = new Set(plan.map((p) => p.name));
  for (const name of repoint.values()) {
    if (!minted.has(name)) {
      throw new Error(`scopebase: the plan repoints an access to \`${name}\`, which no entry mints`);
    }
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
