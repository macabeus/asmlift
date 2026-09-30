// asmlift — two argument registers that are one 64-bit PARAMETER.
//
// The ABI hands a 64-bit argument over in a register pair, so the frontend reads it as two
// live-ins and builds a `concat` from them. That `concat` is the evidence, and this pass turns it
// into the signature: one parameter of width 64 in place of the two words.
//
// WHY THE EVIDENCE IS THE `concat` AND NOT THE ADJACENCY. Two adjacent argument registers are two
// arguments far more often than they are one, so a pass keyed on position would rewrite the
// signature of most functions in the corpus. A `concat` is built at an ATOMIC site only — an ABI
// pair, or a carry-chained add — so it is a claim the machine made rather than one this pass
// invents, and the pair of registers it names is the pair the machine used.
//
// AND WHY EACH HALF MUST BE USED NOWHERE ELSE. A parameter also read on its own is not half of a
// 64-bit value; it is a word this function uses as a word, which is what a 64-bit argument passed
// to a helper and separately tested would look like. Fusing it would delete a use.
import { Fn, Op, Value } from '../ir/core';

/** Count every operand and edge-argument occurrence of each value. Occurrences, not sites: a value
 *  passed to `f(x, x)` is used twice, and a rule that said "used once" about it would be wrong. */
function useCounts(fn: Fn): Map<Value, number> {
  const n = new Map<Value, number>();
  const bump = (v: Value) => n.set(v, (n.get(v) ?? 0) + 1);
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands.forEach(bump);
      for (const s of op.successors) {
        s.args.forEach(bump);
      }
    }
  }
  return n;
}

/** Whether `op` is the `concat` of two entry parameters that ARRIVED as one 64-bit argument: the two
 *  consecutive argument slots, in slot order, each read by nothing else (`uses` counts occurrences).
 *
 *  SLOT ORDER, because a pair built in any other order is a different value. `s64 f(s64 a, s64 b){
 *  return rot32(a) * b; }` hands `__muldi3` a's words swapped (`add r1,r5; add r0,r4` from r0:r1),
 *  so its `concat(r1, r0)` is not `a`, and a fusion that took it would print `a * b`. Consecutive,
 *  because the frontends mint every slot below the highest one read (`mintArgSlotHoles`), so two
 *  neighbouring parameters are two neighbouring slots — including r3 and the first stack word,
 *  which is where agbcc splits a 64-bit argument. */
export function isArgumentPair(entry: readonly Value[], op: Op, uses: (v: Value) => number): boolean {
  if (op.opcode !== 'concat') {
    return false;
  }
  const [lo, hi] = op.operands;
  const at = entry.indexOf(lo);
  return at >= 0 && entry[at + 1] === hi && uses(lo) === 1 && uses(hi) === 1;
}

/** Fuse each entry-parameter pair that a `concat` names into one 64-bit parameter. Returns whether
 *  anything changed. */
export function fuseParamPairs(fn: Fn): boolean {
  const entry = fn.blocks[0];
  if (entry.params.length < 2) {
    return false;
  }
  const uses = useCounts(fn);
  let changed = false;
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op: Op = b.ops[i];
      if (!isArgumentPair(entry.params, op, (v) => uses.get(v) ?? 0)) {
        continue;
      }
      // The pair takes its first slot's position, which is its position in the ABI order the
      // frontend already sorted these into — so the signature keeps the argument order the
      // machine passed them in.
      const whole = op.results[0];
      entry.params.splice(entry.params.indexOf(op.operands[0]), 2, whole);
      // The `concat`'s RESULT becomes the parameter — the same Value, so every existing use
      // already points at it and nothing has to be rewritten. The op itself goes: a block
      // parameter has no defining op, and leaving one would define the value twice.
      b.ops.splice(i, 1);
      i--;
      changed = true;
    }
  }
  return changed;
}
