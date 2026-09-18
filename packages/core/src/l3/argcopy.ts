// L3 respell variation: copy a pointer PARAMETER into a local for ONE REGION.
//
// A pointer parameter that a whole function reads pins its incoming register for the whole body.
// A source that instead copies it into a local — `u8 *b = a0;` at the head of the block that uses
// it — hands the allocator a SECOND name for the same address, which it may home in a different
// register, freeing the parameter's for something else. On
// pokeemerald:SetMauvilleOldManLanguage:agbcc that something else is the arm's loop counter: the
// target copies the base with `adds r6, r5, #0` and then counts in r5.
//
// WHY THIS IS NOT ANY OF ITS NEIGHBOURS. `l3/scopebase.ts` hoists one base per region too, but the
// value it hoists is the ADDRESS OF A GLOBAL (`(T *)&gSym`) and its `shadowed-or-nonarray-base`
// rule refuses a `var` base precisely because `&local` names a different object; a parameter
// already HOLDS the pointer, so nothing is addressed and that rule's argument does not reach here.
// `l3/argbase.ts` names a call argument's fixed addresses, `l3/inlinebase.ts` DELETES a
// constant-address local, and `l3/parkfirst.ts` only reorders a copy the tree already has. None of
// them mints `b = a0`.
//
// THE COPY IS A PLAIN LOCAL, NOT A SCOPED DECLARATION. A braced region declaration and a
// function-top local assigned at the head of the region compile to the same bytes here (both
// spellings were taken through the row's own agbcc), so this pass emits the one L3 already
// spells and adds no block-scope representation to carry a distinction no object shows.
//
// WHAT IS ENUMERATED, AND WHY. Which region the source copied in is not derivable from the tree,
// so every legal region is offered as its own candidate and the differ referees — the `/regcopy`
// idiom this file shares with `l3/coalesce.ts`. Uses OUTSIDE the chosen region keep naming the
// parameter, which is the point: the copy is what makes the two live ranges separable.
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, mapStmtExprs, mapStmtLists, stmtChildren, stmtLists, walkExprs } from './ast';
import { type Gate, firstRejection } from './gates';
import { nameAllocator } from './hoist';

/** One candidate copy, as the gates see it. */
export interface ArgCopyCtx {
  /** the parameter being copied */
  readonly param: string;
  /** the parameter's declared type is a pointer — the register this variation is about is a base */
  readonly isPointer: boolean;
  /** the function assigns the parameter somewhere, so a copy taken earlier can go stale */
  readonly assigned: boolean;
  /** `&param` occurs, so the copy is a DIFFERENT object and any write through the address misses it */
  readonly addressed: boolean;
}

/** The admission rules. The two SOUND ones are the whole soundness argument: with the parameter
 *  never assigned and never addressed, the copy holds the parameter's value at every point the
 *  region can reach, so repointing the region's reads at it renames a value rather than changing
 *  one. Drop either and the rewrite names different memory — C that compiles and scores.
 *
 *  Both are decided over the WHOLE tree — see `countReads` on why every walk in this file goes
 *  through `stmtChildren`/`walkExprs`. A gate that called itself sound while judging a subset of the
 *  statements `repoint` rewrites would be sound about a function nobody compiles. */
export const ARGCOPY_GATES: readonly Gate<ArgCopyCtx>[] = [
  {
    id: 'non-pointer',
    why: 'the freed register is a base register, and a scalar parameter does not hold one',
    sound: false,
    rejects: (c) => !c.isPointer,
  },
  {
    id: 'assigned',
    why: 'the function assigns the parameter, so the copy would hold a value the parameter no longer has',
    sound: true,
    guardedBy: 'argcopy.test.ts: a parameter a `for` header ADVANCES is never copied',
    rejects: (c) => c.assigned,
  },
  {
    id: 'addressed',
    why: 'taking the parameter’s address names its own cell, and the copy is a different cell',
    sound: true,
    guardedBy: 'argcopy.test.ts: a parameter whose ADDRESS is taken in a `for` header is never copied',
    rejects: (c) => c.addressed,
  },
];

/** One candidate REGION, as the region rules see it. Separate from {@link ARGCOPY_GATES} for the
 *  reason `scopebase` keeps two tables: those rules judge the PARAMETER once, these judge each
 *  place it could be copied, and a refusal tally that mixed the two would count a parameter's
 *  single verdict once per region. */
export interface ArgCopyRegionCtx {
  /** reads of the parameter inside this region */
  readonly reads: number;
  /** a loop encloses the region — its own body, or any list nested below one */
  readonly underLoop: boolean;
}

/** Which regions are worth offering. NEITHER is sound — each refuses a spelling that is correct
 *  but models nothing, and what they buy is the candidate count: every one of these is a COMPILE,
 *  and this variation multiplies with `/coalesce`. */
export const ARGCOPY_REGION_GATES: readonly Gate<ArgCopyRegionCtx>[] = [
  {
    id: 'single-read',
    why: 'a region reading the parameter once gives the allocator no live range to shorten, so the copy buys nothing',
    sound: false,
    rejects: (c) => c.reads < 2,
  },
  {
    id: 'loop-region',
    why: 'a copy anywhere inside a loop re-runs every iteration, and the region holding the loop already offers it',
    sound: false,
    guardedBy: 'argcopy.test.ts: an arm NESTED inside a loop body is refused too',
    rejects: (c) => c.underLoop,
  },
];

/** How many `var n` leaves the region holds, nested statements included — the region rules'
 *  yardstick for whether a copy has a range to shorten.
 *
 *  `walkExprs` (ast.ts) is the whole-tree walk, which descends through `stmtChildren` and so sees a
 *  `for`'s `init` and `inc`. That is the walk this file must use everywhere: `repoint` rewrites
 *  those two statements (`mapStmtExprs` recurses into them), so a count taken with `stmtLists` —
 *  which deliberately omits them, being a walk over the SCOPES a statement opens — would report
 *  fewer reads than the rewrite touches. */
function countReads(list: Stmt[], n: string): number {
  let reads = 0;
  for (const e of walkExprs(list)) {
    if (e.k === 'var' && e.name === n) {
      reads++;
    }
  }
  return reads;
}

/** Every nested statement list in `body`, each with the path that reaches it — a REGION is any
 *  list a statement contains, which is what a `case` body, an `if` arm and a loop body all are.
 *  The function's own top-level list is NOT among them: a copy there frees nothing, and the entry
 *  prefix is `l3/parkfirst.ts`'s. */
function regions(body: Stmt[]): { at: number[]; list: Stmt[]; underLoop: boolean }[] {
  const out: { at: number[]; list: Stmt[]; underLoop: boolean }[] = [];
  // carried DOWN rather than read off the immediate parent: an `if` arm two levels inside a loop
  // body re-runs every iteration exactly as the body does, which is what `loop-region` refuses
  const walk = (list: Stmt[], path: number[], underLoop: boolean): void => {
    list.forEach((st, i) => {
      const inside = underLoop || st.k === 'while' || st.k === 'dowhile' || st.k === 'for';
      stmtLists(st).forEach((inner, j) => {
        const here = [...path, i, j];
        out.push({ at: here, list: inner, underLoop: inside });
        walk(inner, here, inside);
      });
    });
  };
  walk(body, [], false);
  return out;
}

/** `list` with every `var n` leaf rewritten to `var to`, nested statements included. Both kind
 *  switches are ast.ts's, so a new statement or expression kind is that file's problem, not this
 *  one's. */
function repoint(list: Stmt[], n: string, to: string): Stmt[] {
  const inExpr = (e: Expr): Expr => (e.k === 'var' && e.name === n ? { ...e, name: to } : mapExprChildren(e, inExpr));
  const inStmt = (s: Stmt): Stmt =>
    mapStmtExprs(
      mapStmtLists(s, (inner) => inner.map(inStmt)),
      inExpr,
    );
  return list.map(inStmt);
}

/** Replace the region at `at` with `next`. */
function replaceRegion(body: Stmt[], at: number[], next: Stmt[]): Stmt[] {
  const [i, j, ...rest] = at;
  return body.map((st, k) => {
    if (k !== i) {
      return st;
    }
    let seen = -1;
    return mapStmtLists(st, (inner) => {
      seen++;
      if (seen !== j) {
        return inner;
      }
      return rest.length ? replaceRegion(inner, rest, next) : next;
    });
  });
}

/** `argCopyCandidates` with the gate table supplied plus which gate refused each parameter — the
 *  same ablation-as-a-value seam the coalescer provides. */
export function argCopyUnder(
  gates: readonly Gate<ArgCopyCtx>[],
  sfn: SFn,
  regionGates: readonly Gate<ArgCopyRegionCtx>[] = ARGCOPY_REGION_GATES,
): { candidates: { merged: string; sfn: SFn }[]; refusals: Map<string, number> } {
  const refusals = new Map<string, number>();
  const out: { merged: string; sfn: SFn }[] = [];
  /** `&n` anywhere in the function — every expression node, `for` header included. */
  const addressed = (n: string): boolean => {
    for (const e of walkExprs(sfn.body)) {
      if (e.k === 'addr' && e.name === n) {
        return true;
      }
    }
    return false;
  };
  /** The function assigns `n` anywhere. `stmtChildren`, never `stmtLists`: a `for`'s `init` and
   *  `inc` are STATEMENTS rather than lists, and an induction step that advances the parameter is
   *  exactly one of them — the shape `structure/structure.ts`'s `recognizeForLoops` mints. */
  const assignsTo = (n: string, list: Stmt[] = sfn.body): boolean =>
    list.some((st) => (st.k === 'assign' && st.name === n) || assignsTo(n, stmtChildren(st)));
  for (const p of sfn.params) {
    const refused = firstRejection(gates, {
      param: p.name,
      isPointer: p.type.kind === 'ptr',
      assigned: assignsTo(p.name),
      addressed: addressed(p.name),
    });
    if (refused !== null) {
      refusals.set(refused, (refusals.get(refused) ?? 0) + 1);
      continue;
    }
    for (const r of regions(sfn.body)) {
      // not a gate: a region with no read of the parameter has nothing to repoint
      const reads = countReads(r.list, p.name);
      if (reads === 0) {
        continue;
      }
      const regionRefused = firstRejection(regionGates, { reads, underLoop: r.underLoop });
      if (regionRefused !== null) {
        refusals.set(regionRefused, (refusals.get(regionRefused) ?? 0) + 1);
        continue;
      }
      // allocated against the ORIGINAL function, so every candidate names its copy identically —
      // each is a separate tree and none of them ever meets another
      const name = nameAllocator(sfn)();
      const copied = [
        { k: 'assign', name, value: { k: 'var', name: p.name } } as Stmt,
        ...repoint(r.list, p.name, name),
      ];
      out.push({
        merged: `${p.name}@${r.at.join('.')}`,
        sfn: {
          ...sfn,
          body: replaceRegion(sfn.body, r.at, copied),
          locals: [...sfn.locals, { name, type: p.type }],
        },
      });
    }
  }
  return { candidates: out, refusals };
}

/** Every legal region copy, each as its own tree. */
export function argCopyCandidates(sfn: SFn): { merged: string; sfn: SFn }[] {
  return argCopyUnder(ARGCOPY_GATES, sfn).candidates;
}
