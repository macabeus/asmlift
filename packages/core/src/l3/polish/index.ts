// asmlift — the READABILITY POLISH: re-spellings of a finished tree that a reader would write and the
// compiler cannot tell apart, applied by the C-family printer to the text it publishes.
//
// WHAT MAY LIVE HERE. A rewrite whose C is the SAME PROGRAM in every dialect the printer serves and
// compiles to the same bytes on every compiler the bench covers, at every level the pass fires at —
// `*p` as `p[0]`, `x = x + 1` as
// `x++`. Not a rewrite the compiler can see: an early return's polarity, a narrower declared type or
// a `do`/`while` turned `for` move code on agbcc, so they are ranked candidates (a variation), never
// a polish. Nor is dropping the `else` after a branch that returns, which reads as the same program
// and is NOT the same tree to agbcc: in `sa3:VramMalloc`'s inner loop,
// `if (c) { return x; } else { if (d) break; v2 = …; }` and its flattened twin allocate registers
// differently (agbcc -O2 -mthumb-interwork, compiled), and the flattened candidate scored 9 rows
// where its draft scored 35 or more. Each rewrite is its own module, states the
// condition under which it does not fire, and is pinned by its own test.
//
// WHERE IT RUNS, and why that is the whole design. The polish runs inside `emitCFamily`, last, on the
// tree the printer is about to print (after the pointer-write legalization, so it sees every cast the
// reader will), and both the text that is COMPILED and the text that is PUBLISHED carry it: a
// candidate is scored on what the report shows. It is a PRINT POLICY the caller chooses, so it lives
// on the backend the caller hands in, `polished(backend, facts)`, and nowhere in the structurer: the
// core library's default backends print the tree as structured, which hundreds of tests pin.
//
// A polished backend keeps the inner printer as its `draft`, and the return-tail reading's size bound
// reads that (pipeline.ts `structureReturnTailReading`), as does rank's duplicate collapse: a polish
// that drops a line must not move a reading, and two trees the polish prints as one text are still
// two candidates. Rank's goto/cast/line tie-break reads the PUBLISHED text, the one the report's
// quality metric counts (rank.ts `compareScored`).
//
// WHAT THE COMPILER SEES DEPENDS ON THE LEVEL. At a level that compiles each statement as it is
// written (`PolishFacts.literal`), three of these re-spellings are other code: `x++` and `x += k`
// on gcc 2.7.2 and KMC gcc at -O0 even for an `int` local, a trailing `return;` (an explicit branch
// to the epilogue on agbcc, IDO and both gcc 2.7.2 builds at -O0), and an unused local (a frame slot
// on agbcc, IDO at -O0 and -O1, and both gcc 2.7.2 builds at -O0). Each pass that is other code
// there says so and stands down. The rest compile alike at every level measured.
import type { TargetDescription } from '../../target';
import type { LanguageBackend, SFn } from '../ast';
import { compoundAssignments } from './compound';
import { hexBitLiterals } from './hex';
import { subscriptZeroBesideConstants } from './ptr0';
import { renumberLocals } from './renumber';
import { callTruthTests } from './truthcall';
import { voidTail } from './voidtail';

/** What a polish pass may ask of the compiler the text is for. */
export interface PolishFacts {
  /** The level compiles each statement as it is written, so a re-spelling the optimizer would fold
   *  away is other code: `compilerBehaviors.keepsUnusedReads`, which target.ts `keepsUnusedReadsAt`
   *  sets for every family's -O0, IDO's -O1 and a compile no level flag names. Those are the levels
   *  where the passes below were measured to differ (agbcc, IDO 7.1, gcc 2.7.2 and KMC gcc at -O0,
   *  IDO at -O1); mwcc at -O0 differs for some of them too. A level this answers wrongly as
   *  optimizing would publish other code, so the answer errs to `true`: an unknown level keeps. */
  readonly literal: boolean;
}

/** The {@link PolishFacts} of a resolved target (target.ts `targetFor`). */
export function polishFactsOf(target: TargetDescription): PolishFacts {
  return { literal: target.compilerBehaviors.keepsUnusedReads === true };
}

/** The tree-level polish rewrites, in the order they run: the ones that drop statements first, so
 *  the spelling ones see the statements that remain. */
const PASSES: readonly ((fn: SFn, facts: PolishFacts) => SFn)[] = [
  voidTail,
  callTruthTests,
  subscriptZeroBesideConstants,
  hexBitLiterals,
  compoundAssignments,
  // last: the rewrites above can only drop mentions, never add one
  renumberLocals,
];

/** The finished tree, re-spelled by every tree-level polish rewrite, in order. */
export function polishTree(fn: SFn, facts: PolishFacts): SFn {
  return PASSES.reduce((t, pass) => pass(t, facts), fn);
}

/** `backend`, printing through the readability polish for a compiler with these `facts`: its
 *  `emit` polishes, and its `draft` is `backend`'s own `emit`. A backend with no polished printer
 *  (`LanguageBackend.polishedEmit`) is returned as it is, and so is one already polished. */
export function polished(backend: LanguageBackend, facts: PolishFacts): LanguageBackend {
  const { polishedEmit, ...inner } = backend;
  if (polishedEmit === undefined) {
    return backend;
  }
  return { ...inner, emit: (fn) => polishedEmit(fn, facts), draft: (fn) => backend.emit(fn) };
}
