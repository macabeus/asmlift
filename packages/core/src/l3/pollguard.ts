// L3 poll-shape re-spelling levers: `pollGuards` regrows an empty bottom-tested loop's guard;
// `pollReads` folds a materialized poll's re-read back into its while condition. Each carries
// its own trace argument below.
//
//     do { } while (dma[2] & 0x80000000);   →   if (dma[2] & 0x80000000) { do { } while (…); }
//
// For an empty body the two forms compile to the SAME instructions — gcc collapses the guard
// into the bottom test late (jump optimization), AFTER flow has counted the guard's reads — so
// the choice leaves no instruction trace, only a register-allocation ripple: the extra
// source-level read raises the condition operands' ref counts, which re-orders the allocator's
// priorities for the WHOLE function (the busy-wait's base landing in a low reg vs `ip`). Which
// form the source spelled is unrecoverable from the bytes; both are emitted and the differ
// referees.
//
// SCOPE (decline over approximate): only a `dowhile` with an EMPTY body regrows a guard —
// there the two forms have IDENTICAL evaluation traces (each evaluates the condition until its
// first falsy result; the regrown guard IS the first bottom-test, not an extra one), so
// volatile reads, calls, any effect in the condition all count the same. A NON-empty body is
// where the forms genuinely differ (the body runs at least once vs at least zero times), which
// is why it never wraps. Declines (null) when no empty do-while exists.
import type { Expr, SFn, Stmt } from './ast';
import { exprChildren, exprEquals, mapExprChildren, mapStmtLists, stmtChildren, stmtExprs } from './ast';

export function pollGuards(sfn: SFn): SFn | null {
  let changed = false;
  const rewrite = (s: Stmt): Stmt => {
    if (s.k === 'dowhile' && s.body.length === 0) {
      changed = true;
      return { k: 'if', cond: s.cond, then: [s], else: [] };
    }
    return mapStmtLists(s, (list) => list.map(rewrite));
  };
  const body = sfn.body.map(rewrite);
  return changed ? { ...sfn, body } : null;
}

// L3 re-spelling lever: a materialized POLL re-reads in its own condition.
//
//     v = dma[2]; while ((v & BUSY) != 0) { v = dma[2]; }   →   while ((dma[2] & BUSY) != 0) {}
//
// The structurer materializes a loop-carried load into a named temp with a pre-loop read and a
// per-iteration re-read; the source may have spelled the read INSIDE the condition of an
// empty-bodied `while`. The two forms have IDENTICAL evaluation traces — the old form reads once
// before plus once per iteration, the new form reads once per condition evaluation, and both
// count 1 + iterations — so volatile reads COUNT the same; the condition gates below (call-free,
// no volatile-rooted or raw derefs) are what make the ORDER identical too: with no other
// observable effect in the condition, there is nothing for the embedded read to reorder against.
// What differs is bytes: the pre-read + temp spelling materializes an extra register and
// instruction the in-condition spelling does not.
//
// SCOPE (decline over approximate): each admission is one named predicate below and carries its own
// refusal's reason; the temp must additionally be the function's OWN non-volatile LOCAL, because a
// bare global's assigns are stores other code observes and its declaration cannot be dropped.
// Declines (null) when no poll matches.
const countVar = (e: Expr, n: string): number =>
  (e.k === 'var' && e.name === n ? 1 : 0) + exprChildren(e).reduce((a, c) => a + countVar(c, n), 0);

const countAddr = (e: Expr, n: string): number =>
  (e.k === 'addr' && e.name === n ? 1 : 0) + exprChildren(e).reduce((a, c) => a + countAddr(c, n), 0);

/** call- and marker-free: no effect the fold could move or duplicate. */
const pure = (e: Expr): boolean => e.k !== 'call' && e.k !== 'marker' && exprChildren(e).every(pure);

/** The var a deref's base stands on, through casts only — null for anything else (a raw address, an
 *  arithmetic base), which is exactly the set `condDerefsPlain` refuses. */
const rootVar = (e: Expr): string | null => (e.k === 'var' ? e.name : e.k === 'cast' ? rootVar(e.e) : null);

/** ORDER-safety for the condition's other reads: a deref there must be rooted at a var declared
 *  non-volatile — a volatile-rooted or raw-address deref is (or may be) an OBSERVABLE read the
 *  fold would unsequence against X inside one expression, where the original sequenced them. */
const condDerefsPlain = (e: Expr, volatileLocals: ReadonlySet<string>): boolean => {
  if (e.k === 'index' || e.k === 'field') {
    const rv = rootVar(e.base);
    if (rv === null || volatileLocals.has(rv)) {
      return false;
    }
  }
  return exprChildren(e).every((c) => condDerefsPlain(c, volatileLocals));
};

/** Every mention of `n` in a statement list — reads, `&n`, and assign targets, at any depth. */
const occurs = (list: Stmt[], n: string): number =>
  list.reduce(
    (a, st) =>
      a +
      stmtExprs(st).reduce((x, e) => x + countVar(e, n) + countAddr(e, n), 0) +
      (st.k === 'assign' && st.name === n ? 1 : 0) +
      occurs(stmtChildren(st), n),
    0,
  );

/** The loop body must be EXACTLY the one re-read: a single assign of the same variable to the same
 *  expression. Any other statement there is one the fold would delete along with the loop's body. */
const bodyIsTheSoleReread = (w: Extract<Stmt, { k: 'while' }>, a: Extract<Stmt, { k: 'assign' }>): boolean =>
  w.body.length === 1 && w.body[0].k === 'assign' && w.body[0].name === a.name && exprEquals(w.body[0].value, a.value);

/** The condition must read the variable EXACTLY once, as a bare var: a second read would double X's
 *  per-iteration evaluation, and an `&v` is not a read at all and cannot be substituted. */
const condReadsVarOnce = (cond: Expr, n: string): boolean => countVar(cond, n) === 1 && countAddr(cond, n) === 0;

/** X must not mention the variable it is assigned to — the folded form evaluates X in a condition
 *  where that variable no longer exists. */
const valueIsSelfFree = (value: Expr, n: string): boolean => countVar(value, n) === 0 && countAddr(value, n) === 0;

/** The condition carries no effect and no observable read of its own, which is what makes the
 *  embedded X unsequenceable against anything: call/marker-free, every deref `condDerefsPlain`. */
const condFoldable = (cond: Expr, volatileLocals: ReadonlySet<string>): boolean =>
  pure(cond) && condDerefsPlain(cond, volatileLocals);

/** The pattern owns EVERY occurrence of the variable: both assign targets and the one condition
 *  read, three in all, counted over the whole function and counting `&v`. Its declaration is dropped
 *  with the temp, so anything else mentioning it would be left naming a variable that is gone. */
const ownsEveryOccurrence = (body: Stmt[], n: string): boolean => occurs(body, n) === 3;

export function pollReads(sfn: SFn): SFn | null {
  const ownPlain = new Set(
    sfn.locals.filter((l) => l.volatile !== true && l.pointeeVolatile !== true).map((l) => l.name),
  );
  const volatileLocals = new Set(
    sfn.locals.filter((l) => l.volatile === true || l.pointeeVolatile === true).map((l) => l.name),
  );
  const subst = (e: Expr, n: string, x: Expr): Expr =>
    e.k === 'var' && e.name === n ? x : mapExprChildren(e, (c) => subst(c, n, x));
  const dropped = new Set<string>();
  const rewriteList = (list: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const w = list[i + 1];
      if (
        a.k === 'assign' &&
        ownPlain.has(a.name) &&
        w !== undefined &&
        w.k === 'while' &&
        bodyIsTheSoleReread(w, a) &&
        condReadsVarOnce(w.cond, a.name) &&
        valueIsSelfFree(a.value, a.name) &&
        pure(a.value) &&
        condFoldable(w.cond, volatileLocals) &&
        ownsEveryOccurrence(sfn.body, a.name)
      ) {
        out.push({ k: 'while', cond: subst(w.cond, a.name, a.value), body: [] });
        dropped.add(a.name);
        i++;
        continue;
      }
      out.push(recurse(a));
    }
    return out;
  };
  const recurse = (s0: Stmt): Stmt => mapStmtLists(s0, rewriteList);
  const body = rewriteList(sfn.body);
  return dropped.size > 0 ? { ...sfn, body, locals: sfn.locals.filter((l) => !dropped.has(l.name)) } : null;
}
