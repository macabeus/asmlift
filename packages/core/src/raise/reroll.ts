// asmlift — re-rolling a loop test the compiler peeled into the loop's entry (ISA-neutral CFG pass).
//
// `for (i = 0; i < 16; i++) { if (t[i] == 7) { hit(); break; } } out();` — agbcc rotates the loop so
// it is entered at the increment, and evaluates the body's test for i = 0 in the ENTRY block:
//
//     E:  ldrb r1, [t]      ; t[0]
//         cmp r1, #7
//         beq .Lhit         ; the first iteration's test
//     H:  add r2, #1        ; i++
//         cmp r2, #15
//         bhi .Lout
//     T:  ldrb r0, [t + i]
//         cmp r0, #7
//         bne H             ; the same test, every later iteration
//     .Lhit: …
//
// The arm `.Lhit` then has two predecessors, one outside the loop, and no loop spelling owns it. But
// E's test IS T's, at the values E hands the loop: it is the loop's first iteration. Rotating the
// loop back — T becomes the header, entered from E with E's values and from H with H's — makes
// E's test redundant and leaves `.Lhit` one predecessor:
//
//     E:  br T(A)           T(q): test(q) ? X : H(q)           H(p): …; cond ? out : T(B)
//
// Sound when T computes what E computes on E's values. The SHAPE comes first and is not tabled — it
// is what names E, H, T and X at all: one forward predecessor E and one latch T, distinct from H,
// both ending in a `cond_br`, T's only predecessor H by one edge, no params on T, and T's other edge
// leaving the loop for the X that E's other edge reaches too. Then the admission, `REROLL_GATES`:
//   • T reads nothing H defines except its back-edge arguments B, which are H's and distinct (so,
//     renamed to T's own params, its ops are a function of the values it hands round);
//   • E's condition and arguments into X are T's, with B replaced by E's arguments A into H — the
//     question guard fusion asks of a rotated loop's guard, answered by the one predicate both read
//     (`sameAtEntry`, ir/entry.ts), with its identities on (`str[0]` is `str[i]` at `i = 0`);
//   • T holds no effect and no read outside what was compared: it now runs whole on the first
//     iteration as well, where E's own copies of anything else would still run;
//   • E runs no effect after the first op its test reads, so the test reads the same memory moved to
//     the head of T as it did at the end of E.
// An effect in E's compared slice needs no rule of its own: the comparison matches it only with an
// op of T of the same opcode, which the third rule refuses, or with itself, which stays.
// Every check that fails leaves the function as it was.
//
// The rotation is ISA-neutral; the top test it then restores (`restoreTopTest`) is not. That rule
// reads the peel as a top-tested source, a GCC fact measured on agbcc alone: the re-roll fires
// there and nowhere else in the corpus, and no other profile has been probed for a peeled do-while.
// Where one peels it, the cost is a `for` spelled where the source was a do-while, never wrong C.
import { Block, Fn, Op, Successor, Value, dominators, mkValue, predecessors, successorsOf } from '../ir/core';
import { effectful, spelledWhenDead } from '../ir/discipline';
import { type EntryReading, sameAtEntry } from '../ir/entry';
import { analyzeLoops } from '../ir/loops';
import { simplifyTrivialPhis } from '../ir/simplify';
import { intWidth } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** One loop whose shape admits a re-roll, and the facts its admission reads. */
export interface PeeledTest {
  /** does T read a value H defines that is not one of its back-edge args? */
  readsHeader: boolean;
  /** is a back-edge arg defined in T itself? */
  backArgInLatch: boolean;
  /** does T hand H one value for two params? */
  backArgRepeated: boolean;
  /** are E's test and its args into X T's own, read on E's values? */
  sameTest: boolean;
  /** does T run an effect, or a read outside its compared slice? */
  latchRunsMore: boolean;
  /** does E run an effect after the first op its compared slice reads? */
  entryWritesAfterRead: boolean;
}

export const REROLL_GATES: readonly Gate<PeeledTest>[] = [
  {
    id: 'latch-reads-header',
    why: 'the rotated latch heads the loop, where a header value other than its back-edge args does not exist',
    sound: true,
    guardedBy: 'reroll.test.ts: a latch that reads a header value it does not hand round is left alone',
    rejects: (c) => c.readsHeader,
  },
  {
    id: 'back-arg-in-latch',
    why: 'the header hands the rotated latch its back-edge args, so they must be the header’s values',
    sound: true,
    guardedBy: 'reroll.test.ts: a back-edge arg the latch computes itself is left alone',
    rejects: (c) => c.backArgInLatch,
  },
  {
    id: 'back-arg-repeated',
    why: 'one value handed round to two params renames to one of them, and the other loses its entry value',
    sound: true,
    guardedBy: 'reroll.test.ts: a latch that hands one value to two header params is left alone',
    rejects: (c) => c.backArgRepeated,
  },
  {
    id: 'not-the-entry-test',
    why: 'only an entry test that is the latch’s own on the entry values is the first iteration',
    sound: true,
    guardedBy: 'reroll.test.ts: an entry test that differs from the loop’s at its first values is left alone',
    rejects: (c) => !c.sameTest,
  },
  {
    id: 'latch-runs-more',
    why: 'the rotated latch runs whole on the first iteration, where the entry’s own copy of anything else still runs',
    sound: true,
    guardedBy: [
      'reroll.test.ts: a latch that runs an effect besides its test is left alone — the entry’s peeled copy stays',
      'reroll.test.ts: a latch that reads memory outside its test is left alone — the first iteration would read it once more',
    ],
    rejects: (c) => c.latchRunsMore,
  },
  {
    id: 'entry-writes-after-read',
    why: 'the entry’s test moves to the head of the latch, past whatever the entry runs after reading it',
    sound: true,
    guardedBy: 'reroll.test.ts: an entry that writes memory after its test reads it is left alone',
    rejects: (c) => c.entryWritesAfterRead,
  },
];

/** Re-roll every peeled loop test the conditions above admit; returns how many. */
export function rerollPeeledTests(
  fn: Fn,
  gates: readonly Gate<PeeledTest>[] = REROLL_GATES,
  topGates: readonly Gate<FoldedTopTest>[] = TOP_TEST_GATES,
): number {
  let done = 0;
  // one at a time: each rotation changes the loop forest
  while (rerollOne(fn, gates, topGates)) {
    done++;
  }
  return done;
}

function rerollOne(fn: Fn, gates: readonly Gate<PeeledTest>[], topGates: readonly Gate<FoldedTopTest>[]): boolean {
  const preds = predecessors(fn);
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
  const forest = analyzeLoops(fn, dominators(fn));
  for (const nl of forest.byHeader.values()) {
    const H = nl.header;
    if (nl.selfLoop || nl.latches.length !== 1 || nl.forwardPreds.length !== 1) {
      continue;
    }
    const T = nl.latches[0];
    const E = nl.forwardPreds[0];
    const tTerm = T.ops[T.ops.length - 1];
    const eTerm = E.ops[E.ops.length - 1];
    if (
      T === H ||
      tTerm.opcode !== 'cond_br' ||
      eTerm.opcode !== 'cond_br' ||
      (preds.get(T) ?? []).some((p) => p !== H) ||
      successorsOf(H).filter((s) => s === T).length !== 1 ||
      T.params.length > 0
    ) {
      continue;
    }
    const tBack = tTerm.successors.findIndex((s) => s.block === H);
    const tOut = 1 - tBack;
    const eIn = eTerm.successors.findIndex((s) => s.block === H);
    const eOut = 1 - eIn;
    if (tBack < 0 || eIn < 0 || tTerm.successors[tOut].block !== eTerm.successors[eOut].block) {
      continue;
    }
    const X = tTerm.successors[tOut].block;
    if (nl.body.has(X) || X === E) {
      continue;
    }
    const B = tTerm.successors[tBack].args;
    const A = eTerm.successors[eIn].args;
    const tReads = [
      ...T.ops.flatMap((op) => op.operands),
      ...T.ops.flatMap((op) => op.successors.flatMap((s) => s.args)),
    ];
    // compare E's test with T's at E's values: T's read with each B[k] as E's A[k], through the ops
    // of T and E only — a read anywhere else may see other memory
    const reading: EntryReading = {
      entry: new Map(B.map((v, k) => [v, A[k]])),
      through: (v) => defBlock.get(v) === T || defBlock.get(v) === E,
      normalize: true,
    };
    const tXArgs = tTerm.successors[tOut].args;
    const eXArgs = eTerm.successors[eOut].args;
    // What the comparison covers: in each block, the ops its condition and its args into X are
    // computed from. Only E's copies of those are deleted below.
    const slice = sliceOf(defs, E, [eTerm.operands[0], ...eXArgs]);
    const tSlice = sliceOf(defs, T, [tTerm.operands[0], ...tXArgs]);
    const firstRead = E.ops.findIndex((op) => slice.has(op));
    const site: PeeledTest = {
      readsHeader: tReads.some((v) => defBlock.get(v) === H && !B.includes(v)),
      backArgInLatch: B.some((v) => defBlock.get(v) === T),
      backArgRepeated: new Set(B).size !== B.length,
      sameTest:
        // the sense: which arm of each condition leaves for X
        sameAtEntry(defs, tTerm.operands[0], eTerm.operands[0], reading, tOut !== eOut) &&
        tXArgs.length === eXArgs.length &&
        tXArgs.every((a, k) => sameAtEntry(defs, a, eXArgs[k], reading)),
      latchRunsMore: T.ops.some((op) => op !== tTerm && (effectful(op) || (spelledWhenDead(op) && !tSlice.has(op)))),
      entryWritesAfterRead: firstRead >= 0 && E.ops.slice(firstRead, -1).some((op) => !slice.has(op) && effectful(op)),
    };
    if (firstRejection(gates, site) !== null) {
      continue;
    }
    // ROTATE: T(q) heads the loop; H hands it B, E hands it A, and T hands H its own params.
    const q = B.map((v) => mkValue(v.type));
    const rename = new Map<Value, Value>(B.map((v, k) => [v, q[k]]));
    const sub = (v: Value) => rename.get(v) ?? v;
    T.params = q;
    for (const op of T.ops) {
      op.operands = op.operands.map(sub);
      for (const s of op.successors) {
        s.args = s.args.map(sub);
      }
    }
    for (const op of H.ops) {
      for (const s of op.successors) {
        if (s.block === T) {
          s.args = [...B];
        }
      }
    }
    rotateWriteOrder(fn, { E, H, T, B, q });
    eTerm.opcode = 'br';
    eTerm.operands = [];
    eTerm.successors = [{ block: T, args: [...A] }];
    eTerm.attrs = {};
    // the test E no longer reads — only its compared slice: any other op of E is E's own code
    for (let changed = true; changed;) {
      changed = false;
      const used = new Set(
        fn.blocks.flatMap((b) => b.ops.flatMap((op) => [...op.operands, ...op.successors.flatMap((s) => s.args)])),
      );
      E.ops = E.ops.filter((op) => {
        const dead = slice.has(op) && !effectful(op) && op.results.every((r) => !used.has(r));
        changed ||= dead;
        return !dead;
      });
    }
    // T now heads the loop: lay it out where H was, so the loop reads in its own order
    fn.blocks = fn.blocks.filter((b) => b !== T);
    fn.blocks.splice(fn.blocks.indexOf(H), 0, T);
    // H's params now take T's own params on their one in-edge: each is that value under a second name
    simplifyTrivialPhis(fn);
    restoreTopTest(fn, { E, T, H }, topGates);
    return true;
  }
  return false;
}

/** One re-rolled loop whose exit test could head it again, and the facts its admission reads. */
export interface FoldedTopTest {
  /** does the exit edge hand the exit block a value that another edge into it does not hand the
   *  same parameter? The loop's own value, which the head and an arm out of the test both hand,
   *  does not count. */
  exitValueDiffers: boolean;
  /** does the exit test or its edge read a value of the loop's blocks other than those H hands
   *  round, or does a block after the exit read one at all? */
  readsLoopValue: boolean;
  /** the exit test on the entry values: `stays` (provably not taken), `leaves`, `guarded` (not a
   *  constant, but the test of the guard the loop is entered under, on the same values and leaving
   *  for the same exit), or `unknown` (not a constant: a memory read, a call, a parameter, an opcode
   *  `EVAL` does not fold) */
  atEntry: 'stays' | 'leaves' | 'guarded' | 'unknown';
}

export const TOP_TEST_GATES: readonly Gate<FoldedTopTest>[] = [
  {
    id: 'exit-value-differs',
    why: 'an exit whose edges hand it different values becomes a second copy of it after the loop, a spelling measured worse',
    sound: false,
    rejects: (c) => c.exitValueDiffers,
  },
  {
    id: 'reads-loop-value',
    why: 'the new head is reached before the loop body, where the body’s own values do not exist yet',
    sound: true,
    guardedBy: 'reroll.test.ts: each top-test refusal above is its rule’s alone',
    rejects: (c) => c.readsLoopValue,
  },
  {
    id: 'not-staying-at-entry',
    why: 'a head test that could leave on entry would skip the first iteration the asm always runs',
    sound: true,
    guardedBy: 'reroll.test.ts: each top-test refusal above is its rule’s alone',
    rejects: (c) => c.atEntry === 'leaves' || c.atEntry === 'unknown',
  },
];

/** Integer opcodes `evalConst` folds, on 32-bit values. */
const EVAL: Readonly<Record<string, (a: number, b: number) => number>> = {
  add: (a, b) => (a + b) | 0,
  sub: (a, b) => (a - b) | 0,
  and: (a, b) => a & b,
  or: (a, b) => a | b,
  xor: (a, b) => a ^ b,
  icmp_eq: (a, b) => +(a === b),
  icmp_ne: (a, b) => +(a !== b),
  icmp_slt: (a, b) => +(a < b),
  icmp_sle: (a, b) => +(a <= b),
  icmp_sgt: (a, b) => +(a > b),
  icmp_sge: (a, b) => +(a >= b),
  icmp_ult: (a, b) => +(a >>> 0 < b >>> 0),
  icmp_ule: (a, b) => +(a >>> 0 <= b >>> 0),
  icmp_ugt: (a, b) => +(a >>> 0 > b >>> 0),
  icmp_uge: (a, b) => +(a >>> 0 >= b >>> 0),
};

/** RESTORE THE TOP TEST THE COMPILER FOLDED AWAY. A loop `rerollOne` just rotated is now
 *
 *     E: br T(A)      T(q): test(q) ? X : H      H: …; B = next(q); exit(B) ? Y : T(B)
 *
 *  which spells `while (1) { …; if (exit) break; }` — and that compiles as a do-while, whose test is
 *  at the bottom. But the peel is evidence that the source tested at the TOP: agbcc's `while`/`for`
 *  emit the exit test ahead of the body (c-parse.in), `expand_end_loop` rotates it to the bottom
 *  and enters at it (stmt.c), and `duplicate_loop_exit_test` copies it in front of the loop
 *  (jump.c), where a constant start folds it away and leaves the first body test in E. A do-while
 *  has no such jump and no peel. So where H's exit test, read on the entry values A, provably stays
 *  in, it moves to a new head C:
 *
 *     E: br C(A)      C(c): exit(c) ? Y : T(c)      T: test(c) ? X : H      H: …; br C(next(c))
 *
 *  which runs the same iterations: on entry the test is false, and every later time it is H's own
 *  test on H's values. Where the start or the bound is not a constant, the copied test does not
 *  fold and stays in front as a guard G of E (`for (i = 0; i < n; i++)` keeps `0 < n`): the same
 *  evidence, and the same move, once G is proven to be that test on those values (`entryGuard`);
 *  then C's test is G's, and G goes. Refuses by `TOP_TEST_GATES`; a refusal keeps the loop as
 *  rotated. */
function restoreTopTest(
  fn: Fn,
  loop: { E: Block; T: Block; H: Block },
  gates: readonly Gate<FoldedTopTest>[],
): boolean {
  const { E, T, H } = loop;
  const hTerm = H.ops[H.ops.length - 1];
  const eTerm = E.ops[E.ops.length - 1];
  const preds = predecessors(fn);
  if (
    hTerm?.opcode !== 'cond_br' ||
    eTerm?.opcode !== 'br' ||
    eTerm.successors[0].block !== T ||
    (preds.get(H) ?? []).some((p) => p !== T) ||
    (preds.get(T) ?? []).some((p) => p !== E && p !== H)
  ) {
    return false;
  }
  const back = hTerm.successors.findIndex((s) => s.block === T);
  if (back < 0 || hTerm.successors[1 - back].block === T) {
    return false;
  }
  const exit = hTerm.successors[1 - back];
  const B = hTerm.successors[back].args;
  const A = eTerm.successors[0].args;
  const inLoop = new Set<Value>([
    ...T.params,
    ...H.params,
    ...[T, H].flatMap((b) => b.ops.flatMap((op) => op.results)),
  ]);
  const defs = new Map<Value, Op>(
    fn.blocks.flatMap((b) => b.ops.flatMap((op) => op.results.map((r) => [r, op] as const))),
  );
  // what moves: the ops of H the exit test is computed from, minus those that compute what H hands round
  const kept = sliceOf(defs, H, B);
  const moved = new Set([...sliceOf(defs, H, [hTerm.operands[0]])].filter((op) => !kept.has(op)));
  const movedResults = new Set([...moved].flatMap((op) => op.results));
  // …and the test is all they compute: a value another op of the loop reads stays where it is
  const readers = [T, H].flatMap((b) => b.ops).filter((op) => op !== hTerm && !moved.has(op));
  if (
    readers.some((op) => [...op.operands, ...op.successors.flatMap((s) => s.args)].some((v) => movedResults.has(v)))
  ) {
    return false;
  }
  // the exit test on the entry values: each B[k] read as A[k], through E's ops and the moved ones
  const entry = new Map<Value, Value>(B.map((v, k) => [v, A[k]]));
  const evalConst = (v0: Value): number | null => {
    const v = entry.get(v0) ?? v0;
    const d = defs.get(v);
    if (d === undefined || intWidth(v.type) !== 32) {
      return null;
    }
    if (d.opcode === 'const') {
      return typeof d.attrs.value === 'number' ? d.attrs.value | 0 : null;
    }
    const f = EVAL[d.opcode];
    if (!f || d.operands.length !== 2 || !(moved.has(d) || E.ops.includes(d))) {
      return null;
    }
    const x = evalConst(d.operands[0]);
    const y = evalConst(d.operands[1]);
    return x === null || y === null ? null : f(x, y);
  };
  const cond = evalConst(hTerm.operands[0]);
  const guard = cond === null ? entryGuard(fn, preds, defs, { E, H, exit, back, B, A, moved }) : null;
  // a value the exit edge hands, or another edge into the exit: the loop's own `k`th value is one
  // value however it is named, as H hands it round (B) or as T receives it
  const own = (v: Value): Value | number => {
    const k = Math.max(B.indexOf(v), T.params.indexOf(v));
    return k < 0 ? v : k;
  };
  const intoExit = fn.blocks
    .flatMap((b) => b.ops[b.ops.length - 1]?.successors ?? [])
    .filter((s) => s.block === exit.block && s !== exit && s !== guard?.out);
  // the blocks after the exit, which C enters now and T no longer dominates: an arm out of T and the
  // exit both read T's values there before the move, the exit's edge then reading them one
  // iteration on
  const after = new Set<Block>();
  for (const stack = [exit.block]; stack.length > 0;) {
    const x = stack.pop()!;
    if (x !== T && x !== H && !after.has(x)) {
      after.add(x);
      stack.push(...successorsOf(x));
    }
  }
  const readAfter = [...after].flatMap((b) =>
    b.ops.flatMap((op) => [...op.operands, ...op.successors.flatMap((s) => s.args)]),
  );
  const site: FoldedTopTest = {
    exitValueDiffers: exit.args.some((v, k) => intoExit.some((s) => own(s.args[k]) !== own(v))),
    readsLoopValue:
      [...[...moved].flatMap((op) => op.operands), hTerm.operands[0], ...exit.args].some(
        (v) => inLoop.has(v) && !movedResults.has(v) && !B.includes(v),
      ) || readAfter.some((v) => inLoop.has(v) && !movedResults.has(v)),
    atEntry:
      cond !== null ? ((cond !== 0) === (back === 0) ? 'stays' : 'leaves') : guard !== null ? 'guarded' : 'unknown',
  };
  if (firstRejection(gates, site) !== null) {
    return false;
  }
  if (guard !== null) {
    dropGuard(fn, guard);
  }
  const c = B.map((v) => mkValue(v.type));
  const rename = new Map<Value, Value>(B.map((v, k) => [v, c[k]]));
  const sub = (v: Value) => rename.get(v) ?? v;
  const headOps = H.ops.filter((op) => moved.has(op));
  for (const op of headOps) {
    op.operands = op.operands.map(sub);
  }
  const C: Block = {
    params: c,
    ops: [
      ...headOps,
      {
        opcode: 'cond_br',
        operands: [sub(hTerm.operands[0])],
        results: [],
        attrs: { ...hTerm.attrs },
        successors: hTerm.successors.map((s, k) =>
          k === back ? { block: T, args: [...c] } : { block: s.block, args: s.args.map(sub) },
        ),
      },
    ],
  };
  H.ops = [
    ...H.ops.filter((op) => op !== hTerm && !moved.has(op)),
    { opcode: 'br', operands: [], results: [], attrs: {}, successors: [{ block: C, args: [...B] }] },
  ];
  eTerm.successors = [{ block: C, args: [...A] }];
  // write order: E and H wrote T's keys on their edges, and now write C's; C writes nothing itself
  const order = fn.writeOrder;
  if (order !== undefined) {
    for (const pred of [E, H]) {
      const rec = order.lastWrite.get(pred);
      T.params.forEach((tk, k) => {
        const at = rec?.get(tk);
        rec?.delete(tk);
        if (at !== undefined) {
          rec?.set(c[k], at);
        }
      });
    }
    if (order.writes.has(T)) {
      order.writes.set(C, 0);
    }
  }
  fn.blocks.splice(fn.blocks.indexOf(T), 0, C);
  // T's params now take C's on their one in-edge
  simplifyTrivialPhis(fn);
  rejoinSunkReturns(predecessors(fn), T, exit.block, new Set([C, T, H]));
  return true;
}

/** AN ARM THAT FELL INTO THE EXIT'S RETURN BREAKS TO IT. Where the code after the loop is the bare
 *  epilogue, return-sinking (raise/retsink.ts) has already given the arm out of the test its own copy
 *  of the `ret`, marked as the fall-through it was: the arm ran out into the epilogue the exit
 *  branches to. Rotated, that reads as `if (v0 >= n) return; … } gHit = 1;`; restored, the arm is an
 *  early `return` inside the `while`, a spelling agbcc compiles to another object, while the arm
 *  running out into the loop's exit is the `break` the layout shows. So where every `ret` in the
 *  arm's region is such a fall-through, returning the values the exit's own lone `ret` returns, it
 *  branches to the exit again: the same instruction stream, and a region the loop reads as a
 *  code-running `break` (`codeBreakArm`) — which it only takes with no other way in. */
function rejoinSunkReturns(preds: ReadonlyMap<Block, Block[]>, T: Block, exit: Block, loop: ReadonlySet<Block>): void {
  const xt = exit.ops[exit.ops.length - 1];
  const tTerm = T.ops[T.ops.length - 1];
  const outs = tTerm?.opcode === 'cond_br' ? tTerm.successors.filter((s) => !loop.has(s.block)) : [];
  if (exit.ops.length !== 1 || xt.opcode !== 'ret' || exit.params.length > 0 || outs.length !== 1) {
    return;
  }
  const X = outs[0].block;
  const region = new Set<Block>();
  const rets: Op[] = [];
  for (const stack = [X]; stack.length > 0;) {
    const x = stack.pop()!;
    if (x === exit || loop.has(x)) {
      return; // already a break, or not an arm
    }
    if (region.has(x)) {
      continue;
    }
    region.add(x);
    const t = x.ops[x.ops.length - 1];
    if (t?.opcode === 'ret') {
      rets.push(t);
    } else if (t?.opcode !== 'br' && t?.opcode !== 'cond_br') {
      return;
    }
    stack.push(...successorsOf(x));
  }
  const { fallthrough: _, ...xAttrs } = xt.attrs;
  const rejoins = (r: Op) => {
    const { fallthrough, ...attrs } = r.attrs;
    return (
      fallthrough === true &&
      JSON.stringify(attrs) === JSON.stringify(xAttrs) &&
      r.operands.length === xt.operands.length &&
      r.operands.every((v, k) => v === xt.operands[k])
    );
  };
  const entered = (x: Block) => (preds.get(x) ?? []).every((p) => region.has(p) || (x === X && p === T));
  if (rets.length === 0 || !rets.every(rejoins) || ![...region].every(entered)) {
    return;
  }
  for (const r of rets) {
    r.opcode = 'br';
    r.operands = [];
    r.attrs = { fallthrough: true };
    r.successors = [{ block: exit, args: [] }];
  }
}

/** The guard a loop is entered under, where the compiler kept the exit test it copied ahead of the
 *  loop (`duplicate_loop_exit_test`, jump.c) rather than fold it: `for (i = 0; i < n; i++)` with `n`
 *  unknown leaves `0 < n` in front of the peeled first test. E's one predecessor G decides between
 *  E and the loop's exit, on the exit test read at the entry values A (`sameAtEntry`, the predicate
 *  guard fusion reads) and with the args the exit edge hands on those values. Then the new head runs
 *  G's own test on G's own values, and G's branch is redundant — provided nothing between them runs:
 *  E's ops now run on the way out as well, and the test reads memory where G read it, so E holds no
 *  effect and no read. */
interface EntryGuard {
  G: Block;
  gTerm: Op;
  /** G's edge into E, and its edge into the exit */
  into: Successor;
  out: Successor;
}
function entryGuard(
  fn: Fn,
  preds: ReadonlyMap<Block, Block[]>,
  defs: ReadonlyMap<Value, Op>,
  r: {
    E: Block;
    H: Block;
    exit: Successor;
    back: number;
    B: readonly Value[];
    A: readonly Value[];
    moved: ReadonlySet<Op>;
  },
): EntryGuard | null {
  const { E, H, exit, back, B, A, moved } = r;
  const ep = preds.get(E) ?? [];
  const G = ep[0];
  if (ep.length !== 1 || G === E || G === H) {
    return null;
  }
  const gTerm = G.ops[G.ops.length - 1];
  if (gTerm?.opcode !== 'cond_br') {
    return null;
  }
  const gIn = gTerm.successors.findIndex((s) => s.block === E);
  if (gIn < 0 || gTerm.successors[1 - gIn].block !== exit.block) {
    return null;
  }
  if (E.ops.slice(0, -1).some((op) => effectful(op) || spelledWhenDead(op))) {
    return null;
  }
  const hTerm = H.ops[H.ops.length - 1];
  const gOut = gTerm.successors[1 - gIn];
  const blockOf = new Map<Op, Block>(fn.blocks.flatMap((b) => b.ops.map((op) => [op, b] as const)));
  const reading: EntryReading = {
    entry: new Map(B.map((v, k) => [v, A[k]])),
    through: (v) => {
      const d = defs.get(v);
      const b = d === undefined ? undefined : blockOf.get(d);
      return d !== undefined && (moved.has(d) || b === E || b === G);
    },
  };
  // the senses: the exit test leaves on its `1 - back`th edge, the guard on its `1 - gIn`th
  const same =
    sameAtEntry(defs, hTerm.operands[0], gTerm.operands[0], reading, 1 - back !== 1 - gIn) &&
    exit.args.length === gOut.args.length &&
    exit.args.every((a, k) => sameAtEntry(defs, a, gOut.args[k], reading));
  return same ? { G, gTerm, into: gTerm.successors[gIn], out: gOut } : null;
}

/** G enters E unconditionally; the ops only its test read go with it. */
function dropGuard(fn: Fn, { G, gTerm, into }: EntryGuard): void {
  const cond = gTerm.operands[0];
  gTerm.opcode = 'br';
  gTerm.operands = [];
  gTerm.successors = [into];
  gTerm.attrs = {};
  const slice = sliceOf(new Map(G.ops.flatMap((op) => op.results.map((v) => [v, op] as const))), G, [cond]);
  for (let changed = true; changed;) {
    changed = false;
    const used = new Set(
      fn.blocks.flatMap((b) => b.ops.flatMap((op) => [...op.operands, ...op.successors.flatMap((s) => s.args)])),
    );
    G.ops = G.ops.filter((op) => {
      const dead = slice.has(op) && !effectful(op) && op.results.every((v) => !used.has(v));
      changed ||= dead;
      return !dead;
    });
  }
}

/** THE WRITE-ORDER BOOKKEEPING THE ROTATION OWES (ir/core.ts `WriteOrder`). A missing `lastWrite`
 *  entry on a measured block says "this block left the key as it was", which the structurer reads as
 *  a licence to name a nested loop's parameter after the enclosing header's, so every edge the
 *  rotation re-targets keeps saying who wrote each key. T's param `q[k]` stands for the key H's
 *  `p[k]` did: it receives the same values on the same register.
 *  • E → T(A) is E's old edge into H, re-targeted: E's records for `p[k]` are its records for `q[k]`.
 *  • H → T(B) is the old back edge T → H(B), seen from the other end. T's copies on it (a record of
 *    T's for `p[k]`) land at the end of H, as `foldWriteOrder` puts a folded block's writes. Where T
 *    made none and `B[k]` is not `p[k]`, the key took a new value before T, so H wrote it — at an
 *    ordinal among H's own writes the record never measured; it takes H's last, the bound every
 *    later write sorts after. Saying "written" where it may not have been costs a spelling at most;
 *    the reverse licenses a name. A `B[k]` that is `p[k]` passes through: no entry, as before.
 *  • T → H(q) passes T's own params on: T writes none of those keys, so its records for `p[k]` go. */
function rotateWriteOrder(fn: Fn, r: { E: Block; H: Block; T: Block; B: readonly Value[]; q: readonly Value[] }): void {
  const order = fn.writeOrder;
  if (order === undefined) {
    return;
  }
  const { E, H, T, B, q } = r;
  const p = H.params;
  const eRec = order.lastWrite.get(E);
  if (eRec !== undefined) {
    p.forEach((pk, k) => {
      const at = eRec.get(pk);
      eRec.delete(pk);
      if (at !== undefined) {
        eRec.set(q[k], at);
      }
    });
  }
  const hBase = order.writes.get(H);
  const tWrites = order.writes.get(T);
  if (hBase === undefined || tWrites === undefined) {
    return; // H or T unmeasured: nobody measured this fn, and nothing reads its absences
  }
  const tRec = order.lastWrite.get(T);
  const hRec = order.lastWrite.get(H) ?? new Map<Value, number>();
  p.forEach((pk, k) => {
    const at = tRec?.get(pk);
    tRec?.delete(pk);
    if (at !== undefined) {
      hRec.set(q[k], hBase + at);
    } else if (B[k] !== pk && hBase > 0) {
      hRec.set(q[k], hBase - 1);
    }
  });
  order.lastWrite.set(H, hRec);
  order.writes.set(H, hBase + tWrites);
}

/** The ops in `blk` the values `roots` are computed from. */
function sliceOf(defs: ReadonlyMap<Value, Op>, blk: Block, roots: readonly Value[]): Set<Op> {
  const out = new Set<Op>();
  const walk = (v: Value) => {
    const d = defs.get(v);
    if (d !== undefined && blk.ops.includes(d) && !out.has(d)) {
      out.add(d);
      d.operands.forEach(walk);
    }
  };
  roots.forEach(walk);
  return out;
}
