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
// one counter (`dotprod`'s a/b pair). A loop is re-spelled only when ALL hold —
//   • the guard tests THE SAME var the counter is initialised from, against 0, in the sense that
//     skips the loop; the do-while exit is exactly `k != 0`;
//   • the body's contiguous TAIL is the steps — ONE `p += 1` per walk pointer and `k -= 1`;
//   • the counter is INTEGER-typed (a pointer's `k - 1` strides its element size — a different
//     trip count) and appears in EXACTLY its four roles (init write, decrement write + read,
//     exit read) — the rewrite deletes the init and the decrement, so any other use of k,
//     wherever it hides (a leftover, the body, a nested loop), would survive them;
//   • every p is mentioned only inside the `if`, and never by a leftover statement;
//   • the skip arm's statements equal, in order, the else arm's loop-preceding statements minus
//     the induction inits — anything left over means the arms are not the same computation;
//   • every deref of a walk pointer reads its own element size (a `*(u8 *)p` over an `s32 *`
//     walk strides 4 as a walk but 1 re-indexed — the v1 stride rule, same reason);
//   • BODY has no `break`/`continue` targeting this loop — the original steps sat in the body's
//     tail, which a `continue` skips, but a `for`'s inc runs: the two shapes genuinely differ;
//   • n is never assigned in the function (a moving bound has no single trip count).
// Everything else declines — the function keeps its countdown spelling, no candidate emitted.
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

interface WalkLoop {
  p: string; // the pointer induction var
  base: string; // the var `p` was initialised from
}

/** Total mentions of `name` across a statement list (reads, writes, everywhere). */
function countMentions(stmts: Stmt[], name: string): number {
  let n = 0;
  const inExpr = (e: Expr): void => {
    if (e.k === 'var' && e.name === name) {
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

/** Does `e` mention var `name` anywhere? */
function mentionsVar(e: Expr, name: string): boolean {
  if (e.k === 'var') {
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
 *  address. Zero is excluded: a null base is not a walk. Spelled as "holds a non-zero constant
 *  and nothing else" rather than by folding, which would need a constant evaluator this file has
 *  no other use for. */
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
  declTypes: Map<string, IrType>,
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
  const baseT = declTypes.get(base.name);
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
  const ivT = declTypes.get(iv);
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
 *  the /livebase pairings instead. */
export function reindexWalks(sfn: SFn, keptWalks?: Set<string>): SFn | null {
  const ptrVars = new Map<string, IrType>();
  const declTypes = new Map<string, IrType>();
  const volatileLocals = new Set(sfn.locals.filter((l) => l.volatile === true).map((l) => l.name));
  for (const v of [...sfn.params, ...sfn.locals, ...(sfn.globals ?? [])]) {
    declTypes.set(v.name, v.type);
  }
  const scalarLocals = new Set([...sfn.params, ...sfn.locals].map((v) => v.name));
  for (const v of [...sfn.params, ...sfn.locals]) {
    if (v.type.kind === 'ptr') {
      ptrVars.set(v.name, v.type);
    }
  }
  if (ptrVars.size === 0) {
    return null;
  }

  let fired = 0;
  let ivCount = 0;
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
          const iv = freshIv();
          const cond = reindexCond(s.cond, walk, iv);
          const body = cond ? reindexStmts(s.body, walk, iv) : null;
          if (cond && body) {
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
          retireIv();
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
          const iv = freshIv();
          const cond = reindexCond(s.cond, walk, iv);
          const body = cond ? reindexStmts(s.body.slice(0, -1), walk, iv) : null;
          if (cond && body) {
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
          retireIv();
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
   *  `confineTo` names the statements every mention of the counter and of each walk pointer must
   *  live in, given the induction inits this found. Returns the inits it consumed, `pre` minus
   *  them, and the counted `for` — or null (decline). */
  function respellCountdown(
    loop: Stmt & { k: 'dowhile' },
    pre: Stmt[],
    k: string,
    kInit: Stmt & { k: 'assign' },
    trip: Expr,
    confineTo: (induction: Stmt[]) => Stmt[],
    accept?: (leftovers: Stmt[]) => boolean,
  ): { inductionInits: Set<Stmt>; leftovers: Stmt[]; counted: Stmt & { k: 'for' } } | null {
    // an INTEGER counter only: C pointer arithmetic strides the element size, so a pointer-typed
    // k's `k - 1` counts elements-of-k, not iterations — the rewrite's `i < n` would run a
    // different trip count. Declining on type closes every pointer-k shape at once (a self-step,
    // an ordinary decrement, whatever spelling).
    if (ptrVars.has(k)) {
      return null;
    }
    // …and a DECLARED one. The rewrite deletes the counter's init and its decrement, which the
    // four-roles rule licenses by proving nothing in this function reads it afterwards — a
    // property that says nothing about a GLOBAL, whose final value is observable to every other
    // caller, ISR and translation unit. structure.ts spells a store to a bare scalar global as an
    // `assign` like any other, so `gCount = 7; do { …; gCount = gCount - 1; } while (…)` reaches
    // here looking exactly like a local counter, and the re-spelling would silently stop writing
    // it.
    if (!scalarLocals.has(k)) {
      return null;
    }
    // the body's contiguous tail: `k -= 1` and `p += 1` per walk pointer
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
    // one step per pointer (a pointer-typed counter never reaches this scan — declined on type
    // above)
    if (!sawDec || walks.length === 0 || dupStep) {
      return null;
    }
    const bodyCore = loop.body.slice(0, cut);
    if (hasLoopExit(bodyCore)) {
      return null;
    }
    // each walk pointer: an init `p = B` in pre (B a var or a rematerializable address)
    const inits = new Map<string, Stmt & { k: 'assign' }>();
    for (const p of walks) {
      const init = pre.find((x): x is Stmt & { k: 'assign' } => x.k === 'assign' && x.name === p);
      const bOk = init && (init.value.k === 'var' || rematerializableAddress(init.value));
      if (!bOk || (init.value.k === 'var' && (init.value.name === p || init.value.name === k))) {
        return null;
      }
      inits.set(p, init);
    }
    const shape = confineTo([kInit, ...inits.values(), loop]);
    // The counter appears in EXACTLY its four roles — init write, decrement write + read, exit
    // read. The rewrite deletes the init and the decrement, so ANY other use of k (a leftover's
    // read, a second decrement, a body read like `*p = k`, a nested loop's) would survive
    // referencing a variable that no longer exists as a counter. Counted over the whole
    // function, which also confines k to the shape: the four this shape accounts for are all
    // inside it, so a fifth anywhere makes the total differ.
    if (countMentions(sfn.body, k) !== 4) {
      return null;
    }
    // every p lives ONLY inside the shape (the v1 rule, counted the same way) — its body uses
    // are policed by reindexStmts (a bare `p` or a write declines; derefs rewrite)
    for (const name of walks) {
      if (countMentions(sfn.body, name) !== countMentions(shape, name)) {
        return null;
      }
    }
    // every deref of p reads p's own element size — re-indexing must not change the stride
    for (const p of walks) {
      const pt = ptrVars.get(p);
      const es = pt?.kind === 'ptr' ? (pt.to.kind === 'int' ? pt.to.width / 8 : pt.to.kind === 'ptr' ? 4 : 0) : 0;
      if (es === 0 || !derefWidths([loop], p).every((w) => w === es)) {
        return null;
      }
    }
    const inductionInits = new Set<Stmt>([kInit, ...inits.values()]);
    const leftovers = pre.filter((x) => !inductionInits.has(x));
    // no leftover may mention a walk pointer: leftovers outlive the deleted step, and their
    // skip-arm twins read a pointer the skip path never initialised
    if (leftovers.some((x) => walks.some((w) => stmtMentions(x, w)))) {
      return null;
    }
    // The caller's own admission, and it runs HERE — before `freshIv` mints an induction local
    // and before `keptWalks` records these pointers. Both outlive a `return null`: a retired
    // candidate would leave a declared-but-unused `i<n>` in the tree and qualify the /volatile
    // product on a pointer belonging to a loop that never re-spelled.
    if (accept && !accept(leftovers)) {
      return null;
    }
    // rewrite: each walk pointer is its OWN base (kept local, step dropped)
    const iv = freshIv();
    let body: Stmt[] | null = bodyCore;
    for (const p of walks) {
      body = body === null ? null : reindexStmts(body, { p, base: p }, iv);
    }
    if (body === null) {
      retireIv();
      return null;
    }
    for (const p of walks) {
      keptWalks?.add(p);
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
    const kT = declTypes.get(kv);
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

  function freshIv(): string {
    // collide-checked: pipeline naming is a*/v*/t*, but future naming (DWARF) may import
    // real source names — never conflate with an existing i<N>.
    let name = `i${ivCount++}`;
    while (sfn.params.some((x) => x.name === name) || locals.some((x) => x.name === name)) {
      name = `i${ivCount++}`;
    }
    locals.push({ name, type: T.s(32) });
    return name;
  }
  function retireIv(): void {
    locals.pop();
    ivCount--;
  }

  const body = walkList(sfn.body);
  if (!fired) {
    return null;
  }
  return { ...sfn, locals, body };
}
