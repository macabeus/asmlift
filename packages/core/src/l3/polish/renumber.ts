// Locals numbered as a reader meets them: `v0`, `v1`, `v2` in the order the body first mentions
// them, with no gaps, and a declared local the body never mentions not declared at all.
//
// A RENAME, NOT A REORDER. The declarations keep the positions the printer gave them, because the
// position is not a spelling: agbcc hands spilled locals their frame slots by declaration rank
// (l3/slotorder.ts), so moving a declaration moves a slot. Only the NAMES move.
//
// Only a local named `v<N>` is renumbered: one that carries another name (a counter's `i`, a role
// name, a frame object's `sp<N>`) was named on purpose. And the renumbering is skipped whole where a
// new name would collide with any other identifier the function names: a parameter, another local,
// a static, a global or a callee.
//
// A local is dropped only where it cannot be the program's: unmentioned, not `volatile`, not a frame
// object, with no initializer and no spill home, and of a scalar or pointer type. An unused array or
// struct is an object the frame may still hold. And never at a level that compiles each statement as
// written (`PolishFacts.literal`): there an unused `s32` still takes a frame slot and moves every
// other slot's offset — `sub sp, #16` against `#12` on agbcc at -O0, and the same on IDO 7.1 at -O0
// and -O1 and on gcc 2.7.2 and KMC gcc at -O0 (compiled). At agbcc -O1/-O2, IDO -O2, gcc 2.7.2 and
// KMC gcc -O1/-O2 and every mwcc level the benchmark ranks at, it compiles alike. The renaming is
// pure spelling at every level.
//
// The variation names a candidate is published under (`coalesce-v4-v0`) keep the names the tree had
// when the variation ran, before this renumbering.
import type { PolishFacts } from '.';
import { type Expr, type SFn, type Stmt, exprChildren, mapStmtLists } from '../ast';
import { mapExprDeep } from './walk';

const GENERIC = /^v\d+$/;

/** Every identifier the body mentions, in the order the printer prints it. */
function mentionOrder(fn: SFn): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const name = (n: string) => {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  const expr = (e: Expr): void => {
    if (e.k === 'var' || e.k === 'addr' || e.k === 'postincr') {
      name(e.name);
    }
    if (e.k === 'call' && typeof e.fn === 'string') {
      name(e.fn);
    }
    exprChildren(e).forEach(expr);
  };
  const stmt = (s: Stmt): void => {
    switch (s.k) {
      case 'assign':
        name(s.name);
        expr(s.value);
        return;
      case 'store':
        expr(s.lval);
        expr(s.value);
        return;
      case 'exprstmt':
        expr(s.value);
        return;
      case 'return':
        if (s.value) {
          expr(s.value);
        }
        return;
      case 'if':
        expr(s.cond);
        s.then.forEach(stmt);
        s.else.forEach(stmt);
        return;
      case 'while':
        expr(s.cond);
        s.body.forEach(stmt);
        return;
      case 'dowhile':
        s.body.forEach(stmt);
        expr(s.cond);
        return;
      case 'for':
        stmt(s.init);
        expr(s.cond);
        stmt(s.inc);
        s.body.forEach(stmt);
        return;
      case 'switch': {
        expr(s.scrutinee);
        const arms = s.cases.map((c) => c.body);
        arms.splice(s.defaultAt ?? s.cases.length, 0, s.default ?? []);
        arms.forEach((a) => a.forEach(stmt));
        return;
      }
      case 'break':
      case 'continue':
      case 'goto':
      case 'caseEndGoto':
        return;
    }
  };
  fn.body.forEach(stmt);
  return out;
}

type Local = SFn['locals'][number];

const droppable = (l: Local): boolean =>
  !l.volatile &&
  l.frame === undefined &&
  l.init === undefined &&
  l.uninit === undefined &&
  l.slots === undefined &&
  (l.type.kind === 'int' || l.type.kind === 'ptr');

function renameStmt(s: Stmt, to: ReadonlyMap<string, string>): Stmt {
  const e = (x: Expr): Expr =>
    mapExprDeep(x, (n) =>
      (n.k === 'var' || n.k === 'addr' || n.k === 'postincr') && to.has(n.name) ? { ...n, name: to.get(n.name)! } : n,
    );
  const inner = mapStmtLists(s, (list) => list.map((c) => renameStmt(c, to)));
  switch (inner.k) {
    case 'assign':
      return { ...inner, name: to.get(inner.name) ?? inner.name, value: e(inner.value) };
    case 'store':
      return { ...inner, lval: e(inner.lval), value: e(inner.value) };
    case 'exprstmt':
      return { ...inner, value: e(inner.value) };
    case 'return':
      return inner.value ? { ...inner, value: e(inner.value) } : inner;
    case 'if':
    case 'while':
    case 'dowhile':
      return { ...inner, cond: e(inner.cond) };
    case 'for':
      return { ...inner, init: renameStmt(inner.init, to), cond: e(inner.cond), inc: renameStmt(inner.inc, to) };
    case 'switch':
      return { ...inner, scrutinee: e(inner.scrutinee) };
    case 'break':
    case 'continue':
    case 'goto':
    case 'caseEndGoto':
      return inner;
  }
}

export function renumberLocals(fn: SFn, facts: PolishFacts): SFn {
  const order = mentionOrder(fn);
  const mentioned = new Set(order);
  const locals = fn.locals.filter((l) => mentioned.has(l.name) || facts.literal || !droppable(l));
  const generic = new Set(locals.filter((l) => GENERIC.test(l.name)).map((l) => l.name));
  const ranked = [
    ...order.filter((n) => generic.has(n)),
    ...locals.filter((l) => generic.has(l.name) && !mentioned.has(l.name)).map((l) => l.name),
  ];
  const to = new Map(ranked.map((n, i) => [n, `v${i}`]));
  const others = new Set([
    ...order.filter((n) => !generic.has(n)),
    ...fn.params.map((p) => p.name),
    ...locals.filter((l) => !generic.has(l.name)).map((l) => l.name),
    ...(fn.statics ?? []).map((s) => s.name),
    ...(fn.images ?? []).map((s) => s.name),
    ...(fn.globals ?? []).map((g) => g.name),
  ]);
  const renames = [...to].some(([a, b]) => a !== b) && ![...to.values()].some((n) => others.has(n));
  if (!renames) {
    return locals.length === fn.locals.length ? fn : { ...fn, locals };
  }
  return {
    ...fn,
    locals: locals.map((l) => (to.has(l.name) ? { ...l, name: to.get(l.name)! } : l)),
    body: fn.body.map((s) => renameStmt(s, to)),
  };
}
