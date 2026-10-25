// asmlift — the CFG folds that run last before structuring, after return-sinking: the loop folds
// rewrite a loop's edges into a shape a loop spelling owns, and the last one takes a parameter off a
// switch case fallen into. Each is its own stage in the trace, so a re-spelled function names the
// fold that moved it.
//
// A MUTABLE RECORD, not a sum of four calls, for the reason `PRE_RECOVERY_PASSES` is one: it is the
// caller-side seam a process outside core swaps to census a fold's gate table (`pnpm bench gates`,
// apps/benchmark/src/run/gate-census.ts). A static import binding cannot be swapped.
import { Fn } from '../ir/core';
import { foldEmptyLatches, foldExitTrampolines } from './latch';
import { rerollPeeledTests } from './reroll';
import { recomputeRedundantParams } from './unpre';
import { unthreadLoopExits } from './unthread';

export interface PreStructureFold {
  /** stable; the trace stage is `stage:<id>` */
  readonly id: string;
  /** the trace stage's title */
  readonly title: string;
  /** how many rewrites the fold made; 0 leaves the function as it was */
  run: (fn: Fn) => number;
}

/** THE ORDER CARRIES LOAD, and each fold runs ONCE: there is no fixpoint across folds, so a fold
 *  that exposes another's shape must run before it. The re-roll needs the latch's way out and the
 *  entry's to reach ONE block, and on `synthetic:break_value:agbcc` they reach it only after the
 *  trampoline fold has spliced out the empty block the break leaves through; ahead of it, the re-roll
 *  declines and the loop with it ('unrecovered back-edge'). `reroll.test.ts` pins it by lifting that
 *  row's pre-fold IR through this record. The latch fold comes first for the same reason in kind:
 *  the folds after it read the back edge it leaves. The un-threading reads loop exits, which the
 *  trampoline fold reshapes, and sits ahead of the re-roll so a loop it gives one way out is one
 *  the re-roll may then read. That place is a precaution: `synthetic:thrbreak:agbcc` and the
 *  pointer walk unthread.ts names lift the same C wherever the fold sits, so `unthread.test.ts`
 *  pins its position, not a lift that needs it. The parameter recompute (`unpre`) runs last
 *  because that is the one place it was measured: it moves no edge, so no loop fold reads what it
 *  leaves, and `unpre.test.ts` pins the place, not a lift that needs it. */
export const PRE_STRUCTURE_FOLDS: PreStructureFold[] = [
  {
    id: 'latchfold',
    title: 'Empty-latch folding (a latch that only jumps back becomes its back edge)',
    run: (fn) => foldEmptyLatches(fn),
  },
  {
    id: 'trampoline',
    title: 'Exit-trampoline folding (an empty block on a loop exit becomes that edge)',
    run: (fn) => foldExitTrampolines(fn),
  },
  {
    id: 'unthread',
    title: 'Loop-exit un-threading (an exit jump-threaded past the re-test after the loop goes back to it)',
    run: (fn) => unthreadLoopExits(fn),
  },
  {
    id: 'reroll',
    title: 'Peeled-test re-rolling (a loop test peeled into the entry becomes the first iteration)',
    run: (fn) => rerollPeeledTests(fn),
  },
  {
    id: 'unpre',
    title: 'Redundant-parameter recomputing (a parameter every edge hands one pure expression becomes it)',
    run: (fn) => recomputeRedundantParams(fn),
  },
];
