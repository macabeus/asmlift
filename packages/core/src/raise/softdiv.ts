// asmlift — soft-division helper-call lowering (L1 recognition; agbcc/ARM-class targets).
//
// A target with no hardware divide lowers `a / b` (and unsigned / `%`) to a call to a compiler
// RUNTIME HELPER: agbcc (ARM EABI) emits `bl __divsi3` with the dividend in r0, divisor in r1.
// asmlift lifts that as an opaque `call{target:"__divsi3"}(a, b)`, which the backend can only spell
// as the uncompilable `__divsi3(a, b)`. This pass:
//   (a) supplies the helper SIGNATURES (RUNTIME_HELPERS) so the two arguments ARE recovered — merged
//       into the frontend's prototype lookup, reusing the existing signature-driven arg recovery; and
//   (b) rewrites the recognised call to the EXISTING division op (`sdiv`/`udiv`/`smod`/`umod` — the
//       same 2-operand form the hardware-divide path emits), so type recovery types the operands'
//       signedness and the structurer lowers it to `a / b` / `a % b`.
// Re-emitting `a / b` recompiles to the same `bl __divsi3` byte-for-byte.
//
// Like array legalization (raise/arrays.ts), this is RECOGNITION the patterns-as-data idiom layer
// cannot state: its match keys on a `call`'s STRING `target` attr, which the numeric `attrEquals`
// cannot express. It is naturally inert on hardware-divide targets (which emit `div`/`divu`,
// never `bl __divsi3`).
import { Fn, mkOp } from '../ir/core';
import type { Opcode } from '../ir/opcodes';
import type { Prototypes } from '../proto';

// runtime helper symbol → { the division op it computes, its argument count }.
//
// THE RESIDUE — the 64-bit helper family. `__muldi3`, `__ashrdi3`/`__ashldi3`/`__lshrdi3`,
// `__divdi3` and PPC's `__shl2i`/`__shr2i` are runtime helpers this table does not hold, and
// neither half of the pass can take them as it stands: each passes its 64-bit arguments as
// REGISTER PAIRS and returns one, so (a) there is no op to rewrite to — no entry in
// `ir/opcodes.ts` has more than one result — and (b) a signature alone would recover a second
// argument register whose value after a `bl` is the callee's HIGH HALF, which the frontend
// resolves to the caller's pre-call value. Recognising the family needs a 64-bit IR value first;
// `docs/int64-representation.md` is the measured case for and against building one, and counts
// the ten corpus rows that reach a helper here.
const SOFT_DIV: Record<string, { op: Opcode; params: number }> = {
  __divsi3: { op: 'sdiv', params: 2 },
  __udivsi3: { op: 'udiv', params: 2 },
  __modsi3: { op: 'smod', params: 2 },
  __umodsi3: { op: 'umod', params: 2 },
};

/** Signatures for the soft-division runtime helpers, so a `bl __divsi3` recovers both arguments.
 *  Consumed by the frontend's arity lookup BEHIND any caller-supplied prototype (headers win). */
export const RUNTIME_HELPERS: Prototypes = Object.fromEntries(
  Object.entries(SOFT_DIV).map(([sym, h]) => [sym, { params: h.params }]),
);

/** Rewrite each recognised soft-division helper call to its division op, in place. Returns whether
 *  anything changed. Runs BEFORE type recovery so the new op's operands get signed/unsigned typing. */
export function recognizeSoftDiv(fn: Fn): boolean {
  let changed = false;
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      if (op.opcode !== 'call') {
        continue;
      }
      const helper = SOFT_DIV[op.attrs.target as string];
      if (!helper) {
        continue;
      }
      // Fold only when BOTH arguments were recovered (the signature makes this the norm). A
      // mis-recovered arity leaves the call untouched rather than fabricating a wrong divide.
      if (op.operands.length !== helper.params || op.results.length !== 1) {
        continue;
      }
      // Reuse the SAME result Value → every existing use already points at it (no RAUW needed).
      const div = mkOp(helper.op, { operands: [...op.operands], results: [op.results[0]] });
      b.ops.splice(i, 1, div);
      changed = true;
    }
  }
  return changed;
}
