// asmlift — natural-loop discovery: the pure CFG analysis the structurer consumes.
//
// Produces a DEFINITE header set computed structurally from back-edges — a block is a loop header
// iff it is a real back-edge target (`h ∈ dom(t)` for an edge `t→h`), never inferred from `cond_br`
// shape. That structural definiteness keeps loop detection from stealing a block switch/if recovery
// owns. It has NOTHING to do with AST emission and is unit-testable on synthetic CFGs with no
// emitter and no toolchain (test/loops.test.ts).
//
// Dominance itself is a substrate fact and lives in `ir/core.ts`; `analyzeLoops` takes the map as
// a parameter, so a caller passes `dominators(fn)` from there.
import { Block, Fn, predecessors, successorsOf } from '../ir/core';

/** One natural loop, keyed by its header. */
export interface NaturalLoop {
  /** the back-edge target — dominates every block in `body`. */
  header: Block;
  /** blocks with a back-edge to `header` (a loop has ≥1). */
  latches: Block[];
  /** the natural-loop node set: `header` + everything reaching a latch without passing through
   *  `header`. Ret-terminated blocks reached from the body (early returns) are NOT included — they are
   *  classified by the structurer, which distinguishes the header's own exit edge (the single real
   *  exit, whether or not it returns) from early-return edges out of other body blocks. */
  body: Set<Block>;
  /** every edge from a body block to a non-body block, scanned over ALL body blocks (so a second
   *  exit deep in the body is visible, not just the header's). The structurer decides which is
   *  the loop exit vs an early return. */
  exitEdges: { from: Block; to: Block }[];
  /** predecessors of `header` that are NOT in the body — the entry (init) side. A unique one is the
   *  preheader. */
  forwardPreds: Block[];
  /** true when `header` is its own successor (the single-block do-while shape emitWhile handles). */
  selfLoop: boolean;
}

export interface LoopForest {
  byHeader: Map<Block, NaturalLoop>;
  /** nesting parent: the header of the smallest loop strictly containing this loop (or null). */
  parent: Map<Block, Block | null>;
}

/** Discover every natural loop and the nesting forest. Pure over the CFG + dominators. */
export function analyzeLoops(fn: Fn, dom: Map<Block, Set<Block>>): LoopForest {
  const preds = predecessors(fn);
  const byHeader = new Map<Block, NaturalLoop>();

  // Back-edges: an edge t→h where h dominates t. h is a header, t a latch. Merge multiple back-edges
  // into one loop (a header can have several latches).
  for (const t of fn.blocks) {
    for (const h of successorsOf(t)) {
      if (!dom.get(t)!.has(h)) {
        continue;
      } // not a back-edge
      let nl = byHeader.get(h);
      if (!nl) {
        nl = { header: h, latches: [], body: new Set([h]), exitEdges: [], forwardPreds: [], selfLoop: false };
        byHeader.set(h, nl);
      }
      nl.latches.push(t);
      if (t === h) {
        nl.selfLoop = true;
      }
    }
  }

  for (const nl of byHeader.values()) {
    const body = nl.body;
    // Natural body: header + every node reaching a latch without passing through the header.
    const stack: Block[] = [];
    for (const l of nl.latches) {
      if (!body.has(l)) {
        body.add(l);
      }
      stack.push(l);
    }
    while (stack.length) {
      const b = stack.pop()!;
      if (b === nl.header) {
        continue;
      }
      for (const p of preds.get(b)!) {
        if (p === nl.header) {
          continue;
        }
        if (!body.has(p)) {
          body.add(p);
          stack.push(p);
        }
      }
    }
    // Exits: every edge from a body block to a non-body block, over every body block. The
    // structurer separates the header's own exit edge (the real exit) from early-return edges.
    for (const b of body) {
      for (const s of successorsOf(b)) {
        if (!body.has(s)) {
          nl.exitEdges.push({ from: b, to: s });
        }
      }
    }
    nl.forwardPreds = (preds.get(nl.header) ?? []).filter((p) => !body.has(p));
  }

  // Nesting: parent(header) = the header of the smallest OTHER loop whose body contains it.
  const headers = [...byHeader.keys()];
  const parent = new Map<Block, Block | null>();
  for (const h of headers) {
    let best: Block | null = null;
    let bestSize = Infinity;
    for (const h2 of headers) {
      if (h2 === h) {
        continue;
      }
      const b2 = byHeader.get(h2)!;
      if (b2.body.has(h) && b2.body.size < bestSize) {
        best = h2;
        bestSize = b2.body.size;
      }
    }
    parent.set(h, best);
  }

  return { byHeader, parent };
}

/** The loop's latches as a CHAIN at its bottom, in the order control reaches them — or null. Each
 *  latch is a two-way branch with one edge back to the header; each one's other edge enters the
 *  next latch, and the last one's leaves the loop. That is `do { … } while (a || b || c)` with its
 *  terms left as branches, which the IR keeps whenever it cannot fold one into a single test (a
 *  later term calls a function, and the fold would run the call unconditionally).
 *
 *  Every latch after the first is entered only from the one before it, takes no params, and hands
 *  the header the same arguments the first one does, so the loop's update is ONE set of copies
 *  whichever term sends it round. The first latch may be the header itself. A single latch, or any
 *  other latch set, is null. */
export function latchChain(nl: NaturalLoop, preds: Map<Block, Block[]>): Block[] | null {
  const latches = new Set(nl.latches);
  if (latches.size < 2) {
    return null;
  }
  const next = new Map<Block, Block>();
  for (const l of latches) {
    const term = l.ops[l.ops.length - 1];
    const back = term.opcode === 'cond_br' ? term.successors.filter((s) => s.block === nl.header) : [];
    if (term.successors.length !== 2 || back.length !== 1) {
      return null;
    }
    next.set(l, term.successors.find((s) => s.block !== nl.header)!.block);
  }
  const entered = new Set(next.values());
  const starts = [...latches].filter((l) => !entered.has(l));
  if (starts.length !== 1) {
    return null;
  }
  const chain = [starts[0]];
  while (latches.has(next.get(chain[chain.length - 1])!) && chain.length <= latches.size) {
    chain.push(next.get(chain[chain.length - 1])!);
  }
  if (chain.length !== latches.size || nl.body.has(next.get(chain[chain.length - 1])!)) {
    return null;
  }
  const backArgs = (l: Block) => l.ops[l.ops.length - 1].successors.find((s) => s.block === nl.header)!.args;
  const first = backArgs(chain[0]);
  for (let i = 1; i < chain.length; i++) {
    const l = chain[i];
    const ps = preds.get(l) ?? [];
    if (l === nl.header || l.params.length !== 0 || ps.length !== 1 || ps[0] !== chain[i - 1]) {
      return null;
    }
    const args = backArgs(l);
    if (args.length !== first.length || args.some((v, k) => v !== first[k])) {
      return null;
    }
  }
  return chain;
}

/** A self-loop that shares its header with an enclosing loop: the natural loops of `do { while
 *  (c); … } while (d)`, which the back-edge analysis merges into one because both back edges
 *  target the same block. The header's own edge is the inner loop and every other latch the outer
 *  one's. */
export interface HeaderNest {
  /** the outer loop's latches: one, or a chain of them (`latchChain`) */
  latches: Block[];
  /** where the inner self-loop's test sends control when it fails — the rest of the outer body */
  innerExit: Block;
}

/** The loop as a {@link HeaderNest}, or null. The header's terminator is a two-way branch with one
 *  edge to itself and the other staying in the loop, and the other latches form the outer loop's
 *  latch or chain. Null when all the latches together form a chain: that is a single loop whose
 *  test the header's branch begins. */
export function sharedHeaderNest(nl: NaturalLoop, preds: Map<Block, Block[]>): HeaderNest | null {
  const h = nl.header;
  const rest = [...new Set(nl.latches)].filter((l) => l !== h);
  const term = h.ops[h.ops.length - 1];
  if (!nl.selfLoop || rest.length === 0 || term.opcode !== 'cond_br' || latchChain(nl, preds) !== null) {
    return null;
  }
  const out = term.successors.filter((s) => s.block !== h);
  if (out.length !== 1 || !nl.body.has(out[0].block)) {
    return null;
  }
  const latches = rest.length === 1 ? rest : latchChain({ ...nl, latches: rest }, preds);
  return latches === null ? null : { latches, innerExit: out[0].block };
}
