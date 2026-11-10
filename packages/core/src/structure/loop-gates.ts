// asmlift structurer — the gate tables of the loop readings past the default, each with the
// candidate it judges: the two-level exit (`TWO_LEVEL_EXIT_GATES`, its outward hand-off, its region
// and its break), a loop in a shared `break` tail (`BREAK_TAIL_GATES`), the `while (1)` read as a
// `for` (`FOR_PLAN_GATES`, `FOR_PLAN_IV_GATES`, `FOR_BOUND_GATES`), and the exit arm's copies of a
// return tail (`EXIT_TAIL_GATES`, `BYPASS_TAIL_GATES`). Data, so a test can drop one gate and run
// the real pass (`StructureHooks`); structure.ts and exit-arms.ts are where each is asked.
import type { Gate } from '../l3/gates';

/** One edge out of a loop's body that `foreverShape`'s last resort weighs as a two-level exit: from
 *  `from` in the body to `to`, beside the loop's own `exit`. Every field is a getter, so a walk runs
 *  only when the rules ahead of it admit. */
export interface TwoLevelCandidate {
  /** the edge leaves from an inner loop's body, not this loop's own */
  readonly fromInnerBody: boolean;
  /** the hit runs code of its own before it reaches `to` (`hitArmOf`) */
  readonly hitRunsCode: boolean;
  /** another edge of this loop already took a second target, and it is not `to` */
  readonly secondTargetElsewhere: boolean;
  /** `to` is the loop's own exit or lies in its body */
  readonly targetIsExitOrInLoop: boolean;
  /** a loop encloses this one and `to` lies outside its body (a `goto` out of both loops) */
  readonly targetPastEnclosingLoop: boolean;
  /** the reading may hand the exit out to the enclosing loop (`TwoLevelExit.outward`): asked only
   *  once every other reading has failed */
  readonly outwardAsked: boolean;
  /** the outward rung's first pass, where the loop takes no two-level exit of its own: only an
   *  outward one */
  readonly ownTargetHeldBack: boolean;
  /** `to` lies past the loop around the enclosing one too (a `goto` out of three loops) */
  readonly targetTwoLoopsOut: boolean;
  /** a loop encloses this one and `exit` lies outside its body */
  readonly exitPastEnclosingLoop: boolean;
  /** `to` is the enclosing loop's header (a two-level `continue`) */
  readonly targetIsEnclosingHeader: boolean;
  /** no forward path from `exit` meets `to` (`twoLevelSkip` is null) */
  readonly exitNeverMeetsTarget: boolean;
  /** the code from `exit` up to `to` re-enters the loop's body */
  readonly skipReentersLoop: boolean;
}

/** When `foreverShape`'s last resort takes an edge for a two-level exit (`TwoLevelExit`). The
 *  argument for each rule is at `twoLevelCandidate` and at that clause. Not in the table: the scope (a
 *  two-level exit is asked only of a `while (1)` reading that failed every other way, `foreverShape`'s
 *  `twoLevel`); the two refusals where the exit is spelled, which judge other contexts
 *  (`TWO_LEVEL_REGION_GATES`, `TWO_LEVEL_BREAK_GATES`); `breakRule`'s DEFENSIVE `leaves for a second
 *  target a loop with a test of its own cannot spell`, read with that function's other refusal
 *  strings; and `emitForever`'s `skipped === null`, a re-check of `exit-never-meets-target`. */
export const TWO_LEVEL_EXIT_GATES: readonly Gate<TwoLevelCandidate>[] = [
  {
    id: 'from-inner-body',
    why: 'an edge out of an inner loop is that loop’s to read first (defensive)',
    sound: false,
    rejects: (c) => c.fromInnerBody,
  },
  {
    id: 'second-target-elsewhere',
    why: 'one flag read after the loop spells one second target, and a third way out has none',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: without second-target-elsewhere a third exit target is still refused where its break is written',
    rejects: (c) => c.secondTargetElsewhere,
  },
  {
    id: 'target-is-exit-or-in-loop',
    why: 'the loop’s own exit and its own body are not a second target (defensive)',
    sound: false,
    rejects: (c) => c.targetIsExitOrInLoop,
  },
  {
    id: 'target-past-enclosing-loop',
    why: 'a break out of both loops hands its flag out to the enclosing loop, asked only once every other reading failed',
    sound: false,
    rejects: (c) => c.targetPastEnclosingLoop && !c.outwardAsked,
  },
  {
    id: 'own-target-held-back',
    why: 'on the outward rung every exit is tried with no flag of the loop’s own first, so the hit’s code laid out ahead of the code after the loop is not read as the exit',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: a `goto` out of both loops takes one flag whichever of its code and the code after the loop is laid out first',
    rejects: (c) => c.ownTargetHeldBack && !c.targetPastEnclosingLoop,
  },
  {
    id: 'hit-code-past-enclosing-loop',
    why: 'a hit whose code runs past both loops is the outward reading’s, which writes that code itself (defensive)',
    sound: false,
    rejects: (c) => c.hitRunsCode && c.targetPastEnclosingLoop,
  },
  {
    id: 'target-two-loops-out',
    why: 'a flag handed out one loop at a time is read by the enclosing loop alone, never the one around it',
    sound: false,
    rejects: (c) => c.targetTwoLoopsOut,
  },
  {
    id: 'exit-past-enclosing-loop',
    why: 'the loop’s own exit lies in the enclosing loop whenever its code meets the target there (defensive)',
    sound: false,
    rejects: (c) => c.exitPastEnclosingLoop,
  },
  {
    id: 'target-is-enclosing-header',
    why: 'the enclosing header is a two-level continue, which no flag read after the loop spells',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: each decline is refused by the two-level rule its shape names',
    rejects: (c) => c.targetIsEnclosingHeader,
  },
  {
    id: 'exit-never-meets-target',
    why: 'where the code after the loop never meets the target, no if after the loop holds the code it skips',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: each decline is refused by the two-level rule its shape names',
    rejects: (c) => c.exitNeverMeetsTarget,
  },
  {
    id: 'skip-reenters-loop',
    why: 'code past the loop that runs back into it is the enclosing header read as the loop exit, not yet weighed',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: without skip-reenters-loop the two-level continue lifts, and agrees',
    rejects: (c) => c.skipReentersLoop,
  },
];

/** An exit edge of a `while (1)` that leaves from an inner loop's body, weighed as the inner loop's
 *  outward two-level exit handed out to this one (`TwoLevelExit.outward`, `outwardExitOf`). */
export interface OutwardExitCandidate {
  /** the innermost loop the edge leaves from is not a child of this one, but nested deeper */
  readonly fromDeeperLoop: boolean;
  /** the code from the edge's target is not a break arm of this loop (`codeBreakArm`): it re-enters
   *  the loop, dispatches, leaves for another target, or is entered where the duplication policy
   *  writes it once, after the loop */
  readonly notABreakArm: boolean;
}

/** When `foreverShape`'s outward rung takes an edge out of an inner loop's body as that loop's
 *  outward two-level exit. The argument is at `outwardExitOf`. Not in the table: the inner loop
 *  taking the same edge for its own (`TWO_LEVEL_EXIT_GATES`), checked once both are classified.
 *  `from-a-deeper-loop` is DEFENSIVE: on a `goto` out of three loops the middle loop never reads
 *  the edge as a break arm of its own (the code from the target misses its exit), and the check
 *  that both loops took the reading sends the outer one back to its other readings. */
export const OUTWARD_EXIT_GATES: readonly Gate<OutwardExitCandidate>[] = [
  {
    id: 'from-a-deeper-loop',
    why: 'the flag is handed out one loop at a time, so the edge must leave a loop this one holds directly',
    sound: false,
    rejects: (c) => c.fromDeeperLoop,
  },
  {
    id: 'not-a-break-arm',
    why: 'the code the exit runs is written in the inner loop ahead of its break, so it must be one this loop’s break arm may write',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: each decline is refused by the two-level rule its shape names',
    rejects: (c) => c.notABreakArm,
  },
];

/** A two-level exit about to be spelled where its `while (1)` sits (`emitForever`). */
export interface TwoLevelRegion {
  /** the region holding the loop ends inside the code the exit skips (`stop` among it) */
  readonly skipsRegionEnd: boolean;
  /** the second target is the merge of the switch arm the loop sits in, and a `break;` after the
   *  loop leaves that switch (`switchBreaks`) */
  readonly breakReachesTarget: boolean;
}

/** When `emitForever` spells a two-level exit in the region it is asked for. The argument is at
 *  `emitForever`. */
export const TWO_LEVEL_REGION_GATES: readonly Gate<TwoLevelRegion>[] = [
  {
    id: 'skips-region-end',
    why: 'the code from the second target would render past the end of the region, and its owner renders it again',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: without skips-region-end the goto into the next arm lifts, and agrees: the rule refuses a correct reading',
    rejects: (c) => c.skipsRegionEnd && !c.breakReachesTarget,
  },
];

/** A two-level exit's `break` about to be written out of one block (`structureBlock`). */
export interface TwoLevelBreak {
  /** the block sits in a case body opened inside the loop, where `break` leaves only the switch */
  readonly inCaseBody: boolean;
}

/** When a block's edge to a two-level exit's second target is written `flag = 1; break;`. The
 *  argument is at the refusal in `structureBlock`. */
export const TWO_LEVEL_BREAK_GATES: readonly Gate<TwoLevelBreak>[] = [
  {
    id: 'from-a-case-body',
    why: 'inside a case body a break leaves only the switch, not the loop',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: without from-a-case-body the case-body exit is refused by the switch-exit rule behind it',
    rejects: (c) => c.inCaseBody,
  },
];

/** A tail several `break` arms share that holds a cycle (`codeBreakArm`, shared). */
export interface BreakTailCycle {
  /** asked by `while (1)`'s last rung (`ArmCopies.cycles`), once every reading that copies no cycle
   *  has failed */
  readonly cycleRung: boolean;
}

/** When a tail several arms share may hold a cycle, so each arm writes its own copy of the loop in
 *  it. The argument is at `earlyReturnArm` (A LOOP IN THE TAIL): the duplication policy's one rule
 *  for a cycle, which `EXIT_TAIL_GATES`' `tail-holds-cycle` and `BYPASS_TAIL_GATES` hold a return
 *  tail to. Not in the table: the acyclic tail (admitted without asking), every other refusal of
 *  `codeBreakArm`, which are its own walk's, and a cycle entered at two blocks, which no copy can
 *  spell as a loop and emission declines loud ("unrecovered back-edge"), as it does wherever the
 *  loop forest holds no loop for a cycle. */
export const BREAK_TAIL_GATES: readonly Gate<BreakTailCycle>[] = [
  {
    id: 'shared-cycle-before-last-resort',
    why: 'a loop copied into every arm is the reading of last resort, after every reading that copies none',
    sound: false,
    guardedBy:
      'loop-break-exit.test.ts: a loop in the tail the arm and the `else` share is copied only once the flag reading fails',
    rejects: (c) => !c.cycleRung,
  },
];

/** One loop's `for` reading (`forPlanAt`, THE LOOP AS A `for`) once its SHAPE is the `for`'s, as
 *  `FOR_PLAN_GATES` judges it. THE FIELDS ARE LAZY, as `CarrierName`'s are: each is computed only
 *  once every rule above it in the table has admitted, so the table's order is also what runs. */
export interface ForPlanCandidate {
  /** an edge into the preheader carries a copy */
  readonly preheaderParams: boolean;
  /** a block besides the guard enters the preheader */
  readonly preheaderSecondWayIn: boolean;
  /** a preheader op has an effect, touches memory, is order-sensitive or qualified */
  readonly preheaderEffect: boolean;
  /** a preheader op can trap (a division) */
  readonly preheaderTraps: boolean;
  /** a preheader op is a def-site anchored write (`anchorConstCopies`) */
  readonly preheaderAnchored: boolean;
  /** an edge into the latch carries a copy */
  readonly latchParams: boolean;
  /** a latch op has an effect or a qualified access */
  readonly latchEffect: boolean;
  /** a latch op is named (materialized) and read outside the latch */
  readonly latchNamedOutside: boolean;
  /** a latch op is a def-site anchored write */
  readonly latchAnchored: boolean;
  /** the latch test reads a body value other than the latch's own ops and the header's params */
  readonly testReadsBody: boolean;
  /** …or the back edge's args do */
  readonly updateReadsBody: boolean;
}

/** `forPlanAt`'s rules past the loop's shape. The argument for each is in the THE LOOP AS A `for`
 *  block above `forPlanAt`. Not in the table, and named here so the table does not read as the whole
 *  of the refusal: the SHAPE the context is built over (one latch that is not the header, one exit,
 *  `g` outside the loop branching only to the header — or the preheader — and the exit, the latch
 *  branching only to the header and the exit, the header entered only from those two), which every
 *  field reads and no rule could be dropped from without a crash; the caller's own construction of a
 *  preheader (a `br` into the header, offered only from a guard); the copies the update and the init
 *  make (`edgeCopyRecords`, which pushes a gap or refuses and so cannot be a prepared field); and
 *  `FOR_PLAN_IV_GATES`, the rules that read those copies.
 *
 *  A preheader in the loop's body is not refused on its own: it is entered only from `g`, and a
 *  natural loop's body holds every predecessor of a block in it but the header, so `g` would be in
 *  the body too, which the shape refuses. */
export const FOR_PLAN_GATES: readonly Gate<ForPlanCandidate>[] = [
  {
    id: 'preheader-params',
    why: 'the preheader runs as statements ahead of the loop, and a value its in-edge hands it would never be written',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without preheader-params the value the guard hands the preheader is read unset',
    rejects: (c) => c.preheaderParams,
  },
  {
    id: 'preheader-second-way-in',
    why: 'the preheader runs once, ahead of the loop, from the guard alone (defensive)',
    sound: false,
    rejects: (c) => c.preheaderSecondWayIn,
  },
  {
    id: 'preheader-effect',
    why: 'the preheader runs ahead of the first test, so also on the path where the guard skipped the loop',
    sound: true,
    guardedBy: 'for-derived-iv.test.ts: a preheader that reads memory refuses the `for`',
    rejects: (c) => c.preheaderEffect,
  },
  {
    id: 'preheader-traps',
    why: 'a division in the preheader would run on the path where the guard skipped the loop, and could trap there',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without preheader-traps a division runs ahead of the loop the guard skipped',
    rejects: (c) => c.preheaderTraps,
  },
  {
    id: 'preheader-anchored',
    why: 'a write anchored at its definition belongs to the edge it replaces, which the loop no longer has (defensive)',
    sound: false,
    rejects: (c) => c.preheaderAnchored,
  },
  {
    // DEFENSIVE: a latch param is read only by the latch's own ops, so by the test or the update,
    // which `test-reads-body` and `update-reads-body` refuse as a body value; one nothing reads is dead.
    id: 'latch-params',
    why: 'the latch is never rendered, so a copy into it would never be written (defensive)',
    sound: false,
    rejects: (c) => c.latchParams,
  },
  {
    id: 'latch-effect',
    why: 'the latch is never rendered, so an effect in it would never run',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without latch-effect a call in the latch never runs',
    rejects: (c) => c.latchEffect,
  },
  {
    // DEFENSIVE: a read outside the latch is one the latch dominates, so past the loop with no guard
    // and no `break` — a loop no fixture or probe has brought here as a `while (1)` (a loop every arm
    // of which continues or returns reads as a `do`-`while` first).
    id: 'latch-named-outside',
    why: 'a named latch value is written nowhere, so a read of it past the latch would see no value (defensive)',
    sound: false,
    rejects: (c) => c.latchNamedOutside,
  },
  {
    id: 'latch-anchored',
    why: 'a write anchored at its definition in the latch would never be rendered (defensive)',
    sound: false,
    rejects: (c) => c.latchAnchored,
  },
  {
    // DEFENSIVE for the first test: a body value has no entry value, so `entry-test-differs` refuses
    // the guard (or the fold) it would be read through.
    id: 'test-reads-body',
    why: 'the test runs ahead of the first trip too, before the body computes what it would read (defensive)',
    sound: false,
    guardedBy:
      'for-plan-gates.test.ts: the heuristic and defensive rules admit nothing wrong when dropped on these fixtures',
    rejects: (c) => c.testReadsBody,
  },
  {
    // Not load-bearing on its own: a body value the latch reads dominates the latch, so it is a
    // header value (named there, and read under that name as the plain reading reads it) or a latch
    // param (refused by `test-reads-body` wherever the test reads it). Kept as the reading measured.
    id: 'update-reads-body',
    why: 'the update reads only the loop variables and values from before the loop, the reading measured',
    sound: false,
    rejects: (c) => c.updateReadsBody,
  },
];

/** `forPlanAt`'s rules that read the update's and the init's copies, once those are made. Lazy, as
 *  `ForPlanCandidate` is. */
export interface ForPlanIv {
  /** a stride's param or its stepped value reaches an edge but the back edge's own slot, an op
   *  outside the loop and its exit arms, the test or the counter's update (A SIBLING'S STRIDE) */
  readonly strideEscapes: boolean;
  /** a stride is of a sibling other than the counter, or a value of the body (or of its exit arms,
   *  when one reads a stride) other than the counter's param and the latch's ops holds the counter's
   *  name, or one holds a stride's or a leaf's name but that value itself */
  readonly strideNameShared: boolean;
  /** a leaf of a stride's G is neither named nor an operand-free op that reads no memory */
  readonly strideLeafReread: boolean;
  /** the test reads the name the update writes, other than through its back-edge value */
  readonly testReadsUpdate: boolean;
  /** the guard is not the test on the entry values, or with no guard the test does not fold to stay
   *  in the loop */
  readonly entryTestDiffers: boolean;
  /** an edge the test leaves by — the guard's (through its relay) or the latch's — hands the exit a
   *  copy that the `for`'s own init (on the guard's) or update (on the latch's) does not make */
  readonly exitCopy: boolean;
  /** …or a slot it carries without a copy (one `edgeCopyRecords` records none for) names a value
   *  the `for` writes otherwise ahead of the test: the init's names on the guard's edge (and the
   *  preheader's), on the latch's the IV past its update, or a latch op it never renders */
  readonly exitNameRewritten: boolean;
  /** the code past the loop reads the IV's param itself, not through an exit param (only a loop
   *  with no guard, whose header dominates its exit, can) */
  readonly pastReadsIv: boolean;
}

/** `forPlanAt`'s rules over the IV, its copies and the test. The argument for each is in the THE
 *  LOOP AS A `for` block. Not in the table: the update that is not ONE copy, which every field
 *  reads; and three refusals left inline ahead of the table — init copies that are cyclic or whose
 *  IV init reads another init copy's name (`copySetIsCyclic`, the `init` clause runs after the
 *  copies ahead of the `for`), and a test or update that reads an inner loop's value
 *  (`latchInnerSub`). Nor the scan of the emitted `for` for a read of a stride's name, which only an
 *  emitted loop can answer (DEFENSIVE: every read of the param renders G). */
export const FOR_PLAN_IV_GATES: readonly Gate<ForPlanIv>[] = [
  {
    id: 'stride-escapes',
    why: 'the `for` writes a stride nowhere, so a read of it past its own back-edge slot would see no value',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without stride-escapes the code after the loop reads a stride never written',
    rejects: (c) => c.strideEscapes,
  },
  {
    // DEFENSIVE: the naming walk names a header param and every body value apart, unless coalescing
    // merges them, and the one merge a fixture brings here holds a single value under both names (an
    // exit arm's param that is the counter, for-plan-gates.test.ts), so no refusal is known to save a
    // wrong read
    id: 'stride-name-shared',
    why: 'a stride is read as G of the counter and of its leaves by name, so each name must hold that one value in the loop (defensive)',
    sound: false,
    rejects: (c) => c.strideNameShared,
  },
  {
    id: 'stride-leaf-reread',
    why: 'a stride is spelled at every read, so a leaf spelled as its own expression would be evaluated again there, past the stores and calls between',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without stride-leaf-reread a base loaded once is loaded again on every trip',
    rejects: (c) => c.strideLeafReread,
  },
  {
    id: 'test-reads-update',
    why: 'the test runs after the update, so a read of the name it writes would see the next trip',
    sound: true,
    guardedBy:
      'for-plan-gates.test.ts: without test-reads-update the test reads the updated IV where the asm read the old',
    rejects: (c) => c.testReadsUpdate,
  },
  {
    id: 'entry-test-differs',
    why: 'the `for` runs its test before the first trip, which the asm does only through the guard it drops',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without entry-test-differs a guard other than the test is dropped',
    rejects: (c) => c.entryTestDiffers,
  },
  {
    id: 'exit-copy',
    why: 'the `for` leaves by its test, which runs no copy into the code after it but the init and the update',
    sound: true,
    // the trace oracle does not reach the latch's way out on every fixture, so the second guard
    // reads the C
    guardedBy: [
      'for-plan-gates.test.ts: without exit-copy the value the test edges hand the exit is never written',
      "for-exit-params.test.ts: without exit-copy the latch's way out leaves the guard's value in the exit",
    ],
    rejects: (c) => c.exitCopy,
  },
  {
    id: 'exit-name-rewritten',
    why: 'the init runs ahead of the first test and the update ahead of every other, so a name either writes no longer holds what the asm left there',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without exit-name-rewritten the exit reads the IV past its update',
    rejects: (c) => c.exitNameRewritten,
  },
  {
    id: 'past-reads-iv',
    why: "past a loop with no guard the code reads the IV as the asm left it on the latch's way out, from before the update the `for` runs ahead of its test",
    sound: true,
    guardedBy:
      'for-exit-params.test.ts: without past-reads-iv the code past a guardless loop reads the IV past its update',
    rejects: (c) => c.pastReadsIv,
  },
];

/** One reading of a latch's `!=` test as a compare against its bound (`forPlanAt`, THE LATCH TEST
 *  AS ITS BOUND). */
export interface ForBoundReading {
  /** the IV's back-edge value is not `i + 1` */
  readonly stepNotUnit: boolean;
  /** the bound (`hi` of the `+ 1` form, `H` of the strict one) is computed in the loop */
  readonly boundInLoop: boolean;
  /** the `+ 1` form read as an unsigned compare */
  readonly plusOneUnsigned: boolean;
  /** the `+ 1` form, over a counter the `for` declares as no `s32` (the signedness variation's `u32`) */
  readonly plusOneCounterWraps: boolean;
}

/** `forPlanAt`'s rules over each reading of the latch's `!=` test as a compare. The argument for each
 *  is in the THE LATCH TEST AS ITS BOUND block. Not in the table: a test that is no `==`/`!=` of the
 *  IV's back-edge value `i + k`, which names no bound to read; and the reading's agreement with the guard,
 *  which `entry-test-differs` asks of the reading this table admits. */
export const FOR_BOUND_GATES: readonly Gate<ForBoundReading>[] = [
  {
    id: 'bound-step-not-unit',
    why: 'a counter that steps by more than one can step past the bound the `!=` waits for, which a compare would leave at',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without bound-step-not-unit a step of two reads the `!=` as a compare',
    rejects: (c) => c.stepNotUnit,
  },
  {
    // DEFENSIVE: the test reads only the latch's ops and the header's params (`test-reads-body`), a
    // header param other than the IV is a second update copy, and a stride the test reads escapes
    id: 'bound-in-loop',
    why: 'the induction reads one bound on every trip, so a bound the loop computes reads nothing (defensive)',
    sound: false,
    rejects: (c) => c.boundInLoop,
  },
  {
    id: 'bound-plus-one-unsigned',
    why: 'an unsigned counter at a bound of UINT_MAX leaves the `!=` after one wrap and never leaves the compare',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without bound-plus-one-unsigned an unsigned `+ 1` bound reads as `<=`',
    rejects: (c) => c.plusOneUnsigned,
  },
  {
    id: 'bound-plus-one-counter-wraps',
    why: 'a counter declared unsigned steps defined from INT_MAX to INT_MIN, where the asm leaves the `!=` and a signed `<=` never leaves',
    sound: true,
    guardedBy:
      'for-plan-gates.test.ts: without bound-plus-one-counter-wraps a `u32` counter reads the signed `+ 1` bound as `<=`',
    rejects: (c) => c.plusOneCounterWraps,
  },
];
/** One block the `exitTail` count (at `earlyReturnArm`) weighs for an arm: a return tail the loop's
 *  own exit path also runs, which the arm would write a copy of. Every field past the first two is a
 *  getter, so its walk runs only when the rules ahead of it admit. */
export interface ExitTailCandidate {
  /** the arm's edge leaves from a latch, the loop's own way out */
  readonly armLeavesByLatch: boolean;
  /** the reading of last resort asked for the copy (`ArmCopies.onExitPath`): a path from before
   *  the loop that skips the exit may enter the tail too (A PATH THAT BYPASSES THE LOOP) */
  readonly lastResort: boolean;
  /** asked by `while (1)`'s last rung (`ArmCopies.cycles`): the tail may hold a loop */
  readonly cycleRung: boolean;
  /** a latch, or a path from before the loop (the zero-trip guard), enters the exit */
  readonly exitIsTestOut: boolean;
  /** the exit path runs a block of its own before the tail: the arm never reaches `exit` */
  readonly exitRunsOwnBlock: boolean;
  /** every predecessor of the block is an arm's block or on the exit's forward path */
  readonly enteredByArmsOrExitPath: boolean;
  /** neither the block nor anything past it holds a cycle */
  readonly acyclicPast: boolean;
}

/** When an early-`return` arm may write a copy of a tail the loop's exit path also runs. The rules
 *  and the argument for each are at `earlyReturnArm` ("THE EXIT PATH RUNS IT TOO"); none is sound,
 *  since every copy runs on a path exclusive of the others. Not in the table: the count's scope — a
 *  copy the caller asked for (`copyExitTail`), and a block with an effect the exit path runs — which
 *  is the walk's own condition. */
export const EXIT_TAIL_GATES: readonly Gate<ExitTailCandidate>[] = [
  {
    id: 'arm-leaves-by-latch',
    why: 'an arm leaving by a latch is the way the loop itself leaves, and a copy past it moves post-loop code into the body',
    sound: false,
    guardedBy: 'loop-break-exit.test.ts: an arm another path also enters is not a `break` arm',
    rejects: (c) => c.armLeavesByLatch,
  },
  {
    id: 'exit-not-test-out',
    why: 'an exit only a mid-body branch enters is another arm, not where the loop test leaves to',
    sound: false,
    guardedBy: 'loop-break-exit.test.ts: a shared tail the exit also reaches lifts only as a flag',
    rejects: (c) => !c.exitIsTestOut,
  },
  {
    id: 'exit-runs-nothing-of-its-own',
    why: 'where the exit path runs no code of its own before the tail, a break reaches the tail and no copy is needed',
    sound: false,
    guardedBy:
      'loop-exit-return-tail.test.ts: an arm that reaches the exit itself is a `break`, and copies no tail past it',
    rejects: (c) => !c.exitRunsOwnBlock,
  },
  {
    id: 'entry-bypasses-exit',
    why: 'a path from before the loop that skips the exit lands on the epilogue the asm holds once after the loop',
    sound: false,
    guardedBy:
      'loop-exit-return-tail.test.ts: a tail also entered straight from before the loop, past the exit, stays refused',
    rejects: (c) => !c.lastResort && !c.enteredByArmsOrExitPath,
  },
  {
    id: 'tail-holds-cycle',
    why: 'a tail holding a loop would be written once per arm where the asm holds it once: the reading of last resort, after every reading that copies none',
    sound: false,
    guardedBy: 'loop-exit-return-tail.test.ts: a tail holding a loop of its own stays refused',
    rejects: (c) => !c.cycleRung && !c.acyclicPast,
  },
];

/** One block the `bypassTail` count (at `earlyReturnArm`) weighs for an arm: a return
 *  tail the loop's own exit path does not run, which a path from outside the loop also enters. */
export interface BypassTailCandidate {
  /** asked by `while (1)`'s last rung (`ArmCopies.cycles`): the tail may hold a loop */
  readonly cycleRung: boolean;
  /** neither the block nor anything past it holds a cycle */
  readonly acyclicPast: boolean;
}

/** When an early-`return` arm may write a copy of a return tail another path from outside the loop
 *  also enters, off the loop's exit path. The argument is at `earlyReturnArm` ("A PATH THAT
 *  BYPASSES THE LOOP"); like `EXIT_TAIL_GATES`, no rule is sound, since every copy runs on a path
 *  exclusive of the others. Not in the table: the count's scope — the reading asked for it
 *  (`ArmCopies.offExitPath`), the block has an effect, the loop's own exit path does not run it,
 *  and a path from outside the loop enters it — which is the walk's own condition. */
export const BYPASS_TAIL_GATES: readonly Gate<BypassTailCandidate>[] = [
  {
    id: 'bypass-tail-holds-cycle',
    why: 'a tail holding a loop would be written once per arm where the asm holds it once: the reading of last resort, after every reading that copies none',
    sound: false,
    guardedBy: 'loop-exit-return-tail.test.ts: a bypassed tail holding a loop of its own is not written in the arm',
    rejects: (c) => !c.cycleRung && !c.acyclicPast,
  },
];
