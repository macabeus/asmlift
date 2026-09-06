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
import { Block, Fn } from '../ir/core';
import { simplifyTrivialPhis } from '../ir/simplify';
import { dce } from '../pattern/engine';
import type { FnProto } from '../proto';
import type { TargetDescription } from '../target';
import { recognizeArrays } from './arrays';
import { recognizeConsts } from './const';
import { recognizeDivPow2 } from './divpow2';
import { numberPureValues } from './gvn';
import { recognizeMagicDivision } from './magicdiv';
import { recognizeMemberArrays } from './memberarrays';
import { rerootNarrowReads } from './narrow';
import { type MergeShape, mergeShapes, narrowBlockLocals } from './narrowlocal';
import { narrowEntryParams } from './paramwidth';
import { type BranchShortCircuitOptions, recognizeBranchShortCircuit, recognizeShortCircuit } from './shortcircuit';
import { recognizeSoftDiv } from './softdiv';
import { recognizeStructArrays } from './struct-arrays';
import { recognizeStructs } from './structs';

/** Per-call options for the pass list — ONE field per pass that takes any, named for the pass, so
 *  a caller reads which recognizer it is steering and a pass that takes none says so by absence.
 *  A field here selects between spellings its pass can already produce; none of them relaxes a
 *  soundness refusal, and each recognizer documents its own. */
export interface PreRecoveryOptions {
  /** raise/shortcircuit.ts `recognizeBranchShortCircuit` — the connective-vs-comparison-tree axis. */
  shortCircuit?: BranchShortCircuitOptions;
}

/** CFG facts read off the function ONCE, before the first pass below rewrites it.
 *
 *  A pass that judges the SHAPE agbcc emitted cannot read that shape off `fn` when its turn comes:
 *  by then divpow2 has deleted a block, both short-circuit folds have rewritten edges, and the
 *  eight `dce: true` passes have changed op counts. So the driver reads it here and hands it down. */
export interface PreRecoveryFacts {
  /** the join shape of every block, for raise/narrowlocal.ts's `edge-extends`. Blocks a later pass
   *  creates are absent, and absent reads as "no diamond" — the refusing direction. */
  mergeShapes: Map<Block, MergeShape>;
}

export interface PreRecoveryPass {
  /** stable id — also the report's trace-stage key. */
  id: string;
  /** run the recognizer; returns a truthy value (a change count, or `true`) iff it CHANGED the IR.
   *  `self` is the prototype the caller supplied for the function being raised — read only by
   *  parameter-width, which checks its inference against a declared width. `lifted` is the
   *  pre-pass CFG snapshot — read only by narrow-local. */
  run: (
    fn: Fn,
    self: FnProto | undefined,
    opts: PreRecoveryOptions,
    target: TargetDescription,
    lifted: PreRecoveryFacts,
  ) => number | boolean;
  /** run `dce` after this pass changes the IR (the pass declares it leaves dead ops behind). */
  dce: boolean;
  /** optional target gate (soft-div only fires on a no-hardware-divide target — see raise/softdiv.ts). */
  gate?: (target: TargetDescription) => boolean;
}

/** THE ordered pre-recovery pass list — the single source of truth shared by pipeline / rank / report.
 *  address-numbering → const-materialize → magic-division → pow2-division → soft-division → array-legalize →
 *  struct-array → member-array → struct-pointer → short-circuit → branch-short-circuit → narrow-reads →
 *  narrow-local → parameter-width. See each recognizer's file for the rationale. */
export const PRE_RECOVERY_PASSES: PreRecoveryPass[] = [
  // FIRST: collapsing duplicate address definitions removes block params every later recognizer
  // would otherwise have to reason around, and it can only shrink the value graph.
  {
    id: 'addrnum',
    // Numbering alone is not enough and not safe to ship alone: collapsing the duplicates leaves a
    // block param whose edges now all carry one value, and the structurer still destroys THAT into
    // a local (it only reuses a name a carrier already has, and an inlined `gaddr` has none).
    // Numbering alone costs kleod:UpdateHUDCounterDisplay its match, so the pair is the atomic
    // unit, expressed as a body rather than a sum of two unrelated counts. It is NOT monotone,
    // which is worth knowing before tuning either half: dropping the cleanup IMPROVES
    // kleod:ConfigureEntityBehavior and kleod:CountCollectedGems, neither of them near matching.
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
  // member-arrays AFTER struct-arrays, and that order IS load-bearing — but the order alone does
  // not deconflict them, because the two passes claim different VALUES: struct-arrays types the
  // materialized `add(P, K)` and member-arrays groups on `P`, so `P->tbl[i].f` reaches both. What
  // deconflicts them is member-arrays' `claimed-access` gate, reading the marks struct-arrays
  // leaves. Its position before `structs` is NOT load-bearing — a base carrying both of THOSE
  // shapes is refused on either side (`direct-access` here, the `unknown` check there) — and it
  // sits there so the three struct synthesizers read in the order of their evidence. `narrowlocal`
  // reads the carrier's extension chain rather than any address, so nothing here orders against it.
  { id: 'member-arrays', run: (fn) => recognizeMemberArrays(fn), dce: true },
  { id: 'structs', run: recognizeStructs, dce: false },
  { id: 'shortcircuit', run: recognizeShortCircuit, dce: true },
  // The control-flow sibling, value form FIRST.
  //
  // Their input SHAPES are disjoint (the value form's second block ends in `br` carrying a phi
  // argument, this one's ends in `cond_br`), so neither can eat the other's literal pattern. The
  // order is not otherwise load-bearing: this pass REWRITES its head's condition into a
  // `logic_or`/`logic_and`, and the value form takes a fused head — both siblings negate a
  // connective by De Morgan (`negateCondOps`, raise/shortcircuit.ts). Running this one first can
  // still cost a value fold wherever that helper refuses the fused cone (a non-negatable leaf, or a
  // cone over its budget), but instrumenting the value form's head gate over the benchmark corpus
  // counts 0 fused heads across the 782 rows that lift map-lessly, so the hazard has no producer
  // there. The reverse direction never could: the value form replaces its head's `cond_br` with a
  // `br`, which this pass never matches.
  {
    id: 'branch-shortcircuit',
    run: (fn, _self, opts) => recognizeBranchShortCircuit(fn, opts.shortCircuit),
    dce: true,
  },
  // LAST, and the position IS load-bearing: this pass reads the CFG's edge arguments to find a
  // loop variable's next value, and both short-circuit folds above rewrite the very edges it reads.
  // `dce: false` — the rewrite orphans nothing, since the operand it drops keeps its other use.
  { id: 'narrow', run: rerootNarrowReads, dce: false },
  // The two WIDTH passes, last and in either order relative to each other: each only DELETES an
  // extension and retypes the parameter that fed it, so every recognizer above sees the shape it
  // was written against and neither can match a shape the other creates. They are disjoint by
  // construction — `narrowlocal` refuses an entry parameter, `paramwidth` reads only entry
  // parameters — and `narrowlocal` cannot take an extension `narrow` above wants either, since a
  // parameter carrying BOTH a `zext` and a `sext` has two readers and is refused.
  // `dce: false` on both — the extension each drops is spliced out in place, and its result has no
  // other reader.
  // The `target` argument is read by ONE conjunct of ONE gate — see raise/narrowlocal.ts's
  // `NarrowLocalOptions`. A whole-pass `gate` would be wrong: the pass's SOUND rules are claims
  // about C and run everywhere; only the join-shape evidence is a claim about gcc 2.x's optimizer.
  // That same conjunct is why this is the one pass reading `lifted`: every pass above it can
  // rewrite the CFG whose shape it judges.
  {
    id: 'narrowlocal',
    run: (fn, _self, _opts, target, lifted) =>
      narrowBlockLocals(
        fn,
        undefined,
        { hoistsSingleSetArm: target.compilerBehaviors.hoistsSingleSetArm },
        lifted.mergeShapes,
      ),
    dce: false,
  },
  { id: 'paramwidth', run: (fn, self) => narrowEntryParams(fn, self), dce: false },
];

/** Run the pre-recovery passes in order. For each pass whose gate passes and that CHANGES the IR, run
 *  `dce` when the pass declares it, then invoke `afterPass(pass, result)` (the caller's verify/trace
 *  hook), if given. */
export function runPreRecovery(
  fn: Fn,
  target: TargetDescription,
  afterPass?: (pass: PreRecoveryPass, result: number | boolean) => void,
  self?: FnProto,
  opts: PreRecoveryOptions = {},
): void {
  const lifted: PreRecoveryFacts = { mergeShapes: mergeShapes(fn) };
  for (const pass of PRE_RECOVERY_PASSES) {
    if (pass.gate && !pass.gate(target)) {
      continue;
    }
    const result = pass.run(fn, self, opts, target, lifted);
    if (result) {
      if (pass.dce) {
        dce(fn);
      }
      afterPass?.(pass, result);
    }
  }
}
