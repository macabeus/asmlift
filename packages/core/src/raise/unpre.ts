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
// it on every edge. "The same" is `sameAtEntry` (ir/entry.ts) with an empty entry map: one opcode,
// one set of attributes, operands the same in turn, down to LEAVES that are one SSA value on every
// edge. The walk reads through an op only when it can be re-evaluated anywhere (`clonable`: no
// effect, no memory read, nothing that traps, no placement stamp), so the expression's value is a
// function of its leaves alone; and every leaf must be defined in a block that strictly dominates
// the block, so it holds the same value there. C names need no argument of their own: the
// recomputed expression is fresh SSA ops reading the leaves, and namecoalesce gives a leaf that is
// live at the block a name no other live value shares.
//
// SCOPE, not soundness (the gates the precondition does not need):
//  • THE BLOCK IS A CASE FALLEN INTO: one in-edge is a `switch_br`'s, and every other comes from a
//    block the dispatch dominates — an arm of that switch. That is the one join the structurer
//    cannot spell as a variable, because the switch-edge copy would re-run on the fall path, so it
//    declines. Everywhere else the parameter IS spellable, and which spelling the source wrote the asm
//    does not say: a sum agbcc kept in each arm is also what a source computing it in each arm
//    compiles to. Measured at every join (full bench, the gate lifted): `synthetic:sw_fallpre` and
//    `synthetic:jt_pre_midg` MATCH, but `synthetic:bgshare:agbcc` and `synthetic:bgswitch:agbcc` lose
//    their MATCH, `synthetic:sw_jtloop:agbcc` goes 8/57 -> 32/58, and 21 rows move in all. Gated, the
//    full bench moves `sw_fallpre` alone (declined -> MATCH). The wider fold would be a lift
//    variation, and a variation never ships a function its default declines (rank.ts), so it could
//    not have lifted this row: the gate is what lets the default carry it.
//  • the argument must be an op with operands. An operand-free argument (a constant, a symbol's
//    address) is what a merge of `return 0;` arms or of a register the compiler set to one constant
//    on several paths carries, and those are spellings other passes own. A default arm that both the
//    switch edge and a falling case hand the constant 7 (the KMC/gcc2.7.2 shape thumb-switch.test.ts
//    pins) therefore still declines.
import {
  type Block,
  type Fn,
  type Op,
  type Successor,
  type Value,
  defOpMap,
  dominators,
  mkValue,
  replaceAllUsesWith,
} from '../ir/core';
import { placedAt, reevalUnsafe, spelledWhenDead } from '../ir/discipline';
import { sameAtEntry } from '../ir/entry';

/** May this op be evaluated again at another program point to the same value? */
const clonable = (d: Op): boolean =>
  d.opcode !== 'call' && d.results.length === 1 && !reevalUnsafe(d) && !spelledWhenDead(d) && placedAt(d) === null;

export interface UnpreOptions {
  /** lift the scope gate: recompute at every join, not only at a case fallen into. Tests only — it
   *  is what the gate's measurement in the header ran. */
  readonly everyJoin?: boolean;
}

/** Recompute every parameter of a case fallen into whose in-edges all hand it one pure expression;
 *  returns how many parameters it removed. */
export function recomputeRedundantParams(fn: Fn, opts: UnpreOptions = {}): number {
  // The CFG does not change, so dominance is computed once; the def map and the homes grow with
  // each clone.
  const dom = dominators(fn);
  const defs = defOpMap(fn);
  const home = new Map<Value, Block>();
  for (const b of fn.blocks) {
    b.params.forEach((p) => home.set(p, b));
    for (const op of b.ops) {
      op.results.forEach((r) => home.set(r, b));
    }
  }
  // The SUCCESSOR itself, not its `args`: `replaceAllUsesWith` gives every successor a new array.
  const inEdges = new Map<Block, { succ: Successor; from: Block; op: Op }[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        inEdges.set(s.block, [...(inEdges.get(s.block) ?? []), { succ: s, from: b, op }]);
      }
    }
  }
  /** THE SCOPE GATE (see the header): a case the switch enters, every other edge from inside it. */
  const fallenInto = (ins: readonly { from: Block; op: Op }[]): boolean => {
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
  let removed = 0;
  // A recomputed parameter can make a later block's arguments equal (a second case fallen into
  // whose argument reads the first's parameter), so sweep until a sweep removes nothing.
  for (let changed = true; changed;) {
    changed = false;
    for (const b of fn.blocks.slice(1)) {
      const ins = inEdges.get(b) ?? [];
      if (ins.length < 2 || !(opts.everyJoin || fallenInto(ins))) {
        continue;
      }
      for (let k = 0; k < b.params.length;) {
        const first = ins[0].succ.args[k];
        const d0 = defs.get(first);
        const equal =
          d0 !== undefined &&
          d0.operands.length > 0 &&
          clonable(d0) &&
          ins.every((e) => sameAtEntry(defs, e.succ.args[k], first, { entry: new Map(), through }));
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
        const value = equal ? clone(first) : undefined;
        if (value === undefined || !leavesDominate) {
          k++;
          continue;
        }
        const param = b.params[k];
        b.ops.unshift(...clones);
        for (const op of clones) {
          defs.set(op.results[0], op);
          home.set(op.results[0], b);
        }
        replaceAllUsesWith(fn, param, value);
        b.params.splice(k, 1);
        for (const e of ins) {
          e.succ.args.splice(k, 1);
        }
        removed++;
        changed = true;
      }
    }
  }
  return removed;
}
