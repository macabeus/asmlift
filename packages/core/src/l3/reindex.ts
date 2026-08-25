// asmlift L3 — the walk→index RE-SPELLING, a differ-ranked representation lever.
//
// A compiler strength-reduces a source-level `arr[i]` loop into a pointer WALK (`*p; p += 1`),
// so asmlift's faithful lift of the machine form emits the walk — but recompiling the walk
// rarely reproduces the bytes the INDEXED source produced (different induction variable,
// different regalloc). Which representation the source used is genuinely ambiguous from asm —
// exactly the class of ambiguity asmlift resolves by CANDIDATES, not guesses (rank.ts: "types
// are differ-ranked levers"). This module produces the indexed re-spelling of a structured
// function; enumerateCandidates emits BOTH and the objdiff score referees.
//
// v1 SCOPE (decline over approximate): a loop is re-spelled only when ALL hold —
//   • it is a `for`/`while` whose pointer induction var `p` (declared `T *`) steps by exactly
//     ONE element (`p = p + 1`) as the loop's `inc` (for) / LAST body statement;
//   • `p`'s init `p = <base>` is the `for` init or the statement immediately preceding the
//     `while`/`dowhile`, with `<base>` a plain var that is never written inside the loop;
//   • every other use of `p` in the loop is a deref base (`p[k]`) or the loop condition
//     comparing `p` against `<base> + N` (the inlined bound shape — `p < base + n`);
//   • `p` is not read after the loop (its post-loop value would be base + iterations).
// The rewrite: `i = 0` (a fresh s32 local) replaces the init, `p[k]` → `base[i + k]` (`base[i]`
// for k 0), the bound → `i <op> N`, the step → `i = i + 1`. Everything else declines — the
// function keeps only its walk spelling, and no candidate is emitted.
//
// v2 SCOPE — the GUARDED COUNTDOWN, the shape agbcc actually emits for `for(i=0;i<n;i++) a[i]`:
//
//     if (0 >= n) { C } else { C ⊎ { p = B; k = n }; do { BODY; p += 1; k -= 1 } while (k != 0) }
//
// re-spells as `C; p = B; for (i = 0; i < n; i++) BODY[p[c] → p[i + c]]`. The `for` tests at top,
// so the guard disappears (it IS the for-condition at entry), and the skip arm C disappears with
// it (its statements are the loop-preceding subset of the else arm, now unconditionally hoisted).
// The walk pointers KEEP their init and lose their step — gcc folds a loop-invariant pointer
// local into addressing, so `p = B; … p[i]` and `B[i]` compile identically, and keeping the
// local is what lets the `/volatile` lever qualify a numeric B. Several walk pointers share the
// one counter (`dotprod`'s a/b pair). Its OWN rules, on top of the shared table below —
//   • the guard tests THE SAME var the counter is initialised from, against 0, in the sense that
//     skips the loop; the do-while exit is exactly `k != 0`;
//   • the skip arm's statements equal, in order, the else arm's loop-preceding statements minus
//     the induction inits — anything left over means the arms are not the same computation;
//   • n is never assigned in the function (a moving bound has no single trip count).
// Everything else declines — the function keeps its countdown spelling, no candidate emitted.
//
// THE SHARED ADMISSION TABLE (`COUNTDOWN_GATES`) — the rules v2 and v4 both answer, as data, so
// "is this rule load-bearing?" is an ablation a test runs rather than an argument a reader
// audits. Each entry's `why` is its label; the argument is here:
//   • the counter is INTEGER-typed. A pointer's `k - 1` strides its element size, so the trip
//     count the rewrite computes would be a different loop's;
//   • the counter is a DECLARED local or param. The rewrite deletes its init and its decrement,
//     licensed by the four-roles rule proving nothing in THIS function reads it afterwards — not
//     a property a global has, whose final value every other caller, ISR and translation unit
//     observes. structure.ts spells a store to a bare scalar global as an `assign` like any
//     other, so a global counter arrives here looking exactly like a local one;
//   • neither the counter nor any walk pointer is declared `volatile`. Deleting the init, the
//     decrement or a `p += 1` deletes accesses another agent is expected to see — a DMA-published
//     frame slot (structure.ts stamps those) is the live shape;
//   • the counter appears in EXACTLY its four roles (init write, decrement write + read, exit
//     read), counted over the whole function; any other use — a leftover's read, the body's, a
//     nested loop's, or an ESCAPED ADDRESS (`&k`, which the mention count sees) — would survive
//     the deletion;
//   • no walk pointer is stepped TWICE in one body — two `p += 1` stride 2, which `p[i]` does
//     not. (That the tail holds a decrement and at least one step is shape recognition, not an
//     admission rule: without them there is no countdown here to refuse.);
//   • each walk pointer has an init ahead of the loop whose base the rewrite can leave standing:
//     a var, or a rematerializable address (see `rematerializableAddress`);
//   • every p is mentioned only inside the loop shape, and never by a leftover statement — a
//     leftover outlives the deleted step, and its skip-arm twin reads a pointer that path never
//     initialised;
//   • every deref of a walk pointer reads its own element size (a `*(u8 *)p` over an `s32 *`
//     walk strides 4 as a walk but 1 re-indexed — the v1 stride rule, same reason);
//   • BODY has no `break`/`continue` targeting this loop — the original steps sat in the body's
//     tail, which a `continue` skips, but a `for`'s inc runs: the two shapes genuinely differ.
// Past the table, the counter's DECLARATION is retired with its writes: nothing mentions it any
// more, and a declared-but-untouched local reads as the deliberate `uninit` slot it is not.
//
// v3 SCOPE — the up-counting BYTE walk with an EXPRESSION base (`p = (u8 *)(EXPR)` ahead of a
// counter-carried do-while): full rules at `tryExprWalk` below.
//
// v4 SCOPE — the UNGUARDED countdown, the shape agbcc emits for `for(i=0;i<C;i++) a[i]` with a
// LITERAL bound. A constant trip count needs no zero-trip guard, and the exit test agbcc writes
// for it is `>= 0` rather than v2's `!= 0`:
//
//     p = B; k = C; do { BODY; p += 1; k -= 1 } while (k >= 0)
//
// re-spells as `p = B; for (i = 0; i < C + 1; i++) BODY[p[c] → p[i + c]]` — k counts C…0, so the
// body runs C + 1 times. Everything downstream of the counter's init is v2's (respellCountdown);
// what this shape adds is its own two rules —
//   • the counter is declared SIGNED. `k >= 0` never fails for an unsigned k, so an unsigned
//     declaration describes a loop that does not terminate, and `C + 1` would be a fiction;
//   • C is a constant in [0, S32_MAX). Below zero `k = -1` runs the body once rather than
//     `C + 1 = 0` times; at the top C + 1 wraps negative and the `for` runs zero times.
// The induction inits are read out of the statements PRECEDING the do-while in its own list
// rather than out of a guard arm, and the counter's init is the only one the rewrite deletes.
import { IrType, T } from '../ir/types';
import { Expr, SFn, Stmt, mapExprChildren, mapStmtExprs, stmtExprs } from './ast';
import { type Gate, firstRejection } from './gates';
import { takenNames } from './hoist';
import { nameStorage } from './storage';
import { type VarTypes, declaredTypes } from './typing';

interface WalkLoop {
  p: string; // the pointer induction var
  base: string; // the var `p` was initialised from
}

/** Total mentions of `name` across a statement list (reads, writes, everywhere). `addr` counts:
 *  `&x` is how a frame local's address renders (structure.ts laddrName), and an escaped address
 *  is a read of the object by whatever holds it — the accounting these recognizers rest on is
 *  "nothing else in the function touches this name", which a var-only count cannot say. */
function countMentions(stmts: Stmt[], name: string): number {
  let n = 0;
  const inExpr = (e: Expr): void => {
    if ((e.k === 'var' || e.k === 'addr') && e.name === name) {
      n++;
    }
    mapExprChildren(e, (c) => {
      inExpr(c);
      return c;
    });
  };
  const inStmt = (s: Stmt): void => {
    if (s.k === 'assign' && s.name === name) {
      n++;
    }
    stmtExprs(s).forEach(inExpr);
    const kids: Stmt[] =
      s.k === 'if'
        ? [...s.then, ...s.else]
        : s.k === 'while' || s.k === 'dowhile'
          ? s.body
          : s.k === 'for'
            ? [s.init, s.inc, ...s.body]
            : s.k === 'switch'
              ? [...s.cases.flatMap((c) => c.body), ...(s.default ?? [])]
              : [];
    kids.forEach(inStmt);
  };
  stmts.forEach(inStmt);
  return n;
}

/** The walk is sound to re-spell only when `base` and `p` are pointers of the SAME element size
 *  and every rewritten deref reads exactly that size — a stride disagreement makes the walk and
 *  the indexed form read DIFFERENT addresses (adversarially learned: `*(u8 *)p` over an `s32 *`
 *  walk strides 4; `((u8 *)base)[i]` strides 1). */
function strideAgrees(pT: IrType | undefined, baseT: IrType | undefined, derefWidths: number[]): boolean {
  if (pT?.kind !== 'ptr' || baseT?.kind !== 'ptr') {
    return false;
  }
  const es = pT.to.kind === 'int' ? pT.to.width / 8 : pT.to.kind === 'ptr' ? 4 : 0;
  const bs = baseT.to.kind === 'int' ? baseT.to.width / 8 : baseT.to.kind === 'ptr' ? 4 : 0;
  return es > 0 && es === bs && derefWidths.every((w) => w === es);
}

/** Every deref width of `p` in a statement list (for the stride check). */
function derefWidths(stmts: Stmt[], p: string): number[] {
  const out: number[] = [];
  const inExpr = (e: Expr): void => {
    if (e.k === 'index' && e.base.k === 'var' && e.base.name === p) {
      out.push(e.width);
    }
    mapExprChildren(e, (c) => {
      inExpr(c);
      return c;
    });
  };
  const inStmt = (s: Stmt): void => {
    stmtExprs(s).forEach(inExpr);
    const kids: Stmt[] =
      s.k === 'if'
        ? [...s.then, ...s.else]
        : s.k === 'while' || s.k === 'dowhile'
          ? s.body
          : s.k === 'for'
            ? [s.init, s.inc, ...s.body]
            : s.k === 'switch'
              ? [...s.cases.flatMap((c) => c.body), ...(s.default ?? [])]
              : [];
    kids.forEach(inStmt);
  };
  stmts.forEach(inStmt);
  return out;
}

/** Does `e` mention `name` anywhere — as a value or as an escaped address (see countMentions)? */
function mentionsVar(e: Expr, name: string): boolean {
  if (e.k === 'var' || e.k === 'addr') {
    return e.name === name;
  }
  let found = false;
  mapExprChildren(e, (c) => {
    found = found || mentionsVar(c, name);
    return c;
  });
  return found;
}

/** Is `name` the target of any assignment, at any depth? */
function stmtAssigns(s: Stmt, name: string): boolean {
  if (s.k === 'assign' && s.name === name) {
    return true;
  }
  const kids: Stmt[] =
    s.k === 'if'
      ? [...s.then, ...s.else]
      : s.k === 'while' || s.k === 'dowhile'
        ? s.body
        : s.k === 'for'
          ? [s.init, s.inc, ...s.body]
          : s.k === 'switch'
            ? [...s.cases.flatMap((c) => c.body), ...(s.default ?? [])]
            : [];
  return kids.some((x) => stmtAssigns(x, name));
}

/** One countdown loop as the shared admission rules read it: every fact collected before any rule
 *  runs. What is NOT here is the shape recognition — a body tail holding a decrement and at least
 *  one pointer step — because without it there is no countdown to admit or refuse. */
export interface CountdownCtx {
  /** the counter's declaration, as the tree spells it */
  kIsPointer: boolean;
  kIsDeclared: boolean;
  kIsVolatile: boolean;
  /** a walk pointer stepped twice in one body */
  dupStep: boolean;
  /** walk pointers declared `volatile` */
  volatileWalks: readonly string[];
  /** the body left after the induction tail carries a `break`/`continue` for this loop */
  coreHasExit: boolean;
  /** walk pointers with no init ahead of the loop, or one whose base the rewrite cannot keep */
  badBases: readonly string[];
  /** total mentions of the counter across the WHOLE function */
  kMentions: number;
  /** walk pointers mentioned outside the loop shape */
  unconfined: readonly string[];
  /** walk pointers whose derefs disagree with their own element size */
  badStrides: readonly string[];
  /** statements ahead of the loop that survive it and still mention a walk pointer */
  leakyLeftovers: number;
}

/** The admission rules v2 and v4 share, as data. The argument for each lives in the file header;
 *  `why` is the label. */
export const COUNTDOWN_GATES: readonly Gate<CountdownCtx>[] = [
  {
    id: 'pointer-counter',
    why: 'C pointer arithmetic strides the pointee, so `k - 1` on a pointer counts elements, not iterations',
    sound: true,
    guardedBy: 'reindex.test.ts: a pointer-typed counter declines',
    rejects: (c) => c.kIsPointer,
  },
  {
    id: 'global-counter',
    why: 'a global counter’s final value is observable to every other caller, ISR and translation unit',
    sound: true,
    guardedBy: 'reindex.test.ts: the counter may not be a GLOBAL',
    rejects: (c) => !c.kIsDeclared,
  },
  {
    id: 'volatile-counter',
    why: 'the rewrite deletes the counter’s init and decrement, which a volatile object’s reader still expects',
    sound: true,
    guardedBy: 'reindex.test.ts: a volatile counter declines',
    rejects: (c) => c.kIsVolatile,
  },
  {
    id: 'volatile-walk',
    why: 're-basing the derefs off a plain local turns N accesses to volatile data into N plain ones',
    sound: true,
    guardedBy: 'reindex.test.ts: a volatile walk pointer declines',
    rejects: (c) => c.volatileWalks.length > 0,
  },
  {
    id: 'two-steps-one-pointer',
    why: 'a pointer stepped twice per iteration strides 2, which `p[i]` does not',
    sound: true,
    guardedBy: 'reindex.test.ts: a pointer stepped twice in one body declines',
    rejects: (c) => c.dupStep,
  },
  {
    id: 'body-exit',
    why: 'the steps sat in the body tail, which a `continue` skips and a `for`’s inc does not',
    sound: true,
    guardedBy: 'reindex.test.ts: a `break` in the body declines',
    rejects: (c) => c.coreHasExit,
  },
  {
    id: 'walk-base',
    why: 'the kept init must be a value the rewrite can leave standing — a var, or a rematerializable address',
    sound: true,
    guardedBy: 'reindex.test.ts: a walk pointer with no init ahead of the loop declines',
    rejects: (c) => c.badBases.length > 0,
  },
  {
    id: 'counter-roles',
    why: 'exactly four mentions — init write, decrement write and read, exit read — are what the rewrite deletes',
    sound: true,
    guardedBy: 'reindex.test.ts: a fifth mention of the counter declines',
    rejects: (c) => c.kMentions !== 4,
  },
  {
    id: 'walk-confined',
    why: 'a mention outside the loop shape reads a pointer whose step the rewrite deleted',
    sound: true,
    guardedBy: 'reindex.test.ts: a walk pointer read after the loop declines',
    rejects: (c) => c.unconfined.length > 0,
  },
  {
    id: 'walk-stride',
    why: 'a deref reading a width other than the pointee’s makes walk and index forms read different addresses',
    sound: true,
    guardedBy: 'reindex.test.ts: a byte deref of a word walk declines',
    rejects: (c) => c.badStrides.length > 0,
  },
  {
    id: 'leftover-walk',
    why: 'a leftover outlives the deleted step, and its skip-arm twin reads a pointer that path never set',
    sound: true,
    guardedBy: 'reindex.test.ts: a leftover mentioning a walk pointer declines',
    rejects: (c) => c.leakyLeftovers > 0,
  },
];

/** A `break`/`continue` that would target the ENCLOSING loop: found at if/switch depth, but not
 *  inside a nested loop (whose own exits target itself). */
function hasLoopExit(stmts: Stmt[]): boolean {
  return stmts.some((s) => {
    switch (s.k) {
      case 'break':
      case 'continue':
        return true;
      case 'if':
        return hasLoopExit(s.then) || hasLoopExit(s.else);
      case 'switch':
        return s.cases.some((c) => hasLoopExit(c.body)) || hasLoopExit(s.default ?? []);
      default:
        return false;
    }
  });
}

function stmtMentions(s: Stmt, name: string): boolean {
  if (s.k === 'assign' && s.name === name) {
    return true;
  }
  const kids: Stmt[] =
    s.k === 'if'
      ? [...s.then, ...s.else]
      : s.k === 'while' || s.k === 'dowhile'
        ? s.body
        : s.k === 'for'
          ? [s.init, s.inc, ...s.body]
          : s.k === 'switch'
            ? [...s.cases.flatMap((c) => c.body), ...(s.default ?? [])]
            : [];
  return stmtExprs(s).some((e) => mentionsVar(e, name)) || kids.some((k) => stmtMentions(k, name));
}

/** `assign(p, p + 1)` on a pointer-typed `p`? */
/** `x = x + 1` on ANY variable — the assigned name, or null. */
function isUnitIncrement(s: Stmt): string | null {
  if (s.k !== 'assign') {
    return null;
  }
  const v = s.value;
  const ok =
    v.k === 'bin' && v.op === '+' && v.l.k === 'var' && v.l.name === s.name && v.r.k === 'const' && v.r.value === 1;
  return ok ? s.name : null;
}

function isUnitStep(s: Stmt, ptrVars: Map<string, IrType>): string | null {
  const n = isUnitIncrement(s);
  return n !== null && ptrVars.has(n) ? n : null;
}

/** ADVERSARIALLY LEARNED (reproduced as an uninitialized-read escape): the walk pointer must be
 *  mentioned NOWHERE in the function outside its init and its loop — counted GLOBALLY, because a
 *  suffix-only scan missed reads after an ENCLOSING construct, leaving the deleted init's var
 *  read uninitialized. One spelling for every recognizer. */
function confinedToWalk(fnBody: Stmt[], name: string, initMentions: number, loop: Stmt): boolean {
  return countMentions(fnBody, name) === initMentions + countMentions([loop], name);
}

/** An address the target can REMATERIALIZE: a constant expression, reading no variable and no
 *  memory. Which ENCODING the compiler picked for it is not a property of the source — agbcc
 *  spells a pool word `(s32 *)33569456` but a shift-encodable one `(s32 *)(128 << 18)`, and every
 *  GBA hardware region (EWRAM 0x2000000, I/O 0x4000000, VRAM 0x6000000 …) takes the second form —
 *  so both must reach the same admission or the whole MMIO/VRAM fill family declines on its
 *  address. A bare `(T *)0` is excluded — a null base is not a walk — but the test is on the
 *  LITERALS the expression mentions, not on the value they fold to, so `(T *)(5 - 5)` passes.
 *  Folding would need a constant evaluator this file has no other use for, and the rewrite keeps
 *  the init verbatim, so no decision downstream reads the value. */
function rematerializableAddress(e: Expr): boolean {
  let nonZero = false;
  let ok = true;
  const visit = (x: Expr): void => {
    switch (x.k) {
      case 'const':
        nonZero ||= x.value !== 0;
        break;
      case 'cast':
      case 'bin':
      case 'un':
        break;
      default:
        ok = false; // var, addr, index, field, call, marker
        return;
    }
    mapExprChildren(x, (c) => {
      visit(c);
      return c;
    });
  };
  visit(e);
  return ok && nonZero;
}

/** Rewrite every deref of `p` into an indexed access off `base`, and every OTHER mention of `p`
 *  fails the walk (returns null): `p[k]` → `base[i + k]` (`base[i]` for k 0). */
function reindexExpr(e: Expr, walk: WalkLoop, iv: string): Expr | null {
  if (e.k === 'var' && e.name === walk.p) {
    return null; // a bare `p` outside a deref/condition — post-v1 shape, decline
  }
  if (e.k === 'index' && e.base.k === 'var' && e.base.name === walk.p) {
    if (mentionsVar(e.idx, walk.p)) {
      return null; // a p-dependent element offset — beyond the v1 shape
    }
    if (e.lead && e.lead.length > 0) {
      return null; // leading subscripts (a multidim array global) — the rebuild below would drop
      // them, turning an element access into a row's. Decline rather than reindex.
    }
    const idx: Expr =
      e.idx.k === 'const' && e.idx.value === 0
        ? { k: 'var', name: iv }
        : { k: 'bin', op: '+', l: { k: 'var', name: iv }, r: e.idx };
    // NOTE: this rebuilds the node from parts, so any field not named here is DROPPED. `lead` is
    // declined above (the deref side); it cannot arrive on the base side either, since `walk.base`
    // is a local pointer and structuring only ever puts `lead` on an array GLOBAL's own name.
    return { k: 'index', base: { k: 'var', name: walk.base }, idx, width: e.width, signed: e.signed };
  }
  let failed = false;
  const out = mapExprChildren(e, (c) => {
    const r = reindexExpr(c, walk, iv);
    if (r === null) {
      failed = true;
      return c;
    }
    return r;
  });
  return failed ? null : out;
}

/** The loop bound `p <op> base + N` → `i <op> N`; `p <op> E` with any other E declines. */
function reindexCond(cond: Expr, walk: WalkLoop, iv: string): Expr | null {
  if (cond.k !== 'bin' || !['<', '<=', '>', '>=', '==', '!='].includes(cond.op)) {
    return null;
  }
  const [pSide, bound, swap] =
    cond.l.k === 'var' && cond.l.name === walk.p
      ? [cond.l, cond.r, false]
      : cond.r.k === 'var' && cond.r.name === walk.p
        ? [cond.r, cond.l, true]
        : [null, null, false];
  if (!pSide || !bound) {
    return null;
  }
  // bound must be the inlined `base + N` (N any p-free expr)
  if (bound.k !== 'bin' || bound.op !== '+') {
    return null;
  }
  const n =
    bound.l.k === 'var' && bound.l.name === walk.base
      ? bound.r
      : bound.r.k === 'var' && bound.r.name === walk.base
        ? bound.l
        : null;
  if (!n || mentionsVar(n, walk.p)) {
    return null;
  }
  const i: Expr = { k: 'var', name: iv };
  return swap ? { k: 'bin', op: cond.op, l: n, r: i } : { k: 'bin', op: cond.op, l: i, r: n };
}

function reindexStmts(stmts: Stmt[], walk: WalkLoop, iv: string): Stmt[] | null {
  const out: Stmt[] = [];
  for (const s of stmts) {
    const r = reindexStmt(s, walk, iv);
    if (r === null) {
      return null;
    }
    out.push(r);
  }
  return out;
}

function reindexStmt(s: Stmt, walk: WalkLoop, iv: string): Stmt | null {
  const rx = (e: Expr) => reindexExpr(e, walk, iv);
  switch (s.k) {
    case 'assign': {
      if (s.name === walk.p || s.name === walk.base) {
        return null;
      } // writes beyond the recognized init/step: decline
      const v = rx(s.value);
      return v ? { ...s, value: v } : null;
    }
    case 'store': {
      const lval = rx(s.lval);
      const value = rx(s.value);
      return lval && value ? { ...s, lval, value } : null;
    }
    case 'exprstmt': {
      const v = rx(s.value);
      return v ? { ...s, value: v } : null;
    }
    case 'return': {
      if (!s.value) {
        return s;
      }
      const v = rx(s.value);
      return v ? { ...s, value: v } : null;
    }
    case 'if': {
      const cond = rx(s.cond);
      const then = reindexStmts(s.then, walk, iv);
      const els = reindexStmts(s.else, walk, iv);
      return cond && then && els ? { ...s, cond, then, else: els } : null;
    }
    // nested loops that MENTION the walk vars decline (their own ivs are out of v1 scope);
    // p-free nested loops pass through untouched.
    case 'while':
    case 'dowhile':
      return stmtMentions(s, walk.p) ? null : s;
    case 'for':
      return stmtMentions(s, walk.p) ? null : s;
    case 'switch': {
      const scrutinee = rx(s.scrutinee);
      if (!scrutinee) {
        return null;
      }
      const cases = s.cases.map((c) => ({ ...c, body: reindexStmts(c.body, walk, iv) }));
      if (cases.some((c) => c.body === null)) {
        return null;
      }
      const dflt = s.default ? reindexStmts(s.default, walk, iv) : undefined;
      if (s.default && dflt === null) {
        return null;
      }
      return {
        ...s,
        scrutinee,
        cases: cases as { values: number[]; body: Stmt[]; fallsThrough: boolean }[],
        default: dflt ?? undefined,
      };
    }
    case 'break':
    case 'continue':
      return s;
  }
}

// ── v3: the up-counting BYTE walk with an EXPRESSION base ────────────────────────────────────
//
//     p = (u8 *)(EXPR); do { … *p … ; p = p + 1; i = i + 1; } while (i < n);
//
// The loop already carries its own integer counter, so the walk pointer is pure strength
// reduction: deleting its init and step and spelling the deref as BASE[i + REST] — the sole
// bare-var addend of EXPR as the index base, the counter FIRST in the index sum — is the
// indexed source the compiler reduces back. v3 SCOPE (decline over approximate):
//   • `p` is a `u8 *` (byte walk: the index and the byte arithmetic agree by construction —
//     a wider element would need the REST addends rescaled from bytes to elements);
//   • the init `p = EXPR` immediately precedes the `dowhile`; EXPR (casts stripped) flattens
//     over `+` into exactly ONE bare-var addend (the base — itself not a non-byte pointer, or
//     `base[i]` would stride its element) plus pure invariant addends (var/const/mul/shl trees
//     whose vars the body never assigns);
//   • the body's statements include exactly one `p = p + 1` and one `i = i + 1` with integer
//     `i` read by the do-while condition; `p` is mentioned nowhere else in the function beyond
//     its init, its step, and derefs AT OFFSET 0 inside this body, and not by the condition.
function tryExprWalk(
  prev2: Stmt | undefined,
  prev: Stmt | undefined,
  dw: Stmt & { k: 'dowhile' },
  ptrVars: Map<string, IrType>,
  fnBody: Stmt[],
  declTypes: VarTypes,
  volatileLocals: ReadonlySet<string>,
): Stmt | null {
  if (prev?.k !== 'assign' || !ptrVars.has(prev.name) || volatileLocals.has(prev.name)) {
    return null;
  }
  const p = prev.name;
  const pT = ptrVars.get(p)!;
  if (pT.kind !== 'ptr' || pT.to.kind !== 'int' || pT.to.width !== 8) {
    return null;
  }
  if (!derefWidths([dw], p).every((w) => w === 1)) {
    return null;
  }
  // EXPR decomposition
  let expr: Expr = prev.value;
  while (expr.k === 'cast') {
    expr = expr.e;
  }
  const addends: Expr[] = [];
  const flatten = (e: Expr): void => {
    if (e.k === 'bin' && e.op === '+') {
      flatten(e.l);
      flatten(e.r);
    } else {
      addends.push(e);
    }
  };
  flatten(expr);
  const bare = addends.filter((a): a is Extract<Expr, { k: 'var' }> => a.k === 'var');
  const rest = addends.filter((a) => a.k !== 'var');
  if (bare.length !== 1) {
    return null;
  }
  const base = bare[0] as Extract<Expr, { k: 'var' }>;
  // declTypes carries params, locals AND globals: a base declared nowhere has an unknowable C
  // stride (its project declaration decides), and a wider pointer strides its element under [i]
  // — both decline.
  const baseT = declTypes(base.name);
  if (baseT === undefined) {
    return null;
  }
  if (baseT.kind === 'ptr' && !(baseT.to.kind === 'int' && baseT.to.width === 8)) {
    return null;
  }
  const pure = (e: Expr): boolean =>
    e.k === 'var' || e.k === 'const'
      ? true
      : e.k === 'bin' && (e.op === '*' || e.op === '+' || e.op === '<<')
        ? pure(e.l) && pure(e.r)
        : e.k === 'cast'
          ? pure(e.e)
          : false;
  const assignedIn = (stmts: Stmt[], name: string): boolean => stmts.some((st) => stmtAssigns(st, name));
  const restVars = new Set<string>();
  const collectVars = (e: Expr): void => {
    if (e.k === 'var') {
      restVars.add(e.name);
    }
    mapExprChildren(e, (c) => {
      collectVars(c);
      return c;
    });
  };
  rest.forEach(collectVars);
  restVars.add(base.name);
  if (!rest.every(pure) || [...restVars].some((n) => assignedIn(dw.body, n))) {
    return null;
  }
  // the steps and the counter
  const isIncOf = (st: Stmt, name?: string): string | null => {
    const n = isUnitIncrement(st);
    return n !== null && (name === undefined || n === name) ? n : null;
  };
  // BOTH steps as the body's contiguous TAIL (either order): every deref then runs with `i`
  // completed steps equal to `p`'s, which is what `BASE[i + REST]` states. A step anywhere
  // earlier (the `*++p` walk, a deref straddling the step) reads a different address.
  const tail = dw.body.slice(-2);
  const tailIncs = tail.map((st) => isIncOf(st)).filter((n): n is string => n !== null);
  if (tailIncs.length !== 2 || !tailIncs.includes(p)) {
    return null;
  }
  const iv = tailIncs.find((n) => n !== p);
  if (iv === undefined) {
    return null;
  }
  const pStepIdx = dw.body.length - 2 + tail.findIndex((st) => isIncOf(st, p) !== null);
  const ivT = declTypes(iv);
  if (ivT !== undefined && ivT.kind !== 'int') {
    return null;
  }
  if (!mentionsVar(dw.cond, iv) || mentionsVar(dw.cond, p)) {
    return null;
  }
  // The counter STARTS AT ZERO (the adjacent `i = 0` init — `BASE[i + REST]` counts completed
  // steps from the walk's own start) and its ONLY write anywhere in the body is the tail step.
  if (prev2?.k !== 'assign' || prev2.name !== iv || prev2.value.k !== 'const' || prev2.value.value !== 0) {
    return null;
  }
  if (dw.body.slice(0, -2).some((st) => stmtAssigns(st, iv)) || tail.filter((st) => isIncOf(st, iv)).length !== 1) {
    return null;
  }
  if (volatileLocals.has(iv) || [...restVars].some((n) => volatileLocals.has(n))) {
    return null;
  }
  // rewrite the derefs, then verify nothing of `p` survives
  const idxOf = (): Expr => rest.reduce<Expr>((acc, r) => ({ k: 'bin', op: '+', l: acc, r }), { k: 'var', name: iv });
  let respelled = true;
  const rewriteExpr = (e: Expr): Expr => {
    const m = mapExprChildren(e, rewriteExpr);
    if (m.k === 'index' && m.base.k === 'var' && m.base.name === p) {
      if (m.idx.k !== 'const' || m.idx.value !== 0) {
        respelled = false;
        return m;
      }
      return { ...m, base: { k: 'var', name: base.name }, idx: idxOf() };
    }
    return m;
  };
  const body = dw.body.filter((_, k) => k !== pStepIdx).map((st) => mapStmtExprs(st, rewriteExpr));
  const dw2: Stmt = { ...dw, body };
  if (!respelled || !confinedToWalk(fnBody, p, countMentions([prev], p), dw)) {
    return null;
  }
  if (countMentions([dw2], p) !== 0) {
    return null;
  }
  return dw2;
}

/** Try the walk→index re-spelling on one function. Returns the transformed COPY when at least
 *  one loop re-spelled, or null (no candidate) when nothing fired — callers emit the extra
 *  candidate only on non-null. Pure: never mutates the input SFn. `keptWalks` collects the names
 *  of the pointers each fired loop kept as its base — v1 the walk's base (a param lands in the
 *  set too, inertly: the volatile lever marks only declared locals), v2 the walk pointers
 *  themselves — the locals the /indexed/volatile product (rank.ts) narrows the volatile lever
 *  to. A v3 loop contributes nothing: it DELETES its pointer, and its base is qualified through
 *  the /livebase pairings instead. `gates` is the shared countdown admission table — a parameter
 *  so a test can ablate one entry and re-run the real pass. */
export function reindexWalks(
  sfn: SFn,
  keptWalks?: Set<string>,
  gates: readonly Gate<CountdownCtx>[] = COUNTDOWN_GATES,
): SFn | null {
  const ptrVars = new Map<string, IrType>();
  const declTypes = declaredTypes(sfn);
  // BOTH volatility facts (ast.ts SFn.locals): the object-volatile counter, and the pointer whose
  // POINTEE is volatile — which is the one the `/volatile` lever mints, and the one a walk carries.
  const volatileLocals = new Set(
    sfn.locals.filter((l) => l.volatile === true || l.pointeeVolatile === true).map((l) => l.name),
  );
  const storage = nameStorage(sfn);
  for (const v of [...sfn.params, ...sfn.locals]) {
    if (v.type.kind === 'ptr') {
      ptrVars.set(v.name, v.type);
    }
  }
  if (ptrVars.size === 0) {
    return null;
  }

  let fired = 0;
  const taken = takenNames(sfn);
  const locals = [...sfn.locals];

  // SOUNDNESS GATE (adversarially learned; every rule REPRODUCED as a wrong-bytes or crash
  // escape without it):
  //   • p !== base (a self-walk's bound chases the stepped var — divergent trip counts);
  //   • base and p must be pointers of the SAME element size, and every deref of p must read
  //     exactly that size — otherwise the walk (strides p's pointee) and the indexed form
  //     (strides base's) read different addresses;
  //   • confinedToWalk — the global mention accounting, shared with v3.
  const soundWalk = (walk: WalkLoop, initMentions: number, loop: Stmt): boolean =>
    walk.p !== walk.base &&
    strideAgrees(ptrVars.get(walk.p), ptrVars.get(walk.base) ?? paramType(walk.base), derefWidths([loop], walk.p)) &&
    confinedToWalk(sfn.body, walk.p, initMentions, loop);
  const paramType = (n: string): IrType | undefined => sfn.params.find((x) => x.name === n)?.type;

  // walk a statement LIST so the `while` shape can see its preceding init statement
  const walkList = (stmts: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      // `for (p = base; p < base + n; p = p + 1)` — the self-contained shape
      if (s.k === 'for') {
        const p = isUnitStep(s.inc, ptrVars);
        const init = s.init;
        if (
          p &&
          init.k === 'assign' &&
          init.name === p &&
          init.value.k === 'var' &&
          // init contributes 2 mentions (the write to p and the inc's read... the for init is
          // part of the loop stmt itself, so count the whole `for` node) — see soundWalk
          soundWalk({ p, base: init.value.name }, 0, s)
        ) {
          const walk: WalkLoop = { p, base: init.value.name };
          const iv = nextIv();
          const cond = reindexCond(s.cond, walk, iv);
          const body = cond ? reindexStmts(s.body, walk, iv) : null;
          if (cond && body) {
            declareIv(iv);
            out.push({
              k: 'for',
              init: { k: 'assign', name: iv, value: { k: 'const', value: 0 } },
              cond,
              inc: {
                k: 'assign',
                name: iv,
                value: { k: 'bin', op: '+', l: { k: 'var', name: iv }, r: { k: 'const', value: 1 } },
              },
              body,
            });
            fired++;
            keptWalks?.add(walk.base);
            continue;
          }
        }
      }
      // `p = base; while (p < base + n) { …; p = p + 1; }`
      if (s.k === 'while' && i > 0) {
        const prev = out[out.length - 1];
        const last = s.body[s.body.length - 1];
        const p = last ? isUnitStep(last, ptrVars) : null;
        if (
          p &&
          prev?.k === 'assign' &&
          prev.name === p &&
          prev.value.k === 'var' &&
          soundWalk({ p, base: prev.value.name }, 1, s)
        ) {
          const walk: WalkLoop = { p, base: prev.value.name };
          const iv = nextIv();
          const cond = reindexCond(s.cond, walk, iv);
          const body = cond ? reindexStmts(s.body.slice(0, -1), walk, iv) : null;
          if (cond && body) {
            declareIv(iv);
            out[out.length - 1] = { k: 'assign', name: iv, value: { k: 'const', value: 0 } };
            out.push({
              k: 'while',
              cond,
              body: [
                ...body,
                {
                  k: 'assign',
                  name: iv,
                  value: { k: 'bin', op: '+', l: { k: 'var', name: iv }, r: { k: 'const', value: 1 } },
                },
              ],
            });
            fired++;
            keptWalks?.add(walk.base);
            continue;
          }
        }
      }
      // v3 — the up-counting byte walk with an expression base: `p = (u8 *)(EXPR)` immediately
      // ahead of a counter-carried do-while (see tryExprWalk)
      if (s.k === 'dowhile') {
        const prev = out[out.length - 1];
        const prev2 = out[out.length - 2];
        const dw2 = tryExprWalk(prev2, prev, s, ptrVars, sfn.body, declTypes, volatileLocals);
        if (dw2) {
          out.pop(); // the walk init is subsumed by the indexed spelling
          out.push(recurse(dw2));
          fired++;
          continue;
        }
        // v4 — the unguarded constant-trip countdown (see the header)
        const cd = respellConstCountdown(out, s);
        if (cd) {
          out.length = 0;
          out.push(...cd.pre, cd.counted);
          fired++;
          continue;
        }
      }
      // the guarded countdown (v2 — see the header): an `if` whose one arm is skip-copies C and
      // whose other arm is C ⊎ inductions followed by the do-while
      if (s.k === 'if') {
        const r = respellGuardedCountdown(s);
        if (r) {
          out.push(...r);
          fired++;
          continue;
        }
      }
      // recurse into compound statements without re-spelling them
      out.push(recurse(s));
    }
    return out;
  };

  const recurse = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'if':
        return { ...s, then: walkList(s.then), else: walkList(s.else) };
      case 'while':
      case 'dowhile':
        return { ...s, body: walkList(s.body) };
      case 'for':
        return { ...s, body: walkList(s.body) };
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: walkList(c.body) })),
          default: s.default ? walkList(s.default) : undefined,
        };
      default:
        return s;
    }
  };

  /** The countdown machinery the guarded (v2) and the unguarded constant-trip (v4) shapes share:
   *  everything downstream of "which statement inits the counter, and what is the trip count".
   *  Recognizes the shape, collects what `gates` reads, and refuses on the first entry that
   *  rejects. `confineTo` names the statements every mention of the counter and of each walk
   *  pointer must live in, given the induction inits this found; `accept` is the caller's own
   *  admission. Returns the inits it consumed, `pre` minus them, and the counted `for` — or null
   *  (decline). */
  function respellCountdown(
    loop: Stmt & { k: 'dowhile' },
    pre: Stmt[],
    k: string,
    kInit: Stmt & { k: 'assign' },
    trip: Expr,
    confineTo: (induction: Stmt[]) => Stmt[],
    accept?: (leftovers: Stmt[]) => boolean,
  ): { inductionInits: Set<Stmt>; leftovers: Stmt[]; counted: Stmt & { k: 'for' } } | null {
    // SHAPE RECOGNITION — the body's contiguous tail is `k -= 1` and one `p += 1` per walk
    // pointer. Not an admission rule: without a decrement and a step there is no countdown here
    // at all, and the facts the rules read are derived from what this scan found.
    const isDec = (x: Stmt): boolean =>
      x.k === 'assign' &&
      x.name === k &&
      x.value.k === 'bin' &&
      x.value.op === '-' &&
      x.value.l.k === 'var' &&
      x.value.l.name === k &&
      x.value.r.k === 'const' &&
      x.value.r.value === 1;
    const walks: string[] = [];
    let cut = loop.body.length;
    let sawDec = false;
    let dupStep = false;
    for (let i = loop.body.length - 1; i >= 0; i--) {
      const x = loop.body[i];
      const p = isUnitStep(x, ptrVars);
      if (p !== null) {
        dupStep ||= walks.includes(p);
        walks.push(p);
        cut = i;
        continue;
      }
      if (!sawDec && isDec(x)) {
        sawDec = true;
        cut = i;
        continue;
      }
      break;
    }
    if (!sawDec || walks.length === 0) {
      return null;
    }
    const bodyCore = loop.body.slice(0, cut);
    const inits = new Map<string, Stmt & { k: 'assign' }>();
    const badBases: string[] = [];
    for (const p of walks) {
      const init = pre.find((x): x is Stmt & { k: 'assign' } => x.k === 'assign' && x.name === p);
      const bOk =
        init &&
        (init.value.k === 'var' ? init.value.name !== p && init.value.name !== k : rematerializableAddress(init.value));
      if (bOk) {
        inits.set(p, init);
      } else {
        badBases.push(p);
      }
    }
    const shape = confineTo([kInit, ...inits.values(), loop]);
    const inductionInits = new Set<Stmt>([kInit, ...inits.values()]);
    const leftovers = pre.filter((x) => !inductionInits.has(x));
    const elemSize = (t: IrType | undefined): number =>
      t?.kind === 'ptr' ? (t.to.kind === 'int' ? t.to.width / 8 : t.to.kind === 'ptr' ? 4 : 0) : 0;
    const ctx: CountdownCtx = {
      kIsPointer: ptrVars.has(k),
      kIsDeclared: storage.get(k) === 'local' || storage.get(k) === 'param',
      kIsVolatile: volatileLocals.has(k),
      dupStep,
      volatileWalks: walks.filter((p) => volatileLocals.has(p)),
      coreHasExit: hasLoopExit(bodyCore),
      badBases,
      kMentions: countMentions(sfn.body, k),
      unconfined: walks.filter((p) => countMentions(sfn.body, p) !== countMentions(shape, p)),
      badStrides: walks.filter((p) => {
        const es = elemSize(ptrVars.get(p));
        return es === 0 || !derefWidths([loop], p).every((w) => w === es);
      }),
      leakyLeftovers: leftovers.filter((x) => walks.some((w) => stmtMentions(x, w))).length,
    };
    if (firstRejection(gates, ctx) !== null) {
      return null;
    }
    // The caller's own admission. It runs before anything is minted, and so does every rule
    // above: the rewrite below is the first statement in this function that mutates `locals` or
    // `keptWalks`, so a decline has nothing to undo.
    if (accept && !accept(leftovers)) {
      return null;
    }
    // rewrite: each walk pointer is its OWN base (kept local, step dropped)
    const iv = nextIv();
    let body: Stmt[] | null = bodyCore;
    for (const p of walks) {
      body = body === null ? null : reindexStmts(body, { p, base: p }, iv);
    }
    if (body === null) {
      return null;
    }
    declareIv(iv);
    for (const p of walks) {
      keptWalks?.add(p);
    }
    // Nothing mentions the counter past this point: its init, its decrement and the exit test are
    // all gone, and the four-roles rule says those were every mention it had. Its declaration goes
    // with them — a local declared, never written and never read reads as the deliberately
    // uninitialized slot `uninit` exists to mark. A PARAM keeps its declaration, having one for a
    // reason the body does not decide.
    const kDecl = locals.findIndex((l) => l.name === k);
    if (kDecl >= 0) {
      locals.splice(kDecl, 1);
    }
    return {
      inductionInits,
      leftovers,
      counted: {
        k: 'for',
        init: { k: 'assign', name: iv, value: { k: 'const', value: 0 } },
        cond: { k: 'bin', op: '<', l: { k: 'var', name: iv }, r: trip },
        inc: {
          k: 'assign',
          name: iv,
          value: { k: 'bin', op: '+', l: { k: 'var', name: iv }, r: { k: 'const', value: 1 } },
        },
        body,
      },
    };
  }

  /** v2: `s` re-spelled as [C…, walk inits…, for], or null (decline). */
  function respellGuardedCountdown(s: Stmt & { k: 'if' }): Stmt[] | null {
    // which arm holds the loop, and does the guard skip it in the right sense?
    const armWith = (arm: Stmt[]): { pre: Stmt[]; loop: Stmt & { k: 'dowhile' } } | null => {
      const last = arm[arm.length - 1];
      return last?.k === 'dowhile' ? { pre: arm.slice(0, -1), loop: last } : null;
    };
    const inElse = armWith(s.else);
    const inThen = armWith(s.then);
    const c = s.cond;
    const guardSkips = (n: string, loopInElse: boolean): boolean => {
      if (c.k !== 'bin') {
        return false;
      }
      const zl = c.l.k === 'const' && c.l.value === 0 && c.r.k === 'var' && c.r.name === n;
      const zr = c.r.k === 'const' && c.r.value === 0 && c.l.k === 'var' && c.l.name === n;
      // loop in else ⇒ cond true skips: 0 >= n / n <= 0. Loop in then ⇒ cond true enters: 0 < n / n > 0.
      return loopInElse ? (zl && c.op === '>=') || (zr && c.op === '<=') : (zl && c.op === '<') || (zr && c.op === '>');
    };
    const pick = inElse ?? inThen;
    const skipArm = inElse ? s.then : s.else;
    if (!pick || (inElse && inThen)) {
      return null;
    }
    const { pre, loop } = pick;
    // the do-while exit: exactly `k != 0`
    const lc = loop.cond;
    if (lc.k !== 'bin' || lc.op !== '!=' || lc.l.k !== 'var' || lc.r.k !== 'const' || lc.r.value !== 0) {
      return null;
    }
    const k = lc.l.name;
    // the counter's init `k = N`, N a var the guard tests
    const kInit = pre.find((x): x is Stmt & { k: 'assign' } => x.k === 'assign' && x.name === k);
    if (!kInit || kInit.value.k !== 'var') {
      return null;
    }
    const n = kInit.value.name;
    if (n === k || !guardSkips(n, pick === inElse)) {
      return null;
    }
    if (sfn.body.some((x) => stmtAssigns(x, n))) {
      return null; // a moving bound
    }
    // the skip arm must be, in order, exactly `pre` minus the induction inits
    const skipArmMatches = (leftovers: Stmt[]): boolean =>
      skipArm.length === leftovers.length &&
      skipArm.every((x, i) => JSON.stringify(x) === JSON.stringify(leftovers[i]));
    const r = respellCountdown(loop, pre, k, kInit, { k: 'var', name: n }, () => [s], skipArmMatches);
    if (!r) {
      return null;
    }
    return [...pre.filter((x) => x !== kInit), r.counted];
  }

  /** v4: the UNGUARDED constant-trip countdown (see the header). `out` holds the statements
   *  already emitted before `dw`, the induction inits among them. Returns the list replacing
   *  `out` (itself minus the counter's init) and the counted `for`, or null (decline). */
  function respellConstCountdown(out: Stmt[], dw: Stmt & { k: 'dowhile' }): { pre: Stmt[]; counted: Stmt } | null {
    // the do-while exit: exactly `k >= 0` / `0 <= k`
    const lc = dw.cond;
    if (lc.k !== 'bin') {
      return null;
    }
    const kv =
      lc.op === '>=' && lc.l.k === 'var' && lc.r.k === 'const' && lc.r.value === 0
        ? lc.l.name
        : lc.op === '<=' && lc.r.k === 'var' && lc.l.k === 'const' && lc.l.value === 0
          ? lc.r.name
          : null;
    if (kv === null) {
      return null;
    }
    // `k >= 0` terminates only for a SIGNED counter — an unsigned one never goes below zero, and
    // the compiler that emitted this test proved it signed (`bge`). A declaration asmlift settled
    // on unsigned describes a different loop, so the trip count `C + 1` would be a fiction.
    const kT = declTypes(kv);
    if (kT?.kind !== 'int' || !kT.signed) {
      return null;
    }
    // the counter's init `k = C`, C a NON-NEGATIVE constant: the loop runs while k counts C…0, so
    // the trip count is C + 1. That is a count only while BOTH ends are representable in the
    // counter's OWN type — below zero `k = -1` runs the body once rather than `C + 1 = 0` times,
    // and above its maximum `k = 200` in an `s8` is -56, which fails `k >= 0` at the first test
    // and runs the body once where `i < 201` runs it 201 times.
    const kMax = 2 ** (kT.width - 1) - 1;
    const kInit = out.find((x): x is Stmt & { k: 'assign' } => x.k === 'assign' && x.name === kv);
    if (!kInit || kInit.value.k !== 'const' || kInit.value.value < 0 || kInit.value.value >= kMax) {
      return null;
    }
    const r = respellCountdown(dw, out, kv, kInit, { k: 'const', value: kInit.value.value + 1 }, (i) => i);
    if (!r) {
      return null;
    }
    return { pre: out.filter((x) => x !== kInit), counted: r.counted };
  }

  /** The next free induction name: the lowest `i<N>` nothing in `sfn` already claims and no
   *  earlier mint has COMMITTED. Pipeline naming is `a`/`v`/`t` prefixed, but a global is
   *  referenced by bare name and future naming (DWARF) may import real source ones, so the
   *  collision set is `takenNames`' — declarations, mentions, call targets and assignment
   *  targets alike — not the declaration lists.
   *
   *  PURE: it reads that snapshot and the locals `declareIv` committed, so a recognizer that
   *  mints and then declines leaves the next mint returning the same name. Callers hold at most
   *  one uncommitted name at a time — every mint site rewrites and commits before the walk
   *  recursion can reach another loop. */
  function nextIv(): string {
    let n = 0;
    while (taken.has(`i${n}`) || locals.some((x) => x.name === `i${n}`)) {
      n++;
    }
    return `i${n}`;
  }
  /** Commit a minted name: the ONE place the induction local is declared, called only once the
   *  rewrite has succeeded. */
  function declareIv(name: string): void {
    locals.push({ name, type: T.s(32) });
  }

  const body = walkList(sfn.body);
  if (!fired) {
    return null;
  }
  return { ...sfn, locals, body };
}
