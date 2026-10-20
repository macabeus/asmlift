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
// Then E→R→(S→)T computes what E→T did, and on every other path nothing moved.
//
// SCOPE, not soundness (the heuristic gates): only the decline shape. R must be another exit target
// of the same loop and E the loop's only edge to T, so each rewrite takes one exit target away; and
// T must not merely return, because an exit that returns is an early `return` the structurer already
// spells. Every function that lifted without this pass keeps its CFG.
//
// THE ARGS E HANDS R are the one value every in-loop edge into R hands that param, where that value
// is defined at E (dominates E's block). The choice is a proposal: the comparison above is what makes
// it sound, and a param with no such value refuses. gcc2.7.2kmc re-masks a `u8` counter on each exit
// edge (`andi v0,a1,0xff` in every delay slot), so its exits hand R distinct values and the row
// `synthetic:thrbreak:gcc2.7.2kmc` stays declined here — a gap of its own, not this pass's.
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
  /** E's target, and the re-test block R the edge would be pointed back at */
  target: Block;
  retest: Block;
  /** does another exit edge of the same loop reach T? */
  targetShared: boolean;
  /** does every path from T reach a `ret` without an effect on the way? */
  targetReturns: boolean;
  /** does R (or the S it reaches T through) run an op whose second run is observable? */
  observable: boolean;
  /** the args E would hand R: per param, the one value every in-loop edge into R hands it */
  args: Value[];
  /** do R's dominators (and so every block R reaches) all dominate E? */
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
    ],
    rejects: (c) => c.observable,
  },
  {
    id: 'not-dominated',
    why: 'a value the re-test reads from above it must exist on the exit edge too',
    sound: true,
    guardedBy: 'unthread.test.ts: a re-test reading a value from a block the exit does not pass is left alone',
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
          const site = judge(nl.body, E, index, T, R, preds, dom, defs, defBlock, dominatesAt);
          if (site === null || firstRejection(gates, site) !== null) {
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
): ThreadedExit | null {
  const eTerm = E.ops[E.ops.length - 1];
  const rTerm = R.ops[R.ops.length - 1];
  // THE SHAPE, untabled: R ends in a `cond_br` (only a branch re-takes E's decision), and each of
  // its params is handed one value by every in-loop edge into R, defined at E — the args E hands it.
  if (rTerm?.opcode !== 'cond_br') {
    return null;
  }
  const into = [...body].flatMap((p) => terminatorEdges(p).filter((s) => s.block === R));
  const args: Value[] = [];
  for (let k = 0; k < R.params.length; k++) {
    const vals = new Set(into.map((s) => s.args[k]));
    const [only] = vals;
    if (vals.size !== 1 || only === undefined || !dominatesAt(only, E)) {
      return null;
    }
    args.push(only);
  }
  const site: ThreadedExit = {
    from: E,
    index,
    target: T,
    retest: R,
    targetShared: [...body].some((p) => p !== E && successorsOf(p).includes(T)),
    targetReturns: returnsPurely(T),
    observable: R.ops.some(observable),
    args,
    dominated: false,
    decided: false,
    onward: false,
  };
  // every block that dominates R dominates E as well, so R's new edge leaves R's dominators — and so
  // every value R and the blocks it reaches read from above — as they were
  site.dominated = [...dom.get(R)!].every((d) => d === R || dom.get(E)!.has(d));
  // the reads a comparison may look through: R's own (R runs nothing observable, so they see the
  // memory E's branch saw), the onward block's for the same reason, and E's after its last effect
  const lastEffect = E.ops.reduce((at, op, i) => (effectful(op) ? i : at), -1);
  const eReads = new Set(E.ops.slice(lastEffect + 1));
  const reading = (onwardBlock: Block | null): EntryReading => ({
    entry: new Map(R.params.map((p, k) => [p, args[k]])),
    through: (v) => {
      const d = defs.get(v);
      if (d === undefined || observable(d)) {
        return false;
      }
      if (!spelledWhenDead(d)) {
        return true;
      }
      const b = defBlock.get(v);
      return b === R || (onwardBlock !== null && b === onwardBlock) || (b === E && eReads.has(d));
    },
    normalize: true,
  });
  // which of R's edges E's sense decides: E's edge `index` holds when E's condition is
  // (index 0 ? true : false); R's edge 0 holds when R's is true
  const rd = reading(null);
  const same = sameAtEntry(defs, rTerm.operands[0], eTerm.operands[0], rd, false);
  const negated = !same && sameAtEntry(defs, rTerm.operands[0], eTerm.operands[0], rd, true);
  site.decided = same || negated;
  // The sense, where the comparison said none, is the one the codes alone suggest: what an ablated
  // `test-differs` would act on, so each later rule judges the rewrite that ablation would make.
  const asNegated =
    negated ||
    (!same && NEGATED_ICMP[defs.get(rTerm.operands[0])?.opcode ?? ''] === defs.get(eTerm.operands[0])?.opcode);
  const eHolds = index === 0;
  const rHolds = asNegated ? !eHolds : eHolds;
  const decided = rTerm.successors[rHolds ? 0 : 1];
  const eArgs = eTerm.successors[index].args;
  if (decided.block === T) {
    site.onward =
      decided.args.length === eArgs.length && decided.args.every((a, k) => sameAtEntry(defs, a, eArgs[k], rd));
    return site;
  }
  // through one block S: no params, one edge on to T, entered only from R, and (judged with R's ops
  // above) nothing observable
  const S = decided.block;
  const sTerm = S.ops[S.ops.length - 1];
  if (
    S === R ||
    body.has(S) ||
    S.params.length > 0 ||
    sTerm?.opcode !== 'br' ||
    sTerm.successors[0].block !== T ||
    (preds.get(S) ?? []).some((p) => p !== R)
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
