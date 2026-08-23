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
// WHICH bases. The pass hoists every key its gate list admits, which answers the question per
// FUNCTION where the source answered it per BASE — one register file spelled as a pointer local
// beside scalar cells spelled as bare derefs. `baseSpanCandidates` splits the admission by SPAN
// (see `BaseSpan`) and emits each half as its own candidate for the differ to referee.
//
// SCOPE / SOUNDNESS. Only an `index` node whose base is a bare `addr` (a global address) or a bare
// `const` (a numeric pointer address) is eligible, and only when 2+ such nodes share the SAME
// (base, width, signedness) — an AGGREGATE base (F9 spells a SCALAR global as a bare `var`, which is
// never an `index`-of-leaf, so scalar recovery is untouched). Non-leaf bases (a local, a
// struct-element `p[a0]`, arithmetic) are excluded: agbcc may re-derive those, so hoisting them can
// MISMATCH (empirically confirmed) — the differ-refereed `/addr-home` axis
// (structure/analysis.ts homeSharedAddresses) serves the shared gaddr-free ARITHMETIC bases
// instead.
// The hoisted local carries the access's pointer type, so the
// deref cast the C backend applied inline at each `index` now lands ONCE on the local's initializer
// and the accesses stride correctly with no per-use cast. A wrong hoist (a base agbcc would actually
// re-materialize) only changes recompiled bytes -> a LOST match under the zero-lost gate, never a
// miscompile: the address value is identical, just held in a different place.
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, mapStmtExprs, stmtChildren, stmtExprs } from './ast';
import { type Gate, ablateHeuristic, firstRejection } from './gates';
import { nameAllocator } from './hoist';

// A HOISTABLE base is a bare `addr` (a global address) or a bare `const` (a numeric pointer
// address). Both are relocation-invariant leaves whose value the compiler keeps in one register
// when it indexes them at 2+ sites. Anything else (a local var, a struct-element `p[a0]`, arbitrary
// arithmetic) is NOT — agbcc may re-derive it. Admitting the bare `var` that scopebase.ts and
// argbase.ts take is the obvious consolidation and it is wrong twice over: this pass has no `lead`
// handling, so a rank-aware `g[0][i]` comes out as `p[0][i]` through a scalar pointer, and it
// undoes raise/gvn.ts's hoist on exactly the rows a symbol map serves (test/addr-placement.test.ts).
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
  /** per key, how many times each CONSTANT offset was accessed — the input to the
   *  `repeated-const-offset` gate, which losing the ProcessHBlankWait match is what bought. A
   *  genuine reused array base touches each constant offset once, or indexes by a variable (not
   *  tallied); a repeat means a scalar re-access, and ONE is enough to disqualify the base even
   *  when it also has distinct-offset uses. */
  constOffCount: Map<string, Map<number, number>>;
  /** keys indexed by a NON-constant expression somewhere — an array walk, so the base spans
   *  cells however few constant offsets it also touches (see `spanOf`). */
  varIndexed: Set<string>;
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
      } else {
        c.varIndexed.add(k);
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

/** One base under consideration, keyed as `(base, width, signedness)`. */
export interface BaseKey {
  key: string;
  uses: number;
  inLoop: boolean;
  /** some CONSTANT offset through this base is touched 2+ times */
  repeatedConstOffset: boolean;
}

/** The admission rules. NONE is sound, and that is a property of the pass rather than an oversight:
 *  a wrong hoist emits the same address held in a different place, so it costs bytes and a match,
 *  never meaning. The zero-lost benchmark gate is what referees them.
 *
 *  The `loop` rule is the subtle one. A loop-body base is loop-invariant, so the compiler keeps it
 *  in a register across the loop too — but hoisting to the FUNCTION TOP forces a callee-saved
 *  register, which can add the prologue push/pop the original avoided. `l3/scopebase.ts` is the
 *  scope-aware hoist that serves those instead. */
export const BASECSE_GATES: readonly Gate<BaseKey>[] = [
  {
    id: 'single-use',
    why: 'one access re-materializes as cheaply as a named local',
    sound: false,
    rejects: (c) => c.uses < 2,
  },
  {
    id: 'loop',
    why: 'a function-top hoist of a loop base forces a callee-saved register the original avoided',
    sound: false,
    rejects: (c) => c.inLoop,
  },
  {
    id: 'repeated-const-offset',
    why: 'a fixed offset touched twice is a scalar RMW, which the compiler re-materializes',
    sound: false,
    rejects: (c) => c.repeatedConstOffset,
  },
];

/** The `/livebase` lever's admission (rank.ts): the default rules with both PLACEMENT heuristics
 *  ablated, keeping only `single-use`. `loop` and `repeated-const-offset` predict which spelling
 *  the compiler chose, and both predictions have a counterexample — an MMIO poll (`p[2] = go;
 *  while (p[2] & BUSY) {}`) stores and re-reads a fixed offset through ONE register the whole
 *  time. Neither gate is `sound`, so ablating them can only change which spelling wins, never
 *  what a candidate means; the differ referees. */
export const LIVEBASE_GATES: readonly Gate<BaseKey>[] = ablateHeuristic(
  ablateHeuristic(BASECSE_GATES, 'loop'),
  'repeated-const-offset',
);

/** How much of an object a base's accesses reach: SEVERAL cells (2+ distinct constant offsets, or
 *  any variable index — a register file, a struct, an array) or a SINGLE one (a scalar). Which of
 *  the two a source spelled as a pointer local is exactly the question `baseSpanCandidates`
 *  enumerates; that it has TWO answers and not one per base is what bounds that enumeration. */
export type BaseSpan = 'block' | 'cell';

const spanOf = (c: Collected, k: string): BaseSpan =>
  c.varIndexed.has(k) || (c.constOffCount.get(k)?.size ?? 0) >= 2 ? 'block' : 'cell';

/** The keys `gates` admits, in first-use order, with the census they were judged from. */
function admit(sfn: SFn, gates: readonly Gate<BaseKey>[]): { c: Collected; keys: string[] } {
  const c: Collected = {
    count: new Map(),
    order: [],
    meta: new Map(),
    inLoop: new Set(),
    constOffCount: new Map(),
    varIndexed: new Set(),
  };
  collect(sfn.body, c, false);
  const keys = c.order.filter(
    (k) =>
      firstRejection(gates, {
        key: k,
        uses: c.count.get(k) ?? 0,
        inLoop: c.inLoop.has(k),
        repeatedConstOffset: [...(c.constOffCount.get(k)?.values() ?? [])].some((n) => n >= 2),
      }) === null,
  );
  return { c, keys };
}

/** The alternative HOISTS of one admission: the same gates, restricted to the bases of one span.
 *  Which of a function's several numeric bases the source named is per-base knowledge the asm does
 *  not carry — an MMIO register file wants one register held across the whole body while the
 *  scalar cell beside it re-materializes — so the spans are emitted as their own candidates and the
 *  differ referees, the same alternative-OUTPUTS mechanism as `volatileSubsetCandidates`.
 *
 *  BOUND: a span is one of two values, so this offers at most TWO extra spellings however many
 *  bases the function has — never a subset explosion. Empty when the admitted bases are all one
 *  span (no choice to offer) or when nothing is admitted; the all-spans hoist is the plain lever's
 *  own candidate and is never repeated here. */
export function baseSpanCandidates(sfn: SFn, gates: readonly Gate<BaseKey>[]): { merged: BaseSpan; sfn: SFn }[] {
  const { c, keys } = admit(sfn, gates);
  const spans = [...new Set(keys.map((k) => spanOf(c, k)))];
  return spans.length < 2 ? [] : spans.map((s) => ({ merged: s, sfn: hoistReusedGlobalBases(sfn, gates, s) }));
}

export function hoistReusedGlobalBases(
  sfn: SFn,
  gates: readonly Gate<BaseKey>[] = BASECSE_GATES,
  /** hoist only the admitted bases of this span (`baseSpanCandidates`); absent ⇒ every one */
  onlySpan?: BaseSpan,
): SFn {
  const { c, keys } = admit(sfn, gates);
  const { meta } = c;
  const hoisted = onlySpan === undefined ? keys : keys.filter((k) => spanOf(c, k) === onlySpan);
  if (hoisted.length === 0) {
    return sfn;
  }

  const fresh = nameAllocator(sfn);

  const localFor = new Map<string, string>();
  const newLocals: { name: string; type: IrType }[] = [];
  const hoistStmts: Stmt[] = [];
  for (const k of hoisted) {
    const m = meta.get(k)!;
    const ptrType = T.ptr(scalarTypeForAccess(m.width, m.signed));
    const nm = fresh();
    localFor.set(k, nm);
    newLocals.push({ name: nm, type: ptrType });
    // `p = (T *)base` — the cast makes the local the access's pointer type so each `p[i]` strides it.
    hoistStmts.push({ k: 'assign', name: nm, value: { k: 'cast', to: ptrType, e: m.base } });
  }

  const rewritten = sfn.body.map((s) => mapStmtExprs(s, (e) => rewrite(e, localFor)));
  // Pool-load order (see `collect`): inits emit in first-use order. When rank's /livebase re-runs
  // this pass, the tree's head already carries the default run's inits — blindly prepending would
  // spell the new base's load above locals the compiler loads first. So the head run of
  // init-shaped assigns is re-ordered together with the new inits by each local's first use in
  // the remaining body; ties keep list order, existing inits first. This deliberately reaches the
  // single default run too (a head of user pointer inits before a firing hoist), where it repairs
  // the same invariant. An init-shaped assign is a ptr-cast of an addr/const leaf into a declared
  // NON-VOLATILE local — it reads nothing and writes its own plain cell, so any order among them
  // means the same thing. The volatile check is load-bearing: two writes to `volatile` locals are
  // observably ordered, so one at the head simply ends the reorderable run.
  const plainLocals = new Set(sfn.locals.filter((l) => !l.volatile).map((l) => l.name));
  const isInitShaped = (s: Stmt): s is Stmt & { k: 'assign' } =>
    s.k === 'assign' &&
    plainLocals.has(s.name) &&
    s.value.k === 'cast' &&
    s.value.to.kind === 'ptr' &&
    isHoistableBase(s.value.e);
  let headLen = 0;
  while (headLen < rewritten.length && isInitShaped(rewritten[headLen])) {
    headLen++;
  }
  const inits = [...rewritten.slice(0, headLen), ...hoistStmts] as (Stmt & { k: 'assign' })[];
  const rest = rewritten.slice(headLen);
  const firstUse = new Map<string, number>();
  for (const s of inits) {
    if (!firstUse.has(s.name)) {
      const i = rest.findIndex((r) => stmtMentionsVar(r, s.name));
      firstUse.set(s.name, i === -1 ? rest.length : i);
    }
  }
  inits.sort((a, b) => firstUse.get(a.name)! - firstUse.get(b.name)!);
  return { ...sfn, body: [...inits, ...rest], locals: [...sfn.locals, ...newLocals] };
}

/** Whether `name` occurs as a `var` anywhere in the statement, nested statements included. */
function stmtMentionsVar(s: Stmt, name: string): boolean {
  const inExpr = (e: Expr): boolean => (e.k === 'var' && e.name === name) || exprChildrenOf(e).some(inExpr);
  if (s.k === 'assign' && s.name === name) {
    return true;
  }
  return stmtExprs(s).some(inExpr) || stmtChildren(s).some((ch) => stmtMentionsVar(ch, name));
}
