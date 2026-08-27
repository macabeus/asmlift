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
 * THE ENTRY BLOCK IS NEVER TOUCHED — its params are the function's signature, and an argument the
 * body ignores is still an argument (frontend/ssa.ts `ensureParam` creates exactly those on
 * purpose). They are therefore seeded LIVE rather than merely skipped: an entry block that is also
 * a loop header has in-edges, and a slot that is kept has to keep whatever feeds it defined. A
 * function with no blocks has no entry and no params, and is a no-op rather than a throw — this
 * runs mid-construction, ahead of the verifier that rejects such a graph.
 * Returns how many were removed.
 */
export function pruneDeadParams(fn: Fn, onRemoved?: (param: Value) => void): number {
  const live = new Set<Value>(fn.blocks[0]?.params ?? []);
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const v of op.operands) {
        live.add(v);
      }
    }
  }
  let growing = true;
  while (growing) {
    growing = false;
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        for (const s of op.successors) {
          s.args.forEach((a, i) => {
            const slot = s.block.params[i];
            if (slot !== undefined && live.has(slot) && !live.has(a)) {
              live.add(a);
              growing = true;
            }
          });
        }
      }
    }
  }

  // One removal pass suffices: `live` is the fixpoint over the whole graph, so dropping the slots
  // outside it cannot make a surviving slot dead, and the args it drops were feeding dead slots.
  let removed = 0;
  for (const b of fn.blocks) {
    if (b === fn.blocks[0]) {
      continue;
    }
    for (let i = b.params.length - 1; i >= 0; i--) {
      const param = b.params[i];
      if (live.has(param)) {
        continue;
      }
      onRemoved?.(param);
      b.params.splice(i, 1);
      for (const pb of fn.blocks) {
        for (const op of pb.ops) {
          for (const s of op.successors) {
            if (s.block === b) {
              s.args.splice(i, 1);
            }
          }
        }
      }
      removed++;
    }
  }
  return removed;
}
