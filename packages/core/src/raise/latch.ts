// asmlift — empty-latch folding (F-CFG-class structural pass; successor-aware, ISA-neutral).
//
// A loop whose back-edge carries a register copy — `add r3, r0, #0` then `b .L6` — lifts to a block
// holding nothing but that branch, because SSA construction turns the copy into an EDGE ARGUMENT.
// The loop is unchanged; its latch has just become a separate empty block sitting between the exit
// test and the header. Loop recovery reads the pair as a shape it will not structure, and the whole
// function declines with "unrecovered back-edge" (sa3:EwramMalloc, sa3:IwramActiveNodeTotalSize and
// kleod:Task_Interactable116 among them). Splicing the block out — every predecessor edge re-pointed
// at the header, carrying the latch's own edge arguments — restores the single-latch loop.
//
// The arguments move soundly because the block has no params and one op: a value the latch's `br`
// passes dominates the latch, so it dominates the end of every predecessor of the latch too.
import { Fn, dominators } from '../ir/core';

/** Splice out every EMPTY LATCH — a block with no params whose single op is an unconditional `br`
 *  to a block that DOMINATES it. Returns how many were removed.
 *
 *  Dominance is the whole gate, and what it buys is the distinction between a latch and a loop
 *  PREHEADER. A preheader is the same empty forwarding block, but it dominates the header rather
 *  than the reverse; folding one hands the structurer a guard branching straight at the header —
 *  the guard-FUSED shape, a different structuring decision carrying its own soundness proof, which
 *  then declines. `sa3:sub_801ECAC` and `kleod:LoadLevel_World7_Vision2` both structure today and
 *  stop if the dominance test is weakened to plain reachability.
 *
 *  A block branching to ITSELF is excluded separately: every block dominates itself, so the test
 *  above admits it, and it is an infinite loop rather than a trampoline.
 *
 *  Iterated: folding one latch can leave its predecessor an empty latch in turn, and removing blocks
 *  only ever ADDS dominators, so a later round can admit an edge this one refused.
 *
 *  A predecessor that already branches to the target ends up with two edges into one block. That is
 *  a block whose every edge continues the loop, so it has no exit and loop recovery declines — the
 *  same loud decline it gave before the fold, pinned by a test rather than pre-empted by a guard.
 */
export function foldEmptyLatches(fn: Fn): number {
  let folded = 0;
  for (;;) {
    const dom = dominators(fn);
    const latch = fn.blocks.find((b) => {
      // `br` is a terminator, so a block whose FIRST op is one holds nothing but that branch.
      if (b.params.length > 0 || b.ops[0]?.opcode !== 'br') {
        return false;
      }
      const target = b.ops[0].successors[0].block;
      return target !== b && dom.get(b)!.has(target);
    });
    if (!latch) {
      return folded;
    }
    const onward = latch.ops[0].successors[0];
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        op.successors.forEach((s, i) => {
          if (s.block === latch) {
            op.successors[i] = { block: onward.block, args: [...onward.args] };
          }
        });
      }
    }
    fn.blocks = fn.blocks.filter((b) => b !== latch);
    folded++;
  }
}
