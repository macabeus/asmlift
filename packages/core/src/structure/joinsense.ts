// Where the JOINED branch sense is still ambiguous — the gate on `rank.ts`'s `/flip-join` axis.
//
// `structure.ts` spells a two-armed reconverging `if` from the layout: the compiler branched
// forward over the then-arm and fell through into it, so `cond_br`'s TAKEN slot is the else-arm
// and the source's own sense comes back unflipped. That reading is the DEFAULT
// (`negateJoinedBranchSense` follows `preserveDivergentBranchSense`), and it holds wherever the
// source wrote the `if` and the polarity the structurer reads is the polarity the compiler emitted.
// This predicate names the two shapes where one of those is not so, and the axis is enumerated
// only there. Both are mechanical and read straight off the IR — neither is a judgement about the
// function.
//
// A FOLDED CONNECTIVE feeding the branch. `raise/shortcircuit.ts` rewrites two `cond_br` blocks
// sharing a target into one `cond_br` over a `logic_and`/`logic_or`, and WHICH connective it
// builds follows from which of ^h's edges led to ^g — so the fold, not the compiler, decides which
// successor is `taken` (its "WHICH SPELLING" note asks for exactly this gate). Compiler-
// independent: agbcc and mwcc both compile `if (a && b)` in pure layout sense, and both need the
// flip on it.
//
// An EMPTY FALL-THROUGH edge — a fall block holding nothing but its own branch. Two different
// things wear that shape, and the axis is owed under either. It is what a conditional branch that
// could not REACH its target leaves behind (agbcc past Thumb's ±256-byte range emits `b<cond>
// .LCBn` and then `b .Lfar @long jump`), and the frontend lifts that verbatim, so `taken` is the
// THEN arm and the layout reading is upside down. It is also what the preheader of a rotated
// `for` loop decays to once its copies fold away — and there the `if` is the compiler's own
// zero-trip guard, which no source wrote, so there is no source sense for the default to be
// faithful to and the differ is the only referee available.
//
// Everything else prunes, which is what makes this a PRUNING gate rather than an additive one, so
// the claim behind it is stated where it can be checked: the one GCC-family pass that genuinely
// inverts a two-armed joined if (`jump.c`'s `if (foo) bar; else break;`, which needs the else-arm
// to end in an unconditional transfer) is NORMALISING — it produces exactly the layout the
// arms-swapped spelling already produces — and `structure.ts` does not put a transfer inside a
// two-armed joined arm anyway, bar the `clampToLoop` shape, whose two spellings compile alike.
// If a future change makes the structurer emit `return`/`goto`/`break` inside such an arm in a
// shape that does NOT converge, that residue returns and neither clause below sees it.
import { type Fn, defOpMap } from '../ir/core';

/** Does this function hold a `cond_br` whose TAKEN slot may not be the sense the source wrote?
 *  Read per lift variant (the fold runs before the axes, and a narrowed lift folds differently),
 *  and deliberately function-wide: the axis is one boolean over every joined `if`, so one
 *  ambiguous site is enough to owe the enumeration. */
export function hasAmbiguousJoinedSense(fn: Fn): boolean {
  const defs = defOpMap(fn);
  return fn.blocks.some((b) => {
    const term = b.ops[b.ops.length - 1];
    if (term?.opcode !== 'cond_br') {
      return false;
    }
    const cond = defs.get(term.operands[0])?.opcode;
    if (cond === 'logic_and' || cond === 'logic_or') {
      return true;
    }
    // The FALL-THROUGH successor only: the inverted branch is the one that still reaches, so a
    // relay can never sit on the taken edge. Tested for a lone `br` whatever it carries rather
    // than through `forwardingTarget`, because this gate prunes — a relay it fails to see costs a
    // match, one it over-reports costs a duplicate the dedup collapses.
    const fall = term.successors[1].block;
    return fall.ops.length === 1 && fall.ops[0].opcode === 'br';
  });
}
