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
