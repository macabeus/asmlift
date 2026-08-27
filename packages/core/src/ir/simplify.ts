// asmlift — SSA cleanups that belong to the substrate, not to any one pass.
//
// Peer of `pattern/engine.ts`'s `dce`: general, opcode-agnostic, and callable by anything that has
// just changed the CFG.
import { Block, Fn, Successor, Value, replaceAllUsesWith } from './core';

/**
 * Remove block params that are really TRIVIAL PHIS — those whose incoming args, across every
 * predecessor edge and ignoring a self-reference from a back edge, are all one value. Such a param
 * carries no join information, so it is replaced by that value and the arg dropped from each
 * predecessor's terminator. Returns how many were removed.
 *
 * Iterated to a fixpoint: removing one phi can make the next trivial.
 *
 * DOMINANCE is free. If every predecessor passes `v`, then `v` is defined before each of those
 * terminators and every path into the block goes through one of them — so `v` dominates the block
 * and every use the param had. The self-reference waiver preserves that: a class where every edge
 * passes the param itself has no first dynamic entry, so the first real entry always arrives on a
 * `v`-passing edge.
 *
 * THE ENTRY BLOCK IS NEVER TOUCHED. Its params are the function's own parameters. Braun's
 * construction in `frontend/ssa.ts` used to rely on entry having no in-edges to get this for free —
 * which stops being true for an entry block that is ALSO a loop header, a shape this codebase does
 * have (`raise/shortcircuit.ts` and `raise/retsink.ts` both guard it explicitly, the former after a
 * reproduced silent miscompile). The guard is stated rather than inherited from an accident.
 *
 * `onRemoved` lets a caller drop its own bookkeeping for the retired param (the frontend's phi-block
 * map); it is called once per removal, before the param is spliced out.
 */
export function simplifyTrivialPhis(fn: Fn, onRemoved?: (param: Value) => void): number {
  const edgesTo = (b: Block): Successor[] => {
    const out: Successor[] = [];
    for (const pb of fn.blocks) {
      for (const op of pb.ops) {
        for (const s of op.successors) {
          if (s.block === b) {
            out.push(s);
          }
        }
      }
    }
    return out;
  };
  let removed = 0;
  for (;;) {
    let changed = false;
    for (const b of fn.blocks) {
      if (b === fn.blocks[0]) {
        continue;
      }
      const incoming = edgesTo(b);
      for (let i = b.params.length - 1; i >= 0; i--) {
        const param = b.params[i];
        const distinct = [...new Set(incoming.map((s) => s.args[i]).filter((v) => v !== param))];
        if (distinct.length !== 1) {
          continue; // a genuine join, or unreachable (no in-edges at all)
        }
        replaceAllUsesWith(fn, param, distinct[0]);
        onRemoved?.(param);
        b.params.splice(i, 1);
        for (const s of incoming) {
          s.args.splice(i, 1);
        }
        removed++;
        changed = true;
      }
    }
    if (!changed) {
      return removed;
    }
  }
}

/**
 * Remove block params NOTHING READS. Their edge args are dropped with them, so a dead join value
 * never surfaces downstream: left in place, the structurer dutifully materializes copies for it
 * on every in-edge (`a3 = v0` after a loop whose counter nobody consumes), and gates keyed on
 * "does this exit carry anything" see cargo that is not there.
 *
 * A read is an OP OPERAND. An edge arg is not one in itself — it forwards a value into a slot, and
 * that is a read exactly when the slot is live — so liveness is a LEAST FIXPOINT seeded by the op
 * operands and grown backwards along the edges. Asking instead "does any arg mention it" is what a
 * per-round reader scan does, and it keeps a mutually-dead CYCLE alive forever: two params feeding
 * only each other across blocks each count as the other's reader. Such a cycle is what the
 * frontend's on-demand construction mints around a loop for a register left holding a stale value,
 * and it is not inert — `raise/struct-arrays.ts` refuses an element pointer that reaches a block
 * arg, so a dead ring around one costs the struct view of an array it has a single real use of.
 *
 * Still conservative in one direction: a param a real op operand reads survives, however dead that
 * op later proves. Liveness is over the IR as it stands, and op-level DCE belongs to
 * `pattern/engine.ts`.
 *
 * THAT MAKES TWO LIVENESS MODELS OVER ONE GRAPH, and they now DISAGREE about the same edge.
 * `pattern/engine.ts`'s `dce` still counts every successor arg as a use unconditionally — the rule
 * abandoned here — and it runs after every changing pre-recovery pass where this runs once, inside
 * the frontend's `finish()`. The disagreement is one-sided and safe: `dce` is the COARSER of the
 * two, so it only ever keeps an op this would have let go, never the reverse. Reach today is ZERO
 * and that is measured rather than argued — re-running this fixpoint over the 458 klonoa functions
 * that clear the frontend, at three checkpoints (straight after the lift, after the idiom fold and
 * after type recovery), removes 0 further params at every one. Booked here so a future round that
 * finds a nonzero reads it as the known divergence rather than a new discovery.
 *
 * THE ENTRY BLOCK IS NEVER TOUCHED — its params are the function's signature, and an argument the
 * body ignores is still an argument (frontend/ssa.ts `ensureParam` creates exactly those on
 * purpose). They are therefore seeded LIVE rather than merely skipped: an entry block that is also
 * a loop header has in-edges, and a slot that is kept has to keep whatever feeds it defined. A
 * function with no blocks has no entry and no params, and is a no-op rather than a throw — this
 * runs mid-construction, ahead of the verifier that rejects such a graph.
 * Returns how many were removed.
 */
export function pruneDeadParams(fn: Fn, onRemoved?: (param: Value) => void): number {
  // Liveness travels BACKWARD — from a live slot to the args feeding it — so it is driven off a
  // WORKLIST over an inverted edge index, not by re-sweeping the graph until a round adds nothing.
  // Round-robin over `fn.blocks` in forward order advances one hop per round along a chain of
  // block params, which is quadratic in the chain length. The worklist is linear in
  // (values + edge args) whatever the block order, and it matters because this is shared L1
  // substrate that runs once per lift on every ISA. Nothing in the corpus reaches the shape today
  // — the largest klonoa function that lifts at all is 107 blocks — but that ceiling is a property
  // of what this frontend currently accepts (274 of the checkout's 732 `.s` decline), not of the
  // game's code, so `test/dead-params.test.ts` budgets both halves against `parse` of the same
  // text.
  //
  // `edgesTo` is the same index the removal pass needs, so it is built ONCE for both: without it
  // each removed param re-walks every op in the function.
  const edgesTo = new Map<Block, Successor[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        const list = edgesTo.get(s.block);
        if (list === undefined) {
          edgesTo.set(s.block, [s]);
        } else {
          list.push(s);
        }
      }
    }
  }
  // Which args feed a given slot. Keyed by the PARAM value (identity is the graph's own), so a
  // slot that becomes live hands back exactly the values that flow into it.
  const feeders = new Map<Value, Value[]>();
  for (const b of fn.blocks) {
    b.params.forEach((slot, i) => {
      const args = (edgesTo.get(b) ?? []).map((s) => s.args[i]).filter((a): a is Value => a !== undefined);
      if (args.length > 0) {
        feeders.set(slot, (feeders.get(slot) ?? []).concat(args));
      }
    });
  }

  const live = new Set<Value>();
  const work: Value[] = [];
  const mark = (v: Value): void => {
    if (!live.has(v)) {
      live.add(v);
      work.push(v);
    }
  };
  for (const p of fn.blocks[0]?.params ?? []) {
    mark(p);
  }
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const v of op.operands) {
        mark(v);
      }
    }
  }
  for (let v = work.pop(); v !== undefined; v = work.pop()) {
    for (const a of feeders.get(v) ?? []) {
      mark(a);
    }
  }

  // One removal pass suffices: `live` is the fixpoint over the whole graph, so dropping the slots
  // outside it cannot make a surviving slot dead, and the args it drops were feeding dead slots.
  let removed = 0;
  for (const b of fn.blocks) {
    if (b === fn.blocks[0]) {
      continue;
    }
    const incoming = edgesTo.get(b) ?? [];
    for (let i = b.params.length - 1; i >= 0; i--) {
      const param = b.params[i];
      if (live.has(param)) {
        continue;
      }
      onRemoved?.(param);
      b.params.splice(i, 1);
      for (const s of incoming) {
        s.args.splice(i, 1);
      }
      removed++;
    }
  }
  return removed;
}
