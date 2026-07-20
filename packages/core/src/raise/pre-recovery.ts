// asmlift — the pre-recovery raise-pass sequence, as ONE shared ordered list.
//
// These recognizers run AFTER idiom-pattern folding and BEFORE type recovery, each rewriting the IR
// into a form recovery/structuring can reason about. Their ORDER and per-pass `dce`/gating semantics
// are load-bearing; this module is the single source of truth — add a pass HERE and every caller
// (pipeline, rank, report) picks it up. A pass added to one call site alone leaves the others
// hitting the unlowered op → a spurious noncompile.
//
// Callers supply an `afterPass` hook for their own per-pass concern (pipeline's raiseRecovered and
// rank's score-probe both verify; the report's trace entries ride pipeline's hook). The `dce` after a
// pass that changed the IR is INTRINSIC to the pass (it declares whether it leaves dead ops) and lives
// in the driver.
import { Fn } from '../ir/core';
import { dce } from '../pattern/engine';
import type { TargetDescription } from '../target';
import { recognizeArrays } from './arrays';
import { recognizeConsts } from './const';
import { recognizeMagicDivision } from './magicdiv';
import { recognizeShortCircuit } from './shortcircuit';
import { recognizeSoftDiv } from './softdiv';
import { recognizeStructArrays } from './struct-arrays';
import { recognizeStructs } from './structs';

export interface PreRecoveryPass {
  /** stable id — also the report's trace-stage key. */
  id: string;
  /** run the recognizer; returns a truthy value (a change count, or `true`) iff it CHANGED the IR. */
  run: (fn: Fn) => number | boolean;
  /** run `dce` after this pass changes the IR (the pass declares it leaves dead ops behind). */
  dce: boolean;
  /** optional target gate (soft-div only fires on a no-hardware-divide target — see raise/softdiv.ts). */
  gate?: (target: TargetDescription) => boolean;
}

/** THE ordered pre-recovery pass list — the single source of truth shared by pipeline / rank / report.
 *  const-materialize → magic-division → soft-division → array-legalize → struct-array →
 *  struct-pointer → short-circuit. See each recognizer's file for the rationale. */
export const PRE_RECOVERY_PASSES: PreRecoveryPass[] = [
  { id: 'const', run: recognizeConsts, dce: true },
  { id: 'magicdiv', run: recognizeMagicDivision, dce: true },
  { id: 'softdiv', run: (fn) => recognizeSoftDiv(fn), dce: false, gate: (t) => !t.capabilities.hwDivide },
  { id: 'arrays', run: recognizeArrays, dce: true },
  // struct-arrays AFTER arrays (scalar stride==width shapes are claimed first — see the
  // discriminator note in raise/struct-arrays.ts) and BEFORE structs (an element's field
  // accesses must not be re-derived as constant-offset struct-pointer accesses).
  { id: 'struct-arrays', run: recognizeStructArrays, dce: true },
  { id: 'structs', run: recognizeStructs, dce: false },
  { id: 'shortcircuit', run: recognizeShortCircuit, dce: true },
];

/** Run the pre-recovery passes in order. For each pass whose gate passes and that CHANGES the IR, run
 *  `dce` when the pass declares it, then invoke `afterPass(pass, result)` (the caller's verify/trace
 *  hook), if given. */
export function runPreRecovery(
  fn: Fn,
  target: TargetDescription,
  afterPass?: (pass: PreRecoveryPass, result: number | boolean) => void,
): void {
  for (const pass of PRE_RECOVERY_PASSES) {
    if (pass.gate && !pass.gate(target)) {
      continue;
    }
    const result = pass.run(fn);
    if (result) {
      if (pass.dce) {
        dce(fn);
      }
      afterPass?.(pass, result);
    }
  }
}
