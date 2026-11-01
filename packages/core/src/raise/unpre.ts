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
import { type Block, type Fn, type Op, type Value, defOpMap, dominators, mkValue, opShape } from '../ir/core';
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
    why: 'outside a switch the parameter is spellable as a variable, and recomputing it re-spells functions that match',
    sound: false,
    rejects: (c) => !c.switchJoin,
  },
  {
    id: 'operand-free',
    why: 'a merged constant or symbol address is a spelling the passes that merge constants own',
    sound: false,
    rejects: (c) => !c.hasOperands,
  },
];

/** Recompute every parameter of a switch's join (a case fallen into, or the switch's exit) whose
 *  in-edges all hand it one pure expression; returns how many parameters it removed. */
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
          firstRejection(gates, { switchJoin: switchJoin(ins), hasOperands: d0!.operands.length > 0 }) !== null
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
