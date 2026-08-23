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
//   • guard re-spelling — an else-less `if` whose then-arm begins with `v = X` and whose
//     condition carries X ITSELF as a comparison side: the assign moves above and that side
//     becomes `v`. X is a const (`for (j = 0; j < n;…)`'s shape) or a pure NON-VOLATILE read
//     (`for (j = *p; j < size;…)` — guard and init read the same cell back to back, which the
//     local-spelling source reads ONCE; collapsing the adjacent pair is what the compiler saw).
//
// SCOPE (decline over approximate): both rewrites touch PRIVATE locals only — a bare-global
// assign stores memory other code observes, a VOLATILE local's store is itself observable (the
// escaped DMA scratch), and a local whose ADDRESS is taken anywhere can be read through the
// pointer where no name betrays it — all three stay put. The common-arm hoist carries pure
// CONST values only. A guard re-spell's X must be call-free and marker-free, may mention only
// the function's own non-volatile params/locals (a global or `&gSym` could be project-declared
// volatile, and a volatile read may not be deduplicated), and the substitution must PRESERVE
// THE COMPARE'S MEANING: the variable's declared type can differ from X's rendered type, so the
// swap is admitted only when both sides were provably non-negative (every signedness reading
// agrees there) or the compare's rendered signedness is unchanged — anything indeterminate
// refuses. The condition must not read the variable (its pre-assign value dies in the move)
// and, for a READ X, must be effect-free as a whole (the hoist moves X's read above it). The
// guard re-spelling
// mints a write on a previously write-free path, so it needs that write to be DEAD there: the
// variable must be untouched after the `if` in its own list and in the tail of every ancestor
// list (a sibling arm of an ancestor `if` is not "after" — it never runs in the same entry).
// Under a loop or switch ancestor the tails stop describing what runs next (a back edge
// re-enters everything, a case can fall through), so there the variable must appear nowhere
// outside the rewritten `if` at all. Declines (null) when nothing changes.
import type { Expr, SFn, Stmt } from './ast';
import { NEGATE_REL, exprChildren, exprEquals, stmtChildren, stmtExprs } from './ast';
import { declaredTypes, provablyNonNegative, renderedIntSignedness } from './typing';

const readsVar = (e: Expr, name: string): boolean =>
  ((e.k === 'var' || e.k === 'addr') && e.name === name) || exprChildren(e).some((c) => readsVar(c, name));

// READS only — a pure write in a tail is benign (it overwrites the minted value on every path,
// and any read after it is that write's business); touchesOutside below is TOTAL because strong
// mode must know the name is absent, presence of any kind included.
const stmtTouches = (s: Stmt, name: string): boolean =>
  stmtExprs(s).some((e) => readsVar(e, name)) || stmtChildren(s).some((x) => stmtTouches(x, name));

const isConstAssign = (s: Stmt): s is Extract<Stmt, { k: 'assign' }> & { value: { k: 'const'; value: number } } =>
  s.k === 'assign' && s.value.k === 'const';

/** Peel value-preserving `(s32)`/`(u32)` casts. Width 32 only: a narrower target truncates. */
const stripWideIntCast = (e: Expr): Expr =>
  e.k === 'cast' && e.to.kind === 'int' && e.to.width === 32 ? stripWideIntCast(e.e) : e;

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
  const volatileLocals = new Set(
    sfn.locals.filter((l) => l.volatile === true || l.pointeeVolatile === true).map((l) => l.name),
  );
  const ownNames = new Set([...sfn.params.map((p) => p.name), ...sfn.locals.map((l) => l.name)]);
  // a guard re-spell's X: call/marker-free, every named leaf a non-volatile param/local of THIS
  // function (a global or &gSym could be project-declared volatile), and every deref rooted at a
  // var through casts only. The var-root rule is a TWO-WORLD argument, not a volatility proof: a
  // deref through a plain-declared pointer local may still be MMIO, but the /volatile axis
  // enumerates the qualified sibling — where this lever refuses — so both worlds reach the
  // differ and collapsing reads here is the plain world's own premise. A raw `*(u16 *)CONST`
  // deref has NO local for /volatile to qualify, so no sibling carries the volatile world and
  // the collapse would silently discard it.
  const varRooted = (e: Expr): boolean => (e.k === 'var' ? true : e.k === 'cast' ? varRooted(e.e) : false);
  const hoistableRead = (e: Expr): boolean => {
    if (e.k === 'call' || e.k === 'marker' || e.k === 'addr') {
      return false;
    }
    if (e.k === 'var' && (!ownNames.has(e.name) || volatileLocals.has(e.name))) {
      return false;
    }
    if ((e.k === 'index' || e.k === 'field') && !varRooted(e.base)) {
      return false;
    }
    return exprChildren(e).every(hoistableRead);
  };
  // A READ X's hoist moves its evaluation ABOVE the whole condition, so the condition must
  // carry no effect it could cross (a call there could write the cell X reads); a CONST init
  // crosses nothing and keeps the wider admission.
  const effectFree = (e: Expr): boolean => e.k !== 'call' && e.k !== 'marker' && exprChildren(e).every(effectFree);
  // A compare operand and the init's value denote the same 32-bit value under different SPELLINGS
  // when a width-32 cast is all that separates them: `/uns-cmp` wraps one side in `(u32)` to make
  // the branch unsigned, and on a zero-trip guard that side is the very const the init assigns.
  // The swap is still exact — `v = X` stores X's 32 bits and `v` is 32-bit-declared
  // (meaningPreserved refuses otherwise), so `v` and `(u32)X` carry the same bit pattern and only
  // the compare's rendered signedness can differ, which meaningPreserved checks separately. A
  // NARROWING cast changes the value and never matches; a POINTER cast is excluded by the same
  // width test, and with it every volatile-qualified spelling (the qualifier lives on a pointee).
  const sameValue = (a: Expr, b: Expr): boolean => exprEquals(stripWideIntCast(a), stripWideIntCast(b));
  const env = declaredTypes(sfn);
  // The compare-meaning gate (see SCOPE): substituting `v` for X may change the compare's
  // rendered signedness through v's declared type. Sufficiency: v's declared width must be 32
  // (the assignment `v = X` then represents any 32-bit-or-narrower X exactly, so v's runtime
  // value EQUALS X's — a narrow-declared v would truncate and no signedness reasoning survives
  // that), and then (a) both original sides provably in [0, 2^31) ⇒ signed and unsigned
  // compares agree on the actual values whatever the swap does to rendered signedness; (b)
  // otherwise a defined, UNCHANGED rendered signedness over equal values gives the identical
  // result. Anything indeterminate refuses.
  const meaningPreserved = (l: Expr, r: Expr, side: 'l' | 'r', v: string): boolean => {
    const vt = env(v);
    if (vt?.kind !== 'int' || vt.width !== 32) {
      return false;
    }
    if (provablyNonNegative(l, env) && provablyNonNegative(r, env)) {
      return true;
    }
    const sign = (a: Expr, b: Expr): boolean | undefined => {
      const sa = renderedIntSignedness(a, env);
      const sb = renderedIntSignedness(b, env);
      return sa === false || sb === false ? false : sa === true && sb === true ? true : undefined;
    };
    const before = sign(l, r);
    const vv: Expr = { k: 'var', name: v };
    const after = side === 'l' ? sign(vv, r) : sign(l, vv);
    return before !== undefined && before === after;
  };

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
      // const operand reads through it unconditionally — no tail gate needed.
      // A BARE const only, where the guard re-spelling below uses the cast-tolerant `sameValue`:
      // this site does not run `meaningPreserved`, so it may not swap in a name whose declared
      // type could re-render the compare's signedness — which is exactly what peeling a `(u32)`
      // would put on the table. A row that needs `/uns-cmp`'s spelling hoisted here brings the
      // gate with it.
      for (const hv of hoisted) {
        if (cond.k === 'bin' && NEGATE_REL[cond.op]) {
          if (cond.l.k === 'const' && cond.l.value === hv.value) {
            cond = { ...cond, l: { k: 'var', name: hv.name } };
          } else if (cond.r.k === 'const' && cond.r.value === hv.value) {
            cond = { ...cond, r: { k: 'var', name: hv.name } };
          }
        }
      }
      // guard re-spelling — X a const or a hoistable read, matched as a whole comparison side
      if (
        els.length === 0 &&
        then.length > 0 &&
        then[0].k === 'assign' &&
        !moved.has(then[0]) &&
        fnLocal.has(then[0].name) &&
        cond.k === 'bin' &&
        NEGATE_REL[cond.op]
      ) {
        const init = then[0];
        const rest = list.slice(i + 1);
        const side =
          isConstAssign(init) || hoistableRead(init.value)
            ? sameValue(cond.l, init.value)
              ? ('l' as const)
              : sameValue(cond.r, init.value)
                ? ('r' as const)
                : null
            : null;
        const deadAfter = ctx.strong
          ? !touchesOutside(sfn.body, s0, init.name)
          : !rest.some((t) => stmtTouches(t, init.name)) &&
            ctx.tails.every((tail) => !tail.some((t) => stmtTouches(t, init.name)));
        if (
          side !== null &&
          !readsVar(cond, init.name) &&
          deadAfter &&
          (isConstAssign(init) || effectFree(cond)) &&
          meaningPreserved(cond.l, cond.r, side, init.name)
        ) {
          out.push(init);
          moved.add(init);
          cond = { ...cond, [side]: { k: 'var', name: init.name } };
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
