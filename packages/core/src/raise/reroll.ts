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
import { Block, Fn, Op, Value, dominators, mkValue, predecessors, successorsOf } from '../ir/core';
import { effectful, spelledWhenDead } from '../ir/discipline';
import { type EntryReading, sameAtEntry } from '../ir/entry';
import { analyzeLoops } from '../ir/loops';
import { simplifyTrivialPhis } from '../ir/simplify';
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
export function rerollPeeledTests(fn: Fn, gates: readonly Gate<PeeledTest>[] = REROLL_GATES): number {
  let done = 0;
  // one at a time: each rotation changes the loop forest
  while (rerollOne(fn, gates)) {
    done++;
  }
  return done;
}

function rerollOne(fn: Fn, gates: readonly Gate<PeeledTest>[]): boolean {
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
    return true;
  }
  return false;
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
