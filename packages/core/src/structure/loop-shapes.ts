// asmlift structurer — the shapes loop recovery hands its emitters: a guarded self-loop
// (`LoopInfo`), a test-at-top `while` (`WhileLoopInfo`), a bottom-test `do-while` (`DoWhileInfo`),
// a `while (1)` (`ForeverLoopInfo`) with its two-level exit (`TwoLevelExit`), and the exits out of
// a body they all carry — an early `return` (`LoopArm`) and a `break` that runs code first
// (`BreakArm`). Types only: structure.ts recognizes and emits them.
import { Block, Value } from '../ir/core';

// Recovered info for a self-loop header: its exit block and the per-parameter back-edge
// arg it feeds (the value on the header→header edge). The back-edge arg is the "next"
// value of the phi; mapping it back to the phi turns the latch test into the while test.
export interface LoopInfo {
  header: Block;
  exit: Block;
  backArgOfParam: Value[]; // index-aligned with header.params
  /** The PURE forwarding block between the guard and the header, when the compiler's own
   *  loop-invariant motion parked computations there (`mov r3,#0x80; lsl r3,#24` feeding the
   *  latch test). Its defs render inline wherever the loop reads them; the block itself is never
   *  structured — the guard's inits come from ITS edge into the header instead. */
  preheader?: Block;
}

// One early-`return` exit out of a loop body, and the blocks of it that run ahead of the loop's
// update on every path that reaches them (`earlyReturnArm` decides which). Per-EDGE rather than
// flattened into per-loop sets: ownership is decided against `from`, so a second edge into the same
// target is a separate question. Two arms' `owned` sets may OVERLAP: a tail only the loop's exit arms
// run (`armsOnly`, the cross-jumped `h(i); return;` two arms end in) is owned by every arm that
// reaches it, and written once in each. A return tail the exit path also runs (`exitTail`) is written
// in the arm too, but owned by none: the exit path's copy runs it after the update. `owned` has one
// reader, `emitDoWhile`, which unions the arms' sets for its pre-update hazard check — an overlap
// only repeats a block in that union — and a `while` hoists no update, so it has no pre-update reads
// to exempt.
export interface LoopArm {
  from: Block;
  to: Block;
  owned: Set<Block>;
}

// A `break` whose arm RUNS CODE first: `if (t[i] == 7) { gHit = 1; break; }`. The arm's blocks never
// reach the latch, so they sit outside the natural loop as a second exit target; `codeBreakArm`
// says when they are one exit with code on the way.
export interface BreakArm {
  from: Block;
  to: Block;
  region: Set<Block>;
  /** where the region stops, where that is not the loop's exit: the second target of a two-level
   *  exit whose hit runs code of its own on the way there (`hitArmOf`, `TwoLevelExit`) */
  exit?: Block;
}

// A loop with no test of its own, `while (1)`: its latches are conditional continues, and it leaves
// by a `break` to `exit` or an early `return`. `exit` is null for a loop no edge leaves at all — the
// main loop that never returns — which has no break, no arm, and nothing after it.
export interface ForeverLoopInfo {
  header: Block;
  latches: Block[];
  forwardPreds: Block[];
  exit: Block | null;
  body: Set<Block>;
  arms: LoopArm[];
  breaks: Set<Block>; // the body blocks whose edge to `exit` is a `break`, or whose edge enters a `breakArms` arm
  breakArms: BreakArm[];
  twoLevel?: TwoLevelExit;
  /** the inner loops that hand this loop an outward two-level exit (`TwoLevelExit.outward`), by
   *  header, each with the blocks its hit leaves from */
  handed?: Map<Block, Set<Block>>;
}

// A SECOND EXIT PAST THE CODE AFTER THE LOOP: `for (j…) { if (hit) goto next; } k(i); next: …`, the
// `goto` a search loop takes out of its own exit region. The loop leaves to `exit` and, from the
// blocks in `from`, to `to`, a block every path from `exit` reaches unless it leaves first
// (`twoLevelCandidate`). L3 holds no `goto` past arbitrary code, so a flag spells it: `f = 0;`
// ahead of the loop, `f = 1; break;` on the edge to `to`, and the code from `exit` up to `to` under
// `if (f == 0)` after it (`emitForever`). Only a `while (1)` takes one, and only where no other
// reading fits. l3/caseendgoto.ts reads that shape back, so a change to it is a change to that
// respell's matcher too.
//
// OUTWARD: `for (i…) { for (j…) { if (hit) { s(j); goto out; } } k(i); } out:`, the `goto` out of
// BOTH loops. `to` lies past the enclosing loop, and the code from it runs on to that loop's own exit
// (`outwardExitOf`). The flag is handed out one loop at a time: the hit runs that code and `f = 1;
// break;`, and `if (f != 0) break;` follows the loop at once, ahead of everything the hit skips.
// Both loops must take the reading, the enclosing one recording it as `handed`, or neither does.
//
// A HIT THAT RUNS CODE FIRST: `for (j…) { if (hit) { a = 1; k(j); goto out; } } k(i); out: …`. The
// edge out of the body enters the hit's own code, which the code after the loop never meets; the
// block that code runs on to is the second target (`hitArmOf`), and the hit is a break arm whose
// region stops there (`BreakArm.exit`), written ahead of `f = 1; break;`. sub_0800D188's MAGNET/BOX
// case is one, its `out:` the `break;` that ends the case, behind which the switch's own `break;`
// leaves the loop around it: agbcc threads the `goto` to the code after that loop (jump.c
// `follow_jumps`), the merge of the switch and the exit of the loop at once. No goto-free spelling
// matches those bytes (the flag adds a variable), so the hit rung is asked only where every
// structuring without it declines (`LAST_RESORT_RUNGS`), and the ranked `/case-end-goto` respells
// the flag read at such a case end as the goto itself (l3/caseendgoto.ts).
export interface TwoLevelExit {
  to: Block;
  from: Set<Block>;
  outward?: true;
}

// A test-at-top multi-block `while`. The header is a pure test whose cond_br enters `bodyEntry`
// (inside the loop) or leaves to `exit` (the single loop exit). Unlike LoopInfo the condition reads
// the header's params directly (top-of-iteration values) — no back-edge substitution.
export interface WhileLoopInfo {
  header: Block;
  bodyEntry: Block;
  exit: Block;
  latch: Block; // the single block with the back-edge to header (its args = the update)
  forwardPreds: Block[]; // header preds outside the loop body (the entry/init side)
  body: Set<Block>; // the pure natural-loop body (for in-body vs exit classification)
  arms: LoopArm[]; // the early-`return` exits out of the body (`earlyReturnArm`)
  breaks: Set<Block>; // the body blocks whose edge to `exit` itself is a `break`, or enters a `breakArms` arm
  breakArms: BreakArm[];
}

// A bottom-tested `do { body } while(cond)`. The header is the body entry (entered before any
// test); the LATCH holds the loop condition and the single exit. Body = header..latch structured, then
// the latch's own ops + the loop-update; the latch test is the do-while condition. The condition is
// read under the latch back-edge substitution (post-update the params hold their next-iteration value).
export interface DoWhileInfo {
  header: Block;
  latch: Block;
  exit: Block;
  forwardPreds: Block[];
  body: Set<Block>; // the pure natural-loop body (for in-body vs exit classification)
  arms: LoopArm[];
}

/** What one `while (1)` reading asks of `foreverShape` past the default: an arm may copy a tail the
 *  exit path also runs (`copyExitTail`), take one edge as a two-level exit (`twoLevel`,
/** What one `while (1)` reading asks of `foreverShape` past the default: an arm may copy a tail the
 *  exit path also runs (`copyExitTail`), take one edge as a two-level exit (`twoLevel`,
 *  `TwoLevelExit`), hand a `goto` out of both loops out one loop at a time (`outward`,
 *  `TwoLevelExit.outward`), copy past `entry-bypasses-exit` and a bypassed return tail
 *  (`lastResort`, `ArmCopies.offExitPath` and `onExitPath`), and copy a loop in a tail it shares
 *  (`cycles`, `ArmCopies.cycles`). */
export interface ForeverAsk {
  readonly copyExitTail?: boolean;
  readonly twoLevel?: boolean;
  /** a two-level exit's hit may run code of its own first (`hitArmOf`) */
  readonly hits?: boolean;
  readonly outward?: boolean;
  readonly lastResort?: boolean;
  readonly cycles?: boolean;
}
