// L3 pass: hoist a REUSED pointer base (a global address or a numeric pointer constant) into a
// typed local pointer.
//
// A base indexed at 2+ sites — `((u8 *)&gTable)[i+5]` and `[i+6]`, or the MMIO/RAM constant
// `((s32 *)0x40000d4)[0]`, `[1]`, `[2]` — re-materialized the address (a fresh pool load) at each
// access, whereas agbcc loads it ONCE into a register and reuses it (the reference spells this as a
// local: `u8 *t = gTable; t[i+5]; t[i+6]`). This pass reproduces that register: it hoists the shared
// base into a local pointer `T *p = (T *)base` and points each access at `p`, so the recompiled code
// keeps the address in one register instead of reloading it.
//
// SCOPE / SOUNDNESS. Only an `index` node whose base is a bare `addr` (a global address) or a bare
// `const` (a numeric pointer address) is eligible, and only when 2+ such nodes share the SAME
// (base, width, signedness) — an AGGREGATE base (F9 spells a SCALAR global as a bare `var`, which is
// never an `index`-of-leaf, so scalar recovery is untouched). Non-leaf bases (a local, a
// struct-element `p[a0]`, arithmetic) are excluded: agbcc may re-derive those, so hoisting them can
// MISMATCH (empirically confirmed). The hoisted local carries the access's pointer type, so the
// deref cast the C backend applied inline at each `index` now lands ONCE on the local's initializer
// and the accesses stride correctly with no per-use cast. A wrong hoist (a base agbcc would actually
// re-materialize) only changes recompiled bytes -> a LOST match under the zero-lost gate, never a
// miscompile: the address value is identical, just held in a different place.
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtChildren, stmtExprs } from './ast';

// A HOISTABLE base is a bare `addr` (a global address) or a bare `const` (a numeric pointer
// address). Both are relocation-invariant leaves whose value the compiler keeps in one register
// when it indexes them at 2+ sites. Anything else (a local var, a struct-element `p[a0]`, arbitrary
// arithmetic) is NOT — agbcc may re-derive it.
type HoistableBase = Extract<Expr, { k: 'addr' } | { k: 'const' }>;
const isHoistableBase = (e: Expr): e is HoistableBase => e.k === 'addr' || e.k === 'const';
const baseId = (b: HoistableBase): string => (b.k === 'addr' ? `a:${b.name}` : `c:${b.value}`);

/** The (base, access-shape) key an `index`-of-hoistable-base shares with its reuse siblings. */
const keyOf = (base: HoistableBase, width: number, signed: boolean): string => `${baseId(base)} ${width} ${signed}`;

interface Collected {
  count: Map<string, number>;
  order: string[];
  meta: Map<string, { base: HoistableBase; width: number; signed: boolean }>;
  /** keys with ANY use inside a loop — disqualified (see the loop note in `hoistReusedGlobalBases`). */
  inLoop: Set<string>;
  /** per key, how many times each CONSTANT offset was accessed. A constant offset touched 2+ times
   *  is a SCALAR access at one fixed location (a `*(T*)C |= x` MMIO read-modify-write, or repeated
   *  `*p`), which the compiler re-materializes rather than register-holds — hoisting it MISMATCHES
   *  (it broke the ProcessHBlankWait match). A key with ANY repeated constant offset is therefore
   *  disqualified, even if it ALSO has distinct-offset uses (a mixed scalar+array base). A genuine
   *  reused array base touches each constant offset once, or uses a variable index (not tallied). */
  constOffCount: Map<string, Map<number, number>>;
}

/** Every `index` node whose base is a hoistable leaf, tallied by key (for the 2+-reuse test) and in
 *  first-appearance order (so the hoisted assignments emit in the order the bases are first used,
 *  matching the compiler's pool-load order). `loop` marks uses nested in a while/do-while/for. */
function collect(stmts: Stmt[], c: Collected, loop: boolean): void {
  const visitExpr = (e: Expr, inLoop: boolean): void => {
    if (e.k === 'index' && isHoistableBase(e.base)) {
      const k = keyOf(e.base, e.width, e.signed);
      if (!c.count.has(k)) {
        c.order.push(k);
        c.meta.set(k, { base: e.base, width: e.width, signed: e.signed });
      }
      c.count.set(k, (c.count.get(k) ?? 0) + 1);
      if (inLoop) {
        c.inLoop.add(k);
      }
      if (e.idx.k === 'const') {
        const m = c.constOffCount.get(k) ?? c.constOffCount.set(k, new Map()).get(k)!;
        m.set(e.idx.value, (m.get(e.idx.value) ?? 0) + 1);
      }
    }
    for (const ch of exprChildrenOf(e)) {
      visitExpr(ch, inLoop);
    }
  };
  for (const s of stmts) {
    // A loop's OWN condition (`stmtExprs` of a while/do-while/for) runs every iteration, so a base
    // there is loop-invariant just like a body use — visit it with `nested`, not the outer flag.
    const nested = loop || s.k === 'while' || s.k === 'dowhile' || s.k === 'for';
    for (const e of stmtExprs(s)) {
      visitExpr(e, nested);
    }
    collect(stmtChildren(s), c, nested);
  }
}

// local re-export to avoid importing exprChildren twice (mapExprChildren covers rewrite).
function exprChildrenOf(e: Expr): Expr[] {
  const out: Expr[] = [];
  mapExprChildren(e, (c) => {
    out.push(c);
    return c;
  });
  return out;
}

/** Rewrite every `index`-of-hoistable-base whose key is hoisted so its base becomes the hoist local. */
function rewrite(e: Expr, localFor: Map<string, string>): Expr {
  if (e.k === 'index' && isHoistableBase(e.base)) {
    const nm = localFor.get(keyOf(e.base, e.width, e.signed));
    if (nm) {
      return { ...e, base: { k: 'var', name: nm }, idx: rewrite(e.idx, localFor) };
    }
  }
  return mapExprChildren(e, (c) => rewrite(c, localFor));
}

function rewriteStmt(s: Stmt, localFor: Map<string, string>): Stmt {
  const mapS = (x: Stmt): Stmt => rewriteStmt(x, localFor);
  switch (s.k) {
    case 'assign':
      return { ...s, value: rewrite(s.value, localFor) };
    case 'store':
      return { ...s, lval: rewrite(s.lval, localFor), value: rewrite(s.value, localFor) };
    case 'exprstmt':
      return { ...s, value: rewrite(s.value, localFor) };
    case 'return':
      return s.value ? { ...s, value: rewrite(s.value, localFor) } : s;
    case 'if':
      return { ...s, cond: rewrite(s.cond, localFor), then: s.then.map(mapS), else: s.else.map(mapS) };
    case 'while':
    case 'dowhile':
      return { ...s, cond: rewrite(s.cond, localFor), body: s.body.map(mapS) };
    case 'for':
      return { ...s, init: mapS(s.init), cond: rewrite(s.cond, localFor), inc: mapS(s.inc), body: s.body.map(mapS) };
    case 'switch':
      return {
        ...s,
        scrutinee: rewrite(s.scrutinee, localFor),
        cases: s.cases.map((c) => ({ ...c, body: c.body.map(mapS) })),
        default: s.default?.map(mapS),
      };
    case 'break':
    case 'continue':
      return s;
  }
}

/** A name not already used by a param/local/global in `sfn`, of the form `p<n>`. */
function freshName(taken: Set<string>): string {
  let n = 0;
  while (taken.has(`p${n}`)) {
    n++;
  }
  const nm = `p${n}`;
  taken.add(nm);
  return nm;
}

export function hoistReusedGlobalBases(sfn: SFn): SFn {
  const c: Collected = { count: new Map(), order: [], meta: new Map(), inLoop: new Set(), constOffCount: new Map() };
  collect(sfn.body, c, false);
  // A repeated CONSTANT offset means a scalar re-access at a fixed location (MMIO RMW / repeated
  // `*p`) the compiler re-materializes — disqualify the whole base, even mixed with array uses.
  const hasRepeatedConstOffset = (k: string): boolean => {
    for (const n of c.constOffCount.get(k)?.values() ?? []) {
      if (n >= 2) {
        return true;
      }
    }
    return false;
  };

  // Reuse 2+ and NOT used inside a loop. A loop-body base is loop-invariant, so the compiler ALSO
  // keeps it in a register across the loop — but hoisting it to the function top forces a
  // callee-saved register that can add prologue push/pop the original avoided, worsening the match
  // (register-pressure matching, not a correctness issue). Straight-line / branch reuse is the safe
  // win; a loop-body base is left inline for a future scope-aware hoist.
  const { count, order, meta } = c;
  const hoisted = order.filter((k) => (count.get(k) ?? 0) >= 2 && !c.inLoop.has(k) && !hasRepeatedConstOffset(k));
  if (hoisted.length === 0) {
    return sfn;
  }

  const taken = new Set<string>([...sfn.params.map((p) => p.name), ...sfn.locals.map((l) => l.name)]);
  // globals are referenced by name; a hoist name must not shadow one that appears in the body.
  collectNames(sfn.body, taken);

  const localFor = new Map<string, string>();
  const newLocals: { name: string; type: IrType }[] = [];
  const hoistStmts: Stmt[] = [];
  for (const k of hoisted) {
    const m = meta.get(k)!;
    const ptrType = T.ptr(scalarTypeForAccess(m.width, m.signed));
    const nm = freshName(taken);
    localFor.set(k, nm);
    newLocals.push({ name: nm, type: ptrType });
    // `p = (T *)base` — the cast makes the local the access's pointer type so each `p[i]` strides it.
    hoistStmts.push({ k: 'assign', name: nm, value: { k: 'cast', to: ptrType, e: m.base } });
  }

  const body = [...hoistStmts, ...sfn.body.map((s) => rewriteStmt(s, localFor))];
  return { ...sfn, body, locals: [...sfn.locals, ...newLocals] };
}

/** Every `var`/`addr`/called-function name mentioned anywhere in `stmts` (so a hoist name collides
 *  with none — a global via `addr`, a local via `var`, OR a callee via `call.fn`). */
function collectNames(stmts: Stmt[], out: Set<string>): void {
  const walk = (e: Expr): void => {
    if (e.k === 'var' || e.k === 'addr') {
      out.add(e.name);
    }
    if (e.k === 'call') {
      out.add(e.fn); // a hoist local must not shadow a called function symbol
    }
    for (const c of exprChildrenOf(e)) {
      walk(c);
    }
  };
  for (const s of stmts) {
    if (s.k === 'assign') {
      out.add(s.name);
    }
    for (const e of stmtExprs(s)) {
      walk(e);
    }
    collectNames(stmtChildren(s), out);
  }
}
