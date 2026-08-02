// L3 re-spelling lever: materialize the deref BASES of a call's arguments into locals, before the
// call.
//
// When a call's arguments are each a deref through a different fixed address, the compiler loads
// BOTH addresses before dereferencing either — it needs two registers live across the argument
// setup, so it emits the two pool loads first:
//
//     ldr  r0, .L4        <- both addresses
//     ldr  r1, .L4+0x4
//     ldrb r0, [r0]       <- then both loads
//     ldrb r1, [r1, #0x8]
//
// Spelling the derefs INLINE in the argument list (`f(*(u8 *)0x4000006, gEntityArray[8])`) makes
// agbcc finish argument 0 before starting argument 1 — `ldr; ldrb; ldr; ldrb` — which is the same
// four instructions in a different order, and a nonmatch. The source that produces the target's
// order names the bases first (`vu8 *p = &REG_VCOUNT_L; u8 *e = gEntityArray; f(*p, e[8])`), which
// is what a decomp author writes and what this pass reproduces.
//
// A LEVER, not a rewrite: it is emitted as an ADDITIONAL candidate (rank.ts `/argbase`) and the
// differ referees, so the inline spelling is always still there to win. That is what bounds the
// risk — a lever that replaced the primary could lose a match, this one cannot.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION, which matters because on a NONMATCH row the
// best-scoring candidate is what the user is shown. Only a PURE leaf base is eligible — a global's
// address (`addr`), a numeric pointer (`const`), or the bare name of a declared global — so
// evaluating it earlier can be neither observable nor faulting. A local variable is excluded: it
// may be assigned between the hoist point and the call, which would change what is dereferenced.
//
// GATE: at least TWO arguments of the same call must qualify, with DISTINCT bases. One base alone
// does not reproduce the reordering (measured: hoisting only the first argument's base on
// kleod:UpdateFadeEffect leaves the diff unchanged at 2, both together take it to 0), so a
// single-base hoist would be churn with no evidence behind it.
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn, Stmt } from './ast';
import { exprEquals, mapExprChildren, stmtChildren, stmtExprs } from './ast';

/** A base this pass may evaluate early: pure, and not something a store can change under us. */
function eligibleBase(base: Expr, globals: ReadonlySet<string>): boolean {
  return base.k === 'addr' || base.k === 'const' || (base.k === 'var' && globals.has(base.name));
}

/** The `index` nodes directly under a call's arguments whose base is eligible — the candidates for
 *  materialization. Only the argument's OWN top-level deref counts: a base buried inside arbitrary
 *  argument arithmetic is not what the compiler is loading up front. */
function argBases(call: Extract<Expr, { k: 'call' }>, globals: ReadonlySet<string>): Extract<Expr, { k: 'index' }>[] {
  const out: Extract<Expr, { k: 'index' }>[] = [];
  for (const a of call.args) {
    if (a.k === 'index' && eligibleBase(a.base, globals)) {
      out.push(a);
    }
  }
  return out;
}

/** Distinct bases, in first-appearance order — the compiler loads each address once. */
function distinctBases(nodes: Extract<Expr, { k: 'index' }>[]): Extract<Expr, { k: 'index' }>[] {
  const out: Extract<Expr, { k: 'index' }>[] = [];
  for (const n of nodes) {
    if (!out.some((o) => exprEquals(o.base, n.base) && o.width === n.width && o.signed === n.signed)) {
      out.push(n);
    }
  }
  return out;
}

function freshName(taken: Set<string>): string {
  for (let i = 0; ; i++) {
    const n = `p${i}`;
    if (!taken.has(n)) {
      taken.add(n);
      return n;
    }
  }
}

function collectNames(stmts: Stmt[], into: Set<string>): void {
  const visit = (e: Expr): void => {
    if (e.k === 'var' || e.k === 'addr') {
      into.add(e.name);
    }
    mapExprChildren(e, (c) => {
      visit(c);
      return c;
    });
  };
  for (const s of stmts) {
    stmtExprs(s).forEach(visit);
    collectNames(stmtChildren(s), into);
  }
}

/**
 * The `/argbase` re-spelling, or null when no statement qualifies (the caller then adds no
 * candidate at all rather than a duplicate of the primary).
 */
export function materializeArgBases(sfn: SFn): SFn | null {
  const globals = new Set((sfn.globals ?? []).map((g) => g.name));
  const taken = new Set<string>([...sfn.params.map((p) => p.name), ...sfn.locals.map((l) => l.name)]);
  collectNames(sfn.body, taken);
  const newLocals: { name: string; type: IrType }[] = [];
  let fired = false;

  // Rewrite ONE statement: every qualifying call in it gets its argument bases named first, and the
  // naming statements are inserted immediately BEFORE it — not at the function top. The compiler
  // loads these addresses right where it needs them, and hoisting further would extend live ranges
  // the original never had (the register-pressure failure basecse.ts's loop gate exists for).
  const rewriteStmt = (s: Stmt): Stmt[] => {
    const pre: Stmt[] = [];
    const localFor: { node: Extract<Expr, { k: 'index' }>; name: string }[] = [];
    const scan = (e: Expr): void => {
      if (e.k === 'call') {
        const bases = distinctBases(argBases(e, globals));
        if (bases.length >= 2) {
          for (const b of bases) {
            const ptrType = T.ptr(scalarTypeForAccess(b.width, b.signed));
            const nm = freshName(taken);
            localFor.push({ node: b, name: nm });
            newLocals.push({ name: nm, type: ptrType });
            pre.push({ k: 'assign', name: nm, value: { k: 'cast', to: ptrType, e: b.base } });
          }
          fired = true;
        }
      }
      mapExprChildren(e, (c) => {
        scan(c);
        return c;
      });
    };
    stmtExprs(s).forEach(scan);
    if (localFor.length === 0) {
      // no call in THIS statement qualified; recurse into nested statements (an if/loop body)
      const kids = stmtChildren(s);
      return kids.length ? [rebuild(s, kids.flatMap(rewriteStmt))] : [s];
    }
    const point = (e: Expr): Expr => {
      const hit = localFor.find((l) => l.node === e);
      return hit
        ? { ...(e as Extract<Expr, { k: 'index' }>), base: { k: 'var', name: hit.name } }
        : mapExprChildren(e, point);
    };
    return [...pre, mapStmtExprs(s, point)];
  };

  const body = sfn.body.flatMap(rewriteStmt);
  return fired ? { ...sfn, body, locals: [...sfn.locals, ...newLocals] } : null;
}

/** Replace a statement's direct expressions, keeping its children. */
function mapStmtExprs(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.k) {
    case 'assign':
      return { ...s, value: f(s.value) };
    case 'store':
      return { ...s, lval: f(s.lval), value: f(s.value) };
    case 'exprstmt':
      return { ...s, value: f(s.value) };
    case 'return':
      return s.value === undefined ? s : { ...s, value: f(s.value) };
    default:
      return s; // control-flow statements are handled by the child recursion above
  }
}

/** Rebuild a control-flow statement around rewritten children. Only the shapes whose bodies are a
 *  flat statement list are supported; anything else is returned unchanged, which simply means this
 *  lever declines to fire inside it. */
function rebuild(s: Stmt, kids: Stmt[]): Stmt {
  if (s.k === 'if') {
    return { ...s, then: kids.slice(0, s.then.length), else: s.else ? kids.slice(s.then.length) : s.else };
  }
  if (s.k === 'while' || s.k === 'dowhile' || s.k === 'for') {
    return { ...s, body: kids };
  }
  return s;
}
