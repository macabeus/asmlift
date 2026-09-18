// Which `return;` statements the SOURCE wrote, read off the assembly.
//
// A void `return;` is a control transfer to the epilogue, and a compiler spells one as an
// unconditional `b <epilogue>`. So where the epilogue is a block of its OWN — nothing in it but the
// `ret` — its in-edges are the ways the body ends, and only one kind of arrival is a statement:
//
//   - an unconditional branch instruction into it → a `return;` the source wrote.
//   - FALLING into it                            → the body simply running out, which spells
//                                                  nothing.
//   - a conditional branch's own edge            → nothing either. Unoptimised code tests into a
//                                                  BODY label and never into the epilogue, so a
//                                                  `bxx` landing there is jump-optimisation having
//                                                  rerouted a branch the source did not write — and
//                                                  by then both spellings are one object anyway.
//
// The statement being decided is the one at the END of the body, so a fall-through in-edge SETTLES
// it: that edge is the body running out, and it wrote no `return;`. A branch in-edge alongside it
// is a `return;`, just not this one — it ends an arm, and `l3/tailret.ts` may delete a return only
// in TAIL position, so an arm the function continues past keeps its own. An arm that IS in tail
// position is one the compiler must branch over regardless (the block laid out before the epilogue
// is the one that falls in, and only one block can be), so its `return;` and its `}` compile to the
// same instruction. That is what makes the answer safe per BLOCK.
//
// With no fall-through in-edge, a branch in-edge is the only evidence there is, and it says the
// source wrote a `return;` — keep it. With neither, nothing reached the epilogue by a written
// transfer at all and there is nothing to spell.
//
// A `ret` SUNK onto one edge (`raise/retsink.ts`, `raise/tailsink.ts`) carries that edge's own
// fall-through fact and answers for itself, which beats anything its block's in-edges could say:
// those are about reaching the statements above the return, not about reaching the epilogue. An
// epilogue block that ALSO holds statements and did not come from sinking is not asked at all, for
// the same reason.
//
// NOT DECIDED HERE: a `while` whose only exit branches straight to the epilogue. That `b` is the
// loop's `}`, and the same instruction to the same address is what a trailing `return;` compiles to
// — the two objects differ only by an empty forwarder block between them, which is a fact about
// branch chains rather than about return spelling. It is kept, which is the side that can never
// delete a return the object needs.
//
// This decides SPELLING only; `l3/tailret.ts` owns whether a marked return is safe to delete.
import type { Block, Fn } from '../ir/core';
import { predecessors } from '../ir/core';

/** The arrival an in-edge stands for: a `return;` the source wrote, or the body running out. */
const isWrittenBranch = (p: Block): boolean => {
  const term = p.ops[p.ops.length - 1];
  return term.opcode === 'br' && term.attrs.fallthrough !== true;
};
const isFallThrough = (p: Block): boolean => {
  const term = p.ops[p.ops.length - 1];
  return term.opcode === 'br' && term.attrs.fallthrough === true;
};
/** A branch out of an EMPTY block is an arm with nothing else in it: the `return;` it stands for is
 *  the only statement that arm would hold, so it has nowhere else to live and is never dropped. */
const isBareBranch = (p: Block): boolean => p.ops.length === 1 && isWrittenBranch(p);

/** The blocks whose `ret` the assembly shows no `return;` for. */
export function unspelledEpilogues(fn: Fn): Set<Block> {
  const preds = predecessors(fn);
  const out = new Set<Block>();
  for (const b of fn.blocks) {
    const term = b.ops[b.ops.length - 1];
    if (term?.opcode !== 'ret') {
      continue;
    }
    const inEdges = preds.get(b) ?? [];
    const fellIn = inEdges.some(isFallThrough) && !inEdges.some(isBareBranch);
    if (term.attrs.fallthrough === true || (b.ops.length === 1 && (fellIn || !inEdges.some(isWrittenBranch)))) {
      out.add(b);
    }
  }
  return out;
}
