// asmlift — empty-latch folding (F-CFG-class structural pass; successor-aware, ISA-neutral).
//
// A loop whose back-edge carries a register copy — `add r3, r0, #0` then `b .L6` — lifts to a block
// holding nothing but that branch, because SSA construction turns the copy into an EDGE ARGUMENT.
// The loop is unchanged; its latch has just become a separate empty block between the exit test and
// the header. Loop DISCOVERY still finds the loop — `ir/loops.ts` reads the same back-edge —
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
import { Block, Fn, dominators, foldWriteOrder, predecessors, reachForward, successorsOf } from '../ir/core';
import { effectful } from '../ir/discipline';
import { analyzeLoops } from '../ir/loops';
import { type Gate, firstRejection } from '../l3/gates';

/** What the gates below judge: one candidate block and the block its `br` goes to. */
export interface LatchCandidate {
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
    // WHAT THIS RULE ACTUALLY DECIDES, which is narrower than its id suggests. A block carrying real
    // work never reaches the table at all: `foldEmptyLatches`' pre-check reads `ops[0].successors[0]`,
    // so a first op that is a `store` (or any non-terminator) has no target and is refused there.
    // What is left for this rule is the block whose sole op IS a terminator but not a `br` — a
    // `cond_br`, whose SECOND successor the fold would discard along with the block.
    id: 'latch-does-work',
    why: 'the sole terminator must be an unconditional `br`: folding a `cond_br` block discards its second successor',
    sound: true,
    guardedBy: 'latch.test.ts: a latch whose sole op is a cond_br is refused — folding it would drop its second arm',
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
    // NOT `sound`, and the burden it used to carry now lives elsewhere: the guarded-self-loop
    // emitter refuses to fuse an unproven guard — it keeps its `if`, or declines loud — and a
    // multi-block loop's guard has no fusion path to lose it to at all. So ablating this gate
    // re-shapes the C without making it wrong, which is a heuristic by the Gate contract. The named
    // test pins that second layer.
    sound: false,
    guardedBy: 'latch.test.ts: ablating the dominance gate hands a guard to the kept-guard loop emitter',
    rejects: (c) => !c.dominatesBlock,
  },
];

/** Splice out every EMPTY LATCH the gates above admit; returns how many were removed.
 *
 *  Iterated, because folding one latch can make its predecessor into one: the predecessor's
 *  SUCCESSOR changes, so an edge that was not a back-edge becomes one. (Dominator sets themselves
 *  only ever shrink — removing a block removes it from every set it was in.)
 *
 *  A predecessor that already branches to the target ends up with two edges into one block, each
 *  carrying its own arguments. Where that predecessor has no other edge the loop has no exit, and
 *  loop recovery spells it `while (1)` with each edge's own update copy.
 */
export function foldEmptyLatches(fn: Fn, gates: readonly Gate<LatchCandidate>[] = LATCH_GATES): number {
  let folded = 0;
  for (;;) {
    const dom = dominators(fn);
    const latch = fn.blocks.find((b) => {
      // THE PRE-CHECK IS WHAT REFUSES A WORK-CARRYING BLOCK. A block whose first op computes
      // something — a `store`, an arithmetic op — is not a terminator and so has no successors, and
      // a candidate with no target is not judged at all. The gates below therefore only ever see a
      // block whose FIRST op is a terminator; `latch-does-work` is the one that then insists it be
      // an unconditional `br`.
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

// ── EMPTY EXIT TRAMPOLINES ──────────────────────────────────────────────────────────────────────
//
// The same empty block on a loop's way OUT. `for (…) { if (t[i] == k) { r = i; break; } }` keeps
// `r` in a register the break copies into (`add r2, r1, #0`), and the copy becomes an edge argument
// of a block that holds nothing but its `br` to the code after the loop — beside a second exit edge
// (the loop's own test failing) that reaches that code directly. The loop then has two exit targets
// and none of them is a `return`, so every loop form refuses it, and the back-edge declines loud at
// `onStack`. Which exit edge carries the block is the compiler's choice: agbcc puts it on the break
// (`synthetic:break_value`) or on the latch's own exit with the break going direct (kleod
// `sub_0801E664`).
//
// The second exit need not land on the target itself. ido, gcc2.7.2kmc and mwcc lay an `else` the
// loop sits beside between the loop and its join — `if (f) { for (..) if (a(i) == k) { id = i + 100;
// break; } } else id = f + 26; out(id);` (`synthetic:break_elsetail`) — so the loop's own exit is an
// empty `b`/`j` over the `else`, and the break reaches the join only through the code its arm runs.
// That loop has two exit targets because of the block just the same, so the scope gate asks whether
// another exit edge's target REACHES the target, going forward and outside the loop's body.
//
// Splicing it out re-points each edge into it at its target with its own arguments, and the loop
// exits to one block: a `break` that carries its copies, which the structurer already spells. The
// arguments move soundly for the reason the latch's do: the block has no params and one op, so
// every value its `br` passes dominates it, and therefore the end of each of its predecessors.

/** One candidate trampoline: the block, where its `br` goes, and the loops it may leave. */
export interface ExitTrampoline {
  block: Block;
  target: Block;
  /** the predecessors of `block` */
  preds: readonly Block[];
  /** does some loop hold every predecessor of `block` but not `block` itself, and leave by another
   *  edge for `target` as well — landing on it, or on a block that reaches it forward without
   *  re-entering the loop (`reachForward`)? */
  sharedExit: boolean;
  /** does every path from `target` reach a `ret` without an effect on the way? */
  pureReturn: boolean;
}

export const EXIT_TRAMPOLINE_GATES: readonly Gate<ExitTrampoline>[] = [
  {
    id: 'trampoline-has-params',
    why: 'a param is a join: the br args may read it, and they would not exist at a predecessor',
    // the fold then hands a predecessor a value it does not dominate, which `verify` refuses loud
    sound: false,
    rejects: (c) => c.block.params.length > 0,
  },
  {
    id: 'trampoline-does-work',
    why: 'the sole terminator must be an unconditional `br`: folding a `cond_br` block discards its second successor',
    sound: true,
    guardedBy: 'latch.test.ts: an exit block whose sole op is a cond_br is never folded',
    rejects: (c) => c.block.ops[0]?.opcode !== 'br',
  },
  {
    id: 'trampoline-self-branch',
    why: 'a block branching to itself is an infinite loop rather than a trampoline',
    sound: false,
    rejects: (c) => c.target === c.block,
  },
  {
    // The SCOPE of the fold, not its soundness: an exit edge's empty block is harmless to the
    // structurer wherever it is the loop's one way out, and folding it there would only re-spell
    // functions that already lift.
    id: 'trampoline-not-a-second-exit',
    why: 'only a loop that also leaves for the same target by another edge, or for a block that runs on into it, has two exit targets because of it',
    sound: false,
    rejects: (c) => !c.sharedExit,
  },
  {
    // A target that only returns already lifts: the structurer takes the edge through the
    // trampoline as an early `return` and copies the pure tail into it. Kept that way, so the fold
    // re-spells no function that lifted before it.
    id: 'trampoline-returns-already',
    why: 'an exit that only returns is an early `return` arm, which the structurer spells without the fold',
    sound: false,
    rejects: (c) => c.pureReturn,
  },
];

/** Every path from `b` ends in a `ret` and runs no effect on the way. */
export function returnsPurely(b: Block): boolean {
  const seen = new Set<Block>();
  for (const stack = [b]; stack.length > 0;) {
    const x = stack.pop()!;
    if (seen.has(x)) {
      continue; // a join two paths share, or a cycle — either way judged on its first visit
    }
    seen.add(x);
    if (x.ops.some(effectful)) {
      return false;
    }
    const t = x.ops[x.ops.length - 1];
    if (t?.opcode === 'ret') {
      continue;
    }
    if (t?.opcode !== 'br' && t?.opcode !== 'cond_br') {
      return false;
    }
    stack.push(...successorsOf(x));
  }
  return true;
}

/** Splice out every empty EXIT TRAMPOLINE the gates above admit; returns how many were removed.
 *  Iterated, as the latch fold is: one splice can make another block's exit edges shared. */
export function foldExitTrampolines(fn: Fn, gates: readonly Gate<ExitTrampoline>[] = EXIT_TRAMPOLINE_GATES): number {
  let folded = 0;
  for (;;) {
    const preds = predecessors(fn);
    const dom = dominators(fn);
    const loops = [...analyzeLoops(fn, dom).byHeader.values()];
    const found = fn.blocks.find((b) => {
      const target = b.ops[0]?.successors[0]?.block;
      if (target === undefined) {
        return false;
      }
      const into = preds.get(b) ?? [];
      const sharedExit =
        into.length > 0 &&
        loops.some(
          (nl) =>
            !nl.body.has(b) &&
            into.every((p) => nl.body.has(p)) &&
            nl.exitEdges.some((e) => e.to !== b && reachForward(e.to, dom, nl.body).has(target)),
        );
      return (
        firstRejection(gates, { block: b, target, preds: into, sharedExit, pureReturn: returnsPurely(target) }) === null
      );
    });
    if (!found) {
      return folded;
    }
    const onward = found.ops[0].successors[0];
    for (const b of fn.blocks) {
      let repointed = false;
      for (const op of b.ops) {
        op.successors.forEach((s, i) => {
          if (s.block === found) {
            op.successors[i] = { block: onward.block, args: [...onward.args] };
            repointed = true;
          }
        });
      }
      if (repointed) {
        foldWriteOrder(fn.writeOrder, found, b);
      }
    }
    fn.blocks = fn.blocks.filter((b) => b !== found);
    folded++;
  }
}
