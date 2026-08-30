// asmlift — SELF-DECLARING CANDIDATES: the pure map-reference query
// (research/self-declaring-candidates-2026-07-26.md).
//
// `collectSymbolRefs` derives, from a FINAL structured tree, every DECLARABLE symbol the body
// references in a VALUE context — the input to the scoring layer's declaration synthesis
// (core declare.ts). "Declarable" and not "map-derived": the dictionary this is called with is
// the caller's, and rank.ts hands it a symbol map UNIONED with the names read straight out of
// the asm's own literal pool / relocations (`bareGlobalSymbols`), so a candidate compiled
// outside project headers declares what it spells even with no map at all. The map's facts win
// per NAME where it has them; the rest come back marked `synthesized`. It is a pure tree query with no pipeline state: the enumeration
// layer (rank.ts) calls it exactly once per candidate, on the tree the candidate's source was
// emitted from, at the moment the candidate is finalized. There is deliberately NO cached
// `symbolRefs` field on `SFn` — a carried field would oblige every future l3 pass to remember
// to recompute it (a dead-store DCE that drops a tree's only reference would otherwise leave a
// stale ref, transitively reintroducing the hazards the collector excludes). Deriving at the
// consumption point makes staleness impossible by construction.
import type { SymbolInfo } from '../symbols';
import { Expr, Stmt, exprChildren, stmtChildren, stmtExprs } from './ast';

/** One recorded VALUE reference — a name the tree references plus the facts to declare it. */
export interface SymbolRef {
  name: string;
  info: SymbolInfo;
  /** NAME-ONLY symbols (no map shape): the bare off-0 access facts observed in the candidate's
   *  own IR — attached by the enumeration (rank.ts bareGlobalAccessFacts), consumed by the
   *  declaration synthesis (declare.ts) as the width/signedness authority for `extern T name;`. */
  access?: { width: number; signed: boolean };
  /** NO SYMBOL MAP KNOWS THIS NAME — the declaration for it is a HYPOTHESIS, not a fact. Both the
   *  name and (through `access`) its width and signedness were read out of the candidate's own
   *  asm: the very bytes the candidate is then scored against. A fitted declaration cannot LOSE
   *  score, so it is not covered by declare.ts's only-loses-score argument — it can manufacture
   *  agreement instead. Which is legitimate (the artifact is decls + source, and it does compile
   *  to those bytes) exactly as long as the consumer SHOWS the declarations with the verdict.
   *  Marked here so a consumer can tell the two provenances apart inside one block. */
  synthesized?: true;
}

/** The declarable symbols a structured body references in a VALUE context — the input to the
 *  scoring layer's declaration synthesis. A name counts when it appears as a `var`/`addr` leaf
 *  and the caller's dictionary knows it (bare `gSym`, `&gSym`, `(u32)Func`, a `field` base — all reduce to
 *  those leaves). A name that is ANY call's target is excluded entirely, even if also
 *  value-referenced: prototyping a called symbol `void F(void);` hard-errors under gcc-2.9
 *  when the call passes args, while leaving it undeclared keeps today's implicit-declaration
 *  behavior (the one honest option without arity knowledge). The function's OWN name
 *  (`selfName`) is excluded too — the candidate's definition IS its declaration, and a
 *  synthesized `void F(void);` above `s32 F(...)` is a conflicting-types hard error (a
 *  self-address reference resolves against the definition itself). */
export function collectSymbolRefs(body: Stmt[], symbols: Map<string, SymbolInfo>, selfName: string): SymbolRef[] {
  const called = new Set<string>();
  const valueRefs = new Set<string>();
  const visitExpr = (e: Expr): void => {
    if (e.k === 'call') {
      called.add(e.fn);
    } else if ((e.k === 'var' || e.k === 'addr') && symbols.has(e.name)) {
      valueRefs.add(e.name);
    }
    exprChildren(e).forEach(visitExpr);
  };
  const visitStmt = (s: Stmt): void => {
    // an `assign` carries its target as a NAME, not an Expr — a scalar global WRITE
    // (`gSym = x;`) references the symbol every bit as much as a read does
    if (s.k === 'assign' && symbols.has(s.name)) {
      valueRefs.add(s.name);
    }
    stmtExprs(s).forEach(visitExpr);
    stmtChildren(s).forEach(visitStmt);
  };
  body.forEach(visitStmt);
  return [...valueRefs]
    .filter((n) => !called.has(n) && n !== selfName)
    .sort()
    .map((n) => ({ name: n, info: symbols.get(n)! }));
}
