// asmlift — undo a partial-redundancy insertion: a block parameter whose every in-edge hands it the
// same pure expression is that expression, recomputed in the block (ISA-neutral CFG pass).
//
// agbcc's gcse PRE (gcse.c `pre_insert` :4337, at the end of a predecessor by `insert_insn_end_bb`
// :4210) makes an expression that is computed on SOME paths into a block fully redundant by
// inserting it on the others, keeps each original computation's result in the same pseudo
// (`pre_insert_copy_insn` :4400), and deletes the copy in the block (`pre_delete` :4508). In
// `for (i = 0; i < n; i++) switch (gId[i]) { … case 2: case 3: if (gK[i + 1] != 0) break; case 4: … }`
// (`synthetic:sw_fallpre:agbcc`) the loop's `i + 1` is inserted above the jump table, case 2 keeps
// its own `gK[i + 1]` sum in that register, and SSA construction reads the register as a parameter
// of `case 4:` fed `i + 1` by both the switch edge and the arm falling into it. The structurer
// spells such a parameter as a C variable assigned on each edge, and on a switch edge that a
// fall-through path also reaches that is an edge copy it refuses to re-run ('the case fallen into
// takes a value from the switch edge'). Recomputing the expression in the block removes the
// parameter, and with it the copy.
//
// SOUND BY SSA: every in-edge's argument is the SAME VALUE, so reading it in the block is reading
// it on every edge. This is ir/simplify.ts's trivial phi (`trivialPhiValue`, which this calls) with
// identity widened to congruence, and with its waiver: a back edge that hands the parameter itself
// hands whatever the last entry did. "The same" is `sameAtEntry` (ir/entry.ts) with an empty entry
// map: one opcode, one set of attributes, operands the same in turn, down to LEAVES that are one SSA
// value on every edge. The walk reads through an op only when it can be re-evaluated anywhere (`clonable`: no
// effect, no memory read, nothing that traps, no placement stamp), so the expression's value is a
// function of its leaves alone; and every leaf must be defined in a block that strictly dominates
// the block, so it holds the same value there. C names need no argument of their own: the
// recomputed expression is fresh SSA ops reading the leaves, and namecoalesce gives a leaf that is
// live at the block a name no other live value shares.
//
// SCOPE, not soundness (the gates the precondition does not need, tabled as `UNPRE_GATES`):
//  • THE BLOCK IS A JOIN OF ONE SWITCH (`not-switch-join`): one in-edge is a `switch_br`'s, at least
//    one comes from another block, and every other comes from a block the dispatch dominates — an
//    arm of that switch. Two joins pass:
//     (1) A CASE FALLEN INTO (`case 4:` above). The structurer cannot spell its parameter as a
//         variable, because the switch-edge copy would re-run on the fall path, so it declines; the
//         fold is what lifts it.
//     (2) THE SWITCH'S EXIT, entered by the dispatch's default edge (the bounds test's, when the
//         source has no `default:`) and by the arms' `break`s. Its parameter IS spellable — a copy at
//         the end of every arm and a `default:` arm holding only the copy — so here the fold changes
//         the spelling, not whether the function lifts. `sw_fallpre`'s MATCH rests on it: PRE's
//         `i + 1` reaches the loop latch from every edge, the default one included, and with the
//         exit refused (only the case fallen into recomputed) the row lifts at 6/61 as `v1 = v0 + 1;`
//         in each arm, a `default:` arm, and `v0 = v1;` where the source has `i++`. Off the bench it
//         also re-spells functions that already lift, host-correct both ways (4 agbcc fuzz
//         seeds): per-arm `v2 = v0 + 1` becomes the latch's `v0 = v0 + 1`, and per-arm
//         `v1 = a1 * 3` (a source's `u = v * 3` above the switch, which every edge hands the join)
//         one `a1 * 3` read at the join.
//    Everywhere else the parameter is spellable too, and which spelling the source wrote the asm
//    does not say: a sum agbcc kept in each arm is also what a source computing it in each arm
//    compiles to. Measured at every join (full bench, the gate lifted): `synthetic:sw_fallpre` and
//    `synthetic:jt_pre_midg` MATCH, but `synthetic:bgshare:agbcc` and `synthetic:bgswitch:agbcc` lose
//    their MATCH, `synthetic:sw_jtloop:agbcc` goes 8/57 -> 32/58, and 21 rows move in all. Gated, the
//    full bench moves `sw_fallpre` alone (declined -> MATCH). The wider fold would be a lift
//    variation, and a variation never ships a function its default declines (rank.ts), so it could
//    not have lifted this row: the gate is what lets the default carry it. `unpre.test.ts` pins both
//    joins and an ordinary `if` join the gate keeps out.
//    A LOOP'S LATCH passes too: the block holding the back edge to a header that dominates it.
//    IDO computes a counted loop's loop-invariant bound `hi + 1` (`addiu v0,a1,1`) in the header
//    and again in the delay slot of every arm's `b latch`, so the latch of `for (i = lo; i <= hi;
//    i++) switch (..) { .. }` (`synthetic:sw_gotocase2:ido7.1`) takes `hi + 1` as a parameter every
//    in-edge hands it. The parameter is spellable — a copy at the end of every arm — but the
//    structurer reads a latch with a parameter as no `for` (`forPlanAt`'s `latch-params`), so the
//    fold is what lets the `for` read the latch at all. It is a pre-structure fold on every
//    toolchain, so it also folds a latch param no `for` reads: a `do`-`while` latch every arm hands
//    `p + 2` (KMC's `loop_elsebreak`) is spelled as the update `p = p + 2` rather than as a copy at
//    the end of each arm. Measured with the scope widened to latches alone over the synthetic tier,
//    16 cells move, no match is lost and no decline turns. Closer: uninit_bits ido 13 -> 6,
//    sw_loopret gcc2.7.2 81 -> 73, sw_loopret_ctl gcc2.7.2 60 -> 56, brk2sw_ctl agbcc 38 -> 34,
//    loop_elsebreak ido 26 -> 22, brk2out_sw ido 151 -> 148. Further: loop_elsebreak gcc2.7.2kmc
//    16 -> 23 and agbcc 26 -> 28, forexit_iv gcc2.7.2kmc 117 -> 121, brk2out_ctl gcc2.7.2kmc
//    151 -> 152; the other six by a line or none. A SIBLING'S STRIDE below is kept
//    out of the pre-structure folds on the same kind of measurement, and there the moves were one
//    way (brk2out_ctl ido 151 -> 214). `unpre.test.ts` pins an ido-shaped latch folding and the `if`
//    join staying out.
//  • the argument must be an op with operands (`operand-free`). An operand-free argument (a constant, a symbol's
//    address) is what a merge of `return 0;` arms or of a register the compiler set to one constant
//    on several paths carries, and those are spellings other passes own. A default arm that both the
//    switch edge and a falling case hand the constant 7 (the KMC/gcc2.7.2 shape thumb-switch.test.ts
//    pins) therefore still declines.
//
// A SIBLING'S LEAF (`recomputeDerivedParams`, its own trace stage just ahead of this one): the
// congruence above with one leaf allowed to differ per edge, where on every edge it is the argument
// that same edge hands a sibling parameter `i`. gcc 2.7.2 strength-reduces `for (i = lo; i <= hi;
// i++) .. gE[i] ..` to a header that carries `i << 3` beside `i`: the guard hands it `(lo, lo << 3)`
// and the latch `(i + 1, (i + 1) << 3)`. SOUND BY SSA, with no induction: on edge `e` the parameter
// `j` receives F(a_e) and `i` receives a_e, so at every entry `j` holds F(i), and reading F(i) in the
// block is reading `j`. F is one `clonable` op of one shape and result type on every edge; each other
// operand is one value every edge shares, defined in a block that strictly dominates this one, or a
// constant of one value (the latch's own `3` against the entry's). An argument that is not such an op
// on some edge (a back edge handing the parameter itself, a load, a call) leaves the parameter alone.
// The edge ops the fold leaves unread are deleted with whatever pure ops only they read, so a latch's
// `i + 1` the dead `(i + 1) << 3` was the second reader of is not named for it.
//
// UNGATED, by measurement: a loop header is no switch join, so this is exactly the widening the
// `not-switch-join` gate keeps from the congruent fold. Over the synthetic tier it moves only gcc
// 2.7.2 and KMC cells and loses no match (retpost_tail, uninit_bits, sw_h3, sw_h4 and bcpy_ind
// match through it; the brk2out rows lift a few insns further, with C that reads correct). It
// cannot be asked per loop as structure.ts's rerun asks its readings: the pre-structure folds run
// once, ahead of every attempt. The recomputed F(i) has no name, so a loop test that reads it reads
// the op of the IV that test sees, never a value one trip stale.
import {
  type Block,
  type Fn,
  type Op,
  type Successor,
  type Value,
  defOpMap,
  dominators,
  mkValue,
  opShape,
} from '../ir/core';
import { deletableWhenDead, placedAt, reevalUnsafe, spelledWhenDead } from '../ir/discipline';
import { sameAtEntry } from '../ir/entry';
import { inEdgesOf, retireParam, trivialPhiValue } from '../ir/simplify';
import { typeEquals } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** May this op be evaluated again at another program point to the same value? */
const clonable = (d: Op): boolean =>
  d.opcode !== 'call' && d.results.length === 1 && !reevalUnsafe(d) && !spelledWhenDead(d) && placedAt(d) === null;

/** A parameter the precondition admits: every in-edge (but a back edge handing the parameter itself)
 *  hands it one pure expression over leaves that strictly dominate the block. */
export interface RedundantParam {
  /** one in-edge is a `switch_br`'s, another comes from elsewhere, and every other comes from a block
   *  the dispatch dominates */
  readonly switchJoin: boolean;
  /** the block holds a loop's back edge: one of its successors is a header that dominates it */
  readonly latchJoin: boolean;
  /** the expression is an op with operands, not a constant or a symbol's address */
  readonly hasOperands: boolean;
}

/** THE SCOPE (the header's), as data: neither rule is needed for soundness — the precondition is —
 *  so neither is `sound`, and a test ablates one with `without()` to run the fold at every join.
 *  THE RESIDUE, untabled: the precondition itself (congruent arguments over `clonable` ops, leaves
 *  that strictly dominate the block). It is what the fold IS, not a refusal of it — drop any part
 *  and the recompute reads a different value — and the gates are asked only of a parameter it
 *  admits, so a census counts scope refusals, not shapes the fold could never take. */
export const UNPRE_GATES: readonly Gate<RedundantParam>[] = [
  {
    id: 'not-switch-join',
    why: 'outside a switch or a loop latch the parameter is spellable as a variable, and recomputing it re-spells functions that match',
    sound: false,
    rejects: (c) => !c.switchJoin && !c.latchJoin,
  },
  {
    id: 'operand-free',
    why: 'a merged constant or symbol address is a spelling the passes that merge constants own',
    sound: false,
    rejects: (c) => !c.hasOperands,
  },
];

/** Recompute every parameter of a switch's join (a case fallen into, or the switch's exit) or of a
 *  loop's latch whose in-edges all hand it one pure expression; returns how many parameters it
 *  removed. */
export function recomputeRedundantParams(fn: Fn, gates: readonly Gate<RedundantParam>[] = UNPRE_GATES): number {
  // The CFG does not change, so dominance and the in-edge index are computed once; the def map and
  // the homes grow with each clone.
  const dom = dominators(fn);
  const defs = defOpMap(fn);
  const home = new Map<Value, Block>();
  for (const b of fn.blocks) {
    b.params.forEach((p) => home.set(p, b));
    for (const op of b.ops) {
      op.results.forEach((r) => home.set(r, b));
    }
  }
  const inEdges = inEdgesOf(fn);
  /** a block the switch enters — a case, or by the default edge its exit — whose every other edge
   *  comes from inside the switch */
  const switchJoin = (ins: readonly { from: Block; op: Op }[]): boolean => {
    const dispatch = ins.find((e) => e.op.opcode === 'switch_br');
    return (
      dispatch !== undefined &&
      ins.some((e) => e.from !== dispatch.from) &&
      ins.every((e) => e.from === dispatch.from || dom.get(e.from)!.has(dispatch.from))
    );
  };
  /** a block holding a back edge: a successor that dominates it is the header of a loop it closes */
  const latchJoin = (b: Block): boolean => b.ops[b.ops.length - 1].successors.some((s) => dom.get(b)!.has(s.block));
  const through = (v: Value) => {
    const d = defs.get(v);
    return d !== undefined && clonable(d);
  };
  /** structural congruence: one pure expression over the same leaves */
  const congruent = (a: Value, b: Value) => sameAtEntry(defs, a, b, { entry: new Map(), through });
  let removed = 0;
  // A recomputed parameter can make a later block's arguments equal (a second case fallen into
  // whose argument reads the first's parameter), so sweep until a sweep removes nothing.
  for (let changed = true; changed;) {
    changed = false;
    for (const b of fn.blocks.slice(1)) {
      const ins = inEdges.get(b) ?? [];
      const incoming = ins.map((e) => e.succ);
      for (let k = 0; k < b.params.length;) {
        // THE trivial-phi predicate (ir/simplify.ts), held to congruence instead of identity: a back
        // edge handing the parameter itself is waived there, for the reason it is waived for a
        // trivial phi.
        const first = trivialPhiValue(incoming, k, b.params[k], congruent);
        const d0 = first === null ? undefined : defs.get(first);
        const clones: Op[] = [];
        const memo = new Map<Value, Value>();
        let leavesDominate = true;
        const clone = (v: Value): Value => {
          const seen = memo.get(v);
          if (seen !== undefined) {
            return seen;
          }
          const d = defs.get(v);
          let out = v;
          if (d !== undefined && clonable(d)) {
            const r = mkValue(v.type);
            const op: Op = {
              opcode: d.opcode,
              operands: d.operands.map(clone),
              results: [r],
              attrs: { ...d.attrs },
              successors: [],
            };
            clones.push(op);
            out = r;
          } else {
            const h = home.get(v);
            if (h === undefined || h === b || !dom.get(b)!.has(h)) {
              leavesDominate = false;
            }
          }
          memo.set(v, out);
          return out;
        };
        const value = first !== null && d0 !== undefined && clonable(d0) ? clone(first) : undefined;
        if (
          value === undefined ||
          !leavesDominate ||
          firstRejection(gates, {
            switchJoin: switchJoin(ins),
            latchJoin: latchJoin(b),
            hasOperands: d0!.operands.length > 0,
          }) !== null
        ) {
          k++;
          continue;
        }
        b.ops.unshift(...clones);
        for (const op of clones) {
          defs.set(op.results[0], op);
          home.set(op.results[0], b);
        }
        retireParam(fn, b, k, value, incoming);
        removed++;
        changed = true;
      }
    }
  }
  return removed;
}

/** Is `x` the same op as `y` apart from its operands' values: one opcode, attributes, operand count
 *  and result type? */
const sameShape = (x: Op, y: Op): boolean =>
  opShape(x) === opShape(y) &&
  x.operands.length === y.operands.length &&
  x.results.length === 1 &&
  typeEquals(x.results[0].type, y.results[0].type);

/** Recompute every block parameter `j` whose in-edges each hand it one pure op F over the argument
 *  that edge hands a sibling parameter `i` (A SIBLING'S LEAF, in the header): `j` is F(i). Returns
 *  how many parameters it removed. */
export function recomputeDerivedParams(fn: Fn): number {
  const dom = dominators(fn);
  const defs = defOpMap(fn);
  const home = new Map<Value, Block>();
  for (const b of fn.blocks) {
    b.params.forEach((p) => home.set(p, b));
    for (const op of b.ops) {
      op.results.forEach((r) => home.set(r, b));
    }
  }
  const inEdges = inEdgesOf(fn);
  /** the edge ops a fold stopped reading, swept once every block is done */
  const orphaned: Op[] = [];
  let removed = 0;
  for (const b of fn.blocks.slice(1)) {
    const ins = inEdges.get(b) ?? [];
    if (ins.length < 2) {
      continue;
    }
    const incoming = ins.map((e) => e.succ);
    /** F(i) as fresh ops at the head of `b`, or null where `j` is no one op of `i`'s arguments */
    const derive = (j: number): { ops: Op[]; value: Value } | null => {
      const ds = incoming.map((s) => defs.get(s.args[j]));
      const d0 = ds[0];
      if (d0 === undefined || !ds.every((d) => d !== undefined && clonable(d) && sameShape(d, d0))) {
        return null;
      }
      for (let i = 0; i < b.params.length; i++) {
        if (i === j) {
          continue;
        }
        const ivSlot = d0.operands.map((_, k) => incoming.every((s, x) => ds[x]!.operands[k] === s.args[i]));
        if (!ivSlot.some(Boolean)) {
          continue;
        }
        const ops: Op[] = [];
        const operands: Value[] = [];
        const ok = d0.operands.every((o, k) => {
          if (ivSlot[k]) {
            operands.push(b.params[i]);
            return true;
          }
          const vals = ds.map((d) => d!.operands[k]);
          if (vals.every((v) => v === o)) {
            // one value every edge shares, which must hold that value here too
            const h = home.get(o);
            operands.push(o);
            return h !== undefined && h !== b && dom.get(b)!.has(h);
          }
          // or a constant of one value on every edge, made again here
          const cs = vals.map((v) => defs.get(v));
          const c0 = cs[0];
          if (c0?.opcode !== 'const' || !cs.every((c) => c !== undefined && c.opcode === 'const' && sameShape(c, c0))) {
            return false;
          }
          const r = mkValue(o.type);
          ops.push({ opcode: 'const', operands: [], results: [r], attrs: { ...c0.attrs }, successors: [] });
          operands.push(r);
          return true;
        });
        if (!ok) {
          continue;
        }
        const r = mkValue(d0.results[0].type);
        ops.push({ opcode: d0.opcode, operands, results: [r], attrs: { ...d0.attrs }, successors: [] });
        return { ops, value: r };
      }
      return null;
    };
    for (let j = 0; j < b.params.length;) {
      const got = derive(j);
      if (got === null) {
        j++;
        continue;
      }
      orphaned.push(...incoming.map((s) => defs.get(s.args[j])!));
      b.ops.unshift(...got.ops);
      for (const op of got.ops) {
        defs.set(op.results[0], op);
        home.set(op.results[0], b);
      }
      retireParam(fn, b, j, got.value, incoming);
      removed++;
    }
  }
  sweepOrphans(fn, orphaned);
  return removed;
}

/** Delete each of `seeds` nothing reads any more, and then each pure op only the deleted read: never
 *  an op the fold did not orphan, which other passes own. */
function sweepOrphans(fn: Fn, seeds: readonly Op[]): void {
  const defs = defOpMap(fn);
  const uses = new Map<Value, number>();
  const read = (v: Value, by: number) => uses.set(v, (uses.get(v) ?? 0) + by);
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands.forEach((o) => read(o, 1));
      op.successors.forEach((s) => s.args.forEach((a) => read(a, 1)));
    }
  }
  const dead = new Set<Op>();
  const work = [...seeds];
  while (work.length > 0) {
    const op = work.pop()!;
    if (dead.has(op) || !clonable(op) || !deletableWhenDead(op) || (uses.get(op.results[0]) ?? 0) > 0) {
      continue;
    }
    dead.add(op);
    for (const o of op.operands) {
      read(o, -1);
      const d = defs.get(o);
      if (d !== undefined) {
        work.push(d);
      }
    }
  }
  if (dead.size > 0) {
    for (const b of fn.blocks) {
      b.ops = b.ops.filter((op) => !dead.has(op));
    }
  }
}

// A SIBLING'S STRIDE (`strideDerivedParams`): the fact `recomputeDerivedParams` folds — a header
// parameter `j` holds G(i) at every entry, `i` a sibling — proved over a loop's two edges by
// INDUCTION where the back edge hands `j + K` rather than G of the argument it hands `i`. IDO
// strength-reduces `gE[i]` in `for (i = lo; i <= hi; i++)` (`synthetic:sw_gotocase2:ido7.1`) to a
// pointer that starts at `gE + (lo << 3)` and steps by 8 beside `i`: the entry hands the header
// `(gE + (lo << 3), lo)` and the back edge `(p + 8, i + 1)`. G is `B + T(x)` or `T(x)`, T one of
// `x << s`, `x * M` (M a constant) or `x` (the last only beside a base), and B one value from outside
// the loop. The entry hands `j` exactly G(x0), x0 being what it hands `i`; the back edge hands `i + D`
// and `j + K` with K = T(D). T is linear in 32-bit words, so G(i + D) = G(i) + T(D) with no overflow
// argument: if `j` = G(i) on one entry, it is G(i + D) = G(i') on the next.
//
// A FACT, NOT A FOLD, by measurement: recomputed in the header ahead of every structuring, as
// `recomputeDerivedParams` recomputes its params, it re-spells every IDO loop that stays `while (1)`
// as an index recomputed per trip, and those lift further from the bytes (synthetic:brk2out_ctl:ido7.1
// 151/176 -> 214/224, forexit_old 163 -> 173). So the structurer reads it only where it spells the
// loop as a `for` (structure.ts `forPlanAt`, A SIBLING'S STRIDE), which writes `j` nowhere and reads
// G(i) at each of its uses. The caller states which values are from outside the loop.

/** A header parameter that is G of a sibling at every entry (A SIBLING'S STRIDE). */
export interface StrideDerived {
  /** the derived parameter's slot in the header */
  readonly j: number;
  /** the sibling's (the counter's) slot */
  readonly i: number;
  /** G's ops as the entry edge computes them, innermost first; the last one's result is G(x0) */
  readonly ops: readonly Op[];
  /** what the entry hands the sibling: the one leaf of G that is not from outside the loop */
  readonly x0: Value;
  /** G's other operands (the base, a multiplier, a shift amount), each from outside the loop */
  readonly leaves: readonly Value[];
}

/** Every header parameter that is G of a sibling at each entry, read over the loop's one entry edge
 *  and one back edge (A SIBLING'S STRIDE). `outside` says a value is defined in a block that strictly
 *  dominates the header. */
export function strideDerivedParams(
  defs: ReadonlyMap<Value, Op>,
  header: Block,
  entry: Successor,
  back: Successor,
  outside: (v: Value) => boolean,
): StrideDerived[] {
  const constOf = (v: Value): number | null => {
    const d = defs.get(v);
    return d?.opcode === 'const' && typeof d.attrs.value === 'number' ? d.attrs.value | 0 : null;
  };
  /** `v` is `p + c`, `c` a constant: `c` */
  const stepOf = (v: Value, p: Value): number | null => {
    const d = defs.get(v);
    if (d?.opcode !== 'add' || d.operands.length !== 2) {
      return null;
    }
    const [a, b] = d.operands;
    return a === p ? constOf(b) : b === p ? constOf(a) : null;
  };
  /** `v` is T(x0): its ops, its constant operands, and T(d) */
  const term = (v: Value, x0: Value, d: number): { ops: Op[]; leaves: Value[]; k: number } | null => {
    if (v === x0) {
      return { ops: [], leaves: [], k: d };
    }
    const t = defs.get(v);
    if (t === undefined || !clonable(t) || (t.opcode === 'shl' && t.operands[0] !== x0)) {
      return null;
    }
    if (t.opcode === 'shl') {
      const amount = t.operands.length === 1 ? t.attrs.imm : t.operands.length === 2 ? constOf(t.operands[1]) : null;
      return typeof amount !== 'number' || amount < 0 || amount > 31
        ? null
        : { ops: [t], leaves: t.operands.slice(1), k: (d << amount) | 0 };
    }
    if (t.opcode === 'mul' && t.operands.length === 2) {
      const at = t.operands.indexOf(x0);
      const m = at < 0 ? null : constOf(t.operands[1 - at]);
      return m === null ? null : { ops: [t], leaves: [t.operands[1 - at]], k: Math.imul(d, m) };
    }
    return null;
  };
  const out: StrideDerived[] = [];
  header.params.forEach((pj, j) => {
    const k = stepOf(back.args[j], pj);
    if (k === null) {
      return;
    }
    for (let i = 0; i < header.params.length; i++) {
      const d = i === j ? null : stepOf(back.args[i], header.params[i]);
      if (d === null || d === 0) {
        continue;
      }
      const x0 = entry.args[i];
      const g = entry.args[j];
      let found: { ops: Op[]; leaves: Value[]; k: number } | null = null;
      const bare = term(g, x0, d);
      if (bare !== null && bare.ops.length > 0) {
        found = bare;
      } else {
        const add = defs.get(g);
        if (add?.opcode === 'add' && add.operands.length === 2 && clonable(add)) {
          for (const at of [0, 1]) {
            const t = term(add.operands[at], x0, d);
            const base = add.operands[1 - at];
            if (t !== null && base !== x0 && outside(base)) {
              found = { ops: [...t.ops, add], leaves: [...t.leaves, base], k: t.k };
              break;
            }
          }
        }
      }
      if (found !== null && found.k === k && found.leaves.every(outside)) {
        out.push({ j, i, ops: found.ops, x0, leaves: found.leaves });
        return;
      }
    }
  });
  return out;
}
