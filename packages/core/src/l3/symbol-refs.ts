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
import type { IrType } from '../ir/types';
import { type AggregateLayout, type FnProto, type ParamType, type Prototypes, spellableProto } from '../proto';
import type { SymbolInfo } from '../symbols';
import type { TargetDescription } from '../target';
import { Expr, SFn, Stmt, exprChildren, mentionedName, stmtChildren, stmtExprs } from './ast';
import { pointerCellsOf, pointerPartners } from './ptrcell';

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
  /** The struct a call target returns through memory — a type the project's headers own
   *  (ir/types.ts `declared`), so `declare.ts` defines it beside `proto`, whose `returns` spells it:
   *  by its tag (`name`), from the members the declaration lists (`layout`, which the lift laid out
   *  to type the call). */
  returned?: { readonly name: string; readonly declared: string; readonly layout: AggregateLayout };
  /** The structs a call target is passed BY VALUE (`byValue` on the call), defined the same way
   *  from the declaration's `byValueLayouts`. */
  passed?: readonly { readonly name: string; readonly declared: string; readonly layout: AggregateLayout }[];
  /** A global the body passes BARE as a struct by value (`take(gS)`), as `struct <tag>`: a
   *  name-only declaration of it is that struct, which the call needs and an integer cell rejects. */
  passedAs?: string;
  /** The bare name holds a pointer (l3/ptrcell.ts): the body stores one into it, or it meets such a
   *  cell bare and nothing reads it as an integer (`pointerPartners`). A name-only declaration of it
   *  is a pointer, which the store needs and an integer cell rejects on CodeWarrior. */
  holdsPointer?: true;
  /** A call target with NO spellable prototype whose address a function-scope static's (or an
   *  anonymous image's) initializer holds. The static's `(u32)&F` precedes every call, so the
   *  implicit declaration a call makes comes too late for it; `declare.ts` prints that same
   *  declaration first, `int F();`, which states no parameter and so binds the call as before. */
  implicitCall?: true;
  /** THE STRUCT THE FUNCTION ITSELF RETURNS ({@link ownReturnDefinition}): a ref under the
   *  function's own name that declares nothing of it — its definition is its declaration — and only
   *  defines `returned`, the type its own signature spells. */
  definesReturn?: true;
}

/** The ref that defines the struct `tree` itself returns by value — a type the project's headers
 *  own (ir/types.ts `declared`), so the candidate's declarations define it as they define a
 *  callee's (`SymbolRef.returned`) — from the members its own declaration `own` lists. Undefined
 *  where it returns no such struct, or its declaration lists no members. */
export function ownReturnDefinition(tree: SFn, own: FnProto | undefined): SymbolRef | undefined {
  const t = tree.retType;
  const layout = own?.returnLayout;
  if (t.kind !== 'struct' || t.declared === undefined || layout?.members === undefined) {
    return undefined;
  }
  return {
    name: tree.name,
    info: { name: tree.name, kind: 'code' },
    returned: { name: t.name, declared: t.declared, layout },
    definesReturn: true,
  };
}

/** The declarable symbols a structured body references in a VALUE context — the input to the
 *  scoring layer's declaration synthesis. A name counts when it appears as a `var`/`addr` leaf
 *  and the caller's dictionary knows it (bare `gSym`, `&gSym`, `(u32)Func`, a `field` base — all reduce to
 *  those leaves). The function's OWN name
 *  (`tree.name`) is excluded too — the candidate's definition IS its declaration, and a
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
  tree: SFn,
  symbols: Map<string, SymbolInfo>,
  /** the project's prototype table — the only thing that can turn a call target into a
   *  declaration. REQUIRED, not optional: a caller that forgot it would silently get the old
   *  blanket refusal back, which is the shape of an optional refusal a second caller switches off. */
  prototypes: Prototypes,
  /** which declared types the frontend lays out, so which a printed prototype may carry */
  target: Pick<TargetDescription, 'doubleArgWords'>,
  onRefused?: (name: string, reason: 'call-target' | 'self-name') => void,
): SymbolRef[] {
  const called = new Set<string>();
  // the struct a callee returns through memory, as the lift typed it
  const returned = new Map<string, Extract<IrType, { kind: 'struct' }>>();
  // …and the structs it is passed by value, by declared parameter index
  const passedTo = new Map<string, Map<number, Extract<IrType, { kind: 'struct' }>>>();
  // …and the globals passed bare as one, by its spelling
  const passedAs = new Map<string, string>();
  const valueRefs = new Set<string>();
  const visitExpr = (e: Expr): void => {
    const named = mentionedName(e);
    if (e.k === 'call' && typeof e.fn === 'string') {
      called.add(e.fn);
      if (e.sret?.kind === 'struct') {
        returned.set(e.fn, e.sret);
      }
      for (const b of e.byValue ?? []) {
        if (b.type.kind === 'struct') {
          const params = passedTo.get(e.fn) ?? passedTo.set(e.fn, new Map()).get(e.fn)!;
          params.set(b.param, b.type);
          const arg = e.args[b.at];
          if (arg?.k === 'var' && symbols.has(arg.name)) {
            // by its tag, which declares even ahead of the definition and of a typedef of it
            passedAs.set(arg.name, `struct ${b.type.name}`);
          }
        }
      }
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
  tree.body.forEach(visitStmt);
  // A function-scope static's initializer names the globals whose addresses it holds
  // (`(u32)&MetatileBehavior_IsTallGrass`), which the candidate must declare as much as the body's —
  // and so does an anonymous image, which the emitter folds into a local's initializer.
  const initAddresses = new Set<string>();
  for (const st of [...(tree.statics ?? []), ...(tree.images ?? [])]) {
    for (const v of st.init ?? []) {
      if (v !== null && typeof v === 'object' && symbols.has(v.symbol)) {
        valueRefs.add(v.symbol);
        initAddresses.add(v.symbol);
      }
    }
  }
  const holdsPointer = new Set([...pointerCellsOf(tree), ...pointerPartners(tree)]);
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
    const p = Object.hasOwn(prototypes, n)
      ? spellableProto(prototypes[n], target, returned.get(n), new Set(passedTo.get(n)?.keys()))
      : undefined;
    if (p !== undefined) {
      proto.set(n, p);
    }
  }
  return [...new Set([...valueRefs, ...proto.keys()])]
    .sort()
    .filter((n) => {
      // …except where an initializer holds its address: there the name is spelled ahead of every
      // call, so leaving it to the call's implicit declaration leaves the initializer naming an
      // undeclared identifier, and the implicit declaration itself is the one that is printed
      // (`SymbolRef.implicitCall`).
      if (called.has(n) && !proto.has(n) && !initAddresses.has(n)) {
        onRefused?.(n, 'call-target');
        return false;
      }
      if (n === tree.name) {
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
      const r = p ? returned.get(n) : undefined;
      const layout = r?.declared !== undefined ? prototypes[n].returnLayout : undefined;
      const definition = layout?.members !== undefined ? { name: r!.name, declared: r!.declared!, layout } : undefined;
      const passed = p
        ? [...(passedTo.get(n) ?? [])].flatMap(([k, t]) => {
            const l = prototypes[n].byValueLayouts?.[k];
            return l?.members !== undefined && t.declared !== undefined
              ? [{ name: t.name, declared: t.declared, layout: l }]
              : [];
          })
        : [];
      return {
        name: n,
        info,
        ...(p ? { proto: p } : {}),
        ...(definition ? { returned: definition } : {}),
        ...(passed.length > 0 ? { passed } : {}),
        ...(passedAs.has(n) ? { passedAs: passedAs.get(n)! } : {}),
        ...(holdsPointer.has(n) ? { holdsPointer: true as const } : {}),
        ...(called.has(n) && !p ? { implicitCall: true as const } : {}),
      };
    });
}
