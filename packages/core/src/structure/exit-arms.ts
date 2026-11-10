// asmlift structurer — the exits out of a loop body and the blocks each one writes: a `break`
// that runs code first (`codeBreakArm`) and an early `return` (`earlyReturnArm`), with the
// duplication policy that decides which tails an arm may copy (`ArmCopies`) and the reachability
// it reads (`offExitPathOf`, `onlyFromBody`, `acyclicThrough`). The gate tables they ask are
// loop-gates.ts; the loop shapes that carry the arms are loop-shapes.ts.
import { Block, reachForward, successorsOf } from '../ir/core';
import { effectful } from '../ir/discipline';
import { type Gate, firstRejection } from '../l3/gates';
import {
  BREAK_TAIL_GATES,
  BYPASS_TAIL_GATES,
  type BreakTailCycle,
  type BypassTailCandidate,
  EXIT_TAIL_GATES,
  type ExitTailCandidate,
} from './loop-gates';

/** What {@link earlyReturnArm} reads beyond its arguments: block dominance and forward
 *  reachability, both of them whole-function facts computed once per `structure()`. */
interface EarlyReturnArmDeps {
  dom: Map<Block, Set<Block>>;
  reachFrom: (b: Block) => Set<Block>;
  preds: ReadonlyMap<Block, Block[]>;
}
/** The arm `from -> to` breaks to `exit` after running code: the region `to` heads re-enters no
 *  `body` block and leaves only for `exit` or by a `ret` of its own. Returns that region, or null.
 *  The region is written inside the loop, ahead of the `break` — a `ret` among it as the `return` it
 *  is: `if (t[i] == 7) { if (k) return; gHit = 1; break; }`.
 *
 *  UNSHARED (the default, and the header-exit caller), `to` is entered by that edge alone and the
 *  region admits no edge from outside itself, so each region block is written once and the region
 *  owns its `ret`s: the `return` is written where the asm holds its one copy.
 *
 *  A TAIL SEVERAL BREAKS SHARE, with `shared` (what `exitArmOf` passes for every in-body code arm):
 *  `if (a) f |= 1; else if (b) f |= 2; else continue; gHit = i; break;` compiles to two arms that
 *  each run their own code and jump to one `gHit = i` block on the way out (agbcc and gcc2.7.2
 *  cross-jump arms written with a tail each into that same shape, jump.c). The region is then
 *  admitted when the arm's head is entered only from the body (a body block, or a block every path
 *  into which comes from the body without passing `exit`: the other arm's own blocks, whose exit
 *  edge the classifier must admit as an arm of its own, or the loop declines), every other block an
 *  edge from outside enters is one the loop's own exit path does not run (`offExitPath`), and the
 *  region holds no cycle, save at `while (1)`'s last rung (`BREAK_TAIL_GATES`). Each arm writes the
 *  shared blocks again ahead of its own `break`, a shared `ret` as one `return` per arm, and a path
 *  from outside the loop (an `else` before it) structures its own copy where the block sits. Those
 *  paths are exclusive — a path that left the body by an arm reaches a region block again only
 *  through `exit`, and the exit does not reach it — so every path runs the tail once, as the asm
 *  does, whatever the tail does; where the compiler cross-jumps, the copies are the same code
 *  (gcc2.7.2kmc byte-identical, agbcc up to register allocation).
 *
 *  THE COST where it does not: ido keeps one tail, and only the source's single copy at the arms'
 *  join recompiles to it. `synthetic:brmerge:ido7.1`'s row source is byte-identical to its target;
 *  the per-arm spelling compiles to 52 instructions against 50 (an extra `lui` and `sb`), so that
 *  row cannot MATCH this way. The single copy needs a `continue` that runs the latch's update — a
 *  `for` whose `inc` is that update, or a `do`/`while` whose test the `continue` reaches — and
 *  structure writes `continue` only to a `while (1)` header, while the L3 `for` respell refuses a
 *  body holding one (l3/ast.ts, the `for` node). */
export function codeBreakArm(
  preds: ReadonlyMap<Block, Block[]>,
  dom: ReadonlyMap<Block, ReadonlySet<Block>>,
  from: Block,
  to: Block,
  body: ReadonlySet<Block>,
  exit: Block,
  shared = false,
  cycles: { cycleRung: boolean; gates: readonly Gate<BreakTailCycle>[] } = NO_SHARED_CYCLES,
): Set<Block> | null {
  if (to === exit || body.has(to)) {
    return null;
  }
  const region = new Set<Block>();
  let leaves = false;
  for (const stack = [to]; stack.length > 0;) {
    const x = stack.pop()!;
    if (x === exit) {
      leaves = true;
      continue;
    }
    if (region.has(x)) {
      continue;
    }
    const t = x.ops[x.ops.length - 1];
    if (body.has(x) || (t.opcode !== 'br' && t.opcode !== 'cond_br' && t.opcode !== 'ret')) {
      return null; // re-enters the loop, or dispatches
    }
    region.add(x);
    stack.push(...successorsOf(x));
  }
  // Shared: the arm's head is entered from another arm when every path into the entering block
  // comes from the body without passing `exit` — the body block itself, or the other arm's own
  // blocks. Never from outside the loop: an edge straight from the body into a block others enter
  // too is a `break` to it, which `while (1)` writes once, after the loop.
  const armOfBody = onlyFromBody(preds, body, exit);
  // Shared, past the head: a block may be entered from anywhere — another arm, or outside the loop —
  // when the loop's own exit path does not run it (`offExitPathOf`). agbcc cross-jumps a `break`
  // that assigns a `u8` with an `else` before the loop that assigns the same `u8` into one `lsr`
  // truncation block, and a `gLast = id;` both write into one `strb` (jump.c); gcc2.7.2kmc keeps one
  // `jal note` the arm's `beql` and the `else` both enter. The per-arm copy is the source's spelling.
  const offExitPath = offExitPathOf(exit, dom);
  let entersShared = false;
  const entered = (x: Block) =>
    (preds.get(x) ?? []).every(
      (p) =>
        region.has(p) ||
        (x === to && p === from) ||
        (shared && (x === to ? armOfBody(p) : offExitPath(x)) && (entersShared = true)),
    );
  if (!leaves || ![...region].every(entered)) {
    return null;
  }
  // A region another arm enters is written once per arm. One only its own edge enters is written
  // once wherever it sits. An acyclic one is written by a walk that meets each block once.
  if (!entersShared || [...region].every((x) => acyclicThrough(x, region))) {
    return region;
  }
  // A SHARED TAIL HOLDING A LOOP: agbcc's `case MAGNET: if (..) continue; ... for (j = 0; j < n; j++)
  // if (t[j] == id) goto found; ... break;` cross-jumps two cases' `break`s into one search loop.
  // Each arm writes its own copy of that loop ahead of its `break`, at `while (1)`'s last rung only
  // (A LOOP IN THE TAIL, at `earlyReturnArm`).
  return firstRejection(cycles.gates, { cycleRung: cycles.cycleRung }) === null ? region : null;
}
const NO_SHARED_CYCLES = { cycleRung: false, gates: BREAK_TAIL_GATES } as const;
/** The duplication policy's admission (written at `earlyReturnArm`): is a block one the loop's own
 *  exit path does not run? Forward only (`reachForward`): round an enclosing loop's back-edge the exit
 *  reaches the inner loop again, which is the next iteration running the block again in the asm too,
 *  not the fall-through path running it after the loop. Computed on first use. */
function offExitPathOf(exit: Block, dom: ReadonlyMap<Block, ReadonlySet<Block>>): (b: Block) => boolean {
  let fromExit: Set<Block> | undefined;
  return (b) => !(fromExit ??= reachForward(exit, dom)).has(b);
}
/** Does every path into a block come from `body` without passing `exit`? True of a body block, and
 *  of a block outside whose every predecessor is one — a loop exit arm's own blocks, and a tail only
 *  those arms enter. Memoised per call; a cycle back to a block is no path from the body. */
function onlyFromBody(
  preds: ReadonlyMap<Block, Block[]>,
  body: ReadonlySet<Block>,
  exit: Block,
): (b: Block) => boolean {
  const fromBody = new Map<Block, boolean>();
  const armOfBody = (p: Block): boolean => {
    if (body.has(p)) {
      return true;
    }
    const known = fromBody.get(p);
    if (known !== undefined) {
      return known;
    }
    fromBody.set(p, false);
    const into = preds.get(p) ?? [];
    const ok = p !== exit && into.length > 0 && into.every(armOfBody);
    fromBody.set(p, ok);
    return ok;
  };
  return armOfBody;
}
/** Does no path inside `region` lead from `x` back to `x`? */
function acyclicThrough(x: Block, region: ReadonlySet<Block>): boolean {
  const seen = new Set<Block>();
  for (const stack = successorsOf(x); stack.length > 0;) {
    const y = stack.pop()!;
    if (y === x) {
      return false;
    }
    if (region.has(y) && !seen.has(y)) {
      seen.add(y);
      stack.push(...successorsOf(y));
    }
  }
  return true;
}

/** Which copies past the duplication policy's defaults a reading asks an exit arm for: the counts
 *  for a path that bypasses the loop (A PATH THAT BYPASSES THE LOOP, at `earlyReturnArm`), and a
 *  tail holding a loop. */
export interface ArmCopies {
  /** `bypassTail`: a return tail off the loop's exit path that a path from outside also enters */
  readonly offExitPath: boolean;
  /** the `exitTail` count waives `entry-bypasses-exit` */
  readonly onExitPath: boolean;
  /** `while (1)`'s last rung: a tail an arm copies may hold a loop, a `break` tail
   *  (`BREAK_TAIL_GATES`) and a return tail (`tail-holds-cycle`, `BYPASS_TAIL_GATES`) alike */
  readonly cycles: boolean;
}
export const NO_COPIES: ArmCopies = { offExitPath: false, onExitPath: false, cycles: false };

// An early `return` out of the loop: forward-walking from `to` WITHOUT re-entering the loop `body`,
// every path terminates in a `ret`. agbcc/gcc merge every `return` into ONE epilogue block and each
// return site just sets the return register and branches there, so a second body exit that lands on
// such a chain is an early RETURN, not a break to a live merge — which is what lets two returns
// merged through a shared `bx lr` recover as a `while` with an in-body early `return` instead of
// declining as "multi-exit".
//
// The arm is structured AT the edge, so any block in it that a second path also reaches is emitted
// twice. A duplicated `return v` is harmless — both copies sit on mutually exclusive paths, so this
// is a FIDELITY rule, not a soundness one.
//
// ONE DUPLICATION POLICY for loop exit arms, here and in `codeBreakArm`'s shared mode. A block with
// effects may be written once per arm when the loop's own exit path does not run it (`offExitPathOf`)
// and it holds no cycle (save at `while (1)`'s last rung, below), whoever else enters it — another
// arm, or a path from before the loop (an `else` beside it). A path that left the body by an arm
// reaches the block only through that arm, because the exit does not reach it; a path from before the
// loop never ran an arm. The paths are exclusive, so each runs one copy once, the arm's or the one
// written where the block sits; on a compiler that cross-jumps (agbcc, gcc2.7.2: jump.c) those copies
// are the source the one block came from. Whether the block has an effect does not enter into it. A
// block the loop's own exit path also runs is, for a `break`, written once, after the loop: the arm's
// `break` reaches it there. `codeBreakArm`'s shared region stops at `exit`, so the loop's own arms
// bound it and it takes no size limit. This walk applies the same policy to a tail that ends in its
// own `return`: an effectful block is admitted only on one of the counts below, and refused
// otherwise. `exitTail` is the one place an arm copies a block the exit path also runs: a `return`
// tail no `break` can reach without running the exit's own code first.
//
// THE EDGE OWNS IT. `from` dominates `to` and `to` dominates the block, so every path reaching it
// runs this edge's predecessor and then this region — and only one edge into `to` can satisfy the
// first half, since two predecessors cannot both dominate it. And the region must not be reachable
// forward from the loop's own exit (`offExitPathOf`), which dominance does NOT rule out: an arm
// landing straight on the post-loop join dominates itself, and claiming it would emit the epilogue
// on both paths. Testing `to` covers the whole region — a block dominated by `to` that the exit
// reached would mean the exit reached `to`.
//
// ONLY THE LOOP'S EXIT ARMS RUN IT (`armsOnly`): the policy's count, plus every path into it comes
// from the body without passing `exit` (`onlyFromBody`). Two arms ending in the same `h(i); return;`,
// which agbcc and gcc2.7.2kmc cross-jump into one block no edge dominates, write it once each: the
// arms run on exclusive paths, so each path still runs it once. The `while` reading that takes one
// such arm for the exit stays refused — the other arm's tail is then reachable from it — so the loop
// falls to the reading whose exit runs nothing of the tail. A shared epilogue the exit also reaches
// still has to be pure, unless the exit path runs a block of its own first (`exitTail`, below).
//
// A PURE block the count admits is owned as well, though no effect forces it. The arms write it
// whether or not they own it, so owning it changes no spelling; what it changes is `emitDoWhile`'s
// escape check, which judges every block no arm owns as code run after the loop, past the update. A
// block only the arms enter runs ahead of the update on every path, so a read there of a loop
// variable is the pre-update value the arm's copy renders. agbcc cross-jumps two of three
// `p.at = …; p.kind = seg->kind; return p;` arms into one such block, reading the element pointer
// the body computed (`synthetic:sretpuretail`); unowned, it would decline the loop as a post-loop
// read of a pre-update variable.
//
// THE EXIT PATH RUNS IT TOO, AFTER CODE OF ITS OWN (`exitTail`). `for (i = 0; i < gCount; i++) { if
// (gTab[i] == x) { *out = r; return; } } gMiss = 1; *out = r;` (`synthetic:retpost_tail`): agbcc
// cross-jumps the arm's `b` to the return label onto the identical `*out = r` before it (jump.c), and
// gcc2.7.2kmc and gcc2.7.2 hold that one store in the `jr ra` delay slot, so the arm and the exit path,
// past `gMiss = 1`, end in one `store; ret` block. A `break` would land on `gMiss = 1`, so nothing but
// a copy spells the arm: the arm writes the tail and its `return`, and the exit path keeps the copy
// written after the loop. Sound for the reason the policy is: a path that took the arm reaches the
// block only through the arm's copy, which ends in its `return`, and the exit path never ran the arm,
// so each path runs one copy once. A copy is the reading of last resort: the caller asks for it
// (`copyExitTail`) only once every reading of the loop has failed without it, since another exit can
// let the arm `break` to the tail (agbcc's rotated `if (bit(i)) { x = i; break; }`, where taking the
// `x = i` arm for the exit would copy the tail into the count test's edge). The count's SCOPE is a
// copy asked for and an effectful block the exit path runs; within it, a block is admitted when no
// rule of `EXIT_TAIL_GATES` refuses it. The rules, in table order, and why each exists:
//   - `arm-leaves-by-latch`: the arm does not leave by a latch, the loop's own way out. agbcc's
//     peeled first test entering a `hit(i); break;` arm leaves no reading with the latch's target as
//     the exit, and the one that took the arm for it would copy the post-loop `out()` into the body
//     as an early return;
//   - `exit-not-test-out`: the exit is where the loop's test leaves to: a latch enters it, or a path
//     from before the loop (the zero-trip guard). An exit only a mid-body branch enters is
//     indistinguishable from an arm: the `while` reading of `if (t[i] == 7) { Ping(i); Hit(a);
//     return; } if (t[i] == 8) { Pong(i); Hit(a); return; }` (`synthetic:retarm2_tail:agbcc`) takes
//     the `Ping` edge for its exit and would copy `Hit(a)` past it; `while (1)`, which keeps both
//     arms without a copy, is read first there, so the rule's live case is a top-tested loop whose
//     header leaves to a `pre()` ahead of the arms' shared tail;
//   - `exit-runs-nothing-of-its-own`: the exit path reaches the block after a block of its own:
//     `exit`, which the arm never reaches. That block need not have an effect: agbcc cross-jumps `{
//     *out = r; return; }` onto the post-loop `r = 0; *out = r;` as well, a register move falling
//     into the one store. An arm that reaches `exit` itself is a `break` to it, which `while (1)`
//     spells; the `do-while` reading would copy the exit's code and the tail into it;
//   - `entry-bypasses-exit`: every predecessor is an arm's block (`onlyFromBody`) or on the exit's
//     forward path — never an entry from before the loop that bypasses the exit (the paragraph below
//     says why), save at the reading of last resort (A PATH THAT BYPASSES THE LOOP);
//   - `tail-holds-cycle`: neither the block nor anything past it holds a cycle, so the region past it
//     only returns, and each copy is one walk, never a loop written once per arm, save at the last
//     rung (A LOOP IN THE TAIL, below).
// None is `sound`: each copy runs on a path exclusive of the others, so a refusal here picks which
// reading of the loop is written, never whether the C means the asm. What keeps a copied tail sound
// is that the arm does not own it (`emitDoWhile`'s escape check, `a tail the exit path also runs
// stays post-loop for the escape check of a \`do-while\``).
//
// WHY A RETURN TAIL ASKS MORE THAN THE POLICY. An entry from before the loop that bypasses the exit
// is sound to copy past — the paths are exclusive — but into a tail that returns it is, in the common
// shape, the loop's own zero-trip guard landing on the post-loop epilogue: `for (i = 0; i < n; i++) {
// if (t[i] == 7) { ping(i); return; } } out(0);`. Admitting it lets the `while` reading take the early-return arm for
// the exit and copy `out(0); return;` into the body, where the asm holds it once after the loop
// (ido7.1 and mwcc_242_81 re-spell `while (1)` that way, equivalent but not the source's shape).
// What it would buy is an `else` before the loop that cross-jumps into the arms' tail (agbcc's
// `else { pong(9); hit(a); return; }`), and that is taken only at the reading of last resort (A PATH
// THAT BYPASSES THE LOOP).
//
// A PATH THAT BYPASSES THE LOOP. agbcc cross-jumps an arm's `fin(..); return;` onto the identical
// tail of an `if` branch before the loop or of a sibling `case` of an outer switch (jump.c
// `find_cross_jump`), so the arm runs into a `call; ret` block a path from outside the loop also
// enters, which no count above admits. Two counts take it, each sound for the policy's reason, and
// each asked for by the reading (`ArmCopies`), never by default. Neither can tell a cross-jump
// from a source `goto` into a shared tail, since the asm is the same: what each admits is the shape,
// on every toolchain, and the rows name the cross-jump only as its commonest source:
//   - `bypassTail` (`offExitPath`): an effectful block the loop's own exit path does not run, which a
//     path from outside the loop enters (not only the loop's arms: a tail only they enter is a
//     `break` target, written once after the loop), is admitted, the arm's own head included, when
//     no rule of `BYPASS_TAIL_GATES` refuses it. A path that took the arm reaches it only through
//     the arm's copy, which ends in its `return`; a path from outside never ran the arm, and the exit
//     never reaches it. It is not owned: a path that did not take the arm runs it too
//     (`synthetic:sw_xjret`, `synthetic:sw_xjret_case`). It is asked at the last resort, and by
//     `while (1)` (`foreverShape`) where a reading without it takes an exit laid out between the
//     body's first and last blocks and an exit past the loop's body fits with it (never an exit laid
//     out ahead of the loop: a label a `goto` jumps back to). An exit in the span may be an early
//     `return` read as the exit, which leaves the post-loop epilogue the paragraph above names off
//     the exit path; under an exit past the body that epilogue is on it, never this count's. The
//     in-span exit stays first, and the exit past the loop is taken only by a structuring run again
//     because the first declined (`PastExitRanking`, at `structure`). Klonoa's sub_08016EEC has the
//     shape (`synthetic:sw_xjret_end`): a loop that ends a `case` takes the arm's own head for its
//     exit, and declines at the switch inside it;
//   - `onExitPath`, at the reading of last resort only: the `exitTail` count waives
//     `entry-bypasses-exit`, so a tail the exit path runs past code of its own is copied although a
//     path from before the loop also lands on it: that path ran neither the arm nor the exit
//     (`synthetic:sw_xjret_post`, where the code after the loop ends in the same `fin(..); return;`).
//     Every other `exitTail` rule still holds. What it admits is any effectful return tail a branch
//     before the loop also enters, cross-jumped or not: the zero-trip epilogue the paragraph above
//     names among them, taken only where every other reading declines. A search loop's found arm
//     that jumps past the not-found code into a join the guard also enters (`if (f) { for (..) if
//     (hit) { id = i; goto j; } id = 3; } else id = 26; j: out(id);`, on gcc2.7.2, gcc2.7.2kmc and
//     ido7.1 as on agbcc) lifts this way with the join written in the arm, where a two-level exit
//     carrying the value would write it once; an unrolled search writes it once per arm.
//
// A LOOP IN THE TAIL. A cycle in a copied tail is the policy's one exception, and it is one rule
// wherever the tail ends: in `break` (`codeBreakArm`, `BREAK_TAIL_GATES`) or in `return`
// (`tail-holds-cycle` above, `BYPASS_TAIL_GATES`). Each arm may write its own copy of the loop, but
// only at `while (1)`'s last rung (`ArmCopies.cycles`), after every reading that copies none: one
// loop the asm holds once, written twice. The copies are exclusive for the policy's reason, so each
// path runs one copy and runs its loop as the asm runs the one loop; the walk never re-enters the
// body, so no copy's loop reaches back into it; and a block on the cycle is never owned (`armsOnly`
// asks for none). Each copy is structured by the reading its own natural loop takes, and a cycle
// entered at two blocks, which has none, declines loud at emission.
//
// Returns the blocks the arm OWNS — the ones that run ahead of the loop's update on every path that
// reaches them — or null when this is not an early-`return` arm. The arm writes every block its walk
// admits, owned or not: an `exitTail` block is admitted but not owned, since the exit path runs it
// after the update. Not exclusive to the arm: a block the `armsOnly` count admits is owned by every
// arm that reaches it, so two arms' sets can share it. `latches` are the loop's latches;
// `exitTailGates` the refusals the `exitTail` count is held to (`EXIT_TAIL_GATES`).
export function earlyReturnArm(
  { dom, reachFrom, preds }: EarlyReturnArmDeps,
  from: Block,
  to: Block,
  body: Set<Block>,
  exit: Block,
  latches: readonly Block[],
  copyExitTail: boolean,
  exitTailGates: readonly Gate<ExitTailCandidate>[] = EXIT_TAIL_GATES,
  bypass: ArmCopies = NO_COPIES,
  bypassTailGates: readonly Gate<BypassTailCandidate>[] = BYPASS_TAIL_GATES,
): Set<Block> | null {
  // does the loop's own exit path run it? forward only (`offExitPathOf`)
  const offExitPath = offExitPathOf(exit, dom);
  const entryOwned = dom.get(to)!.has(from) && to !== exit && offExitPath(to);
  // the duplication policy's admission: the loop's own exit path does not run it, and no cycle holds
  // it — and, for a tail that returns, only the loop's exit arms enter it (`armsOnly`, below). Never
  // the arm's own head: an edge straight from the body into a block others enter too is a `break` to
  // it, which `while (1)` writes once, after the loop — unless the exit path reaches it after a block
  // of its own, which no `break` can skip (`exitTail`).
  const armOfBody = onlyFromBody(preds, body, exit);
  const armsOnly = (bb: Block) =>
    bb !== to && bb !== exit && armOfBody(bb) && offExitPath(bb) && !reachFrom(bb).has(bb);
  // a return tail the loop's own exit path also runs, after a block of its own (THE EXIT PATH RUNS IT
  // TOO, above), asked for only when the caller has found no reading without it
  const acyclicPast = (bb: Block) => ![bb, ...reachFrom(bb)].some((y) => reachFrom(y).has(y));
  const exitTail = (bb: Block): boolean =>
    copyExitTail &&
    !offExitPath(bb) &&
    firstRejection(exitTailGates, {
      armLeavesByLatch: latches.includes(from),
      lastResort: bypass.onExitPath,
      cycleRung: bypass.cycles,
      get exitIsTestOut() {
        return (preds.get(exit) ?? []).some((p) => !body.has(p) || latches.includes(p));
      },
      // `exit` itself, which the arm never reaches (so `bb` is never `exit`, which the loop writes
      // after it)
      get exitRunsOwnBlock() {
        return to !== exit && !reachFrom(to).has(exit);
      },
      get enteredByArmsOrExitPath() {
        return (preds.get(bb) ?? []).every((p) => armOfBody(p) || !offExitPath(p));
      },
      get acyclicPast() {
        return acyclicPast(bb);
      },
    }) === null;
  // a return tail off the exit path that a path from outside the loop also enters (A PATH THAT
  // BYPASSES THE LOOP, above), asked for by the reading
  const bypassTail = (bb: Block): boolean =>
    bypass.offExitPath &&
    offExitPath(bb) &&
    bb !== exit &&
    !armOfBody(bb) &&
    firstRejection(bypassTailGates, {
      cycleRung: bypass.cycles,
      get acyclicPast() {
        return acyclicPast(bb);
      },
    }) === null;
  const owned = new Set<Block>();
  const seen = new Set<Block>();
  const stack = [to];
  while (stack.length) {
    const bb = stack.pop()!;
    if (seen.has(bb)) {
      continue;
    }
    seen.add(bb);
    if (body.has(bb)) {
      return null;
    } // re-enters the loop → not an exit
    if ((entryOwned && dom.get(bb)!.has(to)) || armsOnly(bb)) {
      owned.add(bb);
    } else if (bb.ops.some(effectful) && !exitTail(bb) && !bypassTail(bb)) {
      return null;
    }
    const t = bb.ops[bb.ops.length - 1];
    if (t.opcode === 'ret') {
      continue;
    }
    if (t.opcode === 'br' || t.opcode === 'cond_br') {
      for (const s of t.successors) {
        stack.push(s.block);
      }
      continue;
    }
    return null; // switch_br / unknown terminator → decline
  }
  return owned;
}
