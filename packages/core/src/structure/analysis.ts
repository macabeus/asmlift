// asmlift structurer — the ANALYSIS phase. Pure derivation over the lifted fn — nothing here
// mutates the IR or depends on naming/emission state:
//   • use-site registry — every use of a value, POSITIONED (op + block + index);
//   • per-block SSA value liveness (backward dataflow) — consumed by the coalescing
//     interference check in structure.ts;
//   • the effect-ordering model — which call/load defs must MATERIALIZE as named temps at
//     their own program position instead of inlining at their use.
import { Block, Fn, Op, Value, successorsOf } from '../ir/core';

export interface UseSite {
  blk: Block;
  idx: number;
  op: Op;
}

export interface StructureAnalysis {
  /** every positioned use of a value; a value absent here is dead */
  useSitesOf: Map<Value, UseSite[]>;
  opIndex: Map<Op, number>;
  opBlock: Map<Op, Block>;
  /** SSA values live at each block's entry */
  liveIn: Map<Block, Set<Value>>;
  /** call/load defs that must emit as named temps at their own position */
  materialize: Set<Op>;
  /** cached forward reachability (successors-transitive, excluding the start block itself) */
  reachFrom: (b: Block) => Set<Block>;
}

export function analyze(fn: Fn, returnsVoid: boolean): StructureAnalysis {
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
  const emitPos = (op: Op): { blk: Block; idx: number } | null => {
    if (emitPosCache.has(op)) {
      return emitPosCache.get(op)!;
    }
    const own = { blk: opBlock.get(op)!, idx: opIndex.get(op)! };
    let res: { blk: Block; idx: number } | null;
    if (
      op.successors.length ||
      op.opcode === 'ret' ||
      op.opcode === 'store' ||
      op.opcode === 'astore' ||
      materialize.has(op) ||
      !op.results.length ||
      !useSitesOf.has(op.results[0])
    ) {
      res = own; // statements, terminators, materialized/dead defs
    } else {
      const consumers = [...new Set((useSitesOf.get(op.results[0]) ?? []).map((s) => s.op))];
      res = consumers.length === 1 ? emitPos(consumers[0]) : null;
    }
    emitPosCache.set(op, res);
    return res;
  };
  // Decide in REVERSE program order so a consumer's own materialization is settled before any
  // producer asks for its emit position (SSA: uses follow defs in dominance/layout order) — and
  // iterate to a fixpoint for IR whose block layout does not follow dominance (hand-built IR):
  // materialize only GROWS, and growing it only moves render positions closer / adds barriers,
  // so the loop is monotone and converges.
  for (let sizeBefore = -1; sizeBefore !== materialize.size;) {
    sizeBefore = materialize.size;
    emitPosCache.clear();
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
          // Cheap deref casts still land on the `index` node at the use, preserving byte strides;
          // NON-const pure ops are excluded (an address computation `&g + i` rendered standalone
          // loses the memAccess's inline `(u8 *)` cast — cast-aware base materialization is separate).
          const pr = op.results[0];
          if (op.opcode === 'const' && pr && useSitesOf.has(pr)) {
            const cons = [...new Set((useSitesOf.get(pr) ?? []).map((s) => s.op))];
            if (cons.length > 1 && liveAcrossCall(op, cons)) {
              materialize.add(op);
            }
          }
          continue;
        }
        const r = op.results[0];
        if (!r || !useSitesOf.has(r)) {
          continue;
        } // dead call → exprstmt (unchanged)
        const sites = useSitesOf.get(r)!;
        const consumers = [...new Set(sites.map((s) => s.op))];
        const isCall = op.opcode === 'call';
        // A call must EXECUTE once — any second operand slot duplicates it → named temp.
        if (isCall && sites.length > 1) {
          materialize.add(op);
          continue;
        }
        // A MULTI-RENDER load re-reads memory at each render — which is exactly what the original
        // per-use source spelling did (`while (*s != EOS) *d = *s;` reads *s twice per iteration),
        // so it is sound iff every render still sees the def-time memory: NO write anywhere
        // between the def and ANY render (cycle-aware, conservative write set). Otherwise a temp.
        if (!isCall && consumers.length > 1) {
          const MW = new Set(['store', 'astore', 'call', 'opaque']);
          const wDirty = (list: Op[], from: number, to: number) => {
            for (let k = from; k < to; k++) {
              if (MW.has(list[k].opcode)) {
                return true;
              }
            }
            return false;
          };
          const defToRenderDirty = (q: { blk: Block; idx: number }): boolean => {
            // Same block: the only def-avoiding path is the straight line between the two indices
            // (leaving and re-entering the block re-crosses the def).
            if (q.blk === b && oi < q.idx) {
              return wDirty(b.ops, oi + 1, q.idx);
            }
            if (wDirty(b.ops, oi + 1, b.ops.length) || wDirty(q.blk.ops, 0, q.idx)) {
              return true;
            }
            const between = reachAvoiding(b, b);
            for (const x of between) {
              if (x === q.blk && !reachAvoiding(q.blk, b).has(q.blk)) {
                continue;
              } // acyclic render blk: head checked
              if (x !== q.blk && !reachAvoiding(x, b).has(q.blk)) {
                continue;
              } // not on a def→render path
              if (wDirty(x.ops, 0, x.ops.length)) {
                return true;
              }
            }
            return false;
          };
          const poss = consumers.map((c) => emitPos(c));
          if (poss.some((p) => p === null) || poss.some((p) => defToRenderDirty(p!))) {
            materialize.add(op);
          }
          continue;
        }
        const pos = emitPos(consumers[0]);
        if (!pos) {
          materialize.add(op);
          continue;
        }
        // A between-op is a BARRIER when it renders as a sequenced statement the def would cross:
        // stores/opaque always; a call/load that is dead (statement), materialized (statement), or
        // inlined into a DIFFERENT statement. A sibling effect inlined into the SAME statement is
        // not a reorder — the recompiling compiler orders unsequenced operands of one expression
        // exactly as it originally chose to. Loads never bar a load (reads don't conflict).
        const samePos = (q: { blk: Block; idx: number } | null) => q !== null && q.blk === pos.blk && q.idx === pos.idx;
        const isBarrier = (x: Op): boolean => {
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
        const gapDirty = (list: Op[], from: number, to: number) => {
          for (let k = from; k < to; k++) {
            if (isBarrier(list[k])) {
              return true;
            }
          }
          return false;
        };
        if (pos.blk === b) {
          if (gapDirty(b.ops, oi + 1, pos.idx)) {
            materialize.add(op);
          }
          continue;
        }
        // Cross-block: a call's execution would become path-dependent — always materialize. A
        // load may inline only if NO write exists on any DEF-AVOIDING def→render path (a path
        // re-crossing the def is the next dynamic instance): the def block's tail, the render
        // block's head, and every block between; a render block cyclic WITHOUT passing the def
        // (an inner loop around the render) is checked in full.
        if (isCall) {
          materialize.add(op);
          continue;
        }
        let dirty = gapDirty(b.ops, oi + 1, b.ops.length) || gapDirty(pos.blk.ops, 0, pos.idx);
        if (!dirty) {
          for (const x of reachAvoiding(b, b)) {
            if (x === pos.blk && !reachAvoiding(pos.blk, b).has(pos.blk)) {
              continue;
            } // acyclic render block: head checked
            if (x !== pos.blk && !reachAvoiding(x, b).has(pos.blk)) {
              continue;
            } // not on a def→render path
            if (gapDirty(x.ops, 0, x.ops.length)) {
              dirty = true;
              break;
            }
          }
        }
        if (dirty) {
          materialize.add(op);
        }
      }
    }
  }
  return { useSitesOf, opIndex, opBlock, liveIn, materialize, reachFrom };
}
