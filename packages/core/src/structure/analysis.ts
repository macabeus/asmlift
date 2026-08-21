// asmlift structurer — the ANALYSIS phase. Pure derivation over the lifted fn — nothing here
// mutates the IR or depends on naming/emission state:
//   • use-site registry — every use of a value, POSITIONED (op + block + index);
//   • per-block SSA value liveness (backward dataflow) — consumed by the coalescing
//     interference check in structure.ts;
//   • the effect-ordering model — which defs must MATERIALIZE as named temps at their own
//     program position instead of inlining at their use (calls/loads for effect order, plus
//     the pure defs the homing rules claim).
import { globalCellOf, mayWriteGlobal } from '../ir/alias';
import { Block, Fn, Op, Value, defOpMap, successorsOf } from '../ir/core';
import { EFFECTFUL_OPS } from '../ir/opcodes';

export interface UseSite {
  blk: Block;
  idx: number;
  op: Op;
}

/** the ops whose operands[0] is a memory-access BASE — the address-home axis's slot model */
const MEM_BASE_OPS = new Set(['load', 'store', 'aload', 'astore']);

/** Any gaddr/laddr in the op's operand cone (the op included). Rendered standalone, an address
 *  computation over one loses the memAccess's inline byte-stride cast — the value changes, so
 *  every homing rule refuses the cone (the cast-aware machinery in l3/basecse.ts, scopebase.ts
 *  and nearbase.ts serves those bases instead). The walk deliberately crosses loads — a gaddr
 *  reachable only through a load's address keeps its cast at that load's own deref, so
 *  over-refusal there costs a candidate, never soundness. */
function coneHoldsAddr(op0: Op, defOf: Map<Value, Op>): boolean {
  const seen = new Set<Value>();
  const cone = [op0];
  while (cone.length) {
    const d = cone.pop()!;
    if (d.opcode === 'gaddr' || d.opcode === 'laddr') {
      return true;
    }
    for (const x of d.operands) {
      if (!seen.has(x)) {
        seen.add(x);
        const dd = defOf.get(x);
        if (dd) {
          cone.push(dd);
        }
      }
    }
  }
  return false;
}

/** rank.ts's enumeration gate for the `/addr-home` axis: does the function HAVE a value the axis
 *  would home — a non-const pure def consumed only as the base of 2+ memory accesses, with no
 *  gaddr/laddr in its cone? Mirrors the axis's scope rule in `analyze`, minus the loop-header
 *  seat refusal (that needs the loop model; a false positive costs one duplicate-collapsed
 *  candidate, never a wrong one). */
export function hasHomeableSharedAddress(fn: Fn): boolean {
  const defOf = defOpMap(fn);
  const baseUses = new Map<Value, Set<Op>>();
  const otherUse = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'ret') {
        // A `ret` operand may be a void phantom (analyze() skips it under returnsVoid, which this
        // gate cannot know) — never a disqualifier here. For a genuinely returned base the axis's
        // own rule still refuses, costing one duplicate-collapsed candidate — the same trade the
        // gate's doc names for the loop-header divergence.
        continue;
      }
      op.operands.forEach((o, i) => {
        if (i === 0 && MEM_BASE_OPS.has(op.opcode)) {
          (baseUses.get(o) ?? baseUses.set(o, new Set()).get(o)!).add(op);
        } else {
          otherUse.add(o);
        }
      });
      for (const s of op.successors) {
        for (const a of s.args) {
          otherUse.add(a);
        }
      }
    }
  }
  for (const [v, users] of baseUses) {
    if (users.size < 2 || otherUse.has(v)) {
      continue;
    }
    const d = defOf.get(v);
    if (
      d &&
      d.opcode !== 'const' &&
      d.opcode !== 'call' &&
      d.opcode !== 'load' &&
      d.opcode !== 'aload' &&
      !coneHoldsAddr(d, defOf)
    ) {
      return true;
    }
  }
  return false;
}

/** rank.ts's enumeration gate for the `/expr-home` axis: does the function HAVE a value the
 *  axis would home — a pure non-const def with 2+ distinct consumers inside a loop the def sits
 *  outside, cone-free? Loops here are LAYOUT ranges (a successor at an equal-or-earlier block
 *  position closes one) where the axis's own rule uses the dominator model, and consumers here
 *  come from op operands only (branch-arg uses are invisible) — so unlike
 *  hasHomeableSharedAddress this diverges in BOTH directions: a false positive costs one
 *  duplicate-collapsed candidate, and a false negative silently skips the arm on IR whose block
 *  layout does not follow dominance or whose in-loop consumption is all branch args. Acceptable
 *  because every frontend lays blocks out in address order (a natural loop's back edge points
 *  backward), and a value consumed ONLY as branch args reaches no compare/product/shift — the
 *  shapes the home serves. */
export function hasLoopSharedPureValue(fn: Fn): boolean {
  const defOf = defOpMap(fn);
  const pos = new Map<Block, number>(fn.blocks.map((b, i) => [b, i]));
  const ranges: [number, number][] = [];
  for (const b of fn.blocks) {
    for (const sx of successorsOf(b)) {
      if (pos.get(sx)! <= pos.get(b)!) {
        ranges.push([pos.get(sx)!, pos.get(b)!]);
      }
    }
  }
  if (ranges.length === 0) {
    return false;
  }
  const consumers = new Map<Value, Set<Op>>();
  const opPos = new Map<Op, number>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      opPos.set(op, pos.get(b)!);
      for (const o of op.operands) {
        (consumers.get(o) ?? consumers.set(o, new Set()).get(o)!).add(op);
      }
    }
  }
  for (const [v, cs] of consumers) {
    const d = defOf.get(v);
    if (!d || d.opcode === 'const' || d.opcode === 'call' || d.opcode === 'load' || d.opcode === 'aload') {
      continue;
    }
    const dp = opPos.get(d)!;
    if (
      ranges.some(
        ([lo, hi]) =>
          (dp < lo || dp > hi) && [...cs].filter((c) => opPos.get(c)! >= lo && opPos.get(c)! <= hi).length >= 2,
      ) &&
      !coneHoldsAddr(d, defOf)
    ) {
      return true;
    }
  }
  return false;
}

export interface StructureAnalysis {
  /** every positioned use of a value; a value absent here is dead */
  useSitesOf: Map<Value, UseSite[]>;
  opIndex: Map<Op, number>;
  opBlock: Map<Op, Block>;
  /** SSA values live at each block's entry */
  liveIn: Map<Block, Set<Value>>;
  /** defs that must emit as named temps at their own position — calls/loads for effect order,
   *  plus the pure defs the homing rules claim */
  materialize: Set<Op>;
  /** cached forward reachability (successors-transitive, excluding the start block itself) */
  reachFrom: (b: Block) => Set<Block>;
  /** where a value's expression ultimately renders — the anchored consumer it inlines into,
   *  transitively; null = several places / unresolvable (callers treat conservatively) */
  emitPos: (op: Op) => { blk: Block; idx: number } | null;
  /** may an op `isWrite` accepts execute between `def` and a statement at `render`, on any
   *  def-avoiding path — the fold-ordering gate (see the closure's comment) */
  memWriteBetween: (def: Op, render: { blk: Block; idx: number }, isWrite: (x: Op) => boolean) => boolean;
}

export interface AnalyzeOptions {
  /** the fn's def map (`defOpMap`) — the structurer already holds one, so it is passed rather than
   *  rebuilt. Absent ⇒ the global-aware alias rule below cannot resolve anything and every write
   *  bars, exactly as before it existed. */
  defs?: Map<Value, Op>;
  /** Dominator sets, when the caller already holds them (structure() does) — consumed by the
   *  live-across-a-loop rule's back-edge detection. Absent ⇒ that rule stands down. */
  dom?: Map<Block, Set<Block>>;
  /** THE value-home axis (rank.ts `/reread-globals`). A read of a named global is barred from
   *  rendering at its use by any write in between — even a store to an unrelated global, which
   *  cannot possibly change what it sees. That over-conservatism is what invents the locals the
   *  round-5 dogfood measured as its highest-cost defect ("hoists what agbcc re-reads"):
   *
   *      gA = v; gB = v;   with `s32 v = gValue;`   where the source said `gA = gValue; gB = gValue;`
   *
   *  With this on, the barrier scan for a load whose address resolves to a named global uses THE
   *  shared disjointness query (ir/alias.ts) instead of "any write at all". Materializing a
   *  global's READ is always sound (the deref and its cast render at the def's position — contrast
   *  homeSharedAddresses below, where the materialized value is an address and soundness is
   *  scoped), so today's spelling is never wrong — only sometimes not the one the compiler was
   *  given.
   *  Which side matches is genuinely per-function (the same dogfood watched agbcc go both ways
   *  inside ONE function), so this is a differ-refereed candidate axis, never a default. */
  rereadGlobals?: boolean;
  /** "does the project declare this global volatile?" — a read of a volatile object may NOT be
   *  duplicated or moved, so the axis above refuses on one. Answers false for a symbol the map
   *  does not carry (and for no map at all), which is the same posture the multi-render rule has
   *  always had: without a declaration nothing here can know, and the differ referees the extra
   *  load. Where the map DOES know, the axis is silent about it rather than wrong. */
  volatileGlobal?: (name: string) => boolean;
  /** The in-place-join axis (rank.ts `/inplace`). A load whose result is a `cond_br` successor
   *  ARG feeds a merge: rendered inline it has no name, so the merge param mints a fresh variable
   *  and BOTH arms must assign it. Materialized, the naming walk can home the merge in the load's
   *  own variable, the identity arm elides, and the `if` renders one-sided — `v = *p; if (v > 31)
   *  v = 32;` — which is also what reuses the load's register when recompiled. Whether the source
   *  spelled the temp or the overwrite is not derivable from the asm, so this is a differ-refereed
   *  candidate axis, never a default. Plain `br` args (loop-carried values) are out of scope:
   *  their homes are the loop-param machinery's question. */
  materializeJoinFeeds?: boolean;
  /** The address-home axis (rank.ts `/addr-home`). A pure computed address the asm derived ONCE
   *  and dereferenced at 2+ sites renders, by default, re-derived at each use — and the loads
   *  through it re-read per use — where the original source may have spelled a pointer local plus
   *  scalar temps (`u8 *entry = (u8 *)((a0 << 2) + base); type = entry[1]; idx = entry[0];`).
   *  The two spellings are codegen-visible (the re-derive folds each deref offset into its OWN
   *  pool literal; the home shares one base register across `[rN, #k]` accesses) and which one
   *  the source used is not derivable from asm, so this is a differ-refereed candidate axis,
   *  never a default. With it on: a non-const pure value consumed ONLY as the base operand of
   *  2+ memory accesses materializes, and so does a multi-render `load` through such a base.
   *  Both rules only ADD materialization, which preserves semantics FOR THE VALUES THE SCOPE
   *  ADMITS — the gaddr/laddr cone refusal is the soundness half of that claim (rendered
   *  standalone, an address cone's value changes: the byte-stride cast lives at the use — see
   *  coneHoldsAddr; those bases stay with l3/basecse.ts, scopebase.ts and nearbase.ts), and the
   *  multi-block-loop-header seat refusal is the decline-avoidance half (same as
   *  liveAcrossLoop's). An L3 re-spell could not host this axis: by structuring's end the loads
   *  have already rendered per-use inside separate arms, and only this phase's positioned
   *  memory model can merge them into pre-branch temps. */
  homeSharedAddresses?: boolean;
  /** The loop-expression-home axis (rank.ts `/expr-home`). A pure computed value defined outside
   *  a loop and consumed by 2+ distinct ops inside it is one the compiler holds in a
   *  (callee-saved) register across the iterations — it never re-derives per use in a loop —
   *  where the default renders it re-derived at each use; the source may have spelled a typed
   *  local (`u32 size = 16 << t;` driving a loop bound, a product and a shift). The home's
   *  declared type is the IR value's recovered type, so a u32 value's compares stay unsigned
   *  through the local. Straight-line multi-use values stay OUT (the small-constant class the
   *  const-across-call scope's note records); shared memory-access bases are `/addr-home`'s.
   *  Same refusals as that axis: gaddr/laddr cones and multi-block-loop-header seats. Adding
   *  materialization preserves semantics for the admitted values, exactly as above. */
  homeLoopExprs?: boolean;
}

export function analyze(fn: Fn, returnsVoid: boolean, opts: AnalyzeOptions = {}): StructureAnalysis {
  const {
    defs,
    dom,
    rereadGlobals = false,
    volatileGlobal,
    materializeJoinFeeds = false,
    homeSharedAddresses = false,
    homeLoopExprs = false,
  } = opts;
  // ── use registry ────────────────────────────────────────────────────────────────────────
  // Every use of a value, POSITIONED: the consuming op and its block/index. Successor args are
  // uses AT the terminator (they render in argAssigns at block end). A void function's `ret`
  // operand is a phantom, not a real use — skipping it lets a call whose result ONLY flows into
  // the suppressed return read as a dead (side-effect) call, so `sideEffects()` emits it.
  // One operand SLOT = one entry (an op reading a value twice records two uses — that count is
  // what decides whether an inlined call would EXECUTE twice).
  const useSitesOf = new Map<Value, UseSite[]>();
  const opIndex = new Map<Op, number>();
  const opBlock = new Map<Op, Block>();
  const blockPos = new Map<Block, number>();
  for (const b of fn.blocks) {
    blockPos.set(b, blockPos.size);
    b.ops.forEach((op, i) => {
      opIndex.set(op, i);
      opBlock.set(op, b);
    });
  }
  // Linear program position (block order, then op order): a call "between" a def and a use is one
  // whose position lies strictly between them. This is a PROXY for "a call on a def→use path", not
  // the real dataflow: it checks position order only, not reachability. It can therefore FALSE-
  // POSITIVE — a call in a forward SIBLING branch (never traversed on the def→use path) still sits
  // between them by position (e.g. `def; if(c){call;ret} else {…use…use}`), and back-edges are not
  // modelled either. That is SAFE ONLY BECAUSE the caller materializes exactly `const` ops: a const
  // is a relocation-invariant leaf whose def dominates every use, so binding it to a local is
  // UNCONDITIONALLY semantics-preserving on every path — a false positive costs at most a match (an
  // extra `v =` the compiler would have re-inlined), caught by the zero-lost gate, never wrong C.
  // RE-VERIFY this before widening the whitelist to any value that is not path-independent or that
  // carries a use-site cast (an address computation `&g + i`), for which a false positive is unsound.
  const linPos = (op: Op): number => blockPos.get(opBlock.get(op)!)! * 1e6 + opIndex.get(op)!;
  const callPos: number[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'call') {
        callPos.push(linPos(op));
      }
    }
  }
  // The `/inplace` axis reads: which values ride a `cond_br` edge as a successor ARG. Built
  // once; plain `br` args deliberately not collected (see AnalyzeOptions).
  const condBrArgFed = new Set<Value>();
  if (materializeJoinFeeds) {
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'cond_br') {
          for (const s of op.successors) {
            for (const a of s.args) {
              condBrArgFed.add(a);
            }
          }
        }
      }
    }
  }
  /** True if `def`'s value is still needed after a call — a call lies strictly between the def and
   *  one of its `consumers`. Such a value survives in a callee-saved register (a local), which is
   *  what materializing it reproduces. */
  const liveAcrossCall = (def: Op, consumers: Op[]): boolean => {
    const dp = linPos(def);
    const usePos = consumers.map(linPos);
    return callPos.some((c) => c > dp && usePos.some((u) => u > c));
  };
  for (const b of fn.blocks) {
    b.ops.forEach((op, i) => {
      if (returnsVoid && op.opcode === 'ret') {
        return;
      }
      const site: UseSite = { blk: b, idx: i, op };
      const add = (v: Value) => {
        const arr = useSitesOf.get(v);
        if (arr) {
          arr.push(site);
        } else {
          useSitesOf.set(v, [site]);
        }
      };
      for (const u of op.operands) {
        add(u);
      }
      for (const s of op.successors) {
        for (const a of s.args) {
          add(a);
        }
      }
    });
  }

  // ── per-block liveness of SSA values ──────────────────────────────────────────────────────
  // Backward dataflow. Successor args count as uses at the END of the predecessor (they render
  // in the predecessor's argAssigns), so liveIn(B) means precisely "read at-or-after B's entry".
  // Consumed by the coalescing interference check: merging two values that are ever
  // simultaneously live into one variable name is the textbook silent clobber.
  const liveIn = new Map<Block, Set<Value>>();
  for (const b of fn.blocks) {
    liveIn.set(b, new Set());
  }
  for (let liveChanged = true; liveChanged;) {
    liveChanged = false;
    for (let bi = fn.blocks.length - 1; bi >= 0; bi--) {
      const b = fn.blocks[bi];
      const live = new Set<Value>();
      for (const s of successorsOf(b)) {
        for (const v of liveIn.get(s)!) {
          live.add(v);
        }
      }
      for (let oi = b.ops.length - 1; oi >= 0; oi--) {
        const op = b.ops[oi];
        for (const r of op.results) {
          live.delete(r);
        }
        for (const s of op.successors) {
          for (const a of s.args) {
            live.add(a);
          }
        }
        if (!(returnsVoid && op.opcode === 'ret')) {
          for (const u of op.operands) {
            live.add(u);
          }
        }
      }
      for (const p of b.params) {
        live.delete(p);
      }
      const cur = liveIn.get(b)!;
      if (live.size !== cur.size || ![...live].every((v) => cur.has(v))) {
        liveIn.set(b, live);
        liveChanged = true;
      }
    }
  }

  // ── the effect-ordering model — inline-at-use barriers ────────────────────────────────────
  // `expr()` renders a def's computation AT ITS USE, which silently MOVES it: a call executes
  // once per rendered copy (`foo(a0)+foo(a0)`), a load reads memory at the render point (it can
  // textually sink past an aliasing store). The model: a call/load/aload def may inline ONLY
  // when rendering cannot change behavior — exactly one render position, and the program-order
  // gap between def and render crosses no memory write (loads) / no memory access at all (calls,
  // whose own reads+writes must not reorder against anything). Every other case gets a NAMED
  // TEMP assigned at the def's own program position (sideEffects) — which is precisely the
  // register the compiler used.
  const materialize = new Set<Op>();
  const reachCache = new Map<Block, Set<Block>>();
  const reachFrom = (b: Block): Set<Block> => {
    let r = reachCache.get(b);
    if (r) {
      return r;
    }
    r = new Set<Block>();
    const stack = [...successorsOf(b)];
    while (stack.length) {
      const x = stack.pop()!;
      if (r.has(x)) {
        continue;
      }
      r.add(x);
      stack.push(...successorsOf(x));
    }
    reachCache.set(b, r);
    return r;
  };
  // Reachability that never passes THROUGH `avoid` — the def-block-avoiding variant for
  // per-iteration path checks: a path that re-enters the def's block re-executes the def, so
  // writes on it belong to the NEXT dynamic instance (which re-renders anyway) and must not
  // count against this one. Uncached (per-decision graphs are small).
  const reachAvoiding = (from: Block, avoid: Block): Set<Block> => {
    const r = new Set<Block>();
    const stack = successorsOf(from).filter((s) => s !== avoid);
    while (stack.length) {
      const x = stack.pop()!;
      if (r.has(x)) {
        continue;
      }
      r.add(x);
      for (const s of successorsOf(x)) {
        if (s !== avoid && !r.has(s)) {
          stack.push(s);
        }
      }
    }
    return r;
  };
  // Where a value's expression is ultimately EMITTED: the anchored consumer (statement op,
  // terminator, materialized def) it inlines into, transitively through single-use pure ops.
  // null = renders in several places / unresolvable (treated conservatively by the caller).
  const emitPosCache = new Map<Op, { blk: Block; idx: number } | null>();
  /** an op that renders AT ITS OWN position: a statement, a terminator, a materialized or dead def */
  const anchored = (op: Op): boolean =>
    op.successors.length > 0 ||
    op.opcode === 'ret' ||
    op.opcode === 'store' ||
    op.opcode === 'astore' ||
    materialize.has(op) ||
    !op.results.length ||
    !useSitesOf.has(op.results[0]);
  const consumersOf = (op: Op): Op[] => [...new Set((useSitesOf.get(op.results[0]) ?? []).map((s) => s.op))];
  const emitPos = (op: Op): { blk: Block; idx: number } | null => {
    if (emitPosCache.has(op)) {
      return emitPosCache.get(op)!;
    }
    let res: { blk: Block; idx: number } | null;
    if (anchored(op)) {
      res = { blk: opBlock.get(op)!, idx: opIndex.get(op)! };
    } else {
      const consumers = consumersOf(op);
      res = consumers.length === 1 ? emitPos(consumers[0]) : null;
    }
    emitPosCache.set(op, res);
    return res;
  };
  // EVERY position a value's expression renders at — `emitPos` generalized to the whole set (it
  // answers one place or gives up), by following ALL consumers transitively. That matters for
  // the value-home axis: a pure expression with two consumers (`gOut = e; return e;`) has no single
  // emit position, so `emitPos` answers null and every memory read feeding it is forced into a
  // local — even when re-reading at both places is provably equivalent. Null only for a genuine
  // cycle (defensive: SSA use-def is acyclic through ops), which the caller treats as unresolvable.
  //
  // NEVER for a call: two render positions mean two executions, so a call whose consumer renders in
  // several places must keep answering null and materialize.
  const emitPosSetCache = new Map<Op, { blk: Block; idx: number }[] | null>();
  const emitPositions = (op: Op, visiting: Set<Op> = new Set()): { blk: Block; idx: number }[] | null => {
    const hit = emitPosSetCache.get(op);
    if (hit !== undefined) {
      return hit;
    }
    if (visiting.has(op)) {
      return null;
    }
    let res: { blk: Block; idx: number }[] | null;
    if (anchored(op)) {
      res = [{ blk: opBlock.get(op)!, idx: opIndex.get(op)! }];
    } else {
      visiting.add(op);
      const seenPos = new Set<string>();
      const acc: { blk: Block; idx: number }[] = [];
      res = acc;
      for (const c of consumersOf(op)) {
        const sub = emitPositions(c, visiting);
        if (!sub) {
          res = null;
          break;
        }
        for (const p of sub) {
          const key = `${blockPos.get(p.blk)}:${p.idx}`;
          if (!seenPos.has(key)) {
            seenPos.add(key);
            acc.push(p);
          }
        }
      }
      visiting.delete(op);
    }
    emitPosSetCache.set(op, res);
    return res;
  };
  // THE def→render path discipline — one implementation, three callers (the two materialization
  // rules below and structure.ts's bitfield fold, which imports it). May an op `isWrite` accepts
  // execute between `def` and a statement at `render`, on any def-avoiding path? The def block's
  // tail, the render block's head, and every between-block on a path; a path re-crossing the def
  // is the NEXT dynamic instance and does not count. Path-based on purpose: `fn.blocks` is ADDRESS
  // order, so a linear-position scan misses a block laid out after the render that executes
  // between def and render on the taken path (an audit round broke exactly that way).
  const memWriteBetween = (def: Op, render: { blk: Block; idx: number }, isWrite: (x: Op) => boolean): boolean => {
    const b = opBlock.get(def)!;
    const oi = opIndex.get(def)!;
    const wDirty = (list: Op[], from: number, to: number): boolean => {
      for (let k = from; k < to; k++) {
        if (isWrite(list[k])) {
          return true;
        }
      }
      return false;
    };
    // Same block: the only def-avoiding path is the straight line between the two indices
    // (leaving and re-entering the block re-crosses the def). A render BEFORE the def cannot
    // happen — within a block, uses follow defs — and falls through to the path walk, whose
    // answer is the conservative one.
    if (render.blk === b && oi < render.idx) {
      return wDirty(b.ops, oi + 1, render.idx);
    }
    if (wDirty(b.ops, oi + 1, b.ops.length) || wDirty(render.blk.ops, 0, render.idx)) {
      return true;
    }
    for (const x of reachAvoiding(b, b)) {
      if (x === render.blk && !reachAvoiding(render.blk, b).has(render.blk)) {
        continue; // acyclic render block: head checked
      }
      if (x !== render.blk && !reachAvoiding(x, b).has(render.blk)) {
        continue; // not on a def→render path
      }
      if (wDirty(x.ops, 0, x.ops.length)) {
        return true;
      }
    }
    return false;
  };
  // ── interdependent parallel-copy args ─────────────────────────────────────────────────────
  // A terminator's successor args are ONE parallel copy (argAssigns), whose every read means the
  // PRE-copy value. An arg whose def-tree reads a SIBLING arg of the same edge cannot read it by
  // name there — so the sibling's whole expression is re-derived inside this arg's copy, and
  // `sequentialize` spills old-value temps to untangle the order: arithmetic the compiler
  // performed once, emitted per reader (the coupled-recurrence loop, `a += b*c; d += a;`). The
  // read sibling is the register the copy machinery cannot represent — materialize its def. The
  // walk crosses pure defs only (a call/load render is those rules' question) and stops at
  // params, which always carry a name.
  const defOf = defs ?? defOpMap(fn);
  const copyInterdependent = new Set<Value>();
  const pureReads = (root: Value, acc: Set<Value>) => {
    const stack = [root];
    while (stack.length) {
      const x = stack.pop()!;
      const d = defOf.get(x);
      if (!d || acc.has(x)) {
        continue;
      }
      acc.add(x);
      if (d.opcode !== 'call' && d.opcode !== 'load' && d.opcode !== 'aload') {
        stack.push(...d.operands);
      }
    }
  };
  for (const b of fn.blocks) {
    for (const s of b.ops[b.ops.length - 1]?.successors ?? []) {
      if (s.args.length < 2) {
        continue;
      }
      for (const w of s.args) {
        const d = defOf.get(w);
        if (!d || d.opcode === 'call' || d.opcode === 'load' || d.opcode === 'aload') {
          continue;
        }
        const reads = new Set<Value>();
        for (const o of d.operands) {
          pureReads(o, reads);
        }
        for (const v of s.args) {
          if (v !== w && reads.has(v)) {
            copyInterdependent.add(v);
          }
        }
      }
    }
  }
  // ── natural loops, for the live-across-a-loop rule ────────────────────────────────────────
  // From the caller's dominators (a back edge is `latch → header` with the header dominating the
  // latch); the body is the backward closure from the latch. With no `dom` the rule stands
  // down — the same posture as the `defs`-carried rules.
  const loopBodies: { header: Block; body: Set<Block> }[] = [];
  if (dom) {
    const predsOf = new Map<Block, Block[]>();
    for (const b of fn.blocks) {
      predsOf.set(b, []);
    }
    for (const b of fn.blocks) {
      for (const s of successorsOf(b)) {
        predsOf.get(s)!.push(b);
      }
    }
    for (const latch of fn.blocks) {
      for (const header of successorsOf(latch)) {
        if (!dom.get(latch)?.has(header)) {
          continue;
        }
        const body = new Set<Block>([header]);
        const work = [latch];
        while (work.length) {
          const x = work.pop()!;
          if (!body.has(x)) {
            body.add(x);
            work.push(...(predsOf.get(x) ?? []));
          }
        }
        loopBodies.push({ header, body });
      }
    }
  }
  /** The def's value enters some loop's header live and every consumer sits outside that loop,
   *  as does the def: the value is carried ACROSS the loop, not into it. */
  // Never for a def in a MULTI-BLOCK loop header: a test-at-top `while`'s condition has no seat
  // for a materialized temp (the structurer's headerPure gate), so materializing there trades a
  // structuring function for a decline. Self-loop headers stay eligible — their kept-guard
  // do-while form hosts the temp.
  const multiBlockHeaders = new Set(loopBodies.filter((L) => L.body.size > 1).map((L) => L.header));
  const liveAcrossLoop = (def: Op, r: Value, consumers: Op[]): boolean =>
    !multiBlockHeaders.has(opBlock.get(def)!) &&
    loopBodies.some(
      (L) =>
        liveIn.get(L.header)!.has(r) &&
        !L.body.has(opBlock.get(def)!) &&
        consumers.every((c) => !L.body.has(opBlock.get(c)!)),
    );
  const addressCone = (op0: Op): boolean => coneHoldsAddr(op0, defOf);
  // ── the address-home axis's scope predicate ───────────────────────────────────────────────
  // A value consumed ONLY as the base (operands[0]) of 2+ distinct memory accesses — the shape
  // the axis homes. Any other use (a store's value slot, an aload index, arithmetic, a successor
  // arg) disqualifies it: the home is justified by the shared-base reuse alone.
  const usedOnlyAsSharedBase = (v: Value): boolean => {
    const sites = useSitesOf.get(v) ?? [];
    const consumers = new Set(sites.map((s) => s.op));
    return (
      consumers.size >= 2 &&
      [...consumers].every(
        (c) => MEM_BASE_OPS.has(c.opcode) && c.operands[0] === v && !c.operands.some((o, i) => i > 0 && o === v),
      )
    );
  };
  /** result values the address-home axis materialized — the load rule's admission key */
  const axisHomedBases = new Set<Value>();
  /** the loop-expression-home axis's scope: some loop the def's block is outside has 2+ distinct
   *  consumers of the value inside it (loop model = the caller's dominators; absent ⇒ never) */
  const loopSharedConsumers = (v: Value, defBlk: Block): boolean => {
    const consumers = [...new Set((useSitesOf.get(v) ?? []).map((s) => s.op))];
    return loopBodies.some(
      (L) => !L.body.has(defBlk) && consumers.filter((c) => L.body.has(opBlock.get(c)!)).length >= 2,
    );
  };
  // Decide in REVERSE program order so a consumer's own materialization is settled before any
  // producer asks for its emit position (SSA: uses follow defs in dominance/layout order) — and
  // iterate to a fixpoint for IR whose block layout does not follow dominance (hand-built IR):
  // materialize only GROWS, and growing it only moves render positions closer / adds barriers,
  // so the loop is monotone and converges.
  for (let sizeBefore = -1; sizeBefore !== materialize.size;) {
    sizeBefore = materialize.size;
    emitPosCache.clear();
    emitPosSetCache.clear(); // both render-position caches read `materialize`, which just grew
    for (let bi = fn.blocks.length - 1; bi >= 0; bi--) {
      const b = fn.blocks[bi];
      for (let oi = b.ops.length - 1; oi >= 0; oi--) {
        const op = b.ops[oi];
        if (materialize.has(op)) {
          continue;
        }
        if (op.opcode !== 'call' && op.opcode !== 'load' && op.opcode !== 'aload') {
          // PURE value-producing op (a constant, an address computation, arithmetic — NOT a
          // memory access). A value with ≥2 distinct-STATEMENT uses in the SSA is one the compiler
          // kept in a register and reused: the frontend never dedups, so multi-use exists ONLY
          // because the asm loaded/computed the value once and read the same register again.
          // Inlining it re-derives the value at each use (a fresh pool load / repeated address
          // arithmetic) — which the compiler did NOT do — so materialize it into a local instead,
          // reproducing that register. Pure ⇒ every render is value-identical, so (unlike a load)
          // no intervening memory write can invalidate a later render: multi-consumer suffices, no
          // barrier scan. Scope: a `const` that is LIVE ACROSS A CALL. A value the compiler needs
          // after a call must survive in a CALLEE-SAVED register — i.e. a local — because the call
          // clobbers the caller-saved ones; the compiler therefore loads it ONCE and keeps it,
          // exactly what materializing into a local reproduces (the base of `((s32 *)C)[i]` reused
          // across `foo(...)` calls). WITHOUT a call in its live range the const is instead cheaply
          // re-materialized at each use (a bare `movs r, #0` per init), so materializing it would
          // ADD pointless copies and MISS — hence the call gate (the small-constant regression).
          // Cheap deref casts still land on the `index` node at the use, preserving byte strides.
          // Second scope: a NON-const read by a sibling parallel-copy arg (`copyInterdependent`) —
          // the one place a pure value's inlining is not value-identical rendering but a
          // re-derivation the copy machinery is forced into. Address cones are excluded from it
          // (an `&g + i` rendered standalone loses the memAccess's inline `(u8 *)` cast —
          // cast-aware base materialization is separate), and consts are not in it at all: a
          // re-derived const is re-materialization, which is the compiler's own behavior.
          const pr = op.results[0];
          if (op.opcode === 'const' && pr && useSitesOf.has(pr)) {
            const cons = [...new Set((useSitesOf.get(pr) ?? []).map((s) => s.op))];
            if (cons.length > 1 && liveAcrossCall(op, cons)) {
              materialize.add(op);
            }
          } else if (op.opcode !== 'const' && pr && copyInterdependent.has(pr) && !addressCone(op)) {
            materialize.add(op);
          }
          // Third scope, under the address-home axis only (see AnalyzeOptions.homeSharedAddresses):
          // a non-const pure value consumed ONLY as the base of 2+ memory accesses. The gaddr/laddr
          // cone exclusion and the loop-header seat refusal are the axis's two refusals.
          if (
            homeSharedAddresses &&
            op.opcode !== 'const' &&
            pr &&
            usedOnlyAsSharedBase(pr) &&
            !addressCone(op) &&
            !multiBlockHeaders.has(b)
          ) {
            materialize.add(op);
            axisHomedBases.add(pr);
          }
          // Fourth scope, under the loop-expression-home axis (AnalyzeOptions.homeLoopExprs): a
          // pure non-const value defined outside a loop with 2+ distinct consumers inside it.
          // Shared bases stay the previous scope's (its load rule needs the registration).
          if (
            homeLoopExprs &&
            op.opcode !== 'const' &&
            pr &&
            !usedOnlyAsSharedBase(pr) &&
            loopSharedConsumers(pr, b) &&
            !addressCone(op) &&
            !multiBlockHeaders.has(b)
          ) {
            materialize.add(op);
          }
          continue;
        }
        const r = op.results[0];
        if (!r || !useSitesOf.has(r)) {
          continue;
        } // dead call → exprstmt (unchanged)
        // Under the value-home axis: which named global cell this op reads, if any. A constant-
        // offset `load` only — an `aload`'s runtime index names no single cell, and a call reads
        // everything. Null ⇒ every write bars, exactly as before.
        const cell =
          rereadGlobals && defs && op.opcode === 'load'
            ? globalCellOf(defs, op.operands[0], op.attrs.off as number)
            : null;
        const barsThisRead = cell && defs && !volatileGlobal?.(cell.name) ? mayWriteGlobal(defs, cell.name) : null;
        if (materializeJoinFeeds && op.opcode === 'load' && condBrArgFed.has(r)) {
          materialize.add(op);
          continue;
        }
        const sites = useSitesOf.get(r)!;
        const consumers = [...new Set(sites.map((s) => s.op))];
        const isCall = op.opcode === 'call';
        // A call must EXECUTE once — any second operand slot duplicates it → named temp.
        if (isCall && sites.length > 1) {
          materialize.add(op);
          continue;
        }
        // Live across a LOOP neither side belongs to: the access ran before the loop and the
        // value crossed it in a callee-saved register (hipress's `keep = p[1]`, homed in r8 and
        // touched only by `mov`). Rendering at the use would re-schedule the access to the far
        // side of the loop — the same refusal liveAcrossCall makes for a call, applied to a loop.
        if (liveAcrossLoop(op, r, consumers)) {
          materialize.add(op);
          continue;
        }
        // Address-home axis: a multi-render load THROUGH a base this axis homed re-reads what the
        // asm read once into the register the home just reproduced — home the value too, at the
        // load's own position. Only through axis-homed bases (the fixpoint's later sweep sees them
        // even though reverse order visits the load first); the general multi-render re-read stays
        // the default rule below. axisHomedBases registers on the same sweep that materializes the
        // base — safe because no other rule can pre-empt a value the axis would home: base-slot-only
        // means no successor-arg use (outside copyInterdependent's read set), and the axis's scope
        // excludes consts, the const arm's only clientele.
        if (
          homeSharedAddresses &&
          op.opcode === 'load' &&
          consumers.length > 1 &&
          axisHomedBases.has(op.operands[0]) &&
          !multiBlockHeaders.has(b)
        ) {
          materialize.add(op);
          continue;
        }
        // A MULTI-RENDER load re-reads memory at each render — which is exactly what the original
        // per-use source spelling did (`while (*s != EOS) *d = *s;` reads *s twice per iteration),
        // so it is sound iff every render still sees the def-time memory: NO write anywhere
        // between the def and ANY render (cycle-aware, conservative write set). Otherwise a temp.
        //
        // WHERE it renders. Without the axis: one position per consumer, and a consumer with no
        // single position (its own value renders in several places) refuses. With the axis a load
        // resolves the whole SET instead — the second half of the value-home defect, where the
        // local is invented not by a barrier but because the pure expression downstream is itself
        // duplicated (`gOut = (gValue << 1) + gValue; return (gValue << 1) + gValue;`). Never for a
        // call: several positions there mean several executions.
        const poss =
          rereadGlobals && !isCall
            ? emitPositions(op)
            : consumers.length > 1
              ? consumers.map((c) => emitPos(c))
              : [emitPos(consumers[0])];
        if (!poss || poss.some((p) => p === null)) {
          materialize.add(op);
          continue;
        }
        if (poss.length > 1) {
          const isWrite = barsThisRead ?? ((x: Op) => EFFECTFUL_OPS.has(x.opcode));
          if (poss.some((p) => memWriteBetween(op, p!, isWrite))) {
            materialize.add(op);
          }
          continue;
        }
        const pos = poss[0]!;
        // A between-op is a BARRIER when it renders as a sequenced statement the def would cross:
        // stores/opaque always; a call/load that is dead (statement), materialized (statement), or
        // inlined into a DIFFERENT statement. A sibling effect inlined into the SAME statement is
        // not a reorder — the recompiling compiler orders unsequenced operands of one expression
        // exactly as it originally chose to. Loads never bar a load (reads don't conflict).
        const samePos = (q: { blk: Block; idx: number } | null) => q !== null && q.blk === pos.blk && q.idx === pos.idx;
        const isBarrier = (x: Op): boolean => {
          // Value-home axis: a store/astore this read is PROVABLY disjoint from (a different named
          // global) does not sequence against it, so the read may still render at its use.
          if (barsThisRead && (x.opcode === 'store' || x.opcode === 'astore') && !barsThisRead(x)) {
            return false;
          }
          if (x.opcode === 'store') {
            // A store to a PROVABLY-DISJOINT slot of the same base never aliases the load: same
            // base SSA value, both constant offset+width, ranges non-overlapping (the everyday
            // struct interleave `… = p->field_0; p->field_4 = …`). Anything less certain bars.
            if (!isCall && op.opcode === 'load' && x.operands[0] === op.operands[0]) {
              const lo = op.attrs.off as number,
                lw = op.attrs.width as number;
              const so = x.attrs.off as number,
                sw = x.attrs.width as number;
              if (so + sw <= lo || lo + lw <= so) {
                return false;
              }
            }
            return true;
          }
          if (x.opcode === 'astore' || x.opcode === 'opaque') {
            return true;
          }
          if (x.opcode === 'call') {
            return !x.results.length || !useSitesOf.has(x.results[0]) || materialize.has(x) || !samePos(emitPos(x));
          }
          if (!isCall) {
            return false;
          } // a load never bars a load
          if (x.opcode === 'load' || x.opcode === 'aload') {
            return !x.results.length || !useSitesOf.has(x.results[0])
              ? false // dead load: never emitted at all
              : materialize.has(x) || !samePos(emitPos(x));
          }
          return false;
        };
        // A CROSS-BLOCK call's execution would become path-dependent — always materialize. Within
        // its own block a call is judged like everything else, by the barrier scan below.
        if (isCall && pos.blk !== b) {
          materialize.add(op);
          continue;
        }
        // Otherwise: inline only if no barrier stands on any def-avoiding def→render path.
        if (memWriteBetween(op, pos, isBarrier)) {
          materialize.add(op);
        }
      }
    }
  }
  return { useSitesOf, opIndex, opBlock, liveIn, materialize, reachFrom, emitPos, memWriteBetween };
}
