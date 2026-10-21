// asmlift — un-threading a loop exit the compiler jump-threaded past the test that follows the loop
// (ISA-neutral CFG pass).
//
// `for (i = 0; i < 3; i++) if (x == t[i].a || x == t[i].b) break;  if (x == t[i].a) A; else B;` —
// the code after the loop repeats the test the first `break` just made. GCC's jump threading
// (agbcc jump.c:4517 `thread_jumps`, on from -O1, toplev.c:3598) sees that the branch out of the
// loop on `x == t[i].a` lands on a block R that compares the same operands again, and retargets the
// branch straight at R's taken arm:
//
//     E:  ld v, t[i].a;  cmp x, v;  beq A          ; was: beq R
//         ...                                      ; the loop's other exits reach R
//     R(j):  ld w, t[j].a;  cmp x, w;  bne B       ; falls into A
//
// The loop then leaves for two blocks, A and R, and no loop spelling owns that: the function
// declines with 'unrecovered back-edge'. Pointing E back at R — the edge the source wrote — gives
// the loop one way out, and R re-tests on that path what E just tested, so it takes the edge E took.
//
// SOUND WHEN R'S BRANCH IS DECIDED BY E'S on the path E→R, and the rewrite then runs extra code that
// observes nothing. That is the compiler's own precondition read backwards (jump.c
// `rtx_equal_for_thread_p` on the operands, `comparison_dominates_p` on the codes, no register or
// memory the skipped insns depend on modified in between), and it is what the gates check:
//   • R runs nothing observable: no effect, no qualified or device access, no op that traps, so
//     running it once more on E's path changes nothing but which edge is taken;
//   • R's condition, read with R's params bound to the args E now hands it, is E's condition or its
//     negation (`sameAtEntry`, ir/entry.ts — the predicate the re-roll and guard fusion read), through
//     memory reads in R and in E's block after its last effect only: both read the memory E's branch
//     saw, and a read anywhere else may see other memory;
//   • the edge that decides R's branch on E's sense reaches E's old target T with E's own args —
//     directly (S == T, agbcc), or through one block S that runs nothing observable and branches to
//     T (gcc2.7.2kmc moves the THEN arm's `li v0,1` into the threaded branch's delay slot, so E
//     carries the arm's value as an arg and the arm itself is skipped).
// Then E→R→(S→)T computes what E→T did, and on every other path nothing moved. R may also be a
// block that runs nothing observable and forwards (`br`) to the block Q that re-tests: gcc2.7.2 -O1
// re-masks a `u8` operand on each exit's own block (the latch fall-through and a `beql` delay
// slot), which merge into one exit target ahead of the re-test. Q is then judged as R is above, on
// the values R's `br` hands it.
//
// SCOPE, not soundness (the heuristic gates): only the decline shape. R must be another exit target
// of the same loop and E the loop's only edge to T, so each rewrite takes one exit target away; and
// T must not merely return, because an exit that returns is an early `return` the structurer already
// spells. Every function that lifted without this pass keeps its CFG.
//
// THE ARGS E HANDS R, per param: a value, among those the loop's in-loop edges into R hand it, that
// is defined at E (dominates E's block). A bottom-tested loop's latch hands R the stepped counter,
// which E never sees, and its in-body exits hand R the counter E reads; only the second is defined
// at E. When kmc puts the step in the threaded branch's delay slot (`beq a1,v0,L` / `addiu v1,v1,4`),
// the stepped pointer is defined at E too, and R has two candidates. Each choice is only a proposal:
// the comparison above is what makes it sound, so every combination of candidates (at most
// `MAX_PROPOSALS`) is judged, and the first the gates admit is taken; a param with no such value
// refuses. Inhabitants: `synthetic:thrbreak:agbcc` (top-tested, every exit hands one counter,
// S == T), the pointer walk `synthetic:thrwalk`
// `for (p = t; p < t + 3; p++) if (x == p->a || x == p->b) break;  if (x == p->a) A; else B;`
// (gcc2.7.2kmc: bottom-tested, through S; gcc2.7.2: R a forwarder, through S), and
// `synthetic:thrwalkba`, its tests swapped, where kmc's delay-slot step gives R two candidates.
// Not `synthetic:thrbreak:gcc2.7.2kmc`, whatever the counter's width: kmc indexes `t[i]` there by
// a value each exit computes on its own block (`i<<2`, re-masked `i & 0xff` for a `u8`, in the exit
// branch's delay slot), so no value R reads is defined at E. That row lifts through the break tail
// its exits share instead (structure.ts `codeBreakArm`). Nor a gcc2.7.2 walk with two separate
// break tests (`if (x == p->a) break; if (y == p->b) break;`): every in-loop edge hands R an
// `x & 0xff` its own block re-masked, none defined at E, so it declines loudly.
import { Block, Fn, Op, Value, dominators, predecessors, successorsOf } from '../ir/core';
import { effectful, placedAt, spelledWhenDead } from '../ir/discipline';
import { type EntryReading, sameAtEntry } from '../ir/entry';
import { analyzeLoops } from '../ir/loops';
import { NEGATED_ICMP, opSig } from '../ir/opcodes';
import { simplifyTrivialPhis } from '../ir/simplify';
import { type Gate, firstRejection } from '../l3/gates';
import { returnsPurely } from './latch';

/** One loop exit edge E→T and another exit target R of the same loop that re-tests E's test. */
export interface ThreadedExit {
  /** E's block (in the loop) and which successor of its `cond_br` leaves for T */
  from: Block;
  index: number;
  /** E's target, and the block R the edge would be pointed back at: the re-test, or a forwarder to it */
  target: Block;
  retest: Block;
  /** does another exit edge of the same loop reach T? */
  targetShared: boolean;
  /** does every path from T reach a `ret` without an effect on the way? */
  targetReturns: boolean;
  /** does R (or the re-test it forwards to, or the S it reaches T through) run an op whose second
   *  run is observable? */
  observable: boolean;
  /** the args E would hand R: per param, one of the values the in-loop edges into R hand it that is
   *  defined at E (one proposal; each combination of such values is a site of its own) */
  args: Value[];
  /** once E reaches R, does every value R and the blocks it reaches read still dominate its reader? */
  dominated: boolean;
  /** is R's condition, on E's args, E's condition or its negation — and which one decides S? */
  decided: boolean;
  /** does the decided edge reach T with E's args? */
  onward: boolean;
}

export const UNTHREAD_GATES: readonly Gate<ThreadedExit>[] = [
  {
    id: 'target-shared',
    why: 'pointing one of several exit edges into a block elsewhere takes no exit target away',
    sound: false,
    rejects: (c) => c.targetShared,
  },
  {
    id: 'target-returns',
    why: 'an exit that only returns is an early return arm, which loop recovery spells without this',
    sound: false,
    rejects: (c) => c.targetReturns,
  },
  {
    id: 'retest-observable',
    why: 'the re-test now runs on the exit path as well, so a second run of it must observe nothing',
    sound: true,
    guardedBy: [
      'unthread.test.ts: a re-test block that stores is left alone',
      'unthread.test.ts: a re-test whose onward block stores is left alone',
      'unthread.test.ts: a forwarder that stores is left alone',
    ],
    rejects: (c) => c.observable,
  },
  {
    id: 'not-dominated',
    why: 'a value the re-test (or a block after it) reads from above it must exist on the exit edge too',
    sound: true,
    guardedBy: [
      'unthread.test.ts: a re-test reading a value from a block the exit does not pass is left alone',
      'unthread.test.ts: a forwarder handing the re-test a value from the in-body exit’s block is left alone',
    ],
    rejects: (c) => !c.dominated,
  },
  {
    id: 'test-differs',
    why: 'only a re-test the exit’s own test decides takes the edge the exit took',
    sound: true,
    guardedBy: [
      'unthread.test.ts: a re-test of another operand is left alone',
      'unthread.test.ts: a re-test reading memory the exit block writes after its own read is left alone',
    ],
    rejects: (c) => !c.decided,
  },
  {
    id: 'onward-differs',
    why: 'the decided edge must hand the exit target what the exit edge handed it',
    sound: true,
    guardedBy: [
      'unthread.test.ts: a re-test whose THEN arm hands the join another value is left alone',
      'unthread.test.ts: a re-test whose decided edge is the other one is left alone',
    ],
    rejects: (c) => !c.onward,
  },
];

/** May a second run of `op` be observed? An effect, a placed access (volatile, device, a helper
 *  call), a trap — or `undef`, whose two copies are two storages' contents and not one value. */
const observable = (op: Op): boolean =>
  effectful(op) || placedAt(op) !== null || opSig(op.opcode)?.traps === true || op.opcode === 'undef';

/** Point every threaded loop exit the gates admit back at the re-test it skipped; returns how many. */
export function unthreadLoopExits(fn: Fn, gates: readonly Gate<ThreadedExit>[] = UNTHREAD_GATES): number {
  let done = 0;
  // one at a time: each rewrite changes the exits the next is judged against. Bounded — every rewrite
  // moves an exit edge off a block it was the loop's only edge into.
  for (let cap = fn.blocks.length * 4; cap > 0 && unthreadOne(fn, gates); cap--) {
    done++;
  }
  if (done > 0) {
    simplifyTrivialPhis(fn);
  }
  return done;
}

function unthreadOne(fn: Fn, gates: readonly Gate<ThreadedExit>[]): boolean {
  const preds = predecessors(fn);
  const dom = dominators(fn);
  const defs = new Map<Value, Op>();
  const defBlock = new Map<Value, Block>();
  for (const b of fn.blocks) {
    b.params.forEach((p) => defBlock.set(p, b));
    for (const op of b.ops) {
      op.results.forEach((r) => {
        defs.set(r, op);
        defBlock.set(r, b);
      });
    }
  }
  const dominatesAt = (v: Value, at: Block): boolean => {
    const d = defBlock.get(v);
    return d !== undefined && dom.get(at)!.has(d);
  };
  const forest = analyzeLoops(fn, dom);
  for (const nl of forest.byHeader.values()) {
    const targets = [...new Set(nl.exitEdges.map((e) => e.to))];
    if (targets.length < 2) {
      continue;
    }
    for (const E of nl.body) {
      const eTerm = E.ops[E.ops.length - 1];
      if (eTerm?.opcode !== 'cond_br') {
        continue;
      }
      for (let index = 0; index < eTerm.successors.length; index++) {
        const T = eTerm.successors[index].block;
        if (nl.body.has(T) || eTerm.successors[1 - index].block === T) {
          continue;
        }
        for (const R of targets) {
          if (R === T || R === E || eTerm.successors[1 - index].block === R) {
            continue;
          }
          const site = judge(nl.body, E, index, T, R, preds, dom, defs, defBlock, dominatesAt).find(
            (c) => firstRejection(gates, c) === null,
          );
          if (site === undefined) {
            continue;
          }
          eTerm.successors[index] = { block: R, args: site.args };
          return true;
        }
      }
    }
  }
  return false;
}

function judge(
  body: ReadonlySet<Block>,
  E: Block,
  index: number,
  T: Block,
  R: Block,
  preds: ReadonlyMap<Block, Block[]>,
  dom: ReadonlyMap<Block, Set<Block>>,
  defs: ReadonlyMap<Value, Op>,
  defBlock: ReadonlyMap<Value, Block>,
  dominatesAt: (v: Value, at: Block) => boolean,
): ThreadedExit[] {
  // THE SHAPE, untabled: R re-tests — it ends in a `cond_br` (only a branch re-takes E's decision),
  // or forwards to the block Q that does (`retestOf`) — and each of its params is handed, by some
  // in-loop edge into R, a value defined at E — a candidate arg. One site per combination of
  // candidates, refused as a whole past `MAX_PROPOSALS`.
  const Q = retestOf(R, body, T);
  if (Q === null) {
    return [];
  }
  const into = [...body].flatMap((p) => terminatorEdges(p).filter((s) => s.block === R));
  let proposals: Value[][] = [[]];
  for (let k = 0; k < R.params.length; k++) {
    const vals = [...new Set(into.map((s) => s.args[k]).filter((v) => v !== undefined && dominatesAt(v, E)))];
    proposals = proposals.flatMap((p) => vals.map((v) => [...p, v]));
    if (proposals.length === 0 || proposals.length > MAX_PROPOSALS) {
      return [];
    }
  }
  return proposals.map((args) => judgeArgs(body, E, index, T, R, Q, preds, dom, defs, defBlock, args));
}

/** The block whose `cond_br` re-tests on R's path: R itself, or the one block R forwards to with a
 *  `br`. gcc2.7.2 -O1 re-computes a re-test operand (`andi v1,a0,0xff`) on each exit's own block —
 *  the latch fall-through and the `beql` delay slot, which merge into one exit target — so R is that
 *  block and the re-test sits behind it, entered from the loop's guard as well. */
function retestOf(R: Block, body: ReadonlySet<Block>, T: Block): Block | null {
  const rTerm = R.ops[R.ops.length - 1];
  if (rTerm?.opcode === 'cond_br') {
    return R;
  }
  if (rTerm?.opcode !== 'br') {
    return null;
  }
  const Q = rTerm.successors[0].block;
  return Q !== R && Q !== T && !body.has(Q) && Q.ops[Q.ops.length - 1]?.opcode === 'cond_br' ? Q : null;
}

/** How many arg combinations one (exit, re-test) pair may propose. kmc's delay-slot step gives a
 *  pointer walk two; the bound keeps a re-test with many params from multiplying its comparisons. */
const MAX_PROPOSALS = 8;

function judgeArgs(
  body: ReadonlySet<Block>,
  E: Block,
  index: number,
  T: Block,
  R: Block,
  Q: Block,
  preds: ReadonlyMap<Block, Block[]>,
  dom: ReadonlyMap<Block, Set<Block>>,
  defs: ReadonlyMap<Value, Op>,
  defBlock: ReadonlyMap<Value, Block>,
  args: Value[],
): ThreadedExit {
  const eTerm = E.ops[E.ops.length - 1];
  const qTerm = Q.ops[Q.ops.length - 1];
  const site: ThreadedExit = {
    from: E,
    index,
    target: T,
    retest: R,
    targetShared: [...body].some((p) => p !== E && successorsOf(p).includes(T)),
    targetReturns: returnsPurely(T),
    observable: R.ops.some(observable) || Q.ops.some(observable),
    args,
    dominated: false,
    decided: false,
    onward: false,
  };
  // The edge E→R takes away, of the blocks R reaches, exactly the dominators in R's that are not in
  // E's (any other dominator either dominates both or sits on every path from R). So no value
  // defined in one of those may be read — as an operand or an edge arg — by R or a block it reaches.
  // When R is entered from above the loop (agbcc, kmc), that set is empty; gcc2.7.2's R behind the
  // in-body exit is dominated by that exit's block, whose values the re-test does not read.
  const lost = new Set([...dom.get(R)!].filter((d) => d !== R && !dom.get(E)!.has(d)));
  site.dominated = lost.size === 0 || !readsFrom(R, lost, defBlock);
  // the reads a comparison may look through: R's and Q's own (they run nothing observable, so they
  // see the memory E's branch saw), the onward block's for the same reason, and E's after its last
  // effect
  const lastEffect = E.ops.reduce((at, op, i) => (effectful(op) ? i : at), -1);
  const eReads = new Set(E.ops.slice(lastEffect + 1));
  // on E→R(→Q): R's params hold E's args, and Q's what R's `br` hands it — an R param read as the arg
  // it holds, any other value as itself (one substitution: a value R computes off its own params
  // compares by identity below it, which only refuses)
  const entry = new Map(R.params.map((p, k) => [p, args[k]]));
  if (Q !== R) {
    const fwd = R.ops[R.ops.length - 1].successors[0].args;
    Q.params.forEach((p, k) => entry.set(p, entry.get(fwd[k]) ?? fwd[k]));
  }
  const reading = (onwardBlock: Block | null): EntryReading => ({
    entry,
    through: (v) => {
      const d = defs.get(v);
      if (d === undefined || observable(d)) {
        return false;
      }
      if (!spelledWhenDead(d)) {
        return true;
      }
      const b = defBlock.get(v);
      return b === R || b === Q || (onwardBlock !== null && b === onwardBlock) || (b === E && eReads.has(d));
    },
    normalize: true,
  });
  // which of Q's edges E's sense decides: E's edge `index` holds when E's condition is
  // (index 0 ? true : false); Q's edge 0 holds when Q's is true
  const rd = reading(null);
  const same = sameAtEntry(defs, qTerm.operands[0], eTerm.operands[0], rd, false);
  const negated = !same && sameAtEntry(defs, qTerm.operands[0], eTerm.operands[0], rd, true);
  site.decided = same || negated;
  // The sense, where the comparison said none, is the one the codes alone suggest: what an ablated
  // `test-differs` would act on, so each later rule judges the rewrite that ablation would make.
  const asNegated =
    negated ||
    (!same && NEGATED_ICMP[defs.get(qTerm.operands[0])?.opcode ?? ''] === defs.get(eTerm.operands[0])?.opcode);
  const eHolds = index === 0;
  const rHolds = asNegated ? !eHolds : eHolds;
  const decided = qTerm.successors[rHolds ? 0 : 1];
  const eArgs = eTerm.successors[index].args;
  if (decided.block === T) {
    site.onward =
      decided.args.length === eArgs.length && decided.args.every((a, k) => sameAtEntry(defs, a, eArgs[k], rd));
    return site;
  }
  // through one block S: no params, one edge on to T, entered only from Q, and (judged with R's and
  // Q's ops above) nothing observable
  const S = decided.block;
  const sTerm = S.ops[S.ops.length - 1];
  if (
    S === R ||
    S === Q ||
    body.has(S) ||
    S.params.length > 0 ||
    sTerm?.opcode !== 'br' ||
    sTerm.successors[0].block !== T ||
    (preds.get(S) ?? []).some((p) => p !== Q)
  ) {
    return site;
  }
  site.observable ||= S.ops.some(observable);
  const sd = reading(S);
  const sArgs = sTerm.successors[0].args;
  site.onward = sArgs.length === eArgs.length && sArgs.every((a, k) => sameAtEntry(defs, a, eArgs[k], sd));
  return site;
}

const terminatorEdges = (b: Block) => b.ops[b.ops.length - 1]?.successors ?? [];

/** Does `from`, or a block it reaches, read a value defined in one of `blocks`? */
function readsFrom(from: Block, blocks: ReadonlySet<Block>, defBlock: ReadonlyMap<Value, Block>): boolean {
  const seen = new Set<Block>([from]);
  const work = [from];
  const inside = (v: Value) => blocks.has(defBlock.get(v)!);
  for (let b = work.pop(); b !== undefined; b = work.pop()) {
    if (b.ops.some((op) => op.operands.some(inside) || op.successors.some((e) => e.args.some(inside)))) {
      return true;
    }
    for (const n of successorsOf(b)) {
      if (!seen.has(n)) {
        seen.add(n);
        work.push(n);
      }
    }
  }
  return false;
}
