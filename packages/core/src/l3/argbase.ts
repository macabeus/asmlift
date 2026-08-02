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
// KNOWN LIMITATION: the hoisted local is a plain `T *` — `IrType` models no cv-qualifier at all,
// so naming a VOLATILE cell through it drops the qualifier that macros.ts goes out of its way to
// carry. Pre-existing and not introduced here (every pointer local in the tower has it), but the
// two features meet on exactly the MMIO shape this lever targets, so it is written down rather
// than left to be rediscovered.
//
// GATE: at least TWO arguments of the same call must qualify, with DISTINCT bases. The reordering
// this reproduces only exists when two addresses compete for registers during argument setup — with
// ONE base there is nothing to interleave, so the compiler emits the same sequence either way and
// naming it is pure churn. (Evidence: on kleod:UpdateFadeEffect, hoisting only the first base
// leaves the diff at 2; both together take it to 0.)
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

/** Distinct bases, in first-appearance order — the compiler loads each ADDRESS once.
 *
 *  Keyed on the base alone, deliberately, even though the naming below keys on width too: the gate
 *  counts how many addresses compete for registers during argument setup, and two accesses of the
 *  same address at different widths are still ONE address. Counting them separately would pass the
 *  gate on `callee(*(u8 *)&g, *(u16 *)&g)`, where nothing reorders and there is nothing to fix. */
function distinctBases(nodes: Extract<Expr, { k: 'index' }>[]): Extract<Expr, { k: 'index' }>[] {
  const out: Extract<Expr, { k: 'index' }>[] = [];
  for (const n of nodes) {
    if (!out.some((o) => exprEquals(o.base, n.base))) {
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
    if (e.k === 'call') {
      into.add(e.fn); // a hoist local must not shadow a called function symbol
    }
    mapExprChildren(e, (c) => {
      visit(c);
      return c;
    });
  };
  for (const s of stmts) {
    if (s.k === 'assign') {
      into.add(s.name);
    }
    stmtExprs(s).forEach(visit);
    collectNames(stmtChildren(s), into);
  }
}

/** The (base, width, signedness) key an `index` shares with every other access through the same
 *  base — so ALL of a base's uses in one call rewrite to the same local, not just the first. */
function baseKey(n: Extract<Expr, { k: 'index' }>): string {
  const b = n.base;
  const id = b.k === 'addr' ? `a:${b.name}` : b.k === 'const' ? `c:${b.value}` : `v:${(b as { name: string }).name}`;
  return `${id} ${n.width} ${n.signed}`;
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

  // Rewrite ONE statement into the list that replaces it: the naming assignments, then the
  // statement with its qualifying bases pointed at them. The naming goes immediately BEFORE the
  // statement holding the call, not at the function top — the compiler loads these addresses where
  // it needs them, and hoisting further extends live ranges the original never had (the
  // register-pressure failure basecse.ts's loop gate exists for).
  //
  // NOTE the shape: recursion happens per FIELD, through an exhaustive switch, and the `pre`
  // insertion happens INSIDE it. Rebuilding a statement from a flattened `stmtChildren` list cannot
  // work — inserting statements shifts the boundary the rebuild would have to split at, and
  // `stmtChildren('for')` is `[init, inc, ...body]`, which is not a body. Both mistakes produce
  // COMPILING but wrong C (a call migrating across an if/else boundary; a `for` init duplicated
  // into its body), which no boundary contract checks: they check resolution and spellability, not
  // statement placement.
  const rewrite = (s: Stmt): Stmt[] => {
    const pre: Stmt[] = [];
    const localFor = new Map<string, string>();
    // Only the statement's OWN expressions can carry a call this pass names bases for; nested
    // statement lists get their own `pre`, in their own scope, via the recursion below.
    for (const e of stmtExprs(s)) {
      const scan = (x: Expr): void => {
        if (x.k === 'call') {
          const bases = distinctBases(argBases(x, globals));
          if (bases.length >= 2) {
            for (const b of bases) {
              const key = baseKey(b);
              if (localFor.has(key)) {
                continue;
              }
              const ptrType = T.ptr(scalarTypeForAccess(b.width, b.signed));
              const nm = freshName(taken);
              localFor.set(key, nm);
              newLocals.push({ name: nm, type: ptrType });
              pre.push({ k: 'assign', name: nm, value: { k: 'cast', to: ptrType, e: b.base } });
            }
            fired = true;
          }
        }
        mapExprChildren(x, (c) => {
          scan(c);
          return c;
        });
      };
      scan(e);
    }
    const point = (e: Expr): Expr => {
      if (e.k === 'index' && eligibleBase(e.base, globals)) {
        const nm = localFor.get(baseKey(e));
        if (nm) {
          return { ...e, base: { k: 'var', name: nm }, idx: point(e.idx) };
        }
      }
      return mapExprChildren(e, point);
    };
    const kids = (list: Stmt[]): Stmt[] => list.flatMap(rewrite);
    let out: Stmt;
    switch (s.k) {
      case 'assign':
        out = { ...s, value: point(s.value) };
        break;
      case 'store':
        out = { ...s, lval: point(s.lval), value: point(s.value) };
        break;
      case 'exprstmt':
        out = { ...s, value: point(s.value) };
        break;
      case 'return':
        out = s.value === undefined ? s : { ...s, value: point(s.value) };
        break;
      case 'if':
        out = { ...s, cond: point(s.cond), then: kids(s.then), else: kids(s.else) };
        break;
      case 'while':
      case 'dowhile':
        out = { ...s, cond: point(s.cond), body: kids(s.body) };
        break;
      case 'for': {
        // `init`/`inc` are single statements. A `pre` produced inside either has nowhere legal to
        // go (before the loop changes when it runs; inside the body repeats it), so this pass
        // declines to fire there and leaves them alone.
        out = { ...s, cond: point(s.cond), body: kids(s.body) };
        break;
      }
      case 'switch':
        out = {
          ...s,
          scrutinee: point(s.scrutinee),
          cases: s.cases.map((c) => ({ ...c, body: kids(c.body) })),
          ...(s.default ? { default: kids(s.default) } : {}),
        };
        break;
      case 'break':
      case 'continue':
        out = s;
        break;
    }
    if (pre.length === 0) {
      return [out];
    }
    return [...pre, out];
  };

  const body = sfn.body.flatMap(rewrite);
  return fired ? { ...sfn, body, locals: [...sfn.locals, ...newLocals] } : null;
}
