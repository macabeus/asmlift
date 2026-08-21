// THE OTHER COALESCER is `structure/namecoalesce.ts`, and the dividing line is worth stating: it
// merges the SOURCE AND DESTINATION OF A COPY, which is copy coalescing; this one merges two
// UNRELATED locals whose spans are disjoint, which is register reuse. Neither subsumes the other —
// a copy pair overlaps by construction, so `overlap` below rejects every candidate that one takes.
import { typeToString } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { exprChildren, mapExprChildren, stmtChildren, stmtExprs } from './ast';
import { type Gate, firstRejection } from './gates';

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
  inLoop: boolean;
  constFed: boolean;
  /** the local's FIRST mention is a write, not a read */
  firstIsWrite: boolean;
}
function spans(body: Stmt[]): Map<string, Span> {
  const out = new Map<string, Span>();
  let at = 0;
  const walk = (list: Stmt[], inLoop: boolean): void => {
    for (const s of list) {
      at++;
      const here = new Set<string>();
      if (s.k === 'assign') here.add(s.name);
      for (const e of stmtExprs(s)) namesIn(e, here);
      for (const n of here) {
        const sp = out.get(n) ?? {
          first: at,
          last: at,
          inLoop,
          constFed: true,
          // an assign that ALSO READS the name (`b = g(b)`) is not a pure write; treating it as one
          // let `g` receive the absorbed value
          firstIsWrite: s.k === 'assign' && s.name === n && !stmtExprs(s).some((e) => mentions(e, n)),
        };
        sp.last = at;
        sp.inLoop ||= inLoop;
        if (s.k === 'assign' && s.name === n && s.value.k !== 'const') sp.constFed = false;
        out.set(n, sp);
      }
      walk(stmtChildren(s), inLoop || s.k === 'while' || s.k === 'dowhile' || s.k === 'for');
    }
  };
  walk(body, false);
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
}

/** The admission rules, in evaluation order. Two arguments the `why` fields have no room for:
 *
 *  WHAT `loop` BUYS is the right to read preorder statement order as liveness. Preorder is a
 *  topological order of the CFG except where a later-indexed statement can run before an earlier
 *  one, and every position that does that — a `for`'s `init`/`inc`, any loop body — is inside a
 *  loop. A loop's own CONDITION is not covered: it is visited at the loop statement's own index with
 *  the ENCLOSING flag, which is safe only because a condition cannot WRITE.
 *
 *  ABLATE `first-is-write` ALONE AND NOTHING HAPPENS — `const-fed` masks it, so a survivor first
 *  mentioned by a read was uninitialized there in the original too. Drop both to see what it does,
 *  which is to bound the accepted class below by an order of magnitude. `const-fed` likewise bounds
 *  candidate growth: merges go as `L(L-1)/2` in the local count, each a distinct compile. */
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
    id: 'loop',
    why: 'a back edge can run a later statement first, so preorder stops implying disjoint liveness',
    sound: true,
    guardedBy: 'coalesce-fuzz.test.ts: dropping it clobbers a defined read',
    rejects: (c) => c.x.inLoop || c.y.inLoop,
  },
  {
    id: 'const-fed',
    why: 'a load-fed local is one the compiler had a reason to keep where it was',
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
 *  the paths that skip it. The original read an uninitialized local there, so both spellings are
 *  ill-defined rather than one being wrong — but this is a real difference and the differ, not any
 *  gate, is what keeps it from faking a match. The fuzz asserts it stays reachable, so the carve-out
 *  that excuses it cannot quietly become dead. */
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
 *  mention of `b` inside the other. Params never reach this shape at all — pair members come from
 *  `sfn.locals` only — so there is no param gate to mirror from the span table. */
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

/** The arm-disjoint admission — the SECOND way a pair can merge, for pairs the span model must
 *  refuse (`loop` rejects any in-loop local; `const-fed` rejects every counter). Two locals
 *  confined to OPPOSITE arms of one `if` never coexist at runtime: the `if` picks one arm, so no
 *  read of either can observe the other's write — no liveness reasoning needed. That argument is
 *  exactly what the `loop` gate here protects: a loop ancestor re-enters the `if`, later entries
 *  can take the other arm, and a value written on one visit becomes readable on the next. */
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

function armDisjointCandidates(sfn: SFn): { merged: string; sfn: SFn }[] {
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
  const mentionsOf = (list: Stmt[]): Map<string, number> => {
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
  const total = mentionsOf(sfn.body);
  const locals = new Map(sfn.locals.map((l) => [l.name, l]));
  const typeOf = new Map(sfn.locals.map((l) => [l.name, typeToString(l.type)]));
  const out: { merged: string; sfn: SFn }[] = [];
  const declIdx = new Map(sfn.locals.map((l, i) => [l.name, i]));
  const isVolatile = (n: string): boolean =>
    locals.get(n)?.volatile === true || locals.get(n)?.pointeeVolatile === true;
  // The first PREORDER mention of `n` in an arm, looked for through if statements whose own
  // condition does not read it (an if's cond evaluates before either arm). 'const-write' is a
  // pure `n = K`; anything else mentioning n first — a read, a computed assign, a loop — refuses.
  const firstMention = (list: Stmt[], n: string): 'const-write' | 'other' | null => {
    for (const st of list) {
      const here = new Set<string>();
      if (st.k === 'assign') here.add(st.name);
      for (const e of stmtExprs(st)) namesIn(e, here);
      const inChildren = mentionsOf(stmtChildren(st)).has(n);
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
  const visit = (stmts: Stmt[], inLoop: boolean): void => {
    for (const st of stmts) {
      if (st.k === 'if' && st.then.length && st.else.length) {
        const thenM = mentionsOf(st.then);
        const elseM = mentionsOf(st.else);
        const confined = (m: Map<string, number>): string[] =>
          [...m.entries()].filter(([n, k]) => locals.has(n) && total.get(n) === k).map(([n]) => n);
        for (const a of confined(thenM)) {
          for (const b of confined(elseM)) {
            // the survivor is the earlier declaration, matching how a shared source local reads
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
            {
              out.push({
                merged: `${gone}-${kept}`,
                sfn: { ...sfn, body: rename(sfn.body, gone, kept), locals: sfn.locals.filter((l) => l.name !== gone) },
              });
            }
          }
        }
      }
      visit(stmtChildren(st), inLoop || st.k === 'while' || st.k === 'dowhile' || st.k === 'for');
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
        sfn: { ...sfn, body: rename(sfn.body, a, b), locals: sfn.locals.filter((l) => l.name !== a) },
      });
    }
  }
  return { candidates, refusals };
}
