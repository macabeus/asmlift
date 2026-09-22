// asmlift — 64-bit runtime-helper lowering (L1 recognition).
//
// The peer of `raise/softdiv.ts`, one width up, and NOT gated on a hardware capability. A soft
// division is a division the ISA has no instruction for, so a target with a divider never emits
// one; no ISA this repo targets has 64-bit integer arithmetic at all, so `bl __muldi3` is software
// on every one of them whatever `hwDivide` says.
//
// By the time this runs the frontend has already read the call's arguments as 64-bit values and
// split its result back into the register pair (`frontend/thumb.ts`, at the `bl`), so the rewrite
// itself is the same one-line splice `softdiv` does: the helper's op over the same operands,
// reusing the SAME result value so every existing use already points at it.
//
// The signedness of the OPERATION comes from the helper name where the name splits it
// (`__divdi3`/`__udivdi3`) and from the operands where it does not — agbcc's `__muldi3` serves
// both spellings, so nothing here may read a signedness off it. See the table's own note.
import { Fn, mkOp } from '../ir/core';
import { isWideHelper } from '../runtime-helpers';
import type { TargetDescription } from '../target';

/** Rewrite each recognised 64-bit helper call to the op it computes, in place. Returns whether
 *  anything changed. Runs BEFORE type recovery, so the operands get their signedness there. */
export function recognizeWideHelpers(fn: Fn, target: TargetDescription): boolean {
  const table = target.runtimeHelpers ?? {};
  let changed = false;
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      if (op.opcode !== 'call') {
        continue;
      }
      const helper = table[op.attrs.target as string];
      if (!helper?.op || !isWideHelper(helper)) {
        continue;
      }
      // Its C PARAMETERS, not its argument registers: the frontend has paired the registers up, so
      // a `__ashrdi3` that occupied three of them arrives here with two operands. A call whose
      // arity did not come out as the table says is left alone rather than folded into an op with
      // the wrong number of operands.
      if (op.operands.length !== helper.params.length || op.results.length !== 1) {
        continue;
      }
      b.ops.splice(i, 1, mkOp(helper.op, { operands: [...op.operands], results: [op.results[0]] }));
      changed = true;
    }
  }
  return changed;
}
