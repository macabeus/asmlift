// THE OTHER COALESCER is `structure/namecoalesce.ts`, and the dividing line is worth stating: it
// merges the SOURCE AND DESTINATION OF A COPY, which is copy coalescing; this one merges two
// UNRELATED locals whose spans are disjoint, which is register reuse. Neither subsumes the other —
// a copy pair overlaps by construction, so `overlap` below rejects every candidate that one takes.
//
// TWO admission paths live here, each with its own gate table and its own reading of loops. The
// SPAN path (COALESCE_GATES) proves disjoint liveness from preorder position, so it asks which
// loops RE-RUN a mention of each local and refuses a pair only when one loop holds both. The
// ARM-DISJOINT path (ARM_DISJOINT_GATES) proves the two never coexist because one `if` picks
// between them, so it asks only whether ANY loop encloses that `if` — a second entry breaks the
// argument however the arms' own loops relate. `coalesceCandidates` offers both.
import { typeToString } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { exprChildren, mapExprChildren, stmtChildren, stmtExprs } from './ast';
import { type Gate, firstRejection } from './gates';

/** THE loop-kind test, shared by both admission paths in this file — the span model's enclosure
 *  walk and the arm path's `visit`. */
const isLoop = (s: Stmt): boolean => s.k === 'while' || s.k === 'dowhile' || s.k === 'for';

function namesIn(e: Expr, out: Set<string>): void {
  // `addr` names a GLOBAL, never a local — collected anyway. A name reaching BOTH forms would
  // otherwise get a span that ignores its `addr` mentions, and a SHORT span is a clobber while a
  // long one is only a missed merge. `structure.ts` keeps locals to /^[vt]\d+$/ and excludes global
  // names, so this cannot fire today; collecting is the direction that stays safe if that changes.
  if (e.k === 'var' || e.k === 'addr') out.add(e.name);
  for (const c of exprChildren(e)) namesIn(c, out);
}

/** Does `e` mention `n` anywhere? */
function mentions(e: Expr, n: string): boolean {
  const seen = new Set<string>();
  namesIn(e, seen);
  return seen.has(n);
}
export interface Span {
  first: number;
  last: number;
  /** every loop that RE-RUNS a mention of the local — the whole ancestor chain, not just the
   *  innermost, because an outer loop re-runs an inner one's statements too. A `for`'s init is
   *  not re-run by its own loop, so it contributes only the enclosing ones. */
  loops: Set<Stmt>;
  constFed: boolean;
  /** the local's FIRST mention is a write, not a read */
  firstIsWrite: boolean;
}
/** The INDUCTION VARIABLE a `for` drives: the local its init writes and whose step computes the
 *  next value from the CURRENT one, arithmetically. Those two writes are the variable's own
 *  definition and its own history — not a feed from somewhere the compiler had a reason to
 *  respect, which is what `const-fed` reads every non-const assign as.
 *
 *  Both halves of the step test are load-bearing, and neither is what the pipeline's `for`
 *  producers check — `recognizeForLoops` (structure/structure.ts) admits ANY self-referencing step,
 *  and l3/reindex.ts's two walk rewrites mint `iv = iv + 1`, so this predicate is implied by all
 *  three rather than trusting any of them; a `for` reaching here may be a walk, not a count. `a = *p` (no self-read) and `p = p->next` / `a = tab[a]` (a self-read
 *  that is still a MEMORY read every iteration) are both locals `const-fed` exists to refuse; only
 *  arithmetic over the variable is its own history. The read must be a `var`: `mentions` counts an
 *  `addr` too, and `&a` is not a read of `a`. */
const readsVarArithmetically = (e: Expr, n: string): boolean => {
  if (e.k === 'index' || e.k === 'field' || e.k === 'call' || e.k === 'marker' || e.k === 'addr') {
    return false;
  }
  return (e.k === 'var' && e.name === n) || exprChildren(e).some((c) => readsVarArithmetically(c, n));
};
const stepIsArithmetic = (e: Expr, n: string): boolean => readsVarArithmetically(e, n) && !hasMemoryRead(e);
const hasMemoryRead = (e: Expr): boolean =>
  e.k === 'index' || e.k === 'field' || e.k === 'call' || e.k === 'marker' || exprChildren(e).some(hasMemoryRead);
const forInductionVar = (s: Extract<Stmt, { k: 'for' }>): string | null =>
  s.init.k === 'assign' &&
  s.inc.k === 'assign' &&
  s.init.name === s.inc.name &&
  stepIsArithmetic(s.inc.value, s.inc.name)
    ? s.init.name
    : null;

function spans(body: Stmt[]): Map<string, Span> {
  const out = new Map<string, Span>();
  let at = 0;
  /** the statement's OWN mentions — an assign target, a condition, a scrutinee — at its own
   *  position, inside the loops it runs under */
  const record = (s: Stmt, loops: readonly Stmt[], inductionVar: string | null = null): void => {
    at++;
    const here = new Set<string>();
    if (s.k === 'assign') here.add(s.name);
    for (const e of stmtExprs(s)) namesIn(e, here);
    for (const n of here) {
      const sp = out.get(n) ?? {
        first: at,
        last: at,
        loops: new Set<Stmt>(),
        constFed: true,
        // an assign that ALSO READS the name (`b = g(b)`) is not a pure write; treating it as one
        // let `g` receive the absorbed value
        firstIsWrite: s.k === 'assign' && s.name === n && !stmtExprs(s).some((e) => mentions(e, n)),
      };
      sp.last = at;
      for (const l of loops) {
        sp.loops.add(l);
      }
      if (s.k === 'assign' && s.name === n && s.value.k !== 'const' && n !== inductionVar) sp.constFed = false;
      out.set(n, sp);
    }
  };
  /** the loop set a while/do-while's own condition and children run under — its own. A `for` is
   *  routed separately: `stmtChildren` hands back its init too, and the init is the one child its
   *  loop does not re-run. */
  const under = (s: Stmt, loops: readonly Stmt[]): readonly Stmt[] => (isLoop(s) ? [...loops, s] : loops);
  const walk = (list: Stmt[], loops: readonly Stmt[]): void => {
    for (const s of list) {
      // A `for`'s INIT runs ONCE, ahead of the condition and outside the loop; its cond, inc and
      // body run per iteration. Walking the init first is what makes `for (i = *p; …)` read as a
      // local whose first mention is a WRITE, which is what it is.
      if (s.k === 'for') {
        const inductionVar = forInductionVar(s);
        // The INIT runs once, so the `for` does not re-run it — but only an ASSIGN there is a
        // shape this case places directly. Anything else (a loop, an `if`) goes through the generic
        // walk, which places it and its children by its own kind; `forInductionVar` requires an
        // assign init, so `counter` is null on that path anyway. The INC mirrors it, where the
        // routing is uniformity rather than coverage: an inc's statements sit inside the `for`,
        // which is already in every span the pair could share.
        if (s.init.k === 'assign') {
          record(s.init, loops, inductionVar);
        } else {
          walk([s.init], loops);
        }
        const inner = [...loops, s];
        record(s, inner);
        walk(s.body, inner);
        if (s.inc.k === 'assign') {
          record(s.inc, inner, inductionVar);
        } else {
          walk([s.inc], inner);
        }
        continue;
      }
      // a while/do-while CONDITION re-runs with the body, so it counts as inside its own loop
      const inner = under(s, loops);
      record(s, inner);
      walk(stmtChildren(s), inner);
    }
  };
  walk(body, []);
  return out;
}
function rename(body: Stmt[], from: string, to: string): Stmt[] {
  const inExpr = (e: Expr): Expr =>
    e.k === 'var' && e.name === from ? { ...e, name: to } : mapExprChildren(e, inExpr);
  const inStmt = (s: Stmt): Stmt => {
    const r = { ...s } as Record<string, unknown>;
    if (s.k === 'assign' && s.name === from) r.name = to;
    for (const key of ['value', 'lval', 'cond', 'scrutinee'] as const) {
      const v = (s as Record<string, unknown>)[key];
      if (v !== undefined) r[key] = inExpr(v as Expr);
    }
    for (const key of ['then', 'else', 'body', 'default'] as const) {
      const v = (s as Record<string, unknown>)[key];
      if (Array.isArray(v)) r[key] = (v as Stmt[]).map(inStmt);
    }
    if (s.k === 'for') {
      r.init = inStmt(s.init);
      r.inc = inStmt(s.inc);
    }
    if (s.k === 'switch') r.cases = s.cases.map((c) => ({ ...c, body: c.body.map(inStmt) }));
    return r as Stmt;
  };
  return body.map(inStmt);
}
/** One candidate merge under consideration: absorb `a` into `b`. */
export interface MergePair {
  a: string;
  b: string;
  /** `a`'s span */
  x: Span;
  /** `b`'s span — the SURVIVOR's, which is why the asymmetric gates read `y` */
  y: Span;
  sameType: boolean;
  eitherIsParam: boolean;
  /** either local is object-volatile or carries a pointee-volatile qualifier — typeToString
   *  spells neither, so `sameType` alone lets a qualified local absorb into a plain one */
  eitherIsVolatile: boolean;
  /** some loop holds a mention of BOTH locals */
  sharesLoop: boolean;
}

/** The admission rules, in evaluation order. Two arguments the `why` fields have no room for:
 *
 *  WHAT `shared-loop` BUYS is the right to read preorder statement order as liveness. Preorder is a
 *  topological order of the CFG except where a back edge runs a later-indexed statement before an
 *  earlier one — and a back edge returns only to the head of its OWN loop, whose body is one
 *  contiguous preorder range. So the reordering can reach a PAIR only when some loop holds a
 *  mention of both locals: there the survivor's write can be followed, on the next iteration, by
 *  the absorbed local's read. Where no loop holds both — two sibling loops, or one local living
 *  before the loop the other lives in — no back edge connects the two ranges and preorder IS
 *  execution order. The ancestor chain is what the span records, not the innermost loop: an outer
 *  loop re-runs an inner one's statements, so it can reorder a pair that no inner loop shares.
 *
 *  ABLATE `first-is-write` ALONE AND NOTHING HAPPENS — `const-fed` masks it, so a survivor first
 *  mentioned by a read was uninitialized there in the original too. Drop both to see what it does,
 *  which is to bound the accepted class below by an order of magnitude. `const-fed` likewise bounds
 *  candidate growth: merges go as `L(L-1)/2` in the local count, each a distinct compile. On a
 *  loop-heavy function it is what bounds them, because `shared-loop` refuses only pairs a back
 *  edge can reorder: klonoa's LoadBGTilemapData declares 43 locals — 1806 ordered pairs — and
 *  `const-fed` is what keeps three of them (ablate it and the span path offers 273). A rule
 *  refusing every in-loop local would make that bound redundant; this one does not, so any further
 *  relaxation of `const-fed` is a multiplier, and three call sites pay it (`/coalesce`,
 *  `/scopebase-coalesce`, the `/livebase` pairings). */
export const COALESCE_GATES: readonly Gate<MergePair>[] = [
  {
    id: 'param',
    why: 'a param is the function’s own signature, not a recovered local',
    sound: false,
    rejects: (c) => c.eitherIsParam,
  },
  {
    id: 'type',
    why: 'the survivor keeps its own declared type, so the two must agree',
    sound: false,
    rejects: (c) => !c.sameType,
  },
  {
    id: 'volatile',
    why: 'a volatile qualifier (object or pointee) is observable and typeToString does not spell it — merging strips or adds it',
    sound: true,
    guardedBy: 'coalesce.test.ts: a volatile pair never merges',
    rejects: (c) => c.eitherIsVolatile,
  },
  {
    id: 'shared-loop',
    why: 'a back edge of a loop holding both locals re-runs the absorbed read after the survivor is written',
    sound: true,
    // The ablation sweep proves this gate is load-bearing WHILE it is in the table; it is blind to
    // the two ways the rule can go wrong from here — a relaxation, and an outright deletion, which
    // would simply drop the gate from the table the sweep iterates. Both land on the arm named
    // below, which checks what the pass still emits.
    guardedBy: 'coalesce-fuzz.test.ts: no candidate the pass emits changes a DEFINED read',
    rejects: (c) => c.sharesLoop,
  },
  {
    id: 'const-fed',
    why: 'a load-fed local — other than a for induction variable, whose feeds are its own — is one the compiler had a reason to keep where it was',
    sound: false,
    rejects: (c) => !c.x.constFed || !c.y.constFed,
  },
  {
    id: 'overlap',
    why: 'the ranges must not overlap — the survivor would absorb a value still live',
    sound: true,
    guardedBy: 'coalesce.test.ts: OVERLAPPING ranges never merge',
    rejects: (c) => c.x.last >= c.y.first,
  },
  {
    id: 'first-is-write',
    why: 'a survivor first MENTIONED by a read would see the absorbed value there',
    sound: false,
    rejects: (c) => !c.y.firstIsWrite,
  },
];

/** Every legal single merge, each as its own tree — NOT one committed choice.
 *
 *  Which pair a register allocator coalesced is not derivable from the L3 tree, and first-fit gets
 *  it wrong. Run kleod:UpdateHUDCounterDisplay's published repro script (results.json carries it)
 *  and read the candidate table: of its two legal merges, one scores WORSE than not merging at all
 *  and declaration order is the one that picks it. Emitting no merges at all costs that row its
 *  match, which is what guards this file. `rank.ts` already has the idiom for exactly this —
 *  `/regcopy`'s "the tail choice is allocator-ambiguous, so both are ranked" — so every candidate is
 *  emitted and the differ referees.
 *
 *  ACCEPTED, NOT FIXED: a survivor assigned only on SOME paths still absorbs the other's value on
 *  the paths that skip it — a loop that runs zero iterations is one such path. The original read an uninitialized local there, so both spellings are
 *  ill-defined rather than one being wrong — but this is a real difference and the differ, not any
 *  gate, is what keeps it from faking a match. The fuzz asserts it stays reachable, so the carve-out
 *  that excuses it cannot quietly become dead. */
/** The survivor's declaration list after `gone` is absorbed into `kept`.
 *
 *  The merged local's declaration is dropped, so any attribute on it would be lost — and one of
 *  them is load-bearing: `slot`, the `[sp,#k]` the machine homed it at (ir/core.ts `SlotHomes`).
 *  A merged pair can reproduce at most ONE slot and the LOWER is the earlier declaration rank, so
 *  the survivor takes the minimum of the two. That is the one merge policy, shared verbatim with
 *  the SSA builder's stamp and with `replaceAllUsesWith`; it is a policy and not a proof, because
 *  the machine homed two values and the source declared one local. Neither homed ⇒ no slot: the
 *  merge invents nothing. */
function localsAfterMerge(locals: SFn['locals'], gone: string, kept: string): SFn['locals'] {
  const goneSlot = locals.find((l) => l.name === gone)?.slot;
  return locals
    .filter((l) => l.name !== gone)
    .map((l) => {
      if (l.name !== kept || goneSlot === undefined) {
        return l;
      }
      return { ...l, slot: l.slot === undefined || goneSlot < l.slot ? goneSlot : l.slot };
    });
}

export function coalesceCandidates(sfn: SFn): { merged: string; sfn: SFn }[] {
  const { candidates } = coalesceUnder(COALESCE_GATES, sfn);
  const seen = new Set(candidates.map((c) => c.merged));
  for (const c of armDisjointCandidates(sfn)) {
    if (!seen.has(c.merged)) {
      candidates.push(c);
    }
  }
  return candidates;
}

/** One candidate ARM-DISJOINT merge: every mention of `a` inside one arm of a single `if`, every
 *  mention of `b` inside the other. There is no param gate to mirror from the span table because
 *  the enumeration refuses params structurally: pair members come from `sfn.locals` only, and a
 *  local that SHADOWS a param name is excluded too (see `confined`) — rename() must never touch
 *  a param's mentions. */
export interface ArmPair {
  a: string;
  b: string;
  /** the confining `if` has a loop ancestor, so it can run more than once */
  ifInLoop: boolean;
  sameType: boolean;
  /** either local is object-volatile or carries a pointee-volatile qualifier (see MergePair) */
  eitherIsVolatile: boolean;
  /** each local's FIRST preorder mention inside its arm is a pure const write */
  bothArmConstInit: boolean;
}

/** The arm-disjoint admission — the SECOND way a pair can merge, and what it uniquely buys is the
 *  DIRECTION: the span path's survivor is always the later RANGE, because `overlap` orders the pair
 *  by position, while this path's is the earlier DECLARATION — the two disagree exactly when
 *  declaration order disagrees with range order. It also admits a pair the span gates refuse for a
 *  different reason: `arm-init` is a FIRST-MENTION rule where `const-fed` is an every-assign one,
 *  so arms that open with a const write and then compute (`x = 0; x = x + 1;`) merge here and not
 *  there. Two locals confined to
 *  OPPOSITE arms of one `if` never coexist at runtime: the `if` picks one arm, so no read of either
 *  can observe the other's write — no liveness reasoning needed. That argument is exactly what the
 *  `loop` gate here protects: a loop ancestor re-enters the `if`, later entries can take the other
 *  arm, and a value written on one visit becomes readable on the next. Note this gate wants ANY
 *  enclosing loop, not the span model's shared-loop rule: never-coexisting is a claim about one
 *  entry, so a second entry breaks it however the two arms' loops relate. */
export const ARM_DISJOINT_GATES: readonly Gate<ArmPair>[] = [
  {
    id: 'type',
    why: 'the survivor keeps its own declared type, so the two must agree',
    sound: false,
    rejects: (c) => !c.sameType,
  },
  {
    id: 'volatile',
    why: 'a volatile qualifier (object or pointee) is observable — merging strips or adds it',
    sound: true,
    guardedBy: 'coalesce.test.ts: a volatile pair never merges',
    rejects: (c) => c.eitherIsVolatile,
  },
  {
    id: 'loop',
    why: 'a loop ancestor re-enters the if, so opposite arms both run and a value could cross',
    sound: true,
    guardedBy: 'coalesce.test.ts: an in-loop if never admits its arm pair',
    rejects: (c) => c.ifInLoop,
  },
  {
    id: 'arm-init',
    why: 'a local not const-initialized at its arm’s first mention is one the compiler had a reason to keep — the growth bound const-fed gives the span table',
    sound: false,
    rejects: (c) => !c.bothArmConstInit,
  },
];

/** The arm-disjoint merges alone — the class the livebase pairings enumerate (rank.ts): the
 *  demanding row's shared counter is arm-disjoint, and the span-model merges already ride the
 *  plain /coalesce label, so pairing them too would multiply candidates with no row behind it. */
export function armDisjointCandidates(sfn: SFn): { merged: string; sfn: SFn }[] {
  return armDisjointUnder(ARM_DISJOINT_GATES, sfn).candidates;
}

/** `armDisjointCandidates` with the gate table supplied plus which gate refused each pair — the
 *  same ablation-as-a-value seam `coalesceUnder` provides for the span table. */
export function armDisjointUnder(
  gates: readonly Gate<ArmPair>[],
  sfn: SFn,
): { candidates: { merged: string; sfn: SFn }[]; refusals: Map<string, number> } {
  const refusals = new Map<string, number>();
  if (sfn.locals.length < 2) {
    return { candidates: [], refusals };
  }
  // Both whole-subtree walks below are MEMOISED on node identity, for one call: `firstMention`
  // walks a statement's whole subtree once per statement it scans, and the a×b loop's two calls
  // each depend on only ONE of a and b. Sound because nothing here mutates the tree — the only
  // rewrite is `rename`, which rebuilds every statement it touches and leaves `sfn` alone
  // (structure-purity.test.ts pins the same promise one level up).
  const countMentions = (list: Stmt[]): Map<string, number> => {
    const out = new Map<string, number>();
    const walk = (stmts: Stmt[]): void => {
      for (const st of stmts) {
        const here = new Set<string>();
        if (st.k === 'assign') here.add(st.name);
        for (const e of stmtExprs(st)) namesIn(e, here);
        for (const n of here) out.set(n, (out.get(n) ?? 0) + 1);
        walk(stmtChildren(st));
      }
    };
    walk(list);
    return out;
  };
  const listMentions = new Map<Stmt[], Map<string, number>>();
  const mentionsOf = (list: Stmt[]): Map<string, number> => {
    let m = listMentions.get(list);
    if (m === undefined) {
      m = countMentions(list);
      listMentions.set(list, m);
    }
    return m;
  };
  // `stmtChildren` builds a FRESH array every call, so a statement's subtree counts are keyed on
  // the statement rather than on the list `mentionsOf` would see.
  const childMentions = new Map<Stmt, Map<string, number>>();
  const mentionsUnder = (st: Stmt): Map<string, number> => {
    let m = childMentions.get(st);
    if (m === undefined) {
      m = countMentions(stmtChildren(st));
      childMentions.set(st, m);
    }
    return m;
  };
  const total = mentionsOf(sfn.body);
  const params = new Set(sfn.params.map((p) => p.name));
  const locals = new Map(sfn.locals.map((l) => [l.name, l]));
  const typeOf = new Map(sfn.locals.map((l) => [l.name, typeToString(l.type)]));
  const out: { merged: string; sfn: SFn }[] = [];
  const declIdx = new Map(sfn.locals.map((l, i) => [l.name, i]));
  const isVolatile = (n: string): boolean =>
    locals.get(n)?.volatile === true || locals.get(n)?.pointeeVolatile === true;
  // The first PREORDER mention of `n` in an arm, looked for through if statements whose own
  // condition does not read it (an if's cond evaluates before either arm). 'const-write' is a
  // pure `n = K`; anything else mentioning n first — a read, a computed assign, a loop — refuses.
  const firstMentionIn = (list: Stmt[], n: string): 'const-write' | 'other' | null => {
    for (const st of list) {
      const here = new Set<string>();
      if (st.k === 'assign') here.add(st.name);
      for (const e of stmtExprs(st)) namesIn(e, here);
      const inChildren = mentionsUnder(st).has(n);
      if (!here.has(n) && !inChildren) {
        continue;
      }
      if (st.k === 'assign' && st.name === n && st.value.k === 'const' && !mentions(st.value, n)) {
        return 'const-write';
      }
      if (st.k === 'if' && !here.has(n)) {
        const arm = mentionsOf(st.then).has(n) ? st.then : st.else;
        return firstMention(arm, n);
      }
      return 'other';
    }
    return null;
  };
  // Per (arm, NAME): the answer depends on both, and the a×b loop below asks for each `a` once per
  // `b` and each `b` once per `a`.
  const firstMentions = new Map<Stmt[], Map<string, 'const-write' | 'other' | null>>();
  const firstMention = (list: Stmt[], n: string): 'const-write' | 'other' | null => {
    let per = firstMentions.get(list);
    if (per === undefined) {
      per = new Map();
      firstMentions.set(list, per);
    }
    if (!per.has(n)) {
      per.set(n, firstMentionIn(list, n));
    }
    return per.get(n)!;
  };
  const visit = (stmts: Stmt[], inLoop: boolean): void => {
    for (const st of stmts) {
      if (st.k === 'if' && st.then.length && st.else.length) {
        const thenM = mentionsOf(st.then);
        const elseM = mentionsOf(st.else);
        // locals only, and never a name that is ALSO a param — the span path holds the same
        // belief as a gate, and a local shadowing a param would let rename() rewrite the param's
        // own mentions
        const confined = (m: Map<string, number>): string[] =>
          [...m.entries()].filter(([n, k]) => locals.has(n) && !params.has(n) && total.get(n) === k).map(([n]) => n);
        for (const a of confined(thenM)) {
          for (const b of confined(elseM)) {
            // the survivor is the earlier declaration, matching how a shared source local reads.
            //
            // THIS READS THE STRUCTURER'S ORDER, AND MUST. The declaration list is put into the
            // target's frame order at EMIT time (l3/slotorder.ts), after this pass, so `declIdx`
            // here is the naming walk's order and not the emitted one. That is what makes the
            // choice mean "the earlier declaration in the source asmlift recovered". A tempting
            // refactor that ordered the list any earlier would silently change which local
            // survives every arm-disjoint merge, on every function with two slot-homed locals
            // whose frame order disagrees with their declaration order — which is exactly the
            // population the ordering exists for.
            const [gone, kept] = (declIdx.get(a) ?? 0) <= (declIdx.get(b) ?? 0) ? [b, a] : [a, b];
            const refused = firstRejection(gates, {
              a: gone,
              b: kept,
              ifInLoop: inLoop,
              sameType: typeOf.get(a) === typeOf.get(b),
              eitherIsVolatile: isVolatile(a) || isVolatile(b),
              bothArmConstInit:
                firstMention(st.then, a) === 'const-write' && firstMention(st.else, b) === 'const-write',
            });
            if (refused !== null) {
              refusals.set(refused, (refusals.get(refused) ?? 0) + 1);
              continue;
            }
            out.push({
              merged: `${gone}-${kept}`,
              sfn: { ...sfn, body: rename(sfn.body, gone, kept), locals: localsAfterMerge(sfn.locals, gone, kept) },
            });
          }
        }
      }
      visit(stmtChildren(st), inLoop || isLoop(st));
    }
  };
  visit(sfn.body, false);
  return { candidates: out, refusals };
}

/** `coalesceCandidates` with the gate table supplied, plus which gate refused each pair.
 *
 *  The parameter exists so a test can run the pass with one gate DROPPED — the ablation as a value,
 *  rather than as a flag compiled into the shipped path or an input rewritten to dodge a predicate.
 *  `refusals` is what makes a gate's reachability checkable: a rule nothing ever reaches is a rule
 *  no test can be failing on purpose. */
export function coalesceUnder(
  gates: readonly Gate<MergePair>[],
  sfn: SFn,
): { candidates: { merged: string; sfn: SFn }[]; refusals: Map<string, number> } {
  const refusals = new Map<string, number>();
  if (sfn.locals.length < 2) {
    return { candidates: [], refusals };
  }
  const params = new Set(sfn.params.map((p) => p.name));
  const typeOf = new Map(sfn.locals.map((l) => [l.name, typeToString(l.type)]));
  const volatiles = new Set(
    sfn.locals.filter((l) => l.volatile === true || l.pointeeVolatile === true).map((l) => l.name),
  );
  const sp = spans(sfn.body);
  const candidates: { merged: string; sfn: SFn }[] = [];
  for (const a of sfn.locals.map((l) => l.name)) {
    for (const b of sfn.locals.map((l) => l.name)) {
      const x = sp.get(a);
      const y = sp.get(b);
      // Not a gate: this is what makes the pair a pair at all. A name with no span is one the body
      // never mentions, so there is no range to reason about.
      if (a === b || !x || !y) {
        continue;
      }
      const refused = firstRejection(gates, {
        a,
        b,
        x,
        y,
        sameType: typeOf.get(a) === typeOf.get(b),
        eitherIsParam: params.has(a) || params.has(b),
        eitherIsVolatile: volatiles.has(a) || volatiles.has(b),
        sharesLoop: [...x.loops].some((l) => y.loops.has(l)),
      });
      if (refused !== null) {
        refusals.set(refused, (refusals.get(refused) ?? 0) + 1);
        continue;
      }
      // Labelled by the PAIR, not by an index into enumeration order: an index silently re-points
      // at a different merge if `sfn.locals` ordering ever changes, leaving a recorded provenance
      // that is wrong but plausible.
      candidates.push({
        merged: `${a}-${b}`,
        sfn: { ...sfn, body: rename(sfn.body, a, b), locals: localsAfterMerge(sfn.locals, a, b) },
      });
    }
  }
  return { candidates, refusals };
}
