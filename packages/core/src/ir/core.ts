// asmlift IR — the MLIR-lite substrate shared by all levels.
//
//   - a CFG of basic blocks with TYPED BLOCK-ARGUMENTS (functional-form SSA); no phi
//   - exactly one terminator per block; terminators carry successors + block-arg lists
//   - Value identity is OBJECT IDENTITY, owned by the graph — no module-global counter;
//     textual names are assigned at print time by deterministic traversal
//   - passes transform via replaceAllUsesWith, never in-place opcode/type mutation
//
// The two real representations are this `Fn` (typed-SSA) and the structured `SFn` AST; type
// recovery is an in-place pass on `Fn`.
import type { Opcode } from './opcodes';
import type { IrType } from './types';

export type AttrVal = number | boolean | string | number[];

/** An SSA value. Identity is the object itself; the type may be `unknown` at L1. */
export interface Value {
  type: IrType;
}

/** A branch target: which block, and the arguments bound to its block-parameters. */
export interface Successor {
  block: Block;
  args: Value[];
}

export interface Op {
  opcode: string;
  operands: Value[];
  results: Value[];
  attrs: Record<string, AttrVal>;
  successors: Successor[]; // non-empty only for terminators
}

/** A basic block. `params` are its block-arguments. Must end in exactly one terminator. */
export interface Block {
  params: Value[];
  ops: Op[];
}

/** A function. `blocks[0]` is the entry; its params are the function parameters. */
export interface Fn {
  name: string;
  blocks: Block[];
  /** L1 SIDE DATA (see {@link WriteOrder}); set by the SSA builder, `undefined` on parsed IR.
   *  REQUIRED, not optional, and the `| undefined` is the point: every place that builds an `Fn`
   *  — the copy in `cli/src/report.ts` most of all — has to say what it does with the record, so
   *  a side table added to `Fn` cannot be dropped by a copy that simply never mentions it. */
  writeOrder: WriteOrder | undefined;
  /** L1 SIDE DATA (see {@link SlotHomes}); set by the SSA builder, `undefined` on parsed IR.
   *  REQUIRED-but-possibly-undefined for exactly the reason `writeOrder` is: an optional field is
   *  silently dropped by a copy that never mentions it (`cli/src/report.ts` structuredCloneFn says
   *  so at its own definition), and a fact the structurer reads but the score probe's clone drops
   *  makes that probe's delta a fact about a program asmlift does not emit. */
  slotHomes: SlotHomes | undefined;
}

/** Which `[sp,#k]` the machine homed a value at — the frame coordinate, carried L1 → L3.
 *
 *  The coordinate exists only in the frontends: they record a word sp-relative slot's value in SSA
 *  under the key `sp@k` (`frontend/ssa.ts` stackSlotKey) instead of emitting a store through `sp`,
 *  so by L2 the value is an ordinary SSA value and `k` is gone. This map is where `k` survives.
 *
 *  A KEY IS NOT A FRAME COORDINATE, and the frontends differ on exactly that. `sp@40` is a local
 *  on one ABI and the caller's fifth argument on another, so the shared stamp asks the frontend's
 *  own `LiveInModel.ownedLocals` and refuses an offset outside it. Thumb declares `[0, localArea)`
 *  and already bounds its minting to that range, so every Thumb spill is stamped; MIPS and PPC
 *  declare NO partition, so nothing is stamped there — a MIPS `sw a0,0(sp)` is O32's caller-owned
 *  register-parameter home area, not this function's first declared local. An entry in this map
 *  therefore means "storage this function owns, homed at k", not "some sp-relative key".
 *
 *  It is read by ONE consumer — the structurer, which turns it into `SFn.locals[i].slot` — and
 *  exists because a compiler that hands out frame slots by declaration rank makes the source's
 *  DECLARATION ORDER observable in the object. Absent entries are the norm: most values are never
 *  spilled, and a value with no entry simply has no frame coordinate to order by.
 *
 *  A SET, AND NOTHING MERGES IT. Every place two homes meet — this map's own writes, a value that
 *  inherits another's uses in `replaceAllUsesWith`, several values under one name in the
 *  structurer's naming walk, two named locals absorbed into one by `l3/coalesce.ts` — takes the
 *  UNION. None of those four sites picks an offset, because picking one is a question about the
 *  TARGET and not one of them holds a target: the SSA builder takes `(name, blockCount, preds,
 *  liveInOf)`, `replaceAllUsesWith` takes an `Fn`, and `localsAfterMerge` takes a locals list.
 *
 *  The reduction happens ONCE, in `l3/slotorder.ts`, which is the one place that holds
 *  `SFn.slotOrder`. Earliest declaration rank is the LOWEST offset under an ascending frame and
 *  the HIGHEST under a descending one, so the earlier "take the lower offset" policy was
 *  ascending's answer written four times under a neutral name — right for agbcc, inverted for the
 *  two descriptions whose measured direction is `descending`. Reducing where the direction is in
 *  hand makes it one comparator instead of four copies of a sentence.
 *
 *  It is still a POLICY and not a proof: the machine homed one value at two offsets and the source
 *  declared one local, so no reading of the asm recovers which rank the source had. What the union
 *  buys is that the choice is made where it can be made correctly.
 *
 *  NO `ir/verify.ts` RULE, unlike `writeOrder`: that record is a per-FUNCTION measurement with a
 *  mixed state to reject (some blocks measured, others not). A slot home is per VALUE and
 *  legitimately absent on almost every value, so there is no mixed state for a verifier to catch
 *  and a rule would never fire. */
export type SlotHomes = Map<Value, Set<number>>;

/** The order in which each block WROTE the keys its successors' block-params stand for — a
 *  measurement the SSA builder makes and nothing downstream can recover, because the value graph
 *  keeps no trace of it: a register copy is the same SSA value under a new key, and once a key's
 *  value is a successor's edge argument the write that put it there has no op of its own.
 *
 *  The structurer needs it to spell a parallel copy in the compiler's own order. The compiler
 *  established the block's final register values in SOME order, and in a cyclic copy the register
 *  that reached its final value FIRST is the one whose old value had to be saved elsewhere — the
 *  temp — because the copies that still read that old value run after it. Sorting an edge's copies
 *  by this record puts that copy first, so the sequentializer's first-copy spill reproduces the
 *  compiler's temp instead of guessing from def positions, where an in-block def and an incoming
 *  param have no common scale. LAST write, not first: a predecessor commonly writes one key several
 *  times (1,867 of 5,283 records over three checkouts), and the edge carries what the last left.
 *
 *  Keyed by OBJECTS (the predecessor block, the destination param), never by arg position, so the
 *  param splices in `ir/simplify.ts` cannot leave it stale. A pass that moves one block's ops into
 *  another owes `foldWriteOrder`.
 *
 *  MEASUREMENT IS PER FUNCTION, NOT PER BLOCK. The SSA builder measures every block it builds, so
 *  `writes` covers every block or the record is absent/empty (parsed or hand-built IR — nobody
 *  measured this function); `ir/verify.ts` rejects the mixed state, and says there what that check
 *  does and does not reach. A reader still asks per BLOCK (`structure.ts` `predIsMeasured`), which
 *  is how a wholly unmeasured fn takes the def-position proxy without a second query — but a
 *  missing entry means "no frontend measured this function", never "this block wrote nothing". The
 *  latter is an entry whose `lastWrite` holds no destination of the edge, its own case with its own
 *  golden. */
export interface WriteOrder {
  /** pred → (param of a successor → ordinal, among the pred's writes, of its LAST write to the key
   *  that param stands for). No entry ⇒ the pred did not write the key; the arg passes through. */
  lastWrite: Map<Block, Map<Value, number>>;
  /** Every measured block → how many writes it made. Membership is the "measured" test. */
  writes: Map<Block, number>;
}

/** `from`'s writes now happen at the END of `into` — the bookkeeping a pass owes when it moves one
 *  block's ops (or the edge copies an empty block stood for) into another. Each of `from`'s records
 *  lands under `into` at its ordinal plus `into`'s own write count, so a key `into` wrote itself
 *  still sorts first and a later fold onto `into` composes the same way. REFUSES when `into` was
 *  never measured: a block no builder counted has no place to put `from`'s writes after, and
 *  reading it as "wrote nothing of its own" would be a guess. `from`'s own entries stay; a block a
 *  pass removes from the CFG is never read again. */
export function foldWriteOrder(order: WriteOrder | undefined, from: Block, into: Block): void {
  const base = order?.writes.get(into);
  if (order === undefined || base === undefined) {
    return;
  }
  const moved = order.lastWrite.get(from);
  if (moved !== undefined) {
    const rec = order.lastWrite.get(into) ?? new Map<Value, number>();
    for (const [param, at] of moved) {
      rec.set(param, base + at);
    }
    order.lastWrite.set(into, rec);
  }
  order.writes.set(into, base + (order.writes.get(from) ?? 0));
}

export function mkValue(type: IrType): Value {
  return { type };
}

export function mkOp(opcode: Opcode, o: Partial<Op> = {}): Op {
  return {
    opcode,
    operands: o.operands ?? [],
    results: o.results ?? [],
    attrs: o.attrs ?? {},
    successors: o.successors ?? [],
  };
}

/** The successor blocks of `b`, read off its terminator. */
export function successorsOf(b: Block): Block[] {
  const term = b.ops[b.ops.length - 1];
  return term ? term.successors.map((s) => s.block) : [];
}

/** Predecessor map for the whole function's CFG. */
export function predecessors(fn: Fn): Map<Block, Block[]> {
  const preds = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    preds.set(b, []);
  }
  for (const b of fn.blocks) {
    for (const s of successorsOf(b)) {
      preds.get(s)!.push(b);
    }
  }
  return preds;
}

/** Forward dominators (iterative data-flow). dom(b) = {b} ∪ ⋂ dom(preds).
 *
 *  A CFG fact, so it lives beside `predecessors` it is built on rather than with either consumer:
 *  `verify` needs it to check def-dominates-use, `structure/loops.ts` to tell a back-edge from a
 *  forward one, and `raise/latch.ts` to tell a latch from a preheader. */

export function dominators(fn: Fn): Map<Block, Set<Block>> {
  const preds = predecessors(fn);
  const all = new Set(fn.blocks);
  const dom = new Map<Block, Set<Block>>();
  fn.blocks.forEach((b, i) => dom.set(b, i === 0 ? new Set([b]) : new Set(all)));
  for (let changed = true; changed;) {
    changed = false;
    for (const b of fn.blocks.slice(1)) {
      let inter: Set<Block> | null = null;
      for (const p of preds.get(b)!) {
        const dp = dom.get(p)!;
        if (inter === null) {
          inter = new Set(dp);
          continue;
        }
        for (const x of inter) {
          if (!dp.has(x)) {
            inter.delete(x);
          }
        } // intersect in place (spec-safe delete-in-iter)
      }
      const next = new Set<Block>(inter ?? []);
      next.add(b);
      const prev = dom.get(b)!;
      if (next.size !== prev.size || [...next].some((x) => !prev.has(x))) {
        dom.set(b, next);
        changed = true;
      }
    }
  }
  return dom;
}

/** A block with NO BODY OF ITS OWN: it declares no parameters and holds a single op, which is
 *  therefore its terminator. It computes nothing and it binds nothing. Three sites ask this and
 *  each adds its own clause (`forwardingTarget` below wants a `br` carrying no args;
 *  switch-recover.ts's `isBareExit` admits a `ret` as well; raise/retsink.ts asks it of a
 *  predecessor, to tell a decision that RAN OUT from an arm that ran ON), so the shared half is
 *  stated once, here.
 *
 *  THE PARAMETER CLAUSE IS THE LOAD-BEARING HALF, and the reason this is not spelled
 *  `ops.length === 1`: a case ENTRY whose arm is EMPTY is also one op — the jump onwards — but it
 *  takes the accumulator as a block parameter, so it is a real arm of a dispatch and not a
 *  forwarder. */
export function isBodyless(blk: Block): boolean {
  return blk.params.length === 0 && blk.ops.length === 1;
}

/** Where a chain of TRANSPARENT forwarding blocks lands — no params, a lone `br`, no block args.
 *
 *  A compiler that cannot reach a target from a conditional branch emits the real branch separately
 *  (agbcc past Thumb's ±256-byte range; the binary-search layout of a `switch`), so two sites
 *  reaching one block arrive as two DISTINCT forwarding blocks. A recogniser keyed on successor
 *  identity needs the destination, not the edge.
 *
 *  An edge carrying block ARGUMENTS is not transparent — skipping it would drop the value it
 *  supplies — so the walk stops there. Read-only: nothing about the graph changes.
 *
 *  Two sites test a similar shape and are deliberately NOT callers, both because they KEEP the
 *  args this refuses to walk past: raise/latch.ts's `foldEmptyLatches` rewrites the edge and
 *  carries the forwarder's args onto it; structure/switch-recover.ts's `resolveDefault` walks onto
 *  a default candidate through a `b .Ldefault(v)` and turns that step into one more dispatch edge,
 *  whose copies the hoist re-emits above the `switch`. */
export function forwardingTarget(b: Block): Block {
  const seen = new Set<Block>();
  let cur = b;
  while (isBodyless(cur) && !seen.has(cur)) {
    seen.add(cur);
    const t = cur.ops[0];
    if (t.opcode !== 'br' || t.successors[0].args.length > 0) {
      break;
    }
    cur = t.successors[0].block;
  }
  return cur;
}

/** THE MERGE CLASSES: every value that rides a branch edge, grouped with the block parameter it
 *  binds — transitively, so a value forwarded across several merges lands in one class.
 *
 *  Functional-form SSA has no phi node: a register merge is spelled as an edge ARGUMENT plus a
 *  block PARAMETER, two names for the one value a register carried. So a rule that counts what a
 *  value is USED for reads one merged value as N values with N use counts, and any threshold it
 *  applies (`structure/analysis.ts`'s "base of 2+ accesses") is measured against the wrong
 *  denominator. This is the closure that restores it.
 *
 *  A value on no edge is its own class and is absent from the map — read it as `get(v) ?? [v]`.
 *  Member order is definition order (block order, params before results), so a caller that reports
 *  a class reports it deterministically.
 *
 *  A CFG/SSA fact rather than a rule of any one pass, so it lives here beside `dominators`. Two
 *  callers took it: `structure/analysis.ts`'s shared-base scope, and `structure/structure.ts`'s
 *  signed-use cone, which had hand-rolled the same arg↔param map.
 *
 *  THE THIRD SITE IS NOT THIS RELATION, and saying so is the point of naming it here.
 *  `raise/recover.ts`'s `propagatePointers` runs its own union-find over the edge relation PLUS
 *  the const-offset `add`/`sub` (a pointer ± an integer stays the same pointer), which is a
 *  strictly larger relation and a typing rule of that pass rather than a fact about the CFG.
 *  Rewriting it to start from this map would make it seed a pass-specific union on top, i.e. give
 *  a CFG fact a parameter for one caller's extra edges — so it stays where it is, and what this
 *  paragraph buys is that the next reader looking for a fourth copy knows which of the two the
 *  third one is. */
export function mergeClasses(fn: Fn): Map<Value, readonly Value[]> {
  const parent = new Map<Value, Value>();
  const find = (v: Value): Value => {
    let r = v;
    while ((parent.get(r) ?? r) !== r) {
      r = parent.get(r)!;
    }
    for (let c = v; (parent.get(c) ?? r) !== r;) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    parent.set(r, r);
    return r;
  };
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        // `verify` pins arg/param arity, but this also runs on hand-built IR in tests — take the
        // overlap rather than index past the end.
        const n = Math.min(s.args.length, s.block.params.length);
        for (let i = 0; i < n; i++) {
          parent.set(find(s.args[i]), find(s.block.params[i]));
        }
      }
    }
  }
  const byRoot = new Map<Value, Value[]>();
  for (const b of fn.blocks) {
    for (const v of [...b.params, ...b.ops.flatMap((op) => op.results)]) {
      if (parent.has(v)) {
        const root = find(v);
        (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(v);
      }
    }
  }
  const out = new Map<Value, readonly Value[]>();
  for (const members of byRoot.values()) {
    for (const v of members) {
      out.set(v, members);
    }
  }
  return out;
}

/** Every value defined by an op result → its defining op (block params excluded). */
export function defOpMap(fn: Fn): Map<Value, Op> {
  const m = new Map<Value, Op>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        m.set(r, op);
      }
    }
  }
  return m;
}

/** Replace every use of `oldV` with `newV` (operands + successor args). No in-place op mutation. */
export function replaceAllUsesWith(fn: Fn, oldV: Value, newV: Value): void {
  // The frame coordinate follows the value that inherits the uses. Without this the home stays on
  // a value nothing reads any more while the local the structurer names — `newV` — carries none,
  // and the declaration list loses its order for that local. UNION, never a choice: this helper is
  // handed an `Fn` and an `Fn` carries no target, so it cannot know whether the earlier rank is the
  // lower or the higher offset (`SlotHomes`). `l3/slotorder.ts` decides that, once.
  //
  // A GUARD, MEASURED: instrumented over every agbcc case of both benchmark tiers, this fires 14
  // times on 252 lifted synthetic functions and 112 times on 116 lifted real ones — and in every
  // single firing the inheriting value already carried the same offset. So it has never yet SAVED
  // a home, and the union has never yet held two. It ships because the alternative is a home
  // stranded on a retired value, which is silent.
  const homes = fn.slotHomes;
  if (homes !== undefined) {
    const from = homes.get(oldV);
    if (from !== undefined) {
      const to = homes.get(newV);
      if (to === undefined) {
        homes.set(newV, new Set(from));
      } else {
        from.forEach((off) => to.add(off));
      }
    }
  }
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands = op.operands.map((v) => (v === oldV ? newV : v));
      for (const s of op.successors) {
        s.args = s.args.map((v) => (v === oldV ? newV : v));
      }
    }
  }
}
