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
// immediately before the same `ret`, with the tail's parameters replaced by the arguments that
// path carried; the stores' other operands dominate the tail and so every source of it. A copy
// replaces a `br`, the source's only edge. A CONDITIONAL edge cannot carry one — splicing over it
// would drop the branch's other successor — so the tail stays for the sources that reach it that
// way; that restriction is the rewrite's own precondition, not a gate.
//
// NO GATE: which copy stays shared is the follow's question, and whether a sunk function is worth
// a candidate is rank.ts's, asked with the follow's own predicate (`hasDivergentSharedRet`) rather
// than a copy of it here.
import { type Block, type Fn, type Value, mkOp, predecessors, reachableBlocks, terminator } from '../ir/core';
import { simplifyTrivialPhis } from '../ir/simplify';

/** One edge that supplies the tail its arguments, composed through any forwarder between: `args`
 *  are the values the tail's parameters take on it. */
interface Source {
  readonly from: Block;
  readonly args: readonly Value[];
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
    // The sources, seen through pure forwarders. `argsOf` sends the args of an edge into the block
    // being walked to the values the tail's parameters take on it.
    const forwarders = new Set<Block>();
    const sources: Source[] = [];
    const conditional: Block[] = [];
    const walk = (to: Block, argsOf: (edge: readonly Value[]) => readonly Value[]) => {
      for (const p of preds.get(to) ?? []) {
        const t = terminator(p)!;
        if (t.opcode !== 'br') {
          conditional.push(p);
          continue;
        }
        const args = argsOf(t.successors[0].args);
        const isForwarder =
          p !== fn.blocks[0] &&
          p.ops.length === 1 &&
          !forwarders.has(p) &&
          (preds.get(p) ?? []).every((q) => terminator(q)?.opcode === 'br');
        if (isForwarder) {
          forwarders.add(p);
          walk(p, (inner) => args.map((a) => (p.params.includes(a) ? inner[p.params.indexOf(a)] : a)));
        } else {
          sources.push({ from: p, args });
        }
      }
    };
    walk(tail, (edge) => edge);
    if (sources.length === 0 || sources.length + conditional.length < 2) {
      continue;
    }
    const body = tail.ops.slice(0, -1);
    for (const src of sources) {
      const sub = (v: Value) => (tail.params.includes(v) ? src.args[tail.params.indexOf(v)] : v);
      const copies = body.map((o) => mkOp('store', { operands: o.operands.map(sub), attrs: { ...o.attrs } }));
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
