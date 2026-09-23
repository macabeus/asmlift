// asmlift — SELF-DECLARING CANDIDATES: the pure map-reference query
// (research/self-declaring-candidates-2026-07-26.md).
//
// `collectSymbolRefs` derives, from a FINAL structured tree, every DECLARABLE symbol the body
// references in a VALUE context — the input to the scoring layer's declaration synthesis
// (core declare.ts). "Declarable" and not "map-derived": the dictionary this is called with is
// the caller's, and rank.ts hands it a symbol map UNIONED with the names read straight out of
// the asm's own literal pool / relocations (`bareGlobalSymbols`), so a candidate compiled
// outside project headers declares what it spells even with no map at all. The map's facts win
// per NAME where it has them; the rest come back marked `synthesized`.
//
// It is a pure tree query with no pipeline state: the enumeration
// layer (rank.ts) calls it exactly once per candidate, on the tree the candidate's source was
// emitted from, at the moment the candidate is finalized. There is deliberately NO cached
// `symbolRefs` field on `SFn` — a carried field would oblige every future l3 pass to remember
// to recompute it (a dead-store DCE that drops a tree's only reference would otherwise leave a
// stale ref, transitively reintroducing the hazards the collector excludes). Deriving at the
// consumption point makes staleness impossible by construction.
import { type ParamType, type Prototypes, spellableProto } from '../proto';
import type { SymbolInfo } from '../symbols';
import { Expr, Stmt, exprChildren, mentionedName, stmtChildren, stmtExprs } from './ast';

/** One recorded VALUE reference — a name the tree references plus the facts to declare it. */
export interface SymbolRef {
  name: string;
  info: SymbolInfo;
  /** NAME-ONLY symbols (no map shape): the bare off-0 access facts observed in the candidate's
   *  own IR — attached by the enumeration (rank.ts bareGlobalAccessFacts), consumed by the
   *  declaration synthesis (declare.ts) as the width/signedness authority for `extern T name;`. */
  access?: { width: number; signed: boolean };
  /** NO SYMBOL MAP ACCOUNTS FOR THIS NAME — that is the whole predicate, and it is one fact with
   *  two provenances the consumer must be able to tell apart.
   *
   *  WITHOUT `proto`, the declaration is a HYPOTHESIS: the name and (through `access`) its width
   *  and signedness were read out of the candidate's own asm — the very bytes the candidate is
   *  then scored against. A fitted declaration cannot LOSE score, so it is not covered by
   *  declare.ts's only-loses-score argument; it can manufacture agreement instead. Which is
   *  legitimate (the artifact is decls + source, and it does compile to those bytes) exactly as
   *  long as the consumer SHOWS the declarations with the verdict.
   *
   *  WITH `proto`, the declaration's TEXT is the project's own — a call target asmlift has a
   *  prototype for — and asmlift invented nothing about it. It is still marked, because the
   *  predicate this flag states is about the symbol MAP and not about who wrote the type, and
   *  because the score rests on that line being in the translation unit either way. A consumer
   *  wording the block reads `proto` to say which it is looking at; dropping the mark instead
   *  would under-report a declaration the verdict depends on, which is the direction
   *  `synthesizedRefs` exists to avoid. */
  synthesized?: true;
  /** A CALL TARGET's own declaration, re-spelled from the prototype the project supplied — the
   *  parameter type texts and the return type text, verbatim as the user wrote them. Present only
   *  where {@link spellableProto} could read a COMPLETE C prototype out of the `FnProto`, and it
   *  is what `declare.ts` prints instead of an `extern`: a call target is a function, and
   *  `extern u32 llsrc;` is not a declaration of it. Absent where the symbol map calls the name
   *  something other than code — two facts that disagree are not one fact — and that subtraction
   *  happens at the table (`proto.ts` `prototypesFromSymbols`), so the frontend loses the same
   *  fact in the same place rather than acting on one this withheld. */
  proto?: { readonly params: readonly ParamType[]; readonly returns: ParamType };
}

/** The declarable symbols a structured body references in a VALUE context — the input to the
 *  scoring layer's declaration synthesis. A name counts when it appears as a `var`/`addr` leaf
 *  and the caller's dictionary knows it (bare `gSym`, `&gSym`, `(u32)Func`, a `field` base — all reduce to
 *  those leaves). The function's OWN name
 *  (`selfName`) is excluded too — the candidate's definition IS its declaration, and a
 *  synthesized `void F(void);` above `s32 F(...)` is a conflicting-types hard error (a
 *  self-address reference resolves against the definition itself).
 *
 *  A CALL TARGET IS DECLARED WHEN, AND ONLY WHEN, THE PROJECT DECLARED IT COMPLETELY. `void
 *  F(void);` hard-errors under gcc-2.9 the moment the call passes an argument, so with no arity
 *  knowledge the honest option is to leave the name undeclared and keep C's implicit-declaration
 *  behaviour — which is what this did for every call target and still does for every one the
 *  prototype table cannot spell. Where it CAN (`spellableProto`), that knowledge is exactly what
 *  the refusal said it lacked, and the declaration is the project's own text rather than a guess.
 *  It is needed: an implicit declaration is `int`, so `(s64)llsrc()` sign-extends a word and the
 *  candidate carries an `asr` the target does not have.
 *
 *  Both exclusions are REPORTED through `onRefused`, on the caller's own refusal channel: they
 *  leave a name undeclared for asmlift's own reason, and a consumer's list of those reasons is
 *  incomplete without them. */
export function collectSymbolRefs(
  body: Stmt[],
  symbols: Map<string, SymbolInfo>,
  selfName: string,
  /** the project's prototype table — the only thing that can turn a call target into a
   *  declaration. REQUIRED, not optional: a caller that forgot it would silently get the old
   *  blanket refusal back, which is the shape of an optional refusal a second caller switches off. */
  prototypes: Prototypes,
  onRefused?: (name: string, reason: 'call-target' | 'self-name') => void,
): SymbolRef[] {
  const called = new Set<string>();
  const valueRefs = new Set<string>();
  const visitExpr = (e: Expr): void => {
    const named = mentionedName(e);
    if (e.k === 'call') {
      called.add(e.fn);
    } else if (named !== undefined && symbols.has(named)) {
      valueRefs.add(named);
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
  // A call target is a ref in its own right, whether or not the body also names it as a value —
  // `Object.hasOwn`, because `prototypes` is caller-supplied JSON and a callee may be named
  // `toString`. The union is sorted as one list so the rendered block stays deterministic.
  const proto = new Map<string, NonNullable<SymbolRef['proto']>>();
  for (const n of called) {
    // TWO FACTS ABOUT ONE NAME, AND A DISAGREEMENT IS SILENCE — decided at the TABLE, not here. A
    // map entry that states a data shape for this name contradicts the prototype that calls it a
    // function, and `proto.ts` `prototypesFromSymbols` has already taken the `returns` off such an
    // entry, so what arrives here states no printable prototype and the frontend read the call the
    // same way. Testing it a second time at this reader is what let the two answer differently.
    const p = Object.hasOwn(prototypes, n) ? spellableProto(prototypes[n]) : undefined;
    if (p !== undefined) {
      proto.set(n, p);
    }
  }
  return [...new Set([...valueRefs, ...proto.keys()])]
    .sort()
    .filter((n) => {
      if (called.has(n) && !proto.has(n)) {
        onRefused?.(n, 'call-target');
        return false;
      }
      if (n === selfName) {
        onRefused?.(n, 'self-name');
        return false;
      }
      return true;
    })
    .map((n) => {
      const p = proto.get(n);
      // A call target the map never mentioned still has to carry an `info` — it is a code symbol
      // and that is all this knows about it. `declare.ts` prints the prototype and never reaches
      // the shape, so nothing here is guessed about storage that does not exist.
      const info = symbols.get(n) ?? { name: n, kind: 'code' as const };
      return { name: n, info, ...(p ? { proto: p } : {}) };
    });
}
