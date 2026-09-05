// L3 re-spelling lever: UN-REDUCE a loop-carried accumulator — delete `v = INIT; … v = v + K;`
// and spell each read as the closed form `INIT[start := counter]`.
//
//     v0 = (a0 << 6) + a1;                    while (v1 <= 31) {
//     while (v1 <= 31) {              ⇒          *(s32 *)REG = (v1 << 6) + a1;
//       *(s32 *)REG = v0;                        v1 = v1 + 1;
//       v0 = v0 + 64; v1 = v1 + 1; }           }
//
// WHY IT IS A SPELLING AND NOT A FIX. Strength reduction is a compiler pass, so the accumulated
// form is what the ASM shows whichever form the source had — a source `a[i]` and a source
// `p = a; … p++` compile to the same induction variable. asmlift recovers the reduced form
// because that is what the machine ran; the un-reduced form is the other pre-image, and the differ
// referees. (l3/reindex.ts makes the same argument for a POINTER WALK; this is its scalar-value
// sibling, and the two do not overlap — `reindexWalks` refuses a function with no pointer local.)
//
// WHAT IT BUYS, and it is not readability. A compiler-created giv init is emitted by
// `emit_iv_add_mult` at `loop_start` (gcc/loop.c:4761, inserted at :6985) — during
// `strength_reduce`, which agbcc runs AFTER `move_movables` hoists the loop invariants
// (gcc/loop.c:1151 then :1173). Both insert immediately before the loop, so the giv's init lands
// BELOW everything the invariant hoist put there. No C statement can reach that slot: statement
// order forces a user-written assignment above the whole preheader. Measured on
// synthetic:dmafill, holding the rest fixed — a plain statement before the loop scores 19, the
// same statement under an explicit guard 15, and letting the compiler create the giv 0.
//
// THE ARITHMETIC. The rewrite rests on one invariant: at every read, `acc == g(ctr)`, where `g` is
// the init expression with the counter's own start substituted by the counter. It holds at entry
// because `ctr == start` there, and is preserved because `g` is linear with exactly the
// accumulator's stride — `g(x + D) - g(x) = K`, checked structurally rather than assumed
// (`relate`: a `+` spine down to a shift by `s` with `K = D · 2^s`, a product by `M` with
// `K = D · M`, or the bare counter with `K = D`; any other enclosing operator refuses, because
// under it the stride is not `K`). Every way the invariant could be broken DECLINES: another
// write to either name, an address taken, a read outside the loop, a read at or below the
// accumulator's own step (where it stands one stride ahead of the counter), a `continue` (which
// runs a `for`'s increment but skips the body's tail), and a step this file cannot relate.
//
// THE RE-EVALUATION is the dangerous half, because the closed form is spelled at each read and
// carries whatever the init READ with it. All five gates below read the ORIGINAL init rather than
// the substituted form: the init STATEMENT is deleted, so anything inside the counter-start
// subterm the substitution replaces would be DROPPED rather than moved, which no gate reading the
// closed form could see.
//
// AND THEY ALL ASK ABOUT THE MOTION REGION, which is not the loop. The init is deleted where it
// stood and re-evaluated at every read, so the distance the values travel is everything between
// the two — and BOTH ENDS of that span move. The counter's start is the other anchor, because the
// substitution reads the closed form through it: taken after the init, off a value that has since
// changed, the closed form is off by exactly that change. So the region opens at whichever anchor
// comes FIRST and runs to the loop's last iteration, the loop entering whole so the walk reaches
// its condition and a `for`'s own init and inc as well as its body.
//   • INIT-LOOP-VAR — the init names something the region assigns, so re-evaluating it below that
//     assignment reads a different value. Three shapes, all of which compiled, scored, and
//     computed something else: `for (a0 = a1; …; a0 = a0 + 1)` over `acc = (a1 << 6) + a0` closed
//     to `(a0 << 6) + a0` (a `for`'s counter is stepped in `loop.inc`, which is not in
//     `loop.body`); `acc = (a0 << 6) + a1; a1 = a1 + 100;` above the loop; and the counter's start
//     taken last, `acc = (a0 << 6) + a1; a0 = a0 + 1; i = a0;`. A semantic fuzz over both trees on
//     the same inputs — 18 seeds × 2 generator modes, the second of which emits a statement
//     between the anchors, 1.08M trees and 111707 fired candidates — finds no divergence; asking
//     the LOOP alone put 351 of every 2940 firings on this one hole.
//   • INIT-NAME-ESCAPES — the other half of the same question, for a write no assignment spells.
//     A name whose address the function hands out can be rewritten by a callee or through a
//     stashed pointer, which `assignCount` cannot see: `w = 1; i = a0; acc = (a0 << 6) + w;` over
//     a loop calling `bump(&w)` re-reads `w` once per iteration and picks up whatever the callee
//     left. Refused function-wide, because a stashed pointer outlives the statement that made it.
//   • MOVED-EFFECT — a call or a marker would run once per read instead of once. Refused.
//   • MOVED-VOLATILE — a `volatile` access is one the source pinned precisely so it would not be
//     duplicated or moved. Refused. No corpus row reaches it today (nothing on the base spelling
//     this lever rides carries a qualifier on a READ), so it is guarded by its unit test alone.
//   • MOVED-READ-ALIASABLE — an ordinary memory read moved down the region sees whatever the
//     region wrote. asmlift can only rule that out for writes it can NAME, so a moved read is
//     admitted on one configuration: every write the region evaluates goes to a compile-time
//     constant address INSIDE the target's declared device-register window, and every read lands
//     OUTSIDE it. A device register is not an object a C program declares (target.ts
//     `deviceRegisters`), so no STORE the C performs there can change what an ordinary read sees;
//     the read-side half is what keeps a DEVICE read from being
//     duplicated into N of them, and it resolves an access's WHOLE address where the subscripts
//     are constant, falling back to the chain's root only where they are not (a read rooted at
//     0x03FFFFF0 whose element is 0x04000010 is a device read, and the root alone does not say
//     so). Anything else — a store through a local pointer, a call, a read rooted at no constant
//     at all — REFUSES, which is `ir/alias.ts`'s posture ("unknown BARS") applied where there is
//     no symbol map to resolve a name through.
//
// AND THE PREMISE THAT IS NOT ENOUGH, which this file recorded as a fact about the board and which
// is FALSE. "A write to a hardware register is not a write to any object a C program declares" is
// true, and it does not finish the argument: a DMA controller READS a control word and then WRITES
// ordinary memory on the program's behalf. On the GBA, storing `0x84000020` to `DMA3CNT`
// (0x040000DC) starts a 32-word transfer into `[DMA3DAD]` — and every row this lever reaches
// drives exactly that register. Modelled and executed, the admitted candidate turns a clean walk
// over a destination table into wild writes: the first transfer clobbers the table the init reads,
// and every later iteration recomputes its destination from the garbage.
//
// So the function's device writes are checked against `capabilities.deviceMemoryWriters` — the
// four DMA channel-enable halfwords on this board — and a moved read under one is NOT admitted on
// the gates alone. That scan is the WHOLE PREFIX up to and including the loop, wider than the
// motion region every other gate reads, because a repeating transfer keeps writing for as long as
// it is enabled: where the arming store STANDS says nothing about when the device writes, and a
// channel armed above the init is as asynchronous as one armed inside the loop.
//
// Such a read is admitted only where the differ PROVES it: `needsProof` rides out with the
// candidate, and rank.ts publishes such a spelling only at a byte-exact score,
// withholding it (loudly, in `RankedResult.withheld`) at every other. That is not a softening of
// the rule but the only evidence that settles it — a candidate whose object equals the target's
// IS the program, whatever a gate could have proved about it, and the one corpus inhabitant
// (synthetic:dmaptrsrc) is exactly that: a byte-exact match whose reference source really does
// read `gBg[bg].pTilemap` inside the loop. Barring it instead costs that match and buys nothing —
// the sound alternative, the read hoisted into a local above the loop, scores 16, because a C
// statement lands above the loop's ENTRY GUARD while the compiler's own hoist lands below it.
//
// SCOPE, stated because a decline outside it names no gate and so looks exactly like a gate that
// refused. This pass walks TOP-LEVEL loops only: the counter's start and the accumulator's init are
// found by scanning `sfn.body` above the loop, which is a flat list. A loop under an `if` — or
// inside another loop — is never reached, even when both statements do stand above it in the
// enclosing block. Measured over the corpus in both symbol-map configurations: of 834 trees, 189
// carry a loop, 98 carry a TOP-LEVEL one, and 91 carry only nested ones — `arraysum`, `memcpy1`,
// `revarr`, `dotprod`, `findfirst`, `mergeloop` and `synthetic:dmanest` among them. On klonoa's
// `LoadBGTilemapData` the count is zero, over all 1344 trees its enumeration produces: a decline
// there names no gate, and a reader will attribute one anyway. Widening the scan is a REACH change
// and belongs to a row that demands it (dmanest is the obvious candidate), not to a soundness pass.
//
// AND THE TABLE ANSWERS FOR A SMALLER POPULATION STILL. Instrumented over those same 834 trees,
// the 15 gates are consulted 36 times and only four ever decide: `acc-live-outside` 14,
// `acc-read-at-step` 10, `unrelated-step` 7, `acc-multi-assign` 2, admit 3. The other eleven —
// `moved-read-aliasable`, which the device-memory argument above rests on, among them — are held
// by their unit tests and by the fuzz, and by nothing the corpus has yet shown them. Short-circuit
// order hides a later gate behind an earlier one, so this counts FIRST rejections and not reach.
//
// AND ITS SIBLING. `l3/reindex.ts` un-reduces a POINTER WALK over the same argument, with the same
// shape of gate table, and it already handles the `if (guard) do {} while` rotation this file
// cannot see. The split is by the induction variable's TYPE rather than by the question asked, and
// it costs the duplication a reader will notice — `counter-roles` ≈ `acc-multi-assign` +
// `acc-live-outside`, `walk-stride` ≈ `unrelated-step`, `body-exit` ≈ `continue-in-body`. Folding
// them into one pass over one table is a real improvement and a real refactor; the gate this file
// was actually MISSING from that table (`volatile-counter`) is in it now, which is the part that
// could not wait.
//
// Nothing qualifying ⇒ decline (null), never a duplicate of the primary.
import { cellAddress, inRange, rootConst } from './address';
import {
  type Expr,
  type SFn,
  type Stmt,
  exprEquals,
  exprHasEffect,
  exprReadsVolatile,
  mapExprChildren,
  stmtChildren,
  stmtExprs,
  walkExprs,
} from './ast';
import { type Gate, firstRejection } from './gates';

/** One (loop, accumulator) pair as the gates read it. */
interface AccCtx {
  /** the accumulator is assigned exactly twice: its init above the loop and its step inside */
  assigns: number;
  addrTaken: boolean;
  /** the local's DECLARATION carries an asm fact — a qualifier, a frame slot, an `undef` */
  pinned: boolean;
  /** the accumulator is mentioned outside the loop, other than by its own init */
  liveOutside: boolean;
  /** the accumulator is mentioned at or below its own step, or in the loop's control parts */
  readAtOrBelowStep: boolean;
  /** the counter is assigned exactly twice: its init above the loop and its step inside */
  counterAssigns: number;
  counterAddrTaken: boolean;
  /** the counter local carries a volatility qualifier — every closed form is a new read of it */
  counterVolatile: boolean;
  /** a `continue` anywhere in the body */
  hasContinue: boolean;
  /** the init relates to the counter's start by the accumulator's own stride */
  related: boolean;
  /** the init reads a name something in the motion region assigns */
  initLoopVar: boolean;
  /** the init reads a name whose address the function hands out */
  initNameEscapes: boolean;
  /** the closed form contains a call or a marker */
  movedEffect: boolean;
  /** the closed form reads a `volatile` object */
  movedVolatile: boolean;
  /** the closed form reads memory the region's own writes cannot be told apart from */
  movedAliasable: boolean;
}

export const UNREDUCE_GATES: readonly Gate<AccCtx>[] = [
  {
    id: 'acc-multi-assign',
    why: 'a name written anywhere but its init and its step is not one induction sequence',
    sound: true,
    guardedBy: 'unreduce.test.ts: a third assignment to the accumulator declines',
    rejects: (c) => c.assigns !== 2,
  },
  {
    id: 'acc-addr-taken',
    why: 'a deleted local has no address to take',
    sound: true,
    guardedBy: 'unreduce.test.ts: an address-taken accumulator declines',
    rejects: (c) => c.addrTaken,
  },
  {
    id: 'acc-pinned',
    why: 'a declaration that carries an asm fact cannot be deleted without dropping the fact',
    sound: true,
    guardedBy: 'unreduce.test.ts: a pinned accumulator declines, on every pin a local can carry',
    rejects: (c) => c.pinned,
  },
  {
    id: 'acc-live-outside',
    why: 'a read outside the loop wants a value the closed form no longer computes',
    sound: true,
    guardedBy: 'unreduce.test.ts: an accumulator read after the loop declines',
    rejects: (c) => c.liveOutside,
  },
  {
    id: 'acc-read-at-step',
    why: 'below its own step the accumulator is one stride ahead of the counter',
    sound: true,
    guardedBy: 'unreduce.test.ts: a read below the step declines',
    rejects: (c) => c.readAtOrBelowStep,
  },
  {
    id: 'counter-multi-assign',
    why: 'a counter written elsewhere breaks the relation the closed form is read through',
    sound: true,
    guardedBy: 'unreduce.test.ts: a counter assigned inside an arm declines',
    rejects: (c) => c.counterAssigns !== 2,
  },
  {
    id: 'counter-addr-taken',
    why: 'an address-taken counter can be stepped by anything the address reaches',
    sound: true,
    guardedBy: 'unreduce.test.ts: an address-taken counter declines',
    rejects: (c) => c.counterAddrTaken,
  },
  {
    // The accumulator's pin is `acc-pinned` above; this is the COUNTER's, and it is a different
    // fact: substitution puts the counter where every accumulator read used to be, so a loop that
    // read it once per iteration reads it once per USE. For a volatile object the access COUNT is
    // the semantics (l3/volatileval.ts states the same rule), which is why l3/reindex.ts's
    // `volatile-counter` sibling exists.
    id: 'counter-volatile',
    why: 'the closed form re-reads the counter at every use, and a volatile object counts its reads',
    sound: true,
    guardedBy: 'unreduce.test.ts: a volatile counter declines',
    rejects: (c) => c.counterVolatile,
  },
  {
    id: 'continue-in-body',
    why: 'a `continue` runs a `for`’s increment but skips the body’s tail, desynchronizing the pair',
    sound: true,
    guardedBy: 'unreduce.test.ts: a `continue` in the body declines',
    rejects: (c) => c.hasContinue,
  },
  {
    id: 'unrelated-step',
    why: 'an init this file cannot relate to the counter’s start by the stride proves nothing',
    sound: true,
    guardedBy: 'unreduce.test.ts: a stride that does not match the init’s scale declines',
    rejects: (c) => !c.related,
  },
  {
    id: 'init-loop-var',
    why: 'a name the region assigns reads differently once the init is evaluated below it',
    sound: true,
    guardedBy: 'unreduce.test.ts: an init reading a name the region assigns declines, in every part of it',
    rejects: (c) => c.initLoopVar,
  },
  {
    // `init-loop-var`'s other half. That gate reads C-LEVEL assignment, and a local whose address
    // the function hands out is written where no assignment spells it — by a callee, or through a
    // pointer the region stores into. The address is taken function-wide because a stashed pointer
    // outlives the statement that made it.
    id: 'init-name-escapes',
    why: 'an address-escaped name is written where no assignment names it',
    sound: true,
    guardedBy: 'unreduce.test.ts: an init reading an address-escaped local declines',
    rejects: (c) => c.initNameEscapes,
  },
  {
    id: 'moved-effect',
    why: 'a call or a marker in the closed form would run once per read instead of once',
    sound: true,
    guardedBy: 'unreduce.test.ts: a call in the init declines',
    rejects: (c) => c.movedEffect,
  },
  {
    id: 'moved-volatile',
    why: 'a volatile access is one the source pinned so it would not be duplicated or moved',
    sound: true,
    guardedBy: 'unreduce.test.ts: a volatile read in the init declines',
    rejects: (c) => c.movedVolatile,
  },
  {
    id: 'moved-read-aliasable',
    why: 'a read moved down the region sees whatever writes the region cannot be proved apart from',
    sound: true,
    guardedBy: 'unreduce.test.ts: a moved read declines unless the region writes only device cells',
    rejects: (c) => c.movedAliasable,
  },
];

// ── the induction shapes ────────────────────────────────────────────────────────────────────

/** `name = name + <expr>` as a step, or null. */
function stepOf(s: Stmt, name: string): Expr | null {
  if (s.k !== 'assign' || s.name !== name || s.value.k !== 'bin' || s.value.op !== '+') {
    return null;
  }
  const { l, r } = s.value;
  return l.k === 'var' && l.name === name ? r : r.k === 'var' && r.name === name ? l : null;
}

/** THE relation check: is `init` a function of `start` whose value grows by `k` per `d` of the
 *  counter? Returns the closed form (init with the counter's start replaced by the counter
 *  variable) or null. The three accepted shapes are the three ways a compiler's own giv is
 *  spelled — a scaled shift, a product, and the bare index — and each is verified rather than
 *  assumed: the substituted subterm must be structurally the counter's start, and the stride must
 *  come out of the scale. */
function relate(init: Expr, start: Expr, ctr: string, k: Expr, d: number): Expr | null {
  if ([...subterms(init)].filter((x) => exprEquals(x, start)).length !== 1) {
    return null; // zero: the init does not depend on the counter. two: which one is the index?
  }
  const kConst = k.k === 'const' ? k.value : null;
  const idx = (): Expr => ({ k: 'var', name: ctr });
  const holds = (e: Expr): boolean => [...subterms(e)].some((x) => exprEquals(x, start));
  // The path from the init's root down to the occurrence, one node at a time. Every node on it
  // must be a `+` — so the init is a SUM of the scaled counter and terms that do not mention it,
  // and the whole expression's stride is the scaled term's. Any other enclosing operator refuses:
  // under a `-` on the right the stride flips sign, and under a second scale it multiplies.
  const rec = (x: Expr): Expr | null => {
    // (a) `start << s` — the stride is `d << s`, so `k` has to be that constant
    if (x.k === 'bin' && x.op === '<<' && exprEquals(x.l, start) && x.r.k === 'const') {
      const sh = x.r.value;
      return sh >= 0 && sh < 31 && kConst === d * 2 ** sh ? { k: 'bin', op: '<<', l: idx(), r: x.r } : null;
    }
    // (b) `start * M` in either order — the stride is `d · M`, checkable when `d` is 1 and `M` is
    //     structurally `k`, or when both are constants. The OPERAND ORDER is kept: which side a
    //     product's index sits on is a spelling the differ referees on its own (`/mulfirst`), so
    //     rebuilding it in a canonical order would answer that question here instead.
    if (x.k === 'bin' && x.op === '*' && (exprEquals(x.l, start) || exprEquals(x.r, start))) {
      const startLeft = exprEquals(x.l, start);
      const m = startLeft ? x.r : x.l;
      const ok = d === 1 ? exprEquals(m, k) : m.k === 'const' && kConst !== null && d * m.value === kConst;
      return ok ? { k: 'bin', op: '*', l: startLeft ? idx() : m, r: startLeft ? m : idx() } : null;
    }
    // (c) the counter standing on its own in the sum — the stride is `d` itself
    if (exprEquals(x, start)) {
      return kConst === d ? idx() : null;
    }
    // (d) a `+` node: descend into whichever side carries the occurrence. There is exactly one.
    if (x.k === 'bin' && x.op === '+') {
      const left = holds(x.l);
      const inner = rec(left ? x.l : x.r);
      return inner === null ? null : left ? { ...x, l: inner } : { ...x, r: inner };
    }
    return null; // anything else between the root and the counter, and the stride is not `k`
  };
  return rec(init);
}

/** every node of an expression tree, itself included */
function* subterms(e: Expr): Generator<Expr> {
  yield e;
  for (const c of exprChildrenOf(e)) {
    yield* subterms(c);
  }
}

const exprChildrenOf = (e: Expr): Expr[] => {
  const out: Expr[] = [];
  mapExprChildren(e, (c) => {
    out.push(c);
    return c;
  });
  return out;
};

// ── what a tree does to a name ──────────────────────────────────────────────────────────────

/** assignments to `name` anywhere in these statements, `for` init/inc included */
function assignCount(stmts: readonly Stmt[], name: string): number {
  let n = 0;
  for (const s of stmts) {
    if (s.k === 'assign' && s.name === name) {
      n++;
    }
    n += assignCount(stmtChildren(s), name);
  }
  return n;
}

/** does any expression in these statements read `name`? */
function mentions(stmts: readonly Stmt[], name: string): boolean {
  for (const e of walkExprs(stmts as Stmt[])) {
    if (e.k === 'var' && e.name === name) {
      return true;
    }
  }
  return false;
}

const mentionsIn = (e: Expr, name: string): boolean => [...subterms(e)].some((x) => x.k === 'var' && x.name === name);

const addrTakenIn = (stmts: readonly Stmt[], name: string): boolean => {
  for (const e of walkExprs(stmts as Stmt[])) {
    if (e.k === 'addr' && e.name === name) {
      return true;
    }
  }
  return false;
};

const hasContinueIn = (stmts: readonly Stmt[]): boolean =>
  stmts.some((s) => s.k === 'continue' || hasContinueIn(stmtChildren(s)));

// ── the re-evaluation gates ─────────────────────────────────────────────────────────────────

/** every memory access in an expression, as its own node */
const accessesIn = (e: Expr): (Extract<Expr, { k: 'index' }> | Extract<Expr, { k: 'field' }>)[] =>
  [...subterms(e)].filter((x): x is Extract<Expr, { k: 'index' | 'field' }> => x.k === 'index' || x.k === 'field');

const namesUnder = (e: Expr): string[] =>
  [...subterms(e)].filter((y): y is Extract<Expr, { k: 'var' }> => y.k === 'var').map((y) => y.name);

/** Does a READ land on a device register? Two readings, and neither is enough alone. The chain's
 *  ROOT is what places an access whose subscripts are not constant — `((struct E *)0x03003430)
 *  [a1].field_4` has no compile-time address at all — and a read with no root is unplaceable, so
 *  it bars. The WHOLE address is what places one whose subscripts are: `((s32 *)0x03FFFFF0)[8]`
 *  denotes 0x04000010, BG0HOFS, which the root alone reports as EWRAM. The residual is stated
 *  rather than hidden: a RUNTIME subscript can still carry an access from an out-of-window root
 *  into the window, and nothing here bounds it — the write side has no such gap because it
 *  resolves the whole address or refuses. */
const readsDevice = (r: Expr, window?: readonly [number, number]): boolean => {
  const root = rootConst(r);
  return root === null || inRange(root, window) || inRange(cellAddress(r), window);
};

/** Can the region's writes change what a MEMORY read in the closed form sees? Only "no" when every
 *  write it evaluates goes to a constant address inside the declared device window, and every read
 *  lands outside it. See the file header, including the premise this does NOT establish (a device
 *  that writes memory itself: `deviceWritesMemory` below).
 *
 *  MEMORY ONLY. The NAMES the closed form reads are `init-loop-var`'s question and
 *  `init-name-escapes`', and a closed form with no memory access still has names — which is why
 *  the early return below is not "nothing can change this". */
function movedReadAliasable(closed: Expr, evaluated: readonly Stmt[], window?: readonly [number, number]): boolean {
  const reads = accessesIn(closed);
  if (reads.length === 0) {
    return false; // no access ⇒ no write can reach it; its NAMES are the two gates above
  }
  for (const s of allStmts(evaluated)) {
    // a call or an unmodelled instruction may write anything
    if (stmtExprs(s).some(exprHasEffect)) {
      return true;
    }
    if (s.k === 'store' && !inRange(cellAddress(s.lval), window)) {
      return true;
    }
  }
  return reads.some((r) => readsDevice(r, window));
}

/** Does the loop write a register the DEVICE answers by writing ordinary memory? The premise
 *  `movedReadAliasable` rests on covers the CPU's own stores and nothing else; a DMA trigger is a
 *  store whose effect is a write the C never spells. A store counts when its BYTE RANGE touches
 *  one of the target's declared ranges, so the 32-bit `DMA3CNT` write reaches the enable halfword
 *  four bytes into it. NO declared ranges ⇒ every device store counts, which is the conservative
 *  direction and what a target that has said nothing gets. */
function deviceWritesMemory(evaluated: readonly Stmt[], triggers?: readonly (readonly [number, number])[]): boolean {
  for (const s of allStmts(evaluated)) {
    if (s.k !== 'store' || s.lval.k !== 'index') {
      continue;
    }
    const at = cellAddress(s.lval);
    if (at === null) {
      continue; // `movedReadAliasable` has already refused this loop
    }
    if (triggers === undefined) {
      return true;
    }
    const end = at + s.lval.width;
    if (triggers.some(([lo, hi]) => at < hi && end > lo)) {
      return true;
    }
  }
  return false;
}

function* allStmts(stmts: readonly Stmt[]): Generator<Stmt> {
  for (const s of stmts) {
    yield s;
    yield* allStmts(stmtChildren(s));
  }
}

// ── the pass ────────────────────────────────────────────────────────────────────────────────

/** the loop's counter step statement (a `for`'s `inc`, or the body's last statement) */
const counterStepStmt = (loop: Extract<Stmt, { k: 'while' | 'dowhile' | 'for' }>): Stmt | undefined =>
  loop.k === 'for' ? loop.inc : loop.body[loop.body.length - 1];

/** the statements a loop evaluates outside its body — the parts a substitution must not touch */
const controlStmts = (loop: Extract<Stmt, { k: 'while' | 'dowhile' | 'for' }>): Stmt[] =>
  loop.k === 'for' ? [loop.init, loop.inc] : [];

/** The `/unreduce` candidate. `sfn` is a fresh tree, the input left untouched; `needsProof` says
 *  the closed form re-reads memory over a loop whose device writes may THEMSELVES write memory
 *  (see the header), so rank.ts may publish it only at a byte-exact score. */
export interface UnreduceResult {
  sfn: SFn;
  needsProof: boolean;
}

/** The `/unreduce` candidate, or null when no accumulator qualifies. `window` is the target's
 *  declared device-register range (TargetDescription.capabilities.deviceRegisters) — absent, the
 *  lever still fires on a closed form that reads no memory. `triggers` is
 *  `capabilities.deviceMemoryWriters`; absent, EVERY device store is treated as one. */
export function unreduceAccumulators(
  sfn: SFn,
  window?: readonly [number, number],
  triggers?: readonly (readonly [number, number])[],
): UnreduceResult | null {
  const body = [...sfn.body];
  const deletedInits = new Set<Stmt>();
  const deletedLocals = new Set<string>();
  let changed = false;
  let needsProof = false;

  for (let li = 0; li < body.length; li++) {
    const loop = body[li];
    if (loop.k !== 'while' && loop.k !== 'dowhile' && loop.k !== 'for') {
      continue;
    }
    // the counter: one name stepped by a constant, whose start stands above the loop
    const ctrStep = counterStepStmt(loop);
    if (ctrStep === undefined || ctrStep.k !== 'assign') {
      continue;
    }
    const ctr = ctrStep.name;
    const d = stepOf(ctrStep, ctr);
    if (d === null || d.k !== 'const' || d.value === 0) {
      continue;
    }
    const startStmt =
      loop.k === 'for'
        ? loop.init
        : [...sfn.body.slice(0, li)].reverse().find((s) => s.k === 'assign' && s.name === ctr);
    if (startStmt === undefined || startStmt.k !== 'assign' || startStmt.name !== ctr) {
      continue;
    }
    const outside = [...sfn.body.slice(0, li), ...sfn.body.slice(li + 1)];
    const startIdx = loop.k === 'for' ? li : sfn.body.indexOf(startStmt);
    // A device armed anywhere before the reads happen keeps writing memory WHILE they happen, so
    // the trigger scan is the whole prefix rather than the motion region — a repeating transfer
    // armed above the init is as asynchronous as one armed inside the loop.
    const armed: Stmt[] = [...sfn.body.slice(0, li), loop];
    const rewrites = new Map<string, Expr>();
    for (const cand of sfn.locals) {
      const initStmt = sfn.body.slice(0, li).find((s) => s.k === 'assign' && s.name === cand.name);
      const stepIdx = loop.body.findIndex((s) => stepOf(s, cand.name) !== null);
      if (initStmt === undefined || initStmt.k !== 'assign' || stepIdx < 0 || cand.name === ctr) {
        continue;
      }
      const k = stepOf(loop.body[stepIdx], cand.name)!;
      const closed = relate(initStmt.value, startStmt.value, ctr, k, d.value);
      // THE MOTION REGION: everything that runs between where the init stood and the reads that
      // replace it. Both endpoints move — the init is DELETED, and the counter's start is what the
      // substitution reads the closed form through — so the region opens at whichever of the two
      // comes first and runs to the loop's last iteration. The loop enters WHOLE, so the walk
      // below reaches its condition and a `for`'s own init and inc as well as its body.
      const initIdx = sfn.body.indexOf(initStmt);
      const evaluated: Stmt[] = [...sfn.body.slice(Math.min(initIdx, startIdx) + 1, li), loop];
      const ctrLocal = sfn.locals.find((l) => l.name === ctr);
      const ctx: AccCtx = {
        assigns: assignCount(sfn.body, cand.name),
        addrTaken: addrTakenIn(sfn.body, cand.name),
        // Every flag `SFn.locals` can carry, because each is a fact about the ASM that only the
        // declaration states: two qualifiers (deleting a `volatile u16 *` local re-spells `*p = 0`
        // as a raw cast with no qualifier on it — l3/inlinebase.ts carries it onto the minted cast
        // instead, and this lever has no local left to carry anything), a frame home, an `undef`
        // whose whole content is the assignment that is MISSING, and the SPILL HOMES.
        //
        // WHY `slots` PINS, which is not the obvious reading. Deleting a slot-carrying local does
        // not mis-order the survivors: they stay a subset of one total order and rank correctly
        // among themselves. What it can do is flip a REFUSAL into an ordering. `l3/slotorder.ts`
        // refuses the whole function when two declared locals share one offset, because reload
        // hands each spilled pseudo a fresh slot and a duplicate proves the offsets did not come
        // from reload. Delete one sharer and the survivors are injective — so the ordering fires
        // on a frame whose evidence was already known not to be declaration ranks, and it fires
        // silently. Refusing to delete keeps the duplicate, and keeps the refusal.
        //
        // MEASURED, so this is a stated zero and not an assumption: instrumented at the deletion
        // below, it fires on none of the three agbcc rows that spill AND lift — `spillorder`,
        // `dma_fill_uninit`, `uninit_spill` — so the clause costs no candidate today. (`spill10`
        // spills too but declines in the Thumb frontend, so it never reaches this pass and its
        // zero says nothing.) It is here for the day one does.
        pinned:
          cand.volatile !== undefined ||
          cand.pointeeVolatile !== undefined ||
          cand.frame !== undefined ||
          cand.uninit !== undefined ||
          cand.slots !== undefined,
        liveOutside: mentions(
          outside.filter((s) => s !== initStmt),
          cand.name,
        ),
        readAtOrBelowStep:
          mentions(loop.body.slice(stepIdx + 1), cand.name) ||
          mentionsIn(k, cand.name) ||
          mentionsIn(loop.cond, cand.name) ||
          mentions(controlStmts(loop), cand.name),
        counterAssigns: assignCount(sfn.body, ctr),
        counterAddrTaken: addrTakenIn(sfn.body, ctr),
        counterVolatile: ctrLocal?.volatile === true || ctrLocal?.pointeeVolatile === true,
        hasContinue: hasContinueIn(loop.body),
        related: closed !== null,
        // `evaluated`, not `loop.body`: a `for`'s counter is stepped in `loop.inc`
        initLoopVar: [...namesUnder(initStmt.value)].some((n) => assignCount(evaluated, n) > 0),
        initNameEscapes: [...namesUnder(initStmt.value)].some((n) => addrTakenIn(sfn.body, n)),
        // read off the ORIGINAL init, not the substituted form: the init STATEMENT is deleted, so
        // an effect inside the counter-start subterm the substitution replaces would be dropped
        // rather than moved — one fewer execution, which no gate reading `closed` could see.
        movedEffect: exprHasEffect(initStmt.value),
        movedVolatile: exprReadsVolatile(initStmt.value, sfn),
        movedAliasable: movedReadAliasable(initStmt.value, evaluated, window),
      };
      if (firstRejection(UNREDUCE_GATES, ctx) !== null) {
        continue;
      }
      // The gates have placed every write the C performs; what they cannot place is a write the
      // DEVICE performs in answer to one. A moved read over such a loop is offered under PROOF.
      if (accessesIn(initStmt.value).length > 0 && deviceWritesMemory(armed, triggers)) {
        needsProof = true;
      }
      rewrites.set(cand.name, closed!);
      deletedInits.add(initStmt);
      deletedLocals.add(cand.name);
    }
    if (rewrites.size === 0) {
      continue;
    }
    changed = true;
    const sub = (e: Expr): Expr => {
      if (e.k === 'var') {
        const hit = rewrites.get(e.name);
        if (hit !== undefined) {
          return clone(hit); // a FRESH node per use — identity-keyed rules downstream read it
        }
      }
      return mapExprChildren(e, sub);
    };
    const strip = (stmts: readonly Stmt[]): Stmt[] =>
      stmts.filter((s) => !(s.k === 'assign' && rewrites.has(s.name))).map((s) => mapStmts(s, sub, strip));
    body[li] = { ...loop, body: strip(loop.body) } as Stmt;
  }
  if (!changed) {
    return null;
  }
  return {
    sfn: {
      ...sfn,
      locals: sfn.locals.filter((l) => !deletedLocals.has(l.name)),
      body: body.filter((s) => !deletedInits.has(s)),
    },
    needsProof,
  };
}

const clone = (e: Expr): Expr => mapExprChildren({ ...e }, clone);

/** map a statement's own expressions and its nested lists in one step */
function mapStmts(s: Stmt, f: (e: Expr) => Expr, list: (l: readonly Stmt[]) => Stmt[]): Stmt {
  switch (s.k) {
    case 'assign':
      return { ...s, value: f(s.value) };
    case 'store':
      return { ...s, lval: f(s.lval), value: f(s.value) };
    case 'exprstmt':
      return { ...s, value: f(s.value) };
    case 'return':
      return s.value === undefined ? s : { ...s, value: f(s.value) };
    case 'if':
      return { ...s, cond: f(s.cond), then: list(s.then), else: list(s.else) };
    case 'while':
    case 'dowhile':
      return { ...s, cond: f(s.cond), body: list(s.body) };
    case 'for':
      return {
        ...s,
        cond: f(s.cond),
        init: mapStmts(s.init, f, list),
        inc: mapStmts(s.inc, f, list),
        body: list(s.body),
      };
    case 'switch':
      return {
        ...s,
        scrutinee: f(s.scrutinee),
        cases: s.cases.map((c) => ({ ...c, body: list(c.body) })),
        ...(s.default ? { default: list(s.default) } : {}),
      };
    default:
      return s;
  }
}
