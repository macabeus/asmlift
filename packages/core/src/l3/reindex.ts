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
import { IrType, T } from '../ir/types';
import { Expr, SFn, Stmt, mapExprChildren, stmtExprs } from './ast';

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
function isUnitStep(s: Stmt, ptrVars: Map<string, IrType>): string | null {
  if (s.k !== 'assign' || !ptrVars.has(s.name)) {
    return null;
  }
  const v = s.value;
  const ok =
    v.k === 'bin' && v.op === '+' && v.l.k === 'var' && v.l.name === s.name && v.r.k === 'const' && v.r.value === 1;
  return ok ? s.name : null;
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

/** Try the walk→index re-spelling on one function. Returns the transformed COPY when at least
 *  one loop re-spelled, or null (no candidate) when nothing fired — callers emit the extra
 *  candidate only on non-null. Pure: never mutates the input SFn. `keptWalks` collects the names
 *  of the pointer locals each fired loop kept as its base (v1: the walk's base local; v2: the
 *  walk pointers themselves) — the locals the /indexed/volatile
 *  product (rank.ts) narrows the volatile lever to. */
export function reindexWalks(sfn: SFn, keptWalks?: Set<string>): SFn | null {
  const ptrVars = new Map<string, IrType>();
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
  //   • p must not be mentioned ANYWHERE in the function outside the init + the loop — the
  //     suffix-only check missed reads after an ENCLOSING construct, leaving the deleted init's
  //     var read uninitialized. Counted globally: total mentions == init + loop mentions.
  const soundWalk = (walk: WalkLoop, initMentions: number, loop: Stmt): boolean =>
    walk.p !== walk.base &&
    strideAgrees(ptrVars.get(walk.p), ptrVars.get(walk.base) ?? paramType(walk.base), derefWidths([loop], walk.p)) &&
    countMentions(sfn.body, walk.p) === initMentions + countMentions([loop], walk.p);
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
    // an INTEGER counter only: C pointer arithmetic strides the element size, so a pointer-typed
    // k's `k - 1` counts elements-of-k, not iterations — the rewrite's `i < n` would run a
    // different trip count. Declining on type closes every pointer-k shape at once (a self-step,
    // an ordinary decrement, whatever spelling).
    if (ptrVars.has(k)) {
      return null;
    }
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
    // each walk pointer: an init `p = B` in pre (B a var or a numeric address), confined to the if
    const inits = new Map<string, Stmt & { k: 'assign' }>();
    for (const p of walks) {
      const init = pre.find((x): x is Stmt & { k: 'assign' } => x.k === 'assign' && x.name === p);
      const bOk =
        init &&
        (init.value.k === 'var' ||
          (init.value.k === 'const' && init.value.value !== 0) ||
          (init.value.k === 'cast' && init.value.e.k === 'const' && init.value.e.value !== 0));
      if (!bOk || (init.value.k === 'var' && (init.value.name === p || init.value.name === k))) {
        return null;
      }
      inits.set(p, init);
    }
    // The counter appears in EXACTLY its four roles — init write, decrement write + read, exit
    // read. The rewrite deletes the init and the decrement, so ANY other use of k (a leftover's
    // read, a second decrement, a body read like `*p = k`, a nested loop's) would survive
    // referencing a variable that no longer exists as a counter. Counted over the whole
    // function, which also confines k to this `if`.
    if (countMentions(sfn.body, k) !== 4) {
      return null;
    }
    // every p lives ONLY inside this `if` (the v1 rule, counted the same way) — its body uses
    // are policed by reindexStmts (a bare `p` or a write declines; derefs rewrite)
    for (const name of walks) {
      if (countMentions(sfn.body, name) !== countMentions([s], name)) {
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
    // the skip arm must be, in order, exactly `pre` minus the induction inits
    const inductionInits = new Set<Stmt>([kInit, ...inits.values()]);
    const leftovers = pre.filter((x) => !inductionInits.has(x));
    // no leftover may mention a walk pointer: leftovers outlive the deleted step, and their
    // skip-arm twins read a pointer the skip path never initialised
    if (leftovers.some((x) => walks.some((w) => stmtMentions(x, w)))) {
      return null;
    }
    if (
      skipArm.length !== leftovers.length ||
      !skipArm.every((x, i) => JSON.stringify(x) === JSON.stringify(leftovers[i]))
    ) {
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
    return [
      ...pre.filter((x) => x !== kInit),
      {
        k: 'for',
        init: { k: 'assign', name: iv, value: { k: 'const', value: 0 } },
        cond: { k: 'bin', op: '<', l: { k: 'var', name: iv }, r: { k: 'var', name: n } },
        inc: {
          k: 'assign',
          name: iv,
          value: { k: 'bin', op: '+', l: { k: 'var', name: iv }, r: { k: 'const', value: 1 } },
        },
        body,
      },
    ];
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
