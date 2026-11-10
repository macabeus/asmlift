// asmlift structurer — L3 tree builders and post-passes the emitters call: the empty-then
// peephole (`mkIf`), a loop update spelled inside its test (`spellUpdateInCond`), the variable
// walk and substitution the copies read (`exprVars`, `substVar`), the `while` → `for`
// re-bracketing over the finished body (`recognizeForLoops`), and the order-licence stamp on
// `index` bases (`stampOrderedBases`). Functions of the tree alone, no structurer state.
import {
  Expr,
  Stmt,
  exprChildren,
  keepsHelperRel,
  mapExprChildren,
  mapStmtExprs,
  mentionedName,
  negateCond,
} from '../l3/ast';

// Spell a loop update at the place the bottom test reads the variable: the one `name` leaf becomes
// `name++`. Returns null unless the rendered test MENTIONS `name` exactly once, and that mention is
// a readable leaf. `&v1` is a mention the `++` cannot be placed on and cannot be counted out of —
// a callee reads the object through it — so a test holding one alongside a bare `v1` is refused
// here rather than left to `assertPostIncrUnshared`, which would abort the lift instead.
//
// `preUpdateCondFold` decided that on the DEF TREE, and this asks the same question of what the
// lowering actually produced. The two can disagree — an idiom fold spells a value its operands do
// not show, a substitution stops the render short of a leaf the walk reached — and the two
// disagreements are not equally bad: a test that named the variable twice would be C89-undefined,
// and one that names it not at all would drop the update altogether. Both answer null, and the
// caller declines.
//
// No input reaches either answer today, so it is pinned directly, on hand-built expressions
// (test/loop-preupdate-cond.test.ts) — the discipline `sunkCopyOverDroppedUndef` is held to.
export function spellUpdateInCond(cond: Expr, name: string, by: 1 | -1): Expr | null {
  let found = 0;
  let mentions = 0;
  const rec = (e: Expr): Expr => {
    if (mentionedName(e) === name) {
      mentions++;
    }
    if (e.k === 'var' && e.name === name) {
      found++;
      return { k: 'postincr', name, by };
    }
    return mapExprChildren(e, rec);
  };
  const out = rec(cond);
  return found === 1 && mentions === 1 ? out : null;
}

/** The named global an `index` node's base denotes DIRECTLY, or undefined: the bare `&gSym` an
 *  ordinary element access indexes, and the `(struct S *)&gSym` an array-of-struct element indexes
 *  — the reinterpret cast is the base's spelling, not a different base.
 *
 *  Deliberately not a search. A symbol buried inside a base's arithmetic is a base this licence has
 *  nothing to say about — the order fact is about the address the pool word materialized, and what
 *  a home would bind there is the sum, not the symbol — so it goes unstamped, which costs a
 *  candidate and never a wrong one. The same two shapes are what `l3/basecse.ts` can hoist. */
function indexBaseSymbol(e: Expr): string | undefined {
  if (e.k === 'addr') {
    return e.name;
  }
  return e.k === 'cast' && e.e.k === 'addr' ? e.e.name : undefined;
}

/** Stamp `baseOrdered` on every `index` whose base names an order-licensed global — the ONE place
 *  the L1 order fact enters the L3 tree.
 *
 *  A post-pass over the finished body rather than a `...fromOrder` at each construction site: the
 *  index node is built across `ptrMemberElement`, `memAccess` and `arrayAccess` at more sites than
 *  `operandOff` itself reaches, the licence is per SYMBOL rather than per site, and a walk is
 *  exhaustive by construction where a new site would silently carry no evidence. */
export function stampOrderedBases(body: Stmt[], licensed: ReadonlySet<string> | undefined): Stmt[] {
  if (licensed === undefined || licensed.size === 0) {
    return body;
  }
  const stamp = (e: Expr): Expr => {
    const mapped = mapExprChildren(e, stamp);
    if (mapped.k !== 'index') {
      return mapped;
    }
    const sym = indexBaseSymbol(mapped.base);
    return sym !== undefined && licensed.has(sym) ? { ...mapped, baseOrdered: true as const } : mapped;
  };
  return body.map((s) => mapStmtExprs(s, stamp));
}

// Does any statement CONTINUE this loop (vs. a nested one)? A `continue` inside a nested while/dowhile/
// for targets THAT loop, so we do not descend into them; but `if`/`switch` do not capture `continue`,
// so we scan through those. The structurer emits `continue;` for an edge into the header of a `while
// (1)` (structureRegion) and into the latch of a `for` (`forPlanAt`), so a `while` can hold one: this
// guards the one case where the while→for re-bracketing would change semantics (a `continue` runs
// `inc` under `for`, skips it under `while`).
function hasEnclosingContinue(stmts: Stmt[]): boolean {
  const scan = (s: Stmt): boolean => {
    switch (s.k) {
      case 'continue':
        return true;
      case 'if':
        return s.then.some(scan) || s.else.some(scan);
      case 'switch':
        return s.cases.some((c) => c.body.some(scan)) || (s.default ?? []).some(scan);
      case 'while':
      case 'dowhile':
      case 'for':
        return false; // nested loop captures its own continue
      default:
        return false;
    }
  };
  return stmts.some(scan);
}

// Re-spell an eligible test-at-top `while` as a `for` (quality only). PURELY cosmetic — the C
// desugaring `for(init;cond;inc){body}` compiles identically to `init; while(cond){body; inc}`, so it
// NEVER changes a byte-exact match. Conservative preconditions (a Ghidra `findLoopVariable`-style
// recognition that moves NO op — the init already precedes the loop, the increment is already the
// body's last statement):
//   • the `while` is IMMEDIATELY preceded by `assign(iv, e0)` (the init literally precedes it);
//   • the `while` cond references `iv`;
//   • the body's LAST statement is `assign(iv, e1)` with `e1` referencing `iv` (a genuine self-update —
//     the increment is literally the body's last op, not an unrelated trailing assign);
//   • the body EXCLUDING that increment has no `continue` targeting THIS loop — a `continue` RUNS `inc`
//     under `for` but SKIPS it under `while`, so folding the increment into the header would change
//     semantics. This is the one hazard of the transform; all others are pure re-bracketing.
// Any precondition failing leaves the `while` untouched. Runs bottom-up so inner loops convert first.
export function recognizeForLoops(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s0 of stmts) {
    const s: Stmt =
      s0.k === 'if'
        ? { ...s0, then: recognizeForLoops(s0.then), else: recognizeForLoops(s0.else) }
        : s0.k === 'while' || s0.k === 'dowhile'
          ? { ...s0, body: recognizeForLoops(s0.body) }
          : s0.k === 'for'
            ? { ...s0, body: recognizeForLoops(s0.body) }
            : s0.k === 'switch'
              ? {
                  ...s0,
                  cases: s0.cases.map((c) => ({ ...c, body: recognizeForLoops(c.body) })),
                  ...(s0.default ? { default: recognizeForLoops(s0.default) } : {}),
                }
              : s0;

    const prev = out[out.length - 1];
    if (s.k === 'while' && s.body.length >= 1 && prev && prev.k === 'assign') {
      const iv = prev.name;
      const inc = s.body[s.body.length - 1];
      if (
        inc.k === 'assign' &&
        inc.name === iv &&
        exprVars(inc.value).has(iv) &&
        exprVars(s.cond).has(iv) &&
        !hasEnclosingContinue(s.body.slice(0, -1))
      ) {
        out.pop(); // the init assign moves into the for-header
        out.push({ k: 'for', init: prev, cond: s.cond, inc, body: s.body.slice(0, -1) });
        continue;
      }
    }
    out.push(s);
  }
  return out;
}
// Read-set / rewrite walkers over the FULL Expr union — a walker that misses a node kind (e.g.
// call/index/field reads) sequentializes a copy keyed by an array index in the wrong order.
export function exprVars(e: Expr, acc: Set<string> = new Set()): Set<string> {
  if (e.k === 'var') {
    acc.add(e.name);
  }
  for (const c of exprChildren(e)) {
    exprVars(c, acc);
  }
  return acc;
}
export function substVar(e: Expr, from: string, to: string): Expr {
  if (e.k === 'var') {
    return e.name === from ? { k: 'var', name: to } : e;
  }
  return mapExprChildren(e, (c) => substVar(c, from, to));
}

// empty-then peephole: `if (c) {} else { S }` → `if (!c) { S }`
export function mkIf(cond: Expr, thenS: Stmt[], elseS: Stmt[]): Stmt {
  if (thenS.length === 0 && elseS.length > 0 && !keepsHelperRel(cond)) {
    return { k: 'if', cond: negateCond(cond), then: elseS, else: [] };
  }
  return { k: 'if', cond, then: thenS, else: elseS };
}
