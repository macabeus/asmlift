// asmlift — empty-latch folding (F-CFG-class structural pass; successor-aware, ISA-neutral).
//
// A loop whose back-edge carries a register copy — `add r3, r0, #0` then `b .L6` — lifts to a block
// holding nothing but that branch, because SSA construction turns the copy into an EDGE ARGUMENT.
// The loop is unchanged; its latch has just become a separate empty block between the exit test and
// the header. Loop DISCOVERY still finds the loop — `structure/loops.ts` reads the same back-edge —
// but the do-while emitter requires the latch to end in a `cond_br`, an empty one ends in `br`, and
// the test is at the bottom so the `while` form is unavailable too. The back-edge survives to the
// `onStack` refusal and the whole function declines with "unrecovered back-edge".
//
// Splicing the block out — every predecessor edge re-pointed at the header, carrying the latch's
// own edge arguments — restores the single-latch loop, which is a canonicalization the emitter
// already handles rather than a new case inside it.
//
// The arguments move soundly because the block has no params and one op: a value the latch's `br`
// passes dominates the latch, so it dominates the end of every predecessor of the latch too.
import { Fn, dominators } from '../ir/core';

/** Splice out every EMPTY LATCH — a block with no params whose single op is an unconditional `br`
 *  to a block that DOMINATES it. Returns how many were removed.
 *
 *  Dominance, rather than "the target can reach this block", is what distinguishes a latch from a
 *  loop PREHEADER — the same empty forwarding block seen from the other side. A preheader dominates
 *  its header instead of the reverse, and folding one hands the structurer a guard branching
 *  straight at the header, which is the guard-FUSED shape: a different structuring decision with
 *  its own soundness proof, which then declines. Reachability is not enough to see that, because an
 *  inner loop's preheader sitting inside an OUTER loop is reachable from the inner header round the
 *  outer back-edge.
 *
 *  A block branching to ITSELF is excluded separately: every block dominates itself, so the test
 *  above admits it, and it is an infinite loop rather than a trampoline.
 *
 *  Iterated, because folding one latch can make its predecessor into one: the predecessor's
 *  SUCCESSOR changes, so an edge that was not a back-edge becomes one. (Dominator sets themselves
 *  only ever shrink — removing a block removes it from every set it was in.)
 *
 *  A predecessor that already branches to the target ends up with two edges into one block. That is
 *  a block whose every edge continues the loop, so it has no exit and loop recovery declines — the
 *  same loud decline it gave before the fold.
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
