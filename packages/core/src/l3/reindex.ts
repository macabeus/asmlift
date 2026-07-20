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
// MEASURED GAP (2026-07-17, benchmark survey): this v1 template fires on ZERO current nonmatch
// rows — the real agbcc shape for `for(i=0;i<n;i++) a[i]` is a GUARDED COUNTDOWN do-while with
// TWIN induction vars (`if (0 >= n) {...} else { p = a; k = n; do { ...*p...; p += 1; k -= 1 }
// while (k != 0) }`, e.g. synthetic:countpos at diff 5). Re-deriving the counted `for` from that
// form needs guard-branch merging + induction-variable unification — the v2 recognizer, a
// candidate for the capability-ROI queue. The MECHANISM (candidates + boundary contracts +
// differ referee) is what this module establishes; the recognizer set grows against measured
// shapes.
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
    const idx: Expr =
      e.idx.k === 'const' && e.idx.value === 0
        ? { k: 'var', name: iv }
        : { k: 'bin', op: '+', l: { k: 'var', name: iv }, r: e.idx };
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
 *  candidate only on non-null. Pure: never mutates the input SFn. */
export function reindexWalks(sfn: SFn): SFn | null {
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
            continue;
          }
          retireIv();
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
