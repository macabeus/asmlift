// asmlift — sink a shared STORE tail back into the paths that branch to it.
//
// agbcc's gcse.c PRE finds a trailing store's base partially redundant, INSERTS it at the end of
// every predecessor of the join, and the arms then cross-jump into one `store; ret`:
//
//     if (c) { for (…) …; } else { if (x) { gQ.cur = fnA; return; } }
//     gQ.cur = fnB;
//
// lifts as ONE tail block `^t(v): store gQ.cur, v; ret` that the `fnA` arm and the join the two
// sides reach both branch to. The structurer can spell that tail once, after the `if`, only if the
// `fnA` path returns before it — so this duplicates the tail into every path that branches to it.
// WHICH copy is the tail the source wrote once is not decided here: it is the `ret` reachable from
// both successors of the `if`, which `structure()`'s `followEarlyReturns` finds and spells after
// the `if`, with every other copy an early `return;` (`synthetic:gcsetail`). Under `-fno-gcse` the
// tail/duplicated pairs compile byte-identical, and there is no loop gate: a loop before the join
// is a sample, not a law.
//
// A block that supplies the tail's arguments is a SOURCE: a PURE FORWARDER (`^f(v): br ^t(v)`,
// reached only by `br`) is seen through to its own predecessors, so the arms that branch into the
// tail through a shared base reload are sources like any other (`synthetic:gcsefwd`).
//
// A LIFT VARIANT, NEVER A DEFAULT: `synthetic:gcsepre` and `synthetic:gcsepredup` compile to
// different objects (an r4/r5 swap) and lift to byte-identical IR, the first written with the
// shared tail and the second with the default duplicated into each arm — no IR rule tells them
// apart, so rank.ts enumerates this beside the unsunk lift and the differ referees.
//
// SOUND BY CONSTRUCTION: tail duplication. Each copy runs on exactly the paths that ran the tail,
// immediately before the same `ret`. A value the tail reads is one of two things. It is a block
// parameter of the tail OR OF A FORWARDER on the way, and the copy takes the argument that path's
// edge into that block carried. Or it is defined elsewhere, dominates the tail, and so dominates
// every source of it. The forwarder's own parameter is not a corner: a tail whose only predecessor
// is a forwarder loses its parameter to raise's `simplifyTrivialPhis` and reads the forwarder's
// directly — a jump pad `.L4: b .L6` in front of the store does exactly that — and the forwarder is
// swept once every source holds its copy. A copy replaces a `br`, the source's only edge. A
// CONDITIONAL edge cannot carry one — splicing over it would drop the branch's other successor — so
// the tail stays for the sources that reach it that way; that restriction is the rewrite's own
// precondition, not a gate.
//
// NO GATE: which copy stays shared is the follow's question, and whether a sunk function is worth
// a candidate is rank.ts's, asked with the follow's own predicate (`hasDivergentSharedRet`) rather
// than a copy of it here.
import { type Block, type Fn, type Value, mkOp, predecessors, reachableBlocks, terminator } from '../ir/core';
import { simplifyTrivialPhis } from '../ir/simplify';

/** One edge that supplies the tail its arguments. `resolve` sends a value the tail reads to the
 *  value it has at the end of `from`: a parameter of the tail or of any forwarder between becomes
 *  the argument this path's edge into that block carried, and anything else is left alone. */
interface Source {
  readonly from: Block;
  readonly resolve: (v: Value) => Value;
}

/** A block whose ops are one or more `store`s and then a void `ret`. */
function isStoreTail(b: Block): boolean {
  const t = b.ops[b.ops.length - 1];
  return (
    b.ops.length >= 2 &&
    t.opcode === 'ret' &&
    t.operands.length === 0 &&
    b.ops.slice(0, -1).every((o) => o.opcode === 'store')
  );
}

/** Copy every store tail that two or more sources reach into each source that reaches it by a
 *  `br`; returns whether anything changed. */
export function sinkStoreTails(fn: Fn): boolean {
  let changed = false;
  for (const tail of [...fn.blocks]) {
    if (tail === fn.blocks[0] || !fn.blocks.includes(tail) || !isStoreTail(tail)) {
      continue;
    }
    const preds = predecessors(fn);
    // The sources, seen through pure forwarders. `resolve` sends a value the tail reads to the value
    // it has on entry to the block being walked; each edge out of a predecessor composes one more
    // step onto it — `to`'s own parameters, not only the tail's, because the tail may read a
    // forwarder's parameter directly.
    const forwarders = new Set<Block>();
    const sources: Source[] = [];
    const conditional: Block[] = [];
    const walk = (to: Block, resolve: (v: Value) => Value) => {
      for (const p of preds.get(to) ?? []) {
        const t = terminator(p)!;
        if (t.opcode !== 'br') {
          conditional.push(p);
          continue;
        }
        const edge = t.successors[0].args;
        const through = (v: Value): Value => {
          const w = resolve(v);
          const i = to.params.indexOf(w);
          return i >= 0 ? edge[i] : w;
        };
        const isForwarder =
          p !== fn.blocks[0] &&
          p.ops.length === 1 &&
          !forwarders.has(p) &&
          (preds.get(p) ?? []).every((q) => terminator(q)?.opcode === 'br');
        if (isForwarder) {
          forwarders.add(p);
          walk(p, through);
        } else {
          sources.push({ from: p, resolve: through });
        }
      }
    };
    walk(tail, (v) => v);
    if (sources.length === 0 || sources.length + conditional.length < 2) {
      continue;
    }
    const body = tail.ops.slice(0, -1);
    for (const src of sources) {
      const copies = body.map((o) => mkOp('store', { operands: o.operands.map(src.resolve), attrs: { ...o.attrs } }));
      src.from.ops.splice(src.from.ops.length - 1, 1, ...copies, mkOp('ret'));
    }
    // By REACHABILITY, not predecessor count: the tail (unless a conditional edge keeps it) and
    // every forwarder on the way are left unreachable, however long the chain, and a forwarder's
    // in-edge from another orphan still counts as a predecessor.
    const live = reachableBlocks(fn);
    fn.blocks = fn.blocks.filter((b) => live.has(b));
    changed = true;
  }
  if (changed) {
    simplifyTrivialPhis(fn);
  }
  return changed;
}
