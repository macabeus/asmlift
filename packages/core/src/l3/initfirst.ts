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
// Two rewrites (the guard re-spelling gated on the moved write being dead — see SCOPE):
//   • common-arm hoist — both arms of an `if` begin with the SAME pure-const assign
//     (`if (c) { v = 0; } else { v = 0; … }`, gcc's inverted-guard shape): the assign moves above
//     the `if`, and an emptied then-arm flips into its negated else form.
//   • guard re-spelling — an else-less `if` whose then-arm begins with `v = K` and whose
//     condition carries the CONST K as a comparison operand: the assign moves above and that
//     operand becomes `v`.
//
// SCOPE (decline over approximate): both rewrites touch PRIVATE locals only — a bare-global
// assign stores memory other code observes, a VOLATILE local's store is itself observable (the
// escaped DMA scratch), and a local whose ADDRESS is taken anywhere can be read through the
// pointer where no name betrays it — all three stay put. Hoisted assigns carry pure CONST
// values (an effect or a memory read would reorder against the condition), and the condition
// must not read the variable (its pre-assign value dies in the move). The guard re-spelling
// mints a write on a previously write-free path, so it needs that write to be DEAD there: the
// variable must be untouched after the `if` in its own list and in the tail of every ancestor
// list (a sibling arm of an ancestor `if` is not "after" — it never runs in the same entry).
// Under a loop or switch ancestor the tails stop describing what runs next (a back edge
// re-enters everything, a case can fall through), so there the variable must appear nowhere
// outside the rewritten `if` at all. Declines (null) when nothing changes.
import type { Expr, SFn, Stmt } from './ast';
import { NEGATE_REL, exprChildren, stmtChildren, stmtExprs } from './ast';

const readsVar = (e: Expr, name: string): boolean =>
  ((e.k === 'var' || e.k === 'addr') && e.name === name) || exprChildren(e).some((c) => readsVar(c, name));

// READS only — a pure write in a tail is benign (it overwrites the minted value on every path,
// and any read after it is that write's business); touchesOutside below is TOTAL because strong
// mode must know the name is absent, presence of any kind included.
const stmtTouches = (s: Stmt, name: string): boolean =>
  stmtExprs(s).some((e) => readsVar(e, name)) || stmtChildren(s).some((x) => stmtTouches(x, name));

const isConstAssign = (s: Stmt): s is Extract<Stmt, { k: 'assign' }> & { value: { k: 'const'; value: number } } =>
  s.k === 'assign' && s.value.k === 'const';

export function initFirstGuards(sfn: SFn): SFn | null {
  let changed = false;
  const fnLocal = new Set([
    ...sfn.params.map((d) => d.name),
    ...sfn.locals.filter((l) => l.volatile !== true).map((l) => l.name),
  ]);
  // an address-taken local can be read through the captured pointer with no name in sight
  const dropAddressTaken = (e: Expr): void => {
    if (e.k === 'addr') {
      fnLocal.delete(e.name);
    }
    exprChildren(e).forEach(dropAddressTaken);
  };
  const sweep = (stmts: Stmt[]): void => {
    for (const st of stmts) {
      stmtExprs(st).forEach(dropAddressTaken);
      sweep(stmtChildren(st));
    }
  };
  sweep(sfn.body);

  // `tails`: for each ancestor list, the statements after the ancestor on the path here.
  // `strong`: a loop or switch ancestor exists, so tails stop bounding what runs after.
  interface Ctx {
    tails: Stmt[][];
    strong: boolean;
  }
  // TOTAL (reads and pure writes) — see the note on stmtTouches. Runs against the pre-rewrite
  // tree (`skip` is an original-tree statement, found by identity); the rewrites never change a
  // name's presence in a subtree, so the verdict carries over to the rewritten one.
  const touchesOutside = (list: Stmt[], skip: Stmt, name: string): boolean =>
    list.some(
      (st) =>
        st !== skip &&
        (stmtExprs(st).some((e) => readsVar(e, name)) ||
          (st.k === 'assign' && st.name === name) ||
          touchesOutside(stmtChildren(st), skip, name)),
    );
  // Assigns this pass itself hoisted to an arm head's parent list. An ancestor `if` whose arm now
  // BEGINS with one would otherwise re-spell it again — rewriting its own condition's accidental
  // matching const into the variable and stealing the arrangement the inner guard needed.
  const moved = new Set<Stmt>();
  const rewriteList = (list: Stmt[], ctx: Ctx): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < list.length; i++) {
      const s0 = list[i];
      const s = recurse(s0, { tails: [...ctx.tails, list.slice(i + 1)], strong: ctx.strong });
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
          moved.has(t0) ||
          moved.has(e0) ||
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
        moved.add(t0);
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
        els.length === 0 &&
        then.length > 0 &&
        isConstAssign(then[0]) &&
        !moved.has(then[0]) &&
        fnLocal.has(then[0].name) &&
        cond.k === 'bin' &&
        NEGATE_REL[cond.op]
      ) {
        const init = then[0];
        const rest = list.slice(i + 1);
        const constSide =
          cond.l.k === 'const' && cond.l.value === init.value.value
            ? 'l'
            : cond.r.k === 'const' && cond.r.value === init.value.value
              ? 'r'
              : null;
        const deadAfter = ctx.strong
          ? !touchesOutside(sfn.body, s0, init.name)
          : !rest.some((t) => stmtTouches(t, init.name)) &&
            ctx.tails.every((tail) => !tail.some((t) => stmtTouches(t, init.name)));
        if (constSide !== null && !readsVar(cond, init.name) && deadAfter) {
          out.push(init);
          moved.add(init);
          cond = { ...cond, [constSide]: { k: 'var', name: init.name } };
          then = then.slice(1);
          changed = true;
        }
      }
      out.push({ ...s, cond, then, else: els });
    }
    return out;
  };

  const recurse = (s: Stmt, ctx: Ctx): Stmt => {
    const strong = { ...ctx, strong: true };
    switch (s.k) {
      case 'if':
        return { ...s, then: rewriteList(s.then, ctx), else: rewriteList(s.else, ctx) };
      case 'while':
      case 'dowhile':
        return { ...s, body: rewriteList(s.body, strong) };
      case 'for':
        return { ...s, body: rewriteList(s.body, strong) };
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: rewriteList(c.body, strong) })),
          ...(s.default ? { default: rewriteList(s.default, strong) } : {}),
        };
      default:
        return s;
    }
  };

  const body = rewriteList(sfn.body, { tails: [], strong: false });
  return changed ? { ...sfn, body } : null;
}
