// L3 poll-shape re-spelling levers: `pollGuards` regrows an empty bottom-tested loop's guard,
// and `pollReads` (below) folds a materialized poll's re-read back into its while condition.
// Both trade on the same fact: the two spellings of a busy-wait evaluate their condition — and
// read their cell — the same number of times, so only bytes differ and the differ referees.
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
import { exprChildren, exprEquals, mapExprChildren, stmtChildren, stmtExprs } from './ast';

export function pollGuards(sfn: SFn): SFn | null {
  let changed = false;
  const rewrite = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'dowhile':
        if (s.body.length === 0) {
          changed = true;
          return { k: 'if', cond: s.cond, then: [s], else: [] };
        }
        return { ...s, body: s.body.map(rewrite) };
      case 'while':
        return { ...s, body: s.body.map(rewrite) };
      case 'for':
        return { ...s, body: s.body.map(rewrite) };
      case 'if':
        return { ...s, then: s.then.map(rewrite), else: s.else.map(rewrite) };
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: c.body.map(rewrite) })),
          ...(s.default ? { default: s.default.map(rewrite) } : {}),
        };
      default:
        return s;
    }
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
// count 1 + iterations — so volatile reads COUNT the same; the effect-free-condition gate below
// is what makes the ORDER identical too (with no other effect in the condition, there is nothing
// for the embedded read to reorder against). What differs is bytes: the pre-read + temp spelling
// materializes an extra register and instruction the in-condition spelling does not.
//
// SCOPE (decline over approximate): the temp must be the function's OWN non-volatile LOCAL —
// a bare global's assigns are stores other code observes, and its declaration cannot be
// dropped; the body must be EXACTLY the one re-read assign of the same variable and the same
// expression; the condition must read the variable EXACTLY once (a second read would double the
// per-iteration evaluation of X) and be effect-free apart from X (embedding X inside the
// condition unsequences it against any other effect there); the expression must not mention the
// variable and must be call/marker-free; and the variable — address-taken uses included — must
// appear NOWHERE else in the function, since its declaration is dropped with the temp.
// Declines (null) when no poll matches.
export function pollReads(sfn: SFn): SFn | null {
  const ownPlain = new Set(
    sfn.locals.filter((l) => l.volatile !== true && l.pointeeVolatile !== true).map((l) => l.name),
  );
  const countName = (e: Expr, n: string): number =>
    ((e.k === 'var' || e.k === 'addr') && e.name === n ? 1 : 0) +
    exprChildren(e).reduce((a, c) => a + countName(c, n), 0);
  const pure = (e: Expr): boolean => e.k !== 'call' && e.k !== 'marker' && exprChildren(e).every(pure);
  const occurs = (list: Stmt[], n: string): number =>
    list.reduce(
      (a, st) =>
        a +
        stmtExprs(st).reduce((x, e) => x + countName(e, n), 0) +
        (st.k === 'assign' && st.name === n ? 1 : 0) +
        occurs(stmtChildren(st), n),
      0,
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
        w.body.length === 1 &&
        w.body[0].k === 'assign' &&
        w.body[0].name === a.name &&
        exprEquals(w.body[0].value, a.value) &&
        countName(w.cond, a.name) === 1 &&
        countName(a.value, a.name) === 0 &&
        pure(a.value) &&
        pure(w.cond) &&
        // the pattern owns exactly three occurrences: both assign targets and the cond read
        occurs(sfn.body, a.name) === 3
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
  const recurse = (s0: Stmt): Stmt => {
    switch (s0.k) {
      case 'if':
        return { ...s0, then: rewriteList(s0.then), else: rewriteList(s0.else) };
      case 'while':
      case 'dowhile':
      case 'for':
        return { ...s0, body: rewriteList(s0.body) };
      case 'switch':
        return {
          ...s0,
          cases: s0.cases.map((c) => ({ ...c, body: rewriteList(c.body) })),
          ...(s0.default ? { default: rewriteList(s0.default) } : {}),
        };
      default:
        return s0;
    }
  };
  const body = rewriteList(sfn.body);
  return dropped.size > 0 ? { ...sfn, body, locals: sfn.locals.filter((l) => !dropped.has(l.name)) } : null;
}
