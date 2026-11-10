// asmlift structurer — where a construct whose arms all return ends: the `ret`s every successor
// of a branch shares (`sharedRetsOf`), the enumeration gate of the shared-tail twins
// (`hasDivergentSharedRet`), and the join past early returns (`joinsPastReturns`,
// `joinPastReturnsAsked`) the structurer's `if`, comparison-tree and jump-table sites take.
import { Block, Fn, successorsOf } from '../ir/core';
import { functionPostDominators } from './cfg';

export function isRet(blk: Block): boolean {
  return blk.ops[blk.ops.length - 1]?.opcode === 'ret';
}
/** The `ret`s reachable from EVERY successor of `b` — the region `followOverReturns` keeps — or,
 *  given an `anchor`, from every successor that shares a `ret` with the anchor. Empty when there
 *  is none, and when `b` does not branch at all. `reachFrom` is forward reachability, the start
 *  block excluded.
 *
 *  THE QUESTION IS ABOUT A BRANCH, not about an `if`: "the arms all return, so post-dominance gives
 *  this block no join — where does the construct end?" is asked by a jump table exactly as by a
 *  two-way branch, and the answer is derived the same way. The `if`-shaped reading belongs to the
 *  CALLER that wants it (`hasDivergentSharedRet`), not here.
 *
 *  THE ANCHOR names a successor taken to reach the end the question is about, and leaves out
 *  every successor that shares no `ret` with it (`leftOutOf`). The `switch_br` caller anchors on
 *  the dispatch's DEFAULT edge, whose target is the `default:` arm or the code after the switch: a
 *  `case` that `return`s on its own, or falls into one that does, then no longer empties the
 *  intersection for the arms that `break`. Leaving those successors out is sound for the follow the
 *  caller derives from the answer: the answer is a subset of the anchor's `ret`s, so a successor
 *  left out reaches none of them, hence no block that reaches one — in particular not the follow —
 *  and it is structured to its own `return`. It is a candidate and not evidence that the source
 *  ended the construct there: a `default:` that `return`s on its own is an anchor too, and the
 *  caller states what it reads to tell the two apart. The `if` caller never anchors.
 *
 *  THE DEDUP IS DEFENSIVE AND NO CALLER CAN REACH IT TODAY. It is what makes "two successors that
 *  are the same block" answer `[]` rather than "a branch with a shared `ret`". Both callers ask
 *  only when `ipdom.get(b)` is null, and a branch whose successors are all ONE block has that block
 *  as its post-dominator, so they never ask it of that shape. It stays because the answer belongs
 *  to this function rather than to its callers' guards, and dropping it is a no-op on the corpus:
 *  the reader over every row of the committed artifact (`decompile` per row, no compiling) emits
 *  byte-identical source with and without it. */
export function sharedRetsOf(
  b: Block,
  reachFrom: (x: Block) => ReadonlySet<Block>,
  anchor: Block | null = null,
): Block[] {
  const left = anchor === null ? [] : leftOutOf(b, reachFrom, anchor);
  const succs = [...new Set(successorsOf(b))].filter((x) => !left.includes(x));
  if (succs.length < 2) {
    return [];
  }
  return succs
    .map((x) => retsFrom(x, reachFrom))
    .reduce((shared, rets) => {
      const here = new Set(rets);
      return shared.filter((r) => here.has(r));
    });
}
function retsFrom(x: Block, reachFrom: (x: Block) => ReadonlySet<Block>): Block[] {
  return [x, ...reachFrom(x)].filter(isRet);
}
/** The successors of `b` that share no `ret` with `anchor` — the ones `sharedRetsOf` leaves out. */
export function leftOutOf(b: Block, reachFrom: (x: Block) => ReadonlySet<Block>, anchor: Block): Block[] {
  const anchored = new Set(retsFrom(anchor, reachFrom));
  return [...new Set(successorsOf(b))].filter((x) => !retsFrom(x, reachFrom).some((r) => anchored.has(r)));
}
/** Is there an `if` whose arms reach no common block before EXIT but share a `ret` — the only shape
 *  `followEarlyReturns` changes? The enumeration gate of both shared-tail twins (rank.ts), asked of
 *  the fn as raised and again of the sunk fn; a superset, since it asks `sharedRetsOf` and none of
 *  the follow's three later refusals. An `if`, specifically: see the restriction at the `some`. */
export function hasDivergentSharedRet(fn: Fn): boolean {
  const ipdom = functionPostDominators(fn);
  const reach = new Map<Block, Set<Block>>();
  const reachFrom = (b: Block): Set<Block> => {
    let out = reach.get(b);
    if (out === undefined) {
      out = new Set<Block>();
      for (const stack = successorsOf(b); stack.length;) {
        const x = stack.pop()!;
        if (!out.has(x)) {
          out.add(x);
          stack.push(...successorsOf(x));
        }
      }
      reach.set(b, out);
    }
    return out;
  };
  // `cond_br` HERE, not in `sharedRetsOf`: this is the enumeration gate of the shared-tail twins,
  // and those twins are `if`-shaped variations. A jump table with a shared `ret` has the same
  // no-join shape and no such twin, so asking for it would spend fan on a duplicate candidate.
  return fn.blocks.some(
    (b) =>
      b.ops[b.ops.length - 1]?.opcode === 'cond_br' && ipdom.get(b) === null && sharedRetsOf(b, reachFrom).length > 0,
  );
}
// THE JOIN PAST EARLY RETURNS (the default; off under `copyReturnTails`). A divergent `if` whose
// arms share no `ret` the compiler left apart has no follow above: agbcc and gcc2.7.2 cross-jump
// identical `k(x); gT = x; return;` arms into one return tail, and every toolchain merges the early returns
// and the function's end into one epilogue, so the only `ret` every arm reaches is the one the
// tail reaches too, and the follow lands on it (`synthetic:retchain_xj`). Read instead the block
// `j` the paths that do not return meet at, where every path from `b` that never reaches `j`
// (an EARLY-RETURN path) enters nothing `j` reaches but a RETURN TAIL, which the arm copies, as the
// cross-jump took it from the source. A return tail is a straight line of `br`s ending in the `ret`,
// or code no cycle passes through, every path from which ends in a `ret`, holding no branch this
// reading joins anywhere but at its post-dominator: agbcc and gcc cross-jump a branching one,
// `k(9); if (c) k(8); gT = 1; return;` written in every early return and at the function's end,
// which the tail past `j` enters as well, and which is then the post-dominator of every link.
//
// WHICH `j`: the first in reverse postorder after `b` that EVERY successor of `b` reaches. Of a jump
// table, whose `case` may return on its own, the one the most successors reach, two at least, ahead
// of its CFG join (the return tail every arm reaches): a block two `case`s share on their way to
// the code after the switch is no join of the table. The copies this removes are of a region both
// arms reach, so a block one arm never reaches is no meeting point, however straight the other
// arm's way to its `return`: that is what refuses the join of an `if` inside an early return
// (`if (d) { if (c) x(); k(); return; }`, its `k()`), which the other arm reaches only through the
// epilogue. In acyclic code every block on an arm of `b`
// precedes the arms' meeting point. Sound for the reason the follow is: every path from `b` either
// passes `j` or ends in its own `return`, so each arm structures up to `j` or into a `return`, and a
// return tail an early-return path shares with code past `j` is written in that arm too (bytes, not
// control).
//
// AND THE EARLY-RETURN PATHS BELONG TO ONE ARM EACH. Where both arms return early into one return
// tail that branches (`if (x) y(); k(); return;`), that tail is a meeting point ahead of `j`, and
// the arms stay divergent: only a straight-line tail is copied into two arms of one `if`.
//
// A RETURN TAIL REACHES NO `j` AND NO CYCLE, AND HOLDS NO JOIN PAST RETURNS OF ITS OWN, so the copy
// an early return takes of it is that code and nothing below `b`, and no join past returns inside
// the copy copies in its turn: the copies stay linear in the early returns. A tail that holds one
// (`if (c) { if (d) goto T; A(); } B(); T: ...`, repeated in `T`) is no return tail, and the arms
// stay divergent.
//
// REFUSES (null, the arms stay divergent) when `b` sits on a cycle, when no block qualifies, and
// when the enclosing region's `stop` is reachable from `b` around `j` — the same refusal as the
// follow's, for the same reason.
export function joinsPastReturns(
  fn: Fn,
  reachFrom: (b: Block) => ReadonlySet<Block>,
  ipdom: ReadonlyMap<Block, Block | null>,
): { isReturnTail: (x: Block) => boolean; joinOf: (b: Block, arms?: readonly Block[]) => Block | null } {
  const straightReturn = new Map<Block, boolean>();
  const isStraightReturn = (x: Block): boolean => {
    let known = straightReturn.get(x);
    if (known === undefined) {
      straightReturn.set(x, false); // a `br` cycle is no return tail
      const term = x.ops[x.ops.length - 1];
      known = term.opcode === 'ret' || (term.opcode === 'br' && isStraightReturn(term.successors[0].block));
      straightReturn.set(x, known);
    }
    return known;
  };
  let postorder: Map<Block, number> | undefined;
  const reversePostorder = (): Map<Block, number> => {
    if (postorder === undefined) {
      const order: Block[] = [];
      const seen = new Set<Block>();
      const visit = (root: Block): void => {
        const stack: { blk: Block; next: number }[] = [{ blk: root, next: 0 }];
        seen.add(root);
        while (stack.length) {
          const top = stack[stack.length - 1];
          const succs = successorsOf(top.blk);
          if (top.next < succs.length) {
            const nx = succs[top.next++];
            if (!seen.has(nx)) {
              seen.add(nx);
              stack.push({ blk: nx, next: 0 });
            }
          } else {
            order.push(top.blk);
            stack.pop();
          }
        }
      };
      visit(fn.blocks[0]);
      postorder = new Map(order.reverse().map((x, i) => [x, i]));
    }
    return postorder;
  };
  const returnTail = new Map<Block, boolean>();
  const isReturnTail = (x: Block): boolean => {
    let known = returnTail.get(x);
    if (known === undefined) {
      returnTail.set(x, false); // a block met again before it is settled sits on a cycle
      const succs = successorsOf(x);
      const join = (): Block | null => joinOf(x);
      known =
        isRet(x) ||
        (succs.length > 0 &&
          succs.every(isReturnTail) &&
          (new Set(succs).size === 1 || join() === null || join() === (ipdom.get(x) ?? null)));
      returnTail.set(x, known);
    }
    return known;
  };
  const joins = new Map<Block, Block | null>();
  const treeJoins = new Map<Block, Block | null>();
  // `arms`: the case and default blocks of a comparison tree rooted at `b`, read as a jump table's
  // successors (a switch Regime A recovers)
  const joinOf = (b: Block, arms?: readonly Block[]): Block | null => {
    const memo = arms === undefined ? joins : treeJoins;
    let join = memo.get(b);
    if (join !== undefined) {
      return join;
    }
    join = null;
    const reach = reachFrom(b);
    const rpo = reversePostorder();
    const at = rpo.get(b);
    if (!reach.has(b) && at !== undefined) {
      const succs = [...new Set(arms ?? successorsOf(b))];
      const meet = new Map<Block, number>(
        [...reach].map((j) => [j, succs.filter((x) => x === j || reachFrom(x).has(j)).length]),
      );
      const table = arms !== undefined || b.ops[b.ops.length - 1].opcode === 'switch_br';
      // a jump table's CFG join, and the return tail past it, are where its arms meet the returns
      const cfg = ipdom.get(b) ?? null;
      const pastCfg = (j: Block): boolean => cfg !== null && (j === cfg || reachFrom(cfg).has(j));
      const candidates = [...reach]
        .filter(
          (j) => (rpo.get(j) ?? -1) > at && (table ? meet.get(j)! >= 2 && !pastCfg(j) : meet.get(j) === succs.length),
        )
        .sort((x, y) => meet.get(y)! - meet.get(x)! || rpo.get(x)! - rpo.get(y)!);
      for (const j of candidates) {
        const past = reachFrom(j);
        // the early-return blocks already met from another successor of `b`
        const owner = new Map<Block, Block>();
        let fits = true;
        for (const from of succs) {
          const seen = new Set<Block>([b, j]);
          for (const stack = [from]; fits && stack.length;) {
            const x = stack.pop()!;
            if (seen.has(x)) {
              continue;
            }
            seen.add(x);
            stack.push(...successorsOf(x));
            if (reachFrom(x).has(j) || isStraightReturn(x)) {
              continue;
            }
            // An early-return path reaches no `j`, so it may enter what follows `j` only by a
            // return tail — and it belongs to ONE arm: a block both arms reach without `j` is a
            // meeting point ahead of `j`.
            fits = (!past.has(x) || isReturnTail(x)) && (owner.get(x) ?? from) === from;
            owner.set(x, from);
          }
        }
        if (fits) {
          join = j;
          break;
        }
      }
    }
    memo.set(b, join);
    return join;
  };
  return { isReturnTail, joinOf };
}

/** WHERE THE JOIN PAST EARLY RETURNS IS ASKED, of a branch outside every loop body: where its CFG
 *  join is EXIT or a return tail (an epilogue every early return and the tail branch to is a
 *  post-dominator, and merging there writes everything above it into each arm exactly as EXIT
 *  does). Any other CFG join is where the paths already meet. The one test the structurer's three
 *  sites (`askJoinPastReturns`) ask. */
export function joinPastReturnsAsked(cfgJoin: Block | null, isReturnTail: (x: Block) => boolean): boolean {
  return cfgJoin === null || isReturnTail(cfgJoin);
}
