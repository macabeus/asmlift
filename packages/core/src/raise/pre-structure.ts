// asmlift — the CFG folds that run last before structuring, after return-sinking: each rewrites a
// loop's edges into a shape a loop spelling owns, and each is its own stage in the trace, so a
// re-spelled function names the fold that moved its CFG.
//
// A MUTABLE RECORD, not a sum of three calls, for the reason `PRE_RECOVERY_PASSES` is one: it is the
// caller-side seam a process outside core swaps to census a fold's gate table (`pnpm bench gates`,
// apps/benchmark/src/run/gate-census.ts). A static import binding cannot be swapped.
import { Fn } from '../ir/core';
import { foldEmptyLatches, foldExitTrampolines } from './latch';
import { rerollPeeledTests } from './reroll';

export interface PreStructureFold {
  /** stable; the trace stage is `stage:<id>` */
  readonly id: string;
  /** the trace stage's title */
  readonly title: string;
  /** how many rewrites the fold made; 0 leaves the function as it was */
  run: (fn: Fn) => number;
}

/** In the order they ran in when they shared one stage; `synthetic:break_value:agbcc` takes both of
 *  the last two. */
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
    id: 'reroll',
    title: 'Peeled-test re-rolling (a loop test peeled into the entry becomes the first iteration)',
    run: (fn) => rerollPeeledTests(fn),
  },
];
