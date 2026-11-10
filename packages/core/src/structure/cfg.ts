// asmlift structurer — the CFG facts the structurer reads: in-edges (`predecessorBlocks`,
// `successorTo`, `inEdgeRecords`), the guard shape a self-loop's discovery and its guard fusion
// share (`isGuardShapedPred`), avoiding reachability (`reachesAvoiding`), and the function-level
// immediate post-dominators (`functionPostDominators`, memoised on the CFG facts it reads, over
// `postDominators`). Loop DISCOVERY is ../ir/loops.ts; dominators are ../ir/core.ts.
import { Block, Fn, Successor, dominators, successorsOf } from '../ir/core';
import { type NaturalLoop, analyzeLoops } from '../ir/loops';

// THE one copy of the guard shape (like fieldSpellsDot/derefStrideOk): a predecessor whose
// cond_br decides "enter `header` vs its `exit`". The self-loop DISCOVERY classifies ownership
// with it, and the guard-FUSION site consumes the same shape (its `takenB/fallB === li.exit`
// check is this predicate from the branch's own viewpoint) — a drift between the two is
// fail-safe (traced: either an onStack decline or an unfused `if (g) do…while` spelling, never
// wrong code) but wastes capability, so both keep pointing here.
export function isGuardShapedPred(pred: Block, header: Block, exit: Block): boolean {
  if (pred === header) {
    return false;
  }
  const t = pred.ops[pred.ops.length - 1];
  return (
    t.opcode === 'cond_br' &&
    t.successors.some((sx) => sx.block === header) &&
    t.successors.some((sx) => sx.block === exit)
  );
}

/** does a path from `from` reach `to` without passing through `avoid`? */
export function reachesAvoiding(from: Block, to: Block, avoid: Block): boolean {
  const seen = new Set<Block>([avoid]);
  const stack = successorsOf(from);
  while (stack.length) {
    const x = stack.pop()!;
    if (x === to) {
      return true;
    }
    if (!seen.has(x)) {
      seen.add(x);
      stack.push(...successorsOf(x));
    }
  }
  return false;
}

// --- CFG utilities ---
/** Every block's in-edges. THROWS BY NAME on a successor that is not a block of `fn` — the one
 *  state that makes this map lie, and the one the whole structurer reads positions and dominance
 *  out of. `ir/verify.ts` already rejects that state with a name and the tower runs it after the
 *  lift and after every raising pass, so reaching HERE means a pass built it after the last verify:
 *  exactly when a named error beats a `TypeError` from a CFG utility 3000 lines from anything the
 *  reader recognises. switch-recover.ts PRE5 and its test cite this throw as a loud invariant. */
export function predecessorBlocks(fn: Fn): Map<Block, Block[]> {
  const m = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    m.set(b, []);
  }
  for (const [i, b] of fn.blocks.entries()) {
    for (const s of successorsOf(b)) {
      const preds = m.get(s);
      if (!preds) {
        throw new Error(`successor of block ${i} is not a block of this fn (fn '${fn.name}', predecessorBlocks)`);
      }
      preds.push(b);
    }
  }
  return m;
}
export function successorTo(pred: Block, target: Block) {
  const term = pred.ops[pred.ops.length - 1];
  return term.successors.find((s) => s.block === target);
}
/** EVERY in-edge record into `b` — which is what {@link successorTo} cannot give: it returns only
 *  the FIRST record to a block, so a terminator with two edges to the same block hides the second
 *  edge's args. Callers that ask "what does every path pass for param i" need all of them.
 *
 *  ORDER IS LOAD-BEARING and is `preds` insertion order, then terminator-successor order: the
 *  naming walk takes the FIRST admissible carrier, so a different order is a different spelling.
 *
 *  AND IT IS GUARDED, not merely warned about — measured, not reasoned: rewriting this walk to call
 *  `successorTo` turns 12 tests across 5 files of `packages/core/test` red. The path it would lose
 *  is reached constantly, 326,305 times over that suite on a `cond_br` whose two arms land on one
 *  block and 6 more on a `switch_br`.
 *
 *  The terminator is read UNGUARDED (`ops[ops.length - 1]`) on purpose: every block of a verified
 *  Fn has one, and a guard would turn a malformed Fn's throw into a silent missing edge.
 *
 *  `hasParamRootedMerge` does not go through this, deliberately: it is a pre-structuring query over
 *  a raw Fn and walks `fn.blocks` rather than a predecessor map it would first have to build. */
export function* inEdgeRecords(preds: Map<Block, Block[]>, b: Block): Generator<{ pred: Block; succ: Successor }> {
  for (const pred of new Set(preds.get(b) ?? [])) {
    for (const succ of pred.ops[pred.ops.length - 1].successors) {
      if (succ.block === b) {
        yield { pred, succ };
      }
    }
  }
}

/** THE function-level immediate post-dominators, the one definition `structure()` and its
 *  enumeration gate `hasDivergentSharedRet` both read, so the gate's join for an `if` is the join
 *  the follow sees. A loop no edge leaves reaches no `ret`, so plain post-dominance would hand
 *  every block before it every block as a post-dominator, and an `if` ahead of it an arbitrary
 *  join. Its header ENDS paths as a `ret` does: the region holding the loop ends there
 *  (`emitForever`). `forest` is the caller's, when it already has one. */
export function functionPostDominators(
  fn: Fn,
  forest: { byHeader: ReadonlyMap<Block, NaturalLoop> } = analyzeLoops(fn, dominators(fn)),
): Map<Block, Block | null> {
  const exitless = [...forest.byHeader.values()].filter((nl) => nl.exitEdges.length === 0).map((nl) => nl.header);
  const ends = new Set(exitless);
  // MEMOISED ON THE CFG IT READS: the ladder structures one fn again per rung (`structureLadder`),
  // and each run asks this of the same CFG. The key is everything `postDominators` reads here —
  // the block order, each terminator's opcode and successors, and which blocks end paths — so a
  // structuring that changed any of it computes afresh. Handed out as a copy, so no caller can
  // edit another's answer.
  const key: unknown[] = [];
  for (const b of fn.blocks) {
    const term = b.ops[b.ops.length - 1];
    key.push(b, term?.opcode, ends.has(b), ...successorsOf(b), null);
  }
  const cached = POST_DOMINATORS.get(fn);
  if (cached !== undefined && cached.key.length === key.length && cached.key.every((x, i) => x === key[i])) {
    return new Map(cached.ipdom);
  }
  const ipdom = postDominators(fn, undefined, undefined, ends);
  POST_DOMINATORS.set(fn, { key, ipdom: new Map(ipdom) });
  return ipdom;
}
const POST_DOMINATORS = new WeakMap<Fn, { key: readonly unknown[]; ipdom: ReadonlyMap<Block, Block | null> }>();

// Immediate post-dominators. EXIT is represented as `null`; ret-blocks post-lead to it, and so do
// the blocks of `ends` besides their own successors. Over the subgraph `keep` induces when given,
// every member of which must still reach a `ret` inside it — or, with `onward`, over only the edges
// it names between members of `keep` (and to EXIT, where it names `null`): a block it names no edge
// from ends its paths, post-dominated by nothing but itself.
export function postDominators(
  fn: Fn,
  keep?: ReadonlySet<Block>,
  onward?: (b: Block) => (Block | null)[],
  ends?: ReadonlySet<Block>,
): Map<Block, Block | null> {
  const blocks = keep ? fn.blocks.filter((b) => keep.has(b)) : fn.blocks;
  const nodes: (Block | null)[] = [null, ...blocks];
  const succ = (b: Block): (Block | null)[] => {
    if (onward !== undefined) {
      return onward(b);
    }
    const term = b.ops[b.ops.length - 1];
    if (term.opcode === 'ret') {
      return [null];
    }
    const onwards = successorsOf(b).filter((s) => keep === undefined || keep.has(s));
    return ends?.has(b) === true ? [...onwards, null] : onwards;
  };
  const pdom = new Map<Block | null, Set<Block | null>>();
  pdom.set(null, new Set([null]));
  for (const b of blocks) {
    pdom.set(b, new Set(nodes));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of blocks) {
      const ss = succ(b);
      let inter: Set<Block | null> | null = null;
      for (const s of ss) {
        const ps = pdom.get(s)!;
        if (inter === null) {
          inter = new Set(ps);
          continue;
        }
        for (const x of inter) {
          if (!ps.has(x)) {
            inter.delete(x);
          }
        } // intersect in place (spec-safe delete-in-iter)
      }
      const next = new Set<Block | null>(inter ?? []);
      next.add(b);
      if (!setEq(next, pdom.get(b)!)) {
        pdom.set(b, next);
        changed = true;
      }
    }
  }
  // ipdom(b) = the strict post-dom c with (strictPostDoms(b) \ {c}) ⊆ pdom(c)
  const ipdom = new Map<Block, Block | null>();
  for (const b of blocks) {
    const strict = [...pdom.get(b)!].filter((c) => c !== b);
    let chosen: Block | null = null;
    for (const c of strict) {
      // `others` has strict.length - 1 members, so a smaller set cannot hold them all: the same
      // answer, without building and walking `others` for every farther post-dominator
      if (pdom.get(c)!.size < strict.length - 1) {
        continue;
      }
      const others = strict.filter((x) => x !== c);
      if (others.every((x) => pdom.get(c)!.has(x))) {
        chosen = c;
        break;
      }
    }
    ipdom.set(b, chosen);
  }
  return ipdom;
}
function setEq<X>(a: Set<X>, b: Set<X>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const x of a) {
    if (!b.has(x)) {
      return false;
    }
  }
  return true;
}
