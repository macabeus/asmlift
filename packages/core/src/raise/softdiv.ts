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
import { type RuntimeHelper, isWideHelper, wordsOf } from '../runtime-helpers';
import type { TargetDescription } from '../target';

/** The 32-bit software divisions, off the target's own helper table. WHICH helpers a compiler emits
 *  is a compiler fact and lives there (runtime-helpers.ts); which of them THIS pass answers for is
 *  the question here, and it is the narrow one: a division the ISA has no instruction for. A helper
 *  that computes on a value wider than a register is a different question — no hardware capability
 *  can make one unnecessary — and `raise/widehelpers.ts` answers it, ungated. */
const softDivisions = (target: TargetDescription): Record<string, RuntimeHelper> =>
  Object.fromEntries(Object.entries(target.runtimeHelpers ?? {}).filter(([, h]) => h.op && !isWideHelper(h)));

/** Rewrite each recognised soft-division helper call to its division op, in place. Returns whether
 *  anything changed. Runs BEFORE type recovery so the new op's operands get signed/unsigned typing. */
export function recognizeSoftDiv(fn: Fn, target: TargetDescription): boolean {
  const table = softDivisions(target);
  let changed = false;
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      if (op.opcode !== 'call') {
        continue;
      }
      const helper = table[op.attrs.target as string];
      if (!helper?.op) {
        continue;
      }
      // Fold only when BOTH arguments were recovered (the signature makes this the norm). A
      // mis-recovered arity leaves the call untouched rather than fabricating a wrong divide.
      if (op.operands.length !== wordsOf(helper.params) || op.results.length !== 1) {
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
