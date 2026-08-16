import { typeToString } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { exprChildren, mapExprChildren, stmtChildren, stmtExprs } from './ast';

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
interface Span {
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
 *  GATES:
 *   - a local mentioned inside a loop BODY is excluded. SOUND-critical: it is what makes preorder
 *     statement order a sufficient approximation of liveness. Preorder is a topological order of the
 *     CFG except where a later-indexed statement can run before an earlier one, and the positions
 *     that do that — a `for`'s `init`/`inc`, and everything in any loop body — are inside a loop, so
 *     the gate covers them. A loop's own CONDITION is NOT covered: it is visited at the loop
 *     statement's own index with the ENCLOSING loop flag. That is safe only because a condition
 *     cannot WRITE, so it can extend a read range but never reorder a definition — an earlier
 *     version of this comment claimed the gate covered conditions too, which it does not.
 *     `test/coalesce-fuzz.test.ts` is the differential check; delete this gate and it fails.
 *   - both must be CONSTANT-fed. A codegen heuristic, not soundness: deleting it stays clobber-free
 *     under that fuzz and simply scored worse, because a load-fed local is one the compiler had a
 *     reason to keep where it was. It is also what currently BOUNDS candidate growth: merges are
 *     `L(L-1)/2` in the local count, each a distinct source and so a distinct compile, and nothing
 *     else caps that. Corpus-wide today: 2 rows, 13 kept sources.
 *   - the survivor's first mention must be an ASSIGN THAT DOES NOT ALSO READ IT. `b = g(b)` is a
 *     write and a read in one statement; counting it as a pure write let `g` receive the absorbed
 *     value. NOT a soundness gate, though it reads like one, and `constFed` masks it so only
 *     deleting both shows why: a survivor whose first mention is a READ was uninitialized there in
 *     the ORIGINAL too, so no clobber appears — what this gate bounds is the size of the accepted
 *     class below, which it holds down by an order of magnitude.
 *
 *  ACCEPTED, NOT FIXED: a survivor assigned only on SOME paths still absorbs the other's value on
 *  the paths that skip it. The original read an uninitialized local there, so both spellings are
 *  ill-defined rather than one being wrong — but this is a real difference and the differ, not this
 *  gate, is what keeps it from faking a match. The fuzz asserts it stays reachable, so the carve-out
 *  that excuses it cannot quietly become dead. */
export function coalesceCandidates(sfn: SFn): { merged: string; sfn: SFn }[] {
  if (sfn.locals.length < 2) {
    return [];
  }
  const params = new Set(sfn.params.map((p) => p.name));
  const typeOf = new Map(sfn.locals.map((l) => [l.name, typeToString(l.type)]));
  const sp = spans(sfn.body);
  const out: { merged: string; sfn: SFn }[] = [];
  for (const a of sfn.locals.map((l) => l.name)) {
    for (const b of sfn.locals.map((l) => l.name)) {
      const x = sp.get(a);
      const y = sp.get(b);
      if (a === b || !x || !y || params.has(a) || params.has(b)) {
        continue;
      }
      if (typeOf.get(a) !== typeOf.get(b) || x.inLoop || y.inLoop || !x.constFed || !y.constFed) {
        continue;
      }
      if (x.last >= y.first || !y.firstIsWrite) {
        continue;
      }
      // Labelled by the PAIR, not by an index into enumeration order: an index silently re-points
      // at a different merge if `sfn.locals` ordering ever changes, leaving a recorded provenance
      // that is wrong but plausible.
      out.push({
        merged: `${a}-${b}`,
        sfn: { ...sfn, body: rename(sfn.body, a, b), locals: sfn.locals.filter((l) => l.name !== a) },
      });
    }
  }
  return out;
}
