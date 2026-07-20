// L3 readability pass: dead-LOCAL-store elimination + empty-branch simplification.
//
// asmlift's SSA-destruction (structure.ts) can emit an assignment to a synthesized local whose
// value is never read afterwards — a merge/phi copy the structurer materialized for a value that
// turns out dead (classically, both arms of an `if` write a merge local that nothing downstream
// reads). The compiler DCEs these, so they never affect the MATCH, but they clutter the source:
//   if ((v0 - 1) << 16 != 0) { v0 = (v0 - 1) << 16; } else { flag = 1; v0 = 1; }
// with the two dead `v0 = …` gone the inner `if` has an empty then-arm, which flips to the clean
//   if ((v0 - 1) << 16 == 0) { flag = 1; }
//
// SOUNDNESS. This only ever REMOVES a statement (or flips a branch whose semantics a compiler
// normalizes identically), so it can never invent a false match: a wrongly-removed live store
// changes the recompiled bytes and shows up as a LOST match under the benchmark's zero-lost gate.
// The liveness below is a CONSERVATIVE over-approximation (loops/switches treat every in-scope
// read as live throughout), so a removal only happens when the local is provably dead. Only
// names in `locals` are eligible — globals (side effects, referenced by name from headers) and
// params are never touched — and a value carrying a side effect / gap signal / memory load is
// never dropped (see `mustKeep`). Locals are never address-taken in L3 (`addr` names a global),
// so `var` reads are a COMPLETE account of a local's uses.
//
// Ordering: structureChecked runs `assertResolved` BEFORE this pass, so in strict mode an
// unresolved `?` value trips the contract first and never reaches DCE; `mustKeep` treating `?` as
// keep is defense-in-depth for any future caller that skips that check.
import type { Expr, SFn, Stmt } from './ast';
import { exprChildren, stmtChildren, stmtExprs } from './ast';

/** Accumulate every LOCAL-eligible `var` name read anywhere in `e` (recurses all sub-exprs). An
 *  `addr` node names a global, not a local, so it is not a local read. */
function readsInto(e: Expr, out: Set<string>): void {
  if (e.k === 'var') {
    out.add(e.name);
  }
  for (const c of exprChildren(e)) {
    readsInto(c, out);
  }
}

function reads(e: Expr): Set<string> {
  const s = new Set<string>();
  readsInto(e, s);
  return s;
}

/** True if `e` carries any reason NOT to speculatively delete its assignment/condition:
 *   - `call` — may write memory/globals (a side effect);
 *   - `marker` — the annotate-mode ASMLIFT_ERROR gap signal, which must survive so the gap stays loud;
 *   - the strict-mode `?` unresolved sentinel (`{k:'var', name:'?'}`) — dropping it would let a
 *     value asmlift could NOT lift slip past `assertResolved`, silently downgrading a loud gap;
 *   - a memory load (`index`/`field`) — asmlift models no `volatile`, so a possibly-effectful read
 *     is never deleted (this pass never removes a memory access).
 *  A dead assignment whose value contains any of these is kept. */
function mustKeep(e: Expr): boolean {
  if (e.k === 'call' || e.k === 'marker' || e.k === 'index' || e.k === 'field') {
    return true;
  }
  if (e.k === 'var' && e.name === '?') {
    return true;
  }
  return exprChildren(e).some(mustKeep);
}

/** Every local read anywhere within these statements (exprs + nested statements). Used to give
 *  loops/switches a conservative live-out so a store read on another iteration/case is never cut. */
function allReadsInto(stmts: Stmt[], out: Set<string>): void {
  for (const s of stmts) {
    for (const e of stmtExprs(s)) {
      readsInto(e, out);
    }
    allReadsInto(stmtChildren(s), out);
  }
}

/** Negate a condition, flipping a relational operator directly (`!= → ==`, `< → >=`, …) so an
 *  empty-then flip reads cleanly; anything else wraps in `!( … )`. Both forms are semantically
 *  exact over C's total integer order. */
function negate(cond: Expr): Expr {
  if (cond.k === 'bin') {
    const table: Record<string, '==' | '!=' | '<' | '<=' | '>' | '>='> = {
      '==': '!=',
      '!=': '==',
      '<': '>=',
      '>=': '<',
      '>': '<=',
      '<=': '>',
    };
    const f = table[cond.op];
    if (f) {
      return { k: 'bin', op: f, l: cond.l, r: cond.r };
    }
  }
  return { k: 'un', op: '!', e: cond };
}

/** Backward live-variable walk over one block. `liveOut` is the set of locals live on exit;
 *  returns the rewritten block and the set live on entry. */
function dceBlock(
  stmts: Stmt[],
  liveOut: ReadonlySet<string>,
  locals: ReadonlySet<string>,
): { out: Stmt[]; liveIn: Set<string> } {
  const live = new Set(liveOut);
  const rev: Stmt[] = [];
  const setLive = (next: Set<string>) => {
    live.clear();
    for (const n of next) {
      live.add(n);
    }
  };
  for (let i = stmts.length - 1; i >= 0; i--) {
    const s = stmts[i];
    switch (s.k) {
      case 'assign': {
        if (locals.has(s.name) && !live.has(s.name) && !mustKeep(s.value)) {
          continue; // dead local store — drop it; liveness is unchanged (it was a no-op)
        }
        live.delete(s.name); // the write kills the name for statements before it …
        for (const r of reads(s.value)) {
          live.add(r); // … then its own reads (incl. a self-reference like v = v - 1) are live
        }
        rev.push(s);
        break;
      }
      case 'store': {
        for (const r of reads(s.lval)) {
          live.add(r);
        }
        for (const r of reads(s.value)) {
          live.add(r);
        }
        rev.push(s);
        break;
      }
      case 'exprstmt': {
        for (const r of reads(s.value)) {
          live.add(r);
        }
        rev.push(s);
        break;
      }
      case 'return': {
        if (s.value) {
          for (const r of reads(s.value)) {
            live.add(r);
          }
        }
        rev.push(s);
        break;
      }
      case 'break':
      case 'continue': {
        rev.push(s);
        break;
      }
      case 'if': {
        const t = dceBlock(s.then, live, locals);
        const e = dceBlock(s.else, live, locals);
        const nlive = new Set<string>();
        for (const r of reads(s.cond)) {
          nlive.add(r);
        }
        for (const r of t.liveIn) {
          nlive.add(r);
        }
        for (const r of e.liveIn) {
          nlive.add(r);
        }
        setLive(nlive);
        if (t.out.length === 0 && e.out.length === 0) {
          // both arms empty: keep only if the condition itself has a side effect
          if (mustKeep(s.cond)) {
            rev.push({ k: 'exprstmt', value: s.cond });
          }
        } else if (t.out.length === 0) {
          rev.push({ k: 'if', cond: negate(s.cond), then: e.out, else: [] });
        } else {
          rev.push({ k: 'if', cond: s.cond, then: t.out, else: e.out });
        }
        break;
      }
      case 'while':
      case 'dowhile': {
        // Conservative: any local read anywhere in the loop is live throughout it, so a
        // loop-carried store is never cut. Body DCE removes only what is dead on EVERY path.
        const loopLive = new Set(live);
        allReadsInto([s], loopLive);
        const b = dceBlock(s.body, loopLive, locals);
        const nlive = new Set(loopLive);
        for (const r of b.liveIn) {
          nlive.add(r);
        }
        setLive(nlive);
        rev.push({ ...s, body: b.out });
        break;
      }
      case 'for': {
        const loopLive = new Set(live);
        allReadsInto([s], loopLive);
        const b = dceBlock(s.body, loopLive, locals);
        const nlive = new Set(loopLive);
        for (const r of b.liveIn) {
          nlive.add(r);
        }
        setLive(nlive);
        rev.push({ ...s, body: b.out }); // init/inc left intact (never DCE'd)
        break;
      }
      case 'switch': {
        // Conservative: fall-through makes a case's live-out include later cases, so treat every
        // read anywhere in the switch as live throughout — no case-body store is ever cut.
        const swLive = new Set(live);
        allReadsInto([s], swLive);
        const cases = s.cases.map((c) => ({ ...c, body: dceBlock(c.body, swLive, locals).out }));
        const def = s.default ? dceBlock(s.default, swLive, locals).out : s.default;
        const nlive = new Set(swLive);
        for (const r of reads(s.scrutinee)) {
          nlive.add(r);
        }
        setLive(nlive);
        rev.push({ ...s, cases, default: def });
        break;
      }
      default: {
        // Exhaustiveness guard: a new Stmt kind must be handled here explicitly, never silently
        // dropped (matches the l3/ast.ts "exhaustive under noImplicitReturns" walker discipline).
        const _never: never = s;
        throw new Error(`dce: unhandled statement kind ${(_never as Stmt).k}`);
      }
    }
  }
  rev.reverse();
  return { out: rev, liveIn: live };
}

/** Every local name still referenced (read or assigned) in the final body — used to prune local
 *  declarations that became unused after DCE. */
function referencedNames(stmts: Stmt[], out: Set<string>): void {
  for (const s of stmts) {
    if (s.k === 'assign') {
      out.add(s.name);
    }
    for (const e of stmtExprs(s)) {
      readsInto(e, out);
    }
    referencedNames(stmtChildren(s), out);
  }
}

/** Remove dead local stores and simplify the branches they empty out, then drop any local
 *  declaration left unreferenced. Returns a new SFn; the input is not mutated. */
export function eliminateDeadStores(sfn: SFn): SFn {
  const locals = new Set(sfn.locals.map((l) => l.name));
  const body = dceBlock(sfn.body, new Set<string>(), locals).out;
  const used = new Set<string>();
  referencedNames(body, used);
  return { ...sfn, body, locals: sfn.locals.filter((l) => used.has(l.name)) };
}
