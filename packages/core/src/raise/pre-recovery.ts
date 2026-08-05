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
import { simplifyTrivialPhis } from '../ir/simplify';
import { dce } from '../pattern/engine';
import type { TargetDescription } from '../target';
import { recognizeArrays } from './arrays';
import { recognizeConsts } from './const';
import { recognizeDivPow2 } from './divpow2';
import { numberPureValues } from './gvn';
import { recognizeMagicDivision } from './magicdiv';
import { recognizeBranchShortCircuit, recognizeShortCircuit } from './shortcircuit';
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
 *  address-numbering → const-materialize → magic-division → pow2-division → soft-division → array-legalize →
 *  struct-array → struct-pointer → short-circuit → branch-short-circuit. See each recognizer's file
 *  for the rationale. */
export const PRE_RECOVERY_PASSES: PreRecoveryPass[] = [
  // FIRST: collapsing duplicate address definitions removes block params every later recognizer
  // would otherwise have to reason around, and it can only shrink the value graph.
  {
    id: 'addrnum',
    // Numbering alone is not enough and not safe to ship alone: collapsing the duplicates leaves a
    // block param whose edges now all carry one value, and the structurer still destroys THAT into
    // a local (it only reuses a name a carrier already has, and an inlined `gaddr` has none).
    // Measured: numbering without the phi cleanup made kleod:UpdateHUDCounterDisplay WORSE. So the
    // pair is the atomic unit, expressed as a body rather than a sum of two unrelated counts.
    run: (fn) => {
      const n = numberPureValues(fn);
      return n + simplifyTrivialPhis(fn);
    },
    dce: false,
  },
  { id: 'const', run: recognizeConsts, dce: true },
  { id: 'magicdiv', run: recognizeMagicDivision, dce: true },
  // Position is NOT load-bearing, unlike its neighbours above and below, and saying so is the point:
  // no other pass can see this shape. magicdiv matches a `mulh` DAG; both short-circuit folds require
  // a boolean const arm or a `cond_br`-terminated second block, and this diamond has an `add` arm
  // ending in `br`. Verified by running it before and after each of them — same result. It sits
  // beside magicdiv so that a reader looking for division recovery finds both together.
  { id: 'divpow2', run: recognizeDivPow2, dce: true },
  { id: 'softdiv', run: (fn) => recognizeSoftDiv(fn), dce: false, gate: (t) => !t.capabilities.hwDivide },
  { id: 'arrays', run: recognizeArrays, dce: true },
  // struct-arrays AFTER arrays (scalar stride==width shapes are claimed first — see the
  // discriminator note in raise/struct-arrays.ts) and BEFORE structs (an element's field
  // accesses must not be re-derived as constant-offset struct-pointer accesses).
  { id: 'struct-arrays', run: recognizeStructArrays, dce: true },
  { id: 'structs', run: recognizeStructs, dce: false },
  { id: 'shortcircuit', run: recognizeShortCircuit, dce: true },
  // The control-flow sibling, and this order IS load-bearing — value form FIRST.
  //
  // Their input SHAPES are disjoint (the value form's second block ends in `br` carrying a phi
  // argument, this one's ends in `cond_br`), so neither can eat the other's literal pattern. But
  // this pass REWRITES its head's condition into a `logic_or`/`logic_and`, and the value form
  // refuses any head whose condition is not a negatable icmp — so running this one first can
  // permanently disqualify a value fold that was available. The reverse cannot happen: the value
  // form replaces its head's `cond_br` with a `br`, which this pass never matches.
  { id: 'branch-shortcircuit', run: recognizeBranchShortCircuit, dce: true },
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
