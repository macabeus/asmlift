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
// WHICH bases. The pass hoists every key its gate list admits, which answers per FUNCTION a
// question the source answered per BASE — one register file spelled as a pointer local beside
// scalar cells spelled as bare derefs. The `single-cell` gate is what makes the narrower answer
// reachable: under `LIVEBASE_BLOCK_GATES` a base every access of which is ONE fixed offset stays
// inline, and rank's LIVEBASE_ADMISSIONS roster emits each table's hoist — and every product of
// it — as its own candidate family, for the differ to referee between them. The unit is
// the (base, width, signedness) KEY, not the base — a base read at two widths is two keys, and the
// gate can leave one of them inline while the other binds. COVERAGE: two admissions, not a subset
// lattice, so "some of the several block bases" stays unreachable — a function with two register
// files binds both or neither.
//
// WHAT THE ASM SETTLES. `single-use` refuses a base reached once, on the theory that one access
// re-materializes as cheaply as a named local. Where the compiler constant-folds an inline
// constant-address access's offset into the literal it materializes
// (TargetDescription.compilerBehaviors.foldsConstAddrOffset) that theory is checkable rather than
// assumed: `((u8 *)0x3001100)[3]` emits `.word 0x3001103` + `ldrb [r1]`, so a target holding
// `.word 0x3001100` + `ldrb [r1, #0x3]` came from a source that named the base. The frontend keeps
// that split — an `add rN, #K` between the pool load and the access folds back into one absolute
// address, so a non-zero index arriving here means the offset was in the MEMORY OPERAND. That is
// `unfoldedOffset`, and its three refusals: a SYMBOL base (both spellings emit the same bytes, so
// the asm carries no evidence), an offset of 0 (the fold is the identity), and a target that
// declares nothing (MIPS/PPC put the addend in the instruction whatever the source said).
//
// SCOPE / SOUNDNESS. Only an `index` node whose base is a bare `addr` (a global address) or a bare
// `const` (a numeric pointer address) is eligible, keyed by (base, width, signedness) — how many
// nodes a key needs is the gate table's question, above — an AGGREGATE base (F9 spells a SCALAR global as a bare `var`, which is
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
  /** keys indexed by a NON-constant expression somewhere — an array walk, so the base reaches a
   *  BLOCK of cells however few constant offsets it also touches (see `single-cell`). */
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
  /** every access is the SAME fixed offset — one scalar cell rather than a block of them */
  singleCell: boolean;
  /** A NUMERIC base reached at a non-zero constant offset, on a compiler that folds such an offset
   *  into the literal it materializes (TargetDescription.compilerBehaviors.foldsConstAddrOffset).
   *  There the asm's own split IS the answer: the inline spelling would have emitted the summed
   *  literal at offset 0, so a surviving offset says the source held this base in a named object.
   *  False for a SYMBOL base — `gSym[3]` and `p = gSym; p[3]` emit the same bytes, so the asm
   *  carries no evidence — and false at offset 0, where the fold is the identity. */
  unfoldedOffset: boolean;
}

/** The TARGET facts the admission reads, as a bag rather than a positional boolean so the call
 *  sites name what they are passing. */
export interface BaseCseFacts {
  foldsConstAddrOffset?: boolean;
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
    why: 'one access re-materializes as cheaply as a named local, unless the asm shows it did not',
    sound: false,
    rejects: (c) => c.uses < 2 && !c.unfoldedOffset,
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

/** `/livebase-block`'s admission (rank.ts): `/livebase` plus `single-cell`. The two tables differ
 *  by exactly one gate, so `without(LIVEBASE_BLOCK_GATES, 'single-cell')` is `/livebase`'s own
 *  admission and this selectivity axis prices by ablation like every other.
 *
 *  `single-cell` GENERATES a narrower candidate; it does not classify, and taking it for a compiler
 *  fact is the way to misuse it. Its counterexample is in this corpus: `synthetic:sizebound`'s
 *  `*(u16 *)0x03001048` is reached at one fixed offset only — this rule rejects it — and binding it
 *  is what the differ picks (16 against 36 on the same shape). The rule is legitimate anyway
 *  because it never SUBTRACTS a candidate: `/livebase` rides beside it, and the differ referees.
 *  Promote it into `BASECSE_GATES` or prune with it and that row pays.
 *
 *  Why the ACCESS SHAPE and not the address: an MMIO register file and the IWRAM halfword beside
 *  it are both numeric constants in the same range. And why the rule is not in `BASECSE_GATES`: it
 *  would reject nothing there, being a strict refinement of `repeated-const-offset` — past
 *  `single-use`, a base with no variable index and one distinct offset touched it twice. */
export const LIVEBASE_BLOCK_GATES: readonly Gate<BaseKey>[] = [
  ...LIVEBASE_GATES,
  {
    id: 'single-cell',
    why: 'a base reached at one fixed offset reads as a scalar, which the source more often spells inline',
    sound: false,
    rejects: (c) => c.singleCell,
  },
];

/** The census without the rewrite, so a caller choosing between admissions can compare what two
 *  tables would bind for one tree walk each. */
export function admittedBases(sfn: SFn, gates: readonly Gate<BaseKey>[], facts: BaseCseFacts = {}): readonly string[] {
  return admit(sfn, gates, facts).keys;
}

/** The keys `gates` admits, in first-use order, with the census they were judged from. */
function admit(sfn: SFn, gates: readonly Gate<BaseKey>[], facts: BaseCseFacts): { c: Collected; keys: string[] } {
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
        singleCell: !c.varIndexed.has(k) && (c.constOffCount.get(k)?.size ?? 0) <= 1,
        unfoldedOffset:
          facts.foldsConstAddrOffset === true &&
          c.meta.get(k)?.base.k === 'const' &&
          [...(c.constOffCount.get(k)?.keys() ?? [])].some((o) => o !== 0),
      }) === null,
  );
  return { c, keys };
}

export function hoistReusedGlobalBases(
  sfn: SFn,
  gates: readonly Gate<BaseKey>[] = BASECSE_GATES,
  facts: BaseCseFacts = {},
): SFn {
  const { c, keys: hoisted } = admit(sfn, gates, facts);
  const { meta } = c;
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
