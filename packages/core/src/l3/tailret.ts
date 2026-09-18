// L3 spelling pass: drop a void `return;` the assembly says the source never wrote.
//
// `structure/retspell.ts` marks a return `unspelled` when the machine reached that epilogue without
// the `b <epilogue>` a source `return;` compiles to — the reading, and what makes it decidable, is
// stated there. This pass is the other half: a mark alone is not a licence to delete, because a
// `return` is still a control transfer in the STATEMENT tree. Deleting one that something follows
// lets control run on into it, and that is a semantic change, not a spelling one.
//
// So the licence is TAIL POSITION and nothing weaker: nothing executes after the statement on any
// path, all the way up to the end of the function. A return ending a loop body, a `switch` arm, or
// an `if` arm the function continues past is left exactly where it is, whatever the mark says.
//
// TWO SHAPES REFUSE EVEN IN TAIL POSITION, both because removing the statement would leave a
// statement list that has to be re-spelled rather than shortened:
//
//   - the sole statement of a `then` arm. `if (c) { }` is not the answer — `if (!c) { … }` is, and
//     which sense a compiler emits is a per-SITE question this pass holds nothing to decide.
//   - the whole function body. A body is not a place a statement can vanish from.
//
// An `else` arm IS allowed to empty: an `if` with no else is the same statement, and both the
// printer (`backend/cfamily.ts`) and `l3/dce.ts` already spell `else: []` that way.
//
// THE REFUSALS ARE PROSE, NOT A `Gate` TABLE, and that is the second of the three answers
// `docs/level-tower.md` sanctions rather than an omission. A table buys the ablation — drop this
// rule and something breaks — as a test instead of a claim, and it is worth building for a refusal a
// round has HAD to instrument. None of these was: each is a property of one candidate's own
// position, and `test/tailret.test.ts` holds a test per refusal, which is the ablation the table
// would have bought. Convert them when a round has to argue about one.
//
// Ordering: after `l3/tailmerge.ts`, whose peel moves `assign`/`store`/`exprstmt` only, so a
// `return` ending an arm blocks it — run first and this pass hands tailmerge arms it could not
// otherwise peel, changing rows that have nothing to do with returns. Before `l3/dce.ts`, so its
// branch peephole sees the `else` this pass empties. `pipeline.ts` commits that order.
import type { SFn, Stmt } from './ast';

/** Can this statement be deleted outright — a void return the asm did not spell? */
const isDroppable = (s: Stmt): boolean => s.k === 'return' && s.value === undefined && s.unspelled === true;

/** `stmts` rewritten. `isTail` — control falls off the END of the function after this list, so its
 *  last statement is in tail position. `mayEmpty` — the list is allowed to come back empty. */
function walk(stmts: Stmt[], isTail: boolean, mayEmpty: boolean): Stmt[] {
  const out = stmts.map((s, i) => {
    const tail = isTail && i === stmts.length - 1;
    switch (s.k) {
      case 'if':
        return { ...s, then: walk(s.then, tail, false), else: walk(s.else, tail, true) };
      case 'while':
      case 'dowhile':
      case 'for':
        // A return inside a loop is never in tail position: the statement after it is the next
        // iteration.
        return { ...s, body: walk(s.body, false, false) };
      case 'switch':
        // Nor inside a `switch`: dropping an arm's return diverts it into the arm below.
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: walk(c.body, false, false) })),
          ...(s.default ? { default: walk(s.default, false, false) } : {}),
        };
      default:
        return s;
    }
  });
  const last = out[out.length - 1];
  return isTail && last !== undefined && isDroppable(last) && (out.length > 1 || mayEmpty) ? out.slice(0, -1) : out;
}

export function dropUnspelledReturns(sfn: SFn): SFn {
  return { ...sfn, body: walk(sfn.body, true, false) };
}
