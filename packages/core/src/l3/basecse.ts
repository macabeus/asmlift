// L3 pass: hoist a leaf pointer base (a global address or a numeric pointer constant) into a
// typed local pointer. HOW MANY uses a base needs is the gate table's question, not the pass's:
// the default table wants 2+, `BASEFOLD_GATES` admits one under the conditions below.
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
// WHAT THE ASM SUGGESTS, AND WHY IT IS A CANDIDATE. `single-use` refuses a base reached once, on
// the theory that one access re-materializes as cheaply as a named local. A surviving `[rN, #imm]`
// off a register holding a bare address is EVIDENCE against that theory, on a compiler that folds
// a constant SUBSCRIPT into the literal it materializes
// (TargetDescription.compilerBehaviors.foldsConstAddrOffset, where the compiled pair is).
// `BaseKey.unfoldedOffset` is that shape: the access's constant offset reached the MEMORY OPERAND
// rather than the materialized literal, which `l3/ast.ts`'s `index.operandOff` carries down from
// the lift because the fold at L3 makes the two indistinguishable.
// HOW STRONG THE EVIDENCE IS, compiled in both directions rather than reasoned about — and the
// answer differs between the two base kinds, so read the one you are looking at.
// For a NUMERIC base every inline shape tried spends the offset somewhere the operand does not
// see it: one read folds it into the literal (`.word 0x3001103` + `ldrb [r0]`); several reads at
// several offsets share ONE pool word and pay `sub`/`add` per access; a store pair agbcc CSEs
// (`*(u8 *)0x3001100 = v; *(u16 *)0x3001102 = v;` → one pool word plus `add r1, r1, #0x2`) spends
// it on an add, which the frontend folds back into the address; and a read whose bare address is
// ALSO used as a value takes a SECOND literal (`.word 0x3001100` + `.word 0x3001103`) rather than
// an operand offset.
// For a SYMBOL base that last shape is a COUNTEREXAMPLE, and it is the one thing that separates
// the two. `void live(void){ sink((int)(u8 *)&gS); sink(((u8 *)&gS)[3]); }` emits ONE `.word gS`
// and `ldrb r0, [r4, #0x3]` — agbcc CSEs the symbol reference where it re-materializes the integer
// — so the inline subscript spelling produces exactly the shape this rule reads as evidence
// against it. asmlift lifts that asm back to the correct `((u8 *)&gS)[3]` and then offers the
// named-base respelling anyway. Measured reach: of the 21 keys the symbol half newly admits over
// the artifact's agbcc rows in both symbol-map configurations, 4 are on a base whose address the
// tree also uses as a value (2 distinct keys, on `kleod:ProcessInputAndUpdateEntities` and
// `pokeemerald:TrySetCantSelectMoveBattleScript`).
// So on the symbol half this is weaker than evidence-with-two-known-exceptions: it is a hint with
// a live counterexample, which is precisely why it is a ROSTER ADMISSION and not a gate relaxation
// — the inline spelling rides beside it in every case and `compareScored` orders by score, so the
// hint FIRING wrongly costs a candidate compile and never a match. Note which direction that
// covers: it does not say the flag is free to LOSE. A `/basefold*` candidate that is never
// enumerated takes whatever it would have won with it (deleting the sunk roster row costs
// `synthetic:foldsink` and `sa3:sub_803213C` their matches), which is why `index.operandOff` is
// carried from the lift instead of re-derived, and why a committed pass that can drop it is worth
// a test (test/basecse.test.ts, the tail-merge describe). Promoting the hint to a default would
// need this paragraph to say something it does not.
//
// It is EVIDENCE and not proof, which is why `BASEFOLD_GATES` below is a lever rather than a
// relaxation of the default table. agbcc folds a subscript but keeps an aggregate MEMBER offset in
// the memory operand: `((struct S *)0x3001100)->b` emits `.word 0x3001100` + `ldr [r0, #0x4]`,
// byte-identical to the named-base spelling, and the same holds for a union member and for a
// store. So the shape has two sources and asmlift can spell only one of them; rank.ts offers both
// and the differ referees.
//
// A SYMBOL base reads the same rule, one exception weaker (above). agbcc folds a symbol's offset
// as it folds a numeric one — `((u8 *)&gSym)[3]` emits `.word gSym+0x3` + `ldrb [r1]` where
// `gSym.d` and `u8 *p = (u8 *)&gSym; p[3]` both emit `.word gSym` + `ldrb [r1, #0x3]` — and the
// relocation's addend arrives as an explicit `add` where the operand offset arrives as the load's
// own, so the two are one flag apart at the point the offsets fold together.
//
// SCOPE / SOUNDNESS. Only an `index` node whose base is a bare `addr` (a global address) or a bare
// `const` (a numeric pointer address) is eligible, keyed by (base, width, signedness) — never an
// AGGREGATE base (F9 spells a SCALAR global as a bare `var`, which is never an `index`-of-leaf, so
// scalar recovery is untouched). Non-leaf bases (a local, a struct-element `p[a0]`,
// arithmetic) are excluded: agbcc may re-derive those, so hoisting them can
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
import { type BaseInit, type HoistPlacement, nameAllocator, placeBaseLocals } from './hoist';

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
  /** keys with ANY use inside a loop — disqualified (see the loop note in `hoistBaseLocals`). */
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
  /** keys with an access whose constant offset arrived in the MEMORY OPERAND (l3/ast.ts
   *  `index.operandOff`) — the input to `unfoldedOffset`. */
  operandOff: Set<string>;
}

/** Every `index` node whose base is a hoistable leaf, tallied by key (the gates' use count) and in
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
      if (e.operandOff) {
        c.operandOff.add(k);
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
  /** A base whose constant offset arrived in the MEMORY OPERAND (l3/ast.ts `index.operandOff`).
   *  On a compiler that folds a constant subscript into the literal it materializes, an offset
   *  that reached the instruction instead survived because something OTHER than a subscript put it
   *  there — a named base, or an aggregate member (see the header). Read only by
   *  `BASEFOLD_GATES`, whose roster row rank.ts offers only where the target declares the fold.
   *
   *  Where the fold leaves no evidence to read is decided UPSTREAM and once, in
   *  `structure/structure.ts`: an offset the address expression carried (a relocation addend, a
   *  folded `add`) and an offset of 0 never set the flag, so absence is never proof of anything.
   *  Nothing is subtracted again here, which puts the whole judgement in `single-use-unfolded`
   *  where `ablateHeuristic` can price it. A base of 0 is NOT a second refusal, tempting as it
   *  looks: on MIPS `((s8 *)0)[16]` really is one `lb $v0, 16($zero)` with nowhere else for the
   *  offset to be, but this rule runs only where `foldsConstAddrOffset` is declared, and agbcc
   *  materializes a zero base like any other — `mov r0, #0x10` + `ldrb [r0, #0]` inline against
   *  `s8 *p = (s8 *)0; p[16]`'s `mov r0, #0x0` + `ldrb [r0, #0x10]`, the same discriminating pair
   *  as at 0x3001100. Refusing it costs nothing here either way (no agbcc tree in the corpus
   *  reaches a base-0 access with an operand offset, in either symbol-map configuration), which is
   *  exactly why an unmeasured clause could sit in it. */
  unfoldedOffset: boolean;
}

/** The admission rules. NONE is sound, and that is a property of the pass rather than an oversight:
 *  a wrong hoist emits the same address held in a different place, so it costs bytes and a match,
 *  never meaning. The zero-lost benchmark gate is what referees them.
 *
 *  The `loop` rule is the subtle one. A loop-body base is loop-invariant, so the compiler keeps it
 *  in a register across the loop too — but hoisting to the FUNCTION TOP forces a callee-saved
 *  register, which can add the prologue push/pop the original avoided. `l3/scopebase.ts` is the
 *  scope-aware hoist that serves those instead. */
const reachedOnce = (c: BaseKey): boolean => c.uses < 2;

export const BASECSE_GATES: readonly Gate<BaseKey>[] = [
  {
    id: 'single-use',
    why: 'one access re-materializes as cheaply as a named local',
    sound: false,
    rejects: reachedOnce,
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

/** `/basefold`'s admission (rank.ts): the default rules with `single-use` EXEMPTING a base whose
 *  offset survived into the memory operand (`unfoldedOffset`, see the header). A separate table
 *  rather than a relaxed `single-use`, because the evidence is not proof — an inline
 *  aggregate-member access emits the same bytes — so the spelling it generates belongs beside the
 *  inline one with the differ between them, never committed on the single-shot path where nothing
 *  referees.
 *
 *  HOW TO PRICE THE TWO RULES. `without(BASECSE_GATES, 'single-use')` ablates the use-count rule
 *  alone. The EXEMPTION has no ablation of its own: ablation removes a whole gate, and this table's
 *  gate carries the rule AND its exemption in one `rejects`, so
 *  `without(BASEFOLD_GATES, 'single-use-unfolded')` is `without(BASECSE_GATES, 'single-use')` gate
 *  object for gate object — the naive full ablation, which costs a real match. What the exemption
 *  added is the two tables' admitted-set DIFF, `admittedBases(sfn, BASEFOLD_GATES)` minus
 *  `admittedBases(sfn, BASECSE_GATES)`.
 *
 *  rank.ts offers the row only where the target declares
 *  `compilerBehaviors.foldsConstAddrOffset` — MIPS and PPC put the addend in the instruction by
 *  construction (`lui`/`%lo`, `lis`/`ori`), so a surviving offset carries no information there.
 *  It offers it at BOTH placements (l3/hoist.ts): a base reached once is loaded where it is used,
 *  so where the init sits is the question the differ has to settle, not whether it exists. */
export const BASEFOLD_GATES: readonly Gate<BaseKey>[] = [
  {
    id: 'single-use-unfolded',
    why: 'one access re-materializes as cheaply as a named local, unless its offset survived the fold',
    sound: false,
    rejects: (c) => reachedOnce(c) && !c.unfoldedOffset,
  },
  ...ablateHeuristic(BASECSE_GATES, 'single-use'),
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
export function admittedBases(sfn: SFn, gates: readonly Gate<BaseKey>[]): readonly string[] {
  return admit(sfn, gates).keys;
}

/** The keys `gates` admits, in first-use order, with the census they were judged from. */
function admit(sfn: SFn, gates: readonly Gate<BaseKey>[]): { c: Collected; keys: string[] } {
  const c: Collected = {
    count: new Map(),
    order: [],
    meta: new Map(),
    inLoop: new Set(),
    constOffCount: new Map(),
    varIndexed: new Set(),
    operandOff: new Set(),
  };
  collect(sfn.body, c, false);
  const keys = c.order.filter((k) => {
    const offsets = c.constOffCount.get(k);
    return (
      firstRejection(gates, {
        key: k,
        uses: c.count.get(k) ?? 0,
        inLoop: c.inLoop.has(k),
        repeatedConstOffset: [...(offsets?.values() ?? [])].some((n) => n >= 2),
        singleCell: !c.varIndexed.has(k) && (offsets?.size ?? 0) <= 1,
        unfoldedOffset: c.operandOff.has(k),
      }) === null
    );
  });
  return { c, keys };
}

export function hoistBaseLocals(
  sfn: SFn,
  gates: readonly Gate<BaseKey>[] = BASECSE_GATES,
  placement: HoistPlacement = 'head',
): SFn {
  const { c, keys: hoisted } = admit(sfn, gates);
  const { meta } = c;
  if (hoisted.length === 0) {
    return sfn;
  }

  const fresh = nameAllocator(sfn);

  const localFor = new Map<string, string>();
  const newLocals: { name: string; type: IrType }[] = [];
  const hoistStmts: BaseInit[] = [];
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
  // The new inits join the tree's LEADING run of base inits rather than being prepended above it:
  // when rank's /livebase re-runs this pass the head already carries the default run's, and
  // blindly prepending would spell the new base's pool load above locals the compiler loads first.
  // That is why `HoistPlacement` has no `prepend` — the hazard is typed out rather than warned
  // about. `placement` then answers where the whole run goes (l3/hoist.ts, the mechanism
  // sinkinit.ts's policy shares). Under either value it is ordered by first use, which is
  // pool-load order (see `collect`) — deliberately reaching the single default run too (a head of
  // user pointer inits before a firing hoist), where it repairs the same invariant.
  const locals = [...sfn.locals, ...newLocals];
  // The shell carries the minted DECLARATIONS and the REWRITTEN statements together: first-use
  // would not know the new names without the first, and would query the pre-rewrite accesses
  // without the second.
  const { body } = placeBaseLocals({ ...sfn, locals, body: rewritten }, hoistStmts, placement);
  return { ...sfn, body, locals };
}
