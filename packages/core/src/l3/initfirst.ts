// L3 re-spelling lever: a loop INIT moves above the guard that encloses it, and the guard reads
// the initialized variable.
//
// `for (i = 0; i < n; i++)` compiles with the init BEFORE the zero-trip test (`mov r3,#0` then
// `cmp r3, r5`), while `if (0 < n) { i = 0; do … }` compiles with the init behind the branch.
// Both source forms lift to the SAME IR — a const has no position — so which the original spelled
// is not recoverable; this lever emits the init-first sibling and the differ referees:
//
//     if (0 < n) { v = 0; … }   →   v = 0; if (v < n) { … }
//
// Two rewrites, applied per statement list at every nesting level:
//   • common-arm hoist — both arms of an `if` begin with the SAME pure-const assign
//     (`if (c) { v = 0; } else { v = 0; … }`, gcc's inverted-guard shape): the assign moves above
//     the `if`, and an emptied then-arm flips into its negated else form.
//   • guard re-spelling — an else-less `if` whose then-arm begins with `v = K` and whose
//     condition carries the CONST K as a comparison operand: the assign moves above and that
//     operand becomes `v`.
//
// SCOPE (decline over approximate): both rewrites touch LOCALS only — a bare-global assign
// stores memory that other code observes, so moving one across the guard is a real store on the
// skip path. Hoisted assigns carry pure CONST values (an effect or a memory read would reorder
// against the condition), and the condition must not read the variable (its pre-assign value
// dies in the move). The guard re-spelling mints a write on a previously write-free path, so it
// fires only in the TOP-LEVEL statement list — inside a loop the skip-path write re-executes
// where an enclosing scope can watch it — and only when the variable appears nowhere after the
// `if` there. Declines (null) when nothing changes.
import type { Expr, SFn, Stmt } from './ast';
import { NEGATE_REL, exprChildren, stmtExprs } from './ast';

const readsVar = (e: Expr, name: string): boolean =>
  ((e.k === 'var' || e.k === 'addr') && e.name === name) || exprChildren(e).some((c) => readsVar(c, name));

const stmtTouches = (s: Stmt, name: string): boolean => {
  if (stmtExprs(s).some((e) => readsVar(e, name))) {
    return true;
  }
  switch (s.k) {
    case 'if':
      return [...s.then, ...s.else].some((x) => stmtTouches(x, name));
    case 'while':
    case 'dowhile':
      return s.body.some((x) => stmtTouches(x, name));
    case 'for':
      return [s.init, s.inc, ...s.body].some((x) => stmtTouches(x, name));
    case 'switch':
      return [...s.cases.flatMap((c) => c.body), ...(s.default ?? [])].some((x) => stmtTouches(x, name));
    default:
      return false;
  }
};

const isConstAssign = (s: Stmt): s is Extract<Stmt, { k: 'assign' }> & { value: { k: 'const'; value: number } } =>
  s.k === 'assign' && s.value.k === 'const';

export function initFirstGuards(sfn: SFn): SFn | null {
  let changed = false;
  const fnLocal = new Set([...sfn.params, ...sfn.locals].map((d) => d.name));

  const rewriteList = (list: Stmt[], topLevel: boolean): Stmt[] => {
    const out: Stmt[] = [];
    for (const s0 of list) {
      const s = recurse(s0);
      if (s.k !== 'if') {
        out.push(s);
        continue;
      }
      let { cond, then, else: els } = s;
      // common-arm hoist
      const hoisted: { name: string; value: number }[] = [];
      for (;;) {
        const t0 = then[0];
        const e0 = els[0];
        if (
          t0 === undefined ||
          e0 === undefined ||
          !isConstAssign(t0) ||
          !isConstAssign(e0) ||
          !fnLocal.has(t0.name) ||
          t0.name !== e0.name ||
          t0.value.value !== e0.value.value ||
          readsVar(cond, t0.name)
        ) {
          break;
        }
        out.push(t0);
        hoisted.push({ name: t0.name, value: t0.value.value });
        changed = true;
        then = then.slice(1);
        els = els.slice(1);
      }
      if (then.length === 0 && els.length > 0) {
        const neg = cond.k === 'bin' ? NEGATE_REL[cond.op] : undefined;
        if (neg !== undefined && cond.k === 'bin') {
          cond = { ...cond, op: neg };
          [then, els] = [els, then];
          changed = true;
        }
      }
      // a COMMON-hoisted variable holds its const on both paths, so the condition's matching
      // const operand reads through it unconditionally — no tail gate needed
      for (const hv of hoisted) {
        if (cond.k === 'bin' && NEGATE_REL[cond.op]) {
          if (cond.l.k === 'const' && cond.l.value === hv.value) {
            cond = { ...cond, l: { k: 'var', name: hv.name } };
          } else if (cond.r.k === 'const' && cond.r.value === hv.value) {
            cond = { ...cond, r: { k: 'var', name: hv.name } };
          }
        }
      }
      // guard re-spelling
      if (
        topLevel &&
        els.length === 0 &&
        then.length > 0 &&
        isConstAssign(then[0]) &&
        fnLocal.has(then[0].name) &&
        cond.k === 'bin' &&
        NEGATE_REL[cond.op]
      ) {
        const init = then[0];
        const rest = list.slice(list.indexOf(s0) + 1);
        const constSide =
          cond.l.k === 'const' && cond.l.value === init.value.value
            ? 'l'
            : cond.r.k === 'const' && cond.r.value === init.value.value
              ? 'r'
              : null;
        if (constSide !== null && !readsVar(cond, init.name) && !rest.some((t) => stmtTouches(t, init.name))) {
          out.push(init);
          cond = { ...cond, [constSide]: { k: 'var', name: init.name } };
          then = then.slice(1);
          changed = true;
        }
      }
      out.push({ ...s, cond, then, else: els });
    }
    return out;
  };

  const recurse = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'if':
        return { ...s, then: rewriteList(s.then, false), else: rewriteList(s.else, false) };
      case 'while':
      case 'dowhile':
        return { ...s, body: rewriteList(s.body, false) };
      case 'for':
        return { ...s, body: rewriteList(s.body, false) };
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: rewriteList(c.body, false) })),
          ...(s.default ? { default: rewriteList(s.default, false) } : {}),
        };
      default:
        return s;
    }
  };

  const body = rewriteList(sfn.body, true);
  return changed ? { ...sfn, body } : null;
}
