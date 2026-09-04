// L3 structural simplification: a statement that ends EVERY arm of an `if` moves below the `if`.
//
// SSA destruction puts the same merge-variable write at the end of each arm, because each arm is
// where that edge's copy belongs:
//
//     if (c) { v4 = 1; } else { g[594] = g[659]; v4 = 1; }
//
// The source wrote it once. Both arms execute it LAST on their own path, so hoisting it below the
// `if` runs it exactly once, on the same paths, in the same order relative to everything else —
// which is why this needs no liveness or dominance analysis and holds even for a side-effecting
// statement. It is the merge direction that is unconditionally sound: hoisting a common HEAD above
// the `if` would move it across the condition's own evaluation, which is not.
//
// Runs BEFORE `eliminateDeadStores`, whose empty-then peephole then flips the arm this empties:
//
//     if (c) { } else { g[594] = g[659]; } v4 = 1;   →   if (!c) { g[594] = g[659]; } v4 = 1;
//
// THE BENCHMARK DOES NOT GUARD THIS PASS. It fires on two of its 743 rows and both match with the
// merge and without it, so no score moves if this file breaks — and none moves if the pipeline
// simply stops calling it. `test/tailmerge.test.ts` covers that gap explicitly, end to end, on one
// of those two functions; the rest of that file calls this pass directly and cannot see an unwiring.
//
// Placement is not a matter of taste: peeling the same statements ABOVE the `if` is a THIRD option,
// unsound for its own reason (it crosses the condition as well as both arms). The soundness argument
// above covers only below-vs-in-arms.
//
// KNOWN INTERACTIONS, both byte-level rather than soundness. This pass is unconditional like
// `dce.ts` and `basecse.ts` rather than a differ-refereed lever, and the argument those files each
// state for themselves applies here too and was missing: a wrong merge changes recompiled bytes and
// surfaces as a LOST match under the zero-lost gate, never as wrong C.
//
//   - it DEFEATS basecse's scalar-fixed-offset gate. That gate counts repeated constant offsets
//     function-wide and refuses to hoist them; it was bought by losing the ProcessHBlankWait match.
//     Deleting an arm's duplicate drops the count 2→1, so a base that gate would have refused is now
//     hoisted. Systematic, not incidental.
//   - it does NOT reach a fixpoint with `eliminateDeadStores`. A DIFFERING DEAD statement at the end
//     of the arms hides the common tail, and DCE only removes it afterwards, so the shape this pass
//     exists for is missed. The fix is a fixpoint of the pair, not one extra call — a lone second
//     pass leaves an empty `if` behind.
//   - THE SAME HIDING HAPPENS WITHOUT DCE, and the edge-copy sort decides when. An arm ends in the
//     copies of one CFG edge, and `structure.ts` orders those copies by the predecessor's write
//     record (or by the def-position proxy); an arm-varying copy ordered LAST hides an agreeing one
//     behind it. Measured on klonoa `CountCollectedGems` (map-less, agbcc): the record's order
//     leaves five copies of `v22 = (s32 *)50345232;` in the arms where the proxy's order merges
//     them into one, and with THIS PASS disabled both orders emit all six — so the duplication is
//     this peel not firing, not something the sort creates. Reaching the hidden statement is not a
//     matter of peeling further: it would have to move ACROSS the differing one, which needs the
//     independence argument this pass deliberately does not have (see the soundness note above).
//     Pinned both ways in `test/tailmerge.test.ts`.
//
// SCOPE. Only `assign`/`store`/`exprstmt` merge, compared structurally through `exprEquals`.
// Control flow (`break`/`continue`/`return`) is excluded: moving one out of an arm changes which
// statements the arm can still reach. Nested `if`/loop/`switch` statements are excluded because
// comparing them needs a full `Stmt` congruence, and there is no second inhabitant for one — the
// `Expr`-level comparison is the part that already exists, is tested, and is all this needs.
//
// An `ASMLIFT_ERROR` marker ending both arms merges like anything else. The gap stays loud (the
// artifact still refuses to compile) but `collectMarkers` then reports it once rather than twice,
// which is accurate — it is one gap that ran on both paths.
import type { SFn, Stmt } from './ast';
import { exprEquals } from './ast';

/** Statements this pass may move. Deliberately narrow — see SCOPE. */
type Mergeable = Extract<Stmt, { k: 'assign' } | { k: 'store' } | { k: 'exprstmt' }>;
const isMergeable = (s: Stmt): s is Mergeable => s.k === 'assign' || s.k === 'store' || s.k === 'exprstmt';

/** Do these two statements write the same thing from the same expression? */
function sameStmt(a: Stmt, b: Stmt): boolean {
  if (!isMergeable(a) || !isMergeable(b) || a.k !== b.k) {
    return false;
  }
  if (a.k === 'assign' && b.k === 'assign') {
    return a.name === b.name && exprEquals(a.value, b.value);
  }
  if (a.k === 'store' && b.k === 'store') {
    return exprEquals(a.lval, b.lval) && exprEquals(a.value, b.value);
  }
  const av = (a as Extract<Stmt, { k: 'exprstmt' }>).value;
  const bv = (b as Extract<Stmt, { k: 'exprstmt' }>).value;
  return exprEquals(av, bv);
}

/** Rewrite one statement, then the list it lives in. */
function rewrite(s: Stmt): Stmt[] {
  const list = (xs: Stmt[]): Stmt[] => xs.flatMap(rewrite);
  switch (s.k) {
    case 'if': {
      const then = list(s.then);
      const els = list(s.else);
      // Peel from the END of both arms while they agree. The length test is a precondition of the
      // NEXT peel, not a floor: `if (c) { a } else { a }` peels until BOTH arms are empty, which is
      // fine — `eliminateDeadStores` then drops the `if` and keeps its condition as an `exprstmt`
      // only when the condition itself has a side effect. Note what that means for a condition that
      // is a memory LOAD: a compare-and-branch present in the asm disappears from the emitted C,
      // and the surviving bare `*(u16 *)&gReg;` is something the compiler may elide — so a read the
      // original performed unconditionally becomes one it may not. Byte-level, and the differ sees
      // it, but it is the one shape where a zero-arm merge is qualitatively unlike a partial one.
      const tail: Stmt[] = [];
      while (then.length > 0 && els.length > 0 && sameStmt(then[then.length - 1], els[els.length - 1])) {
        tail.unshift(then[then.length - 1]);
        then.pop();
        els.pop();
      }
      return [{ ...s, then, else: els }, ...tail];
    }
    case 'while':
    case 'dowhile':
      return [{ ...s, body: list(s.body) }];
    case 'for':
      return [{ ...s, body: list(s.body) }];
    case 'switch':
      // Case bodies are NOT merged: a case that falls through to the next has no "end" of its own,
      // so peeling its last statement would move code across a fall-through boundary.
      return [
        {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: list(c.body) })),
          ...(s.default ? { default: list(s.default) } : {}),
        },
      ];
    case 'assign':
    case 'store':
    case 'exprstmt':
    case 'return':
    case 'break':
    case 'continue':
      return [s];
  }
}

/** Move every statement that ends all arms of an `if` below that `if`. */
export function mergeCommonTails(sfn: SFn): SFn {
  return { ...sfn, body: sfn.body.flatMap(rewrite) };
}
