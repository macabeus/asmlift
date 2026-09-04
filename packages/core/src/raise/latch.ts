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
//
// WHY DOMINANCE, AND NOT "the target can reach this block". The two disagree on a loop PREHEADER —
// the same empty forwarding block seen from the other side, which dominates its header instead of
// the reverse. Reachability alone cannot refuse one, because an INNER loop's preheader sitting
// inside an OUTER loop is reachable from the inner header round the outer back-edge. Folding a
// preheader hands the structurer a guard branching straight at the header — the guarded-self-loop
// shape, where the structurer either fuses under its guard proof or keeps the guard as its own
// `if` (declining loud on the hazards). The guard therefore survives the fold either way; what the
// gate preserves is the SHAPE — a forward trampoline is not a latch, and folding one re-casts an
// unrelated branch as a loop guard — which is the `target-dominates` entry's own note below.
import { Fn, dominators, foldWriteOrder } from '../ir/core';
import { type Gate, firstRejection } from '../l3/gates';

/** What the gates below judge: one candidate block and the block its `br` goes to. */
interface LatchCandidate {
  block: Fn['blocks'][number];
  target: Fn['blocks'][number];
  dominatesBlock: boolean;
}

export const LATCH_GATES: readonly Gate<LatchCandidate>[] = [
  {
    id: 'latch-has-params',
    why: "a param means the block JOINS edges, so its br args are not this one edge's copy",
    sound: false,
    rejects: (c) => c.block.params.length > 0,
  },
  {
    id: 'latch-does-work',
    why: "the block's ops go with the block, and a result-less store leaves no trace behind",
    sound: true,
    guardedBy: 'a latch holding a STORE is refused — nothing downstream would notice it vanish',
    // `br` is a terminator, so a block whose FIRST op is one holds nothing but that branch.
    rejects: (c) => c.block.ops[0]?.opcode !== 'br',
  },
  {
    id: 'self-branch',
    why: 'every block dominates itself, so this is an infinite loop rather than a trampoline',
    sound: false,
    rejects: (c) => c.target === c.block,
  },
  {
    id: 'target-dominates',
    why: "a preheader is the same empty block from the other side; folding it re-shapes another block's branch into a loop guard",
    // Formerly `sound`: the fold once handed the guard's cond_br to a fusion that DROPPED an
    // unproven guard outright. That burden now lives in the guarded-self-loop emitter — an
    // unproven guard keeps its `if` (or declines loud), and a multi-block loop's guard never had
    // a fusion path to lose it to — so ablating this gate re-shapes the C without making it
    // wrong, which is a heuristic by the Gate contract. The named test pins the second layer.
    sound: false,
    guardedBy: 'ablating the dominance gate hands a guard to the kept-guard loop emitter',
    rejects: (c) => !c.dominatesBlock,
  },
];

/** Splice out every EMPTY LATCH the gates above admit; returns how many were removed.
 *
 *  Iterated, because folding one latch can make its predecessor into one: the predecessor's
 *  SUCCESSOR changes, so an edge that was not a back-edge becomes one. (Dominator sets themselves
 *  only ever shrink — removing a block removes it from every set it was in.)
 *
 *  A predecessor that already branches to the target ends up with two edges into one block. That is
 *  a block whose every edge continues the loop, so it has no exit and loop recovery declines — the
 *  same loud decline it gave before the fold.
 */
export function foldEmptyLatches(fn: Fn, gates: readonly Gate<LatchCandidate>[] = LATCH_GATES): number {
  let folded = 0;
  for (;;) {
    const dom = dominators(fn);
    const latch = fn.blocks.find((b) => {
      const target = b.ops[0]?.successors[0]?.block;
      return (
        target !== undefined &&
        firstRejection(gates, { block: b, target, dominatesBlock: dom.get(b)!.has(target) }) === null
      );
    });
    if (!latch) {
      return folded;
    }
    const onward = latch.ops[0].successors[0];
    for (const b of fn.blocks) {
      let repointed = false;
      for (const op of b.ops) {
        op.successors.forEach((s, i) => {
          if (s.block === latch) {
            op.successors[i] = { block: onward.block, args: [...onward.args] };
            repointed = true;
          }
        });
      }
      // The copies the latch stood for now happen at the end of this predecessor — after its own
      // writes, which the write-order record has to keep saying (ir/core.ts `foldWriteOrder`).
      if (repointed) {
        foldWriteOrder(fn.writeOrder, latch, b);
      }
    }
    fn.blocks = fn.blocks.filter((b) => b !== latch);
    folded++;
  }
}
