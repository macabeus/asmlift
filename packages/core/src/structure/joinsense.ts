// Where the JOINED branch sense is still ambiguous — the gate on `rank.ts`'s `/flip-join` axis.
//
// `structure.ts` spells a two-armed reconverging `if` from the layout: the compiler branched
// forward over the then-arm and fell through into it, so `cond_br`'s TAKEN slot is the else-arm and
// the source's own sense comes back unflipped. That reading is the default
// (`negateJoinedBranchSense` follows `preserveDivergentBranchSense`), and it holds wherever the
// source wrote the `if` and the polarity the structurer reads is the polarity the compiler emitted.
// Two shapes break one of those, and the axis is enumerated only there.
//
// A FOLDED CONNECTIVE feeding the branch. `raise/shortcircuit.ts` rewrites two `cond_br` blocks
// sharing a target into one `cond_br` over a `logic_and`/`logic_or`, and which connective it builds
// follows from which of ^h's edges led to ^g — so the FOLD decides which successor is `taken` (its
// "WHICH SPELLING" note asks for exactly this gate). Not a compiler fact: `synthetic:ifor_near` is
// one source that needs the flip on both agbcc/Thumb and mwcc/PowerPC.
//
// An EMPTY FALL-THROUGH edge — a fall block holding nothing but its own branch. Two unrelated
// things wear that shape and the axis is owed under both. It is what a conditional branch that
// could not REACH its target leaves behind (agbcc past Thumb's ±256-byte range emits `b<cond>
// .LCBn` then `b .Lfar @long jump`), which the frontend lifts verbatim, so `taken` becomes the THEN
// arm and the layout reading is upside down. It is also what a rotated `for` loop's preheader
// decays to once its copies fold away — and there the `if` is the compiler's own zero-trip guard,
// which no source wrote, so no source sense exists for the default to be faithful to.
//
// Everything else PRUNES, so the claim behind the pruning is stated where it can be checked: the
// one GCC-family pass that genuinely inverts a two-armed joined if (`jump.c`'s
// `if (foo) bar; else break;`, which needs the else-arm to end in an unconditional transfer) is
// NORMALISING — it produces the layout the arms-swapped spelling already produces — and
// `structure.ts` does not put a transfer inside a two-armed joined arm anyway, bar the
// `clampToLoop` shape, whose two spellings compile alike. A change that makes the structurer emit
// `return`/`goto`/`break` inside such an arm in a shape that does NOT converge brings that residue
// back, and neither clause below would see it.
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
    // relay can never sit on the taken edge. A lone `br` whatever it carries, not
    // `forwardingTarget` — this gate prunes, and a relay it fails to see costs a match where one
    // it over-reports costs a duplicate the dedup collapses.
    const fall = term.successors[1].block;
    return fall.ops.length === 1 && fall.ops[0].opcode === 'br';
  });
}
