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
// Sound when T computes what E computes on E's values, which is what the checks below establish:
//   • the loop has one forward predecessor E and one latch T, whose only predecessor is the header H;
//     T's other edge leaves the loop for X, and E's other edge reaches X too;
//   • T reads nothing H defines except its back-edge arguments B (so, renamed to T's own params, its
//     ops are a function of the values it hands round);
//   • E's condition and arguments into X are T's, with B replaced by E's arguments A into H — the
//     question guard fusion asks of a rotated loop's guard, answered by the one predicate both read
//     (`sameAtEntry`, ir/entry.ts), with its identities on (`str[0]` is `str[i]` at `i = 0`);
//   • T holds no effect and no read outside what was compared: it now runs whole on the first
//     iteration as well, where E's own copies of anything else would still run;
//   • E runs no effect after the first op its test reads, so the test reads the same memory moved to
//     the head of T as it did at the end of E.
// Every check that fails leaves the function as it was.
import { Block, Fn, Op, Value, dominators, mkValue, predecessors, successorsOf } from '../ir/core';
import { effectful, spelledWhenDead } from '../ir/discipline';
import { type EntryReading, sameAtEntry } from '../ir/entry';
import { analyzeLoops } from '../ir/loops';
import { simplifyTrivialPhis } from '../ir/simplify';

/** Re-roll every peeled loop test the conditions above admit; returns how many. */
export function rerollPeeledTests(fn: Fn): number {
  let done = 0;
  // one at a time: each rotation changes the loop forest
  while (rerollOne(fn)) {
    done++;
  }
  return done;
}

function rerollOne(fn: Fn): boolean {
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
    // T reads nothing H defines but B
    const fromH = (v: Value) => defBlock.get(v) === H;
    const tReads = [
      ...T.ops.flatMap((op) => op.operands),
      ...T.ops.flatMap((op) => op.successors.flatMap((s) => s.args)),
    ];
    if (tReads.some((v) => fromH(v) && !B.includes(v))) {
      continue;
    }
    // one back-edge arg per param: a value handed round twice would be renamed to one of them only
    if (new Set(B).size !== B.length) {
      continue;
    }
    // compare E's test with T's at E's values: T's read with each B[k] as E's A[k], through the ops
    // of T and E only — a read anywhere else may see other memory
    const reading: EntryReading = {
      entry: new Map(B.map((v, k) => [v, A[k]])),
      through: (v) => defBlock.get(v) === T || defBlock.get(v) === E,
      normalize: true,
    };
    const tXArgs = tTerm.successors[tOut].args;
    const eXArgs = eTerm.successors[eOut].args;
    if (
      // the sense: which arm of each condition leaves for X
      !sameAtEntry(defs, tTerm.operands[0], eTerm.operands[0], reading, tOut !== eOut) ||
      tXArgs.length !== eXArgs.length ||
      tXArgs.some((a, k) => !sameAtEntry(defs, a, eXArgs[k], reading))
    ) {
      continue;
    }
    // What the comparison above covers: in each block, the ops its condition and its args into X are
    // computed from. Only E's copies of those are deleted below.
    const slice = sliceOf(defs, E, [eTerm.operands[0], ...eTerm.successors[eOut].args]);
    const tSlice = sliceOf(defs, T, [tTerm.operands[0], ...tTerm.successors[tOut].args]);
    // After the rotation T runs WHOLE on the first iteration too, where before E ran in its place.
    // So T may hold nothing but what was compared, and nothing E would also have run: no effect at
    // all (E keeps its own peeled copy, and the first iteration would run it twice — agbcc peels
    // `gCnt++` with the test), and no read outside the compared slices (a read the asm kept is
    // evidence of `volatile`, and one more would run). Its back-edge args must be H's, not T's own:
    // H hands them to T after the rotation.
    if (
      T.ops.some((op) => op !== tTerm && (effectful(op) || (spelledWhenDead(op) && !tSlice.has(op)))) ||
      [...slice].some(effectful) ||
      B.some((v) => defBlock.get(v) === T)
    ) {
      continue;
    }
    // E runs no effect after the first op its compared slice reads, so that slice reads the same
    // memory moved to the head of T as it did at the end of E
    const firstRead = E.ops.findIndex((op) => slice.has(op));
    if (firstRead >= 0 && E.ops.slice(firstRead, -1).some((op) => !slice.has(op) && effectful(op))) {
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
        const dead = slice.has(op) && op.results.every((r) => !used.has(r));
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
