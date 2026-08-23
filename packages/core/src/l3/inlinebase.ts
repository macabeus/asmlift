// L3 re-spelling lever: DELETE a pointer local holding a CONSTANT address and spell each access
// through it as the cast constant (`*(u16 *)0x4000208` rather than `p = (u16 *)0x4000208; *p`).
//
// The local is structure/analysis.ts's value-home spelling for a `const` with 2+ consumers that
// is LIVE ACROSS A CALL: a value the compiler needs after a call survives in a callee-saved
// register, and a named local reproduces that register. The machine fact is real — agbcc does
// park the address in `r4` across the calls — but it does NOT imply the source named anything:
// a constant re-spelled at each use is CSEd into the same one register. So the asm
// underdetermines the spelling, and this is the differ-refereed other side of it.
//
// It is codegen-visible, which is why both sides have to be enumerated rather than one picked:
// the extra `p = …;` statement is scheduled ahead of the rest of the entry block, so the pool
// load moves in front of the frame-address materialization the target emits first
// (pokeemerald:EReader_Reset, agbcc 2.9-arm-000512 — 1 insert + 1 delete, the whole residual).
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION: this is constant propagation of a local that is
// assigned once, from a compile-time constant, before anything mentions it, and whose address is
// never taken — so every use reads that constant on every path, and the substituted expression
// carries the local's own declared type, so each use renders at the C type the variable had.
//
// GATE — the local must be all of: pointer-typed; initialized by a bare `const` (a `(T *)base`
// CAST initializer is l3/basecse.ts's reuse hoist, whose own lever family owns that question);
// assigned exactly once, by a statement at the body's TOP LEVEL that no earlier statement's
// mention precedes; never address-taken; used only as the base of an `index`, at 2+ sites (one
// use is not the reused address this exists for); and carrying neither volatility flag nor
// `frame` (a slot is an asm fact — see the SFn.locals doc). Anything else, and nothing
// qualifying at all, DECLINES (null) rather than approximating.
import type { IrType } from '../ir/types';
import {
  type Expr,
  type SFn,
  type Stmt,
  exprChildren,
  mapExprChildren,
  mapStmtExprs,
  stmtChildren,
  stmtExprs,
} from './ast';

/** What one local's mentions look like across the whole body. */
interface Mentions {
  assigns: number;
  /** body-top-level index of its single top-level assignment, or null */
  topAssignAt: number | null;
  /** the bare-`const` value that assignment stores, or null if it stores anything else */
  constValue: number | null;
  addrTaken: number;
  /** uses as the `base` of an `index` node — the only use this lever can re-spell */
  baseUses: number;
  otherUses: number;
  /** body-top-level index of the first statement mentioning the name at all */
  firstAt: number | null;
}

const blank = (): Mentions => ({
  assigns: 0,
  topAssignAt: null,
  constValue: null,
  addrTaken: 0,
  baseUses: 0,
  otherUses: 0,
  firstAt: null,
});

/** Visit every node, telling the callback whether it stands as an `index`'s base. */
function walkExpr(e: Expr, visit: (x: Expr, isIndexBase: boolean) => void, isIndexBase = false): void {
  visit(e, isIndexBase);
  if (e.k === 'index') {
    walkExpr(e.base, visit, true);
    walkExpr(e.idx, visit, false);
    return;
  }
  for (const c of exprChildren(e)) {
    walkExpr(c, visit, false);
  }
}

/** Tally every mention of every local, keyed by name. */
function tally(sfn: SFn): Map<string, Mentions> {
  const t = new Map<string, Mentions>(sfn.locals.map((l) => [l.name, blank()]));
  const seen = (name: string, at: number): Mentions | undefined => {
    const m = t.get(name);
    if (m && m.firstAt === null) {
      m.firstAt = at;
    }
    return m;
  };
  const stmt = (s: Stmt, at: number, top: boolean): void => {
    if (s.k === 'assign') {
      const m = seen(s.name, at);
      if (m) {
        m.assigns++;
        if (top) {
          m.topAssignAt = at;
          m.constValue = s.value.k === 'const' ? s.value.value : null;
        }
      }
    }
    for (const e of stmtExprs(s)) {
      walkExpr(e, (x, isIndexBase) => {
        if (x.k === 'var') {
          const m = seen(x.name, at);
          if (m) {
            if (isIndexBase) {
              m.baseUses++;
            } else {
              m.otherUses++;
            }
          }
        } else if (x.k === 'addr') {
          const m = seen(x.name, at);
          if (m) {
            m.addrTaken++;
          }
        }
      });
    }
    for (const c of stmtChildren(s)) {
      stmt(c, at, false);
    }
  };
  sfn.body.forEach((s, i) => stmt(s, i, true));
  return t;
}

/** The `/inlinebase` candidate, or null when no local qualifies. Read-only: returns a fresh SFn
 *  whose body is rebuilt, leaving the input untouched. */
export function inlineConstBases(sfn: SFn): SFn | null {
  const t = tally(sfn);
  const inline = new Map<string, IrType>();
  const values = new Map<string, number>();
  for (const l of sfn.locals) {
    const m = t.get(l.name);
    if (
      m === undefined ||
      l.type.kind !== 'ptr' ||
      l.volatile !== undefined ||
      l.pointeeVolatile !== undefined ||
      l.frame !== undefined ||
      m.assigns !== 1 ||
      m.topAssignAt === null ||
      m.constValue === null ||
      m.firstAt !== m.topAssignAt ||
      m.addrTaken !== 0 ||
      m.otherUses !== 0 ||
      m.baseUses < 2
    ) {
      continue;
    }
    inline.set(l.name, l.type);
    values.set(l.name, m.constValue);
  }
  if (inline.size === 0) {
    return null;
  }
  // A FRESH node per use — never one shared tree — because identity-keyed rules downstream
  // (contracts.ts's dot-base exemption) read node identity.
  const sub = (e: Expr): Expr => {
    if (e.k === 'var') {
      const to = inline.get(e.name);
      if (to !== undefined) {
        return { k: 'cast', to, e: { k: 'const', value: values.get(e.name)! } };
      }
    }
    return mapExprChildren(e, sub);
  };
  const body = sfn.body.filter((s) => !(s.k === 'assign' && inline.has(s.name))).map((s) => mapStmtExprs(s, sub));
  return { ...sfn, locals: sfn.locals.filter((l) => !inline.has(l.name)), body };
}
