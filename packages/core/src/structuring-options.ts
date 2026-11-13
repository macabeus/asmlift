// asmlift — the options a lift hands the structurer, built in ONE place.
//
// Four sites structure a recovered function for output: pipeline.ts `decompile`, rank.ts
// `enumerateCandidates`, trace.ts `decompileTraced` and the cli's report.ts score probe. Each
// spread the same inputs together by hand, and a structuring input added at one site had to be
// mirrored at the other three. They now call `structuringOptions`, which spreads them in one fixed
// order; each site passes only what it sets and says at the call why the rest is omitted.
//
// The spread order below is the one every site used before this module: the target's behaviours,
// the backend's spellings, the forced readings, the gap policy, then the symbol facts. A later
// spread wins over an earlier one with the same key, so moving an input changes which value a
// shared key ends with. A site that sets more (rank.ts's per-candidate settings) spreads this
// object first and its own keys after it.
import { aggregateTag, aggregateType } from './aggregate';
import type { IrType } from './ir/types';
import type { LanguageBackend } from './l3/ast';
import { type FnProto, type Prototypes, declaresVoidReturn } from './proto';
import { type ContextGlobals, ownParamNames } from './proto-context';
import type { StructureOptions } from './structure/structure-options';
import type { SymbolInfo } from './symbols';
import { type TargetDescription, structureOptionsFor } from './target';

/** What `structuringOptions` reads. Every optional input is left out of the result when it is
 *  absent, false or empty, exactly as each site's `...(x ? { x } : {})` spread did. */
export interface StructuringInputs {
  target: TargetDescription;
  /** The function being lifted: its own entries in `prototypes` and `ownContextProto` are what
   *  its printed parameter names are derived from (see `ownContextProto`). */
  name: string;
  /** The function's own declared return (`declaresVoidReturn`), from the caller's table. */
  returnsVoid: boolean;
  /** The prototype table the target's declared argument and return types are read from. */
  prototypes: Prototypes;
  /** What the emitted language can print is a structuring input: a backend that cannot spell
   *  switch fall-through, a switch `break` or an early `return` must not be handed a tree carrying
   *  one, because its refusal costs the whole lift (or candidate). */
  backend: LanguageBackend;
  /** Force the return-tail copies (pipeline.ts `DecompileOptions.copyReturnTails`). */
  copyReturnTails?: boolean;
  /** Force the join past early returns (pipeline.ts `DecompileOptions.joinPastReturns`). */
  joinPastReturns?: boolean;
  /** The gap policy. Absent leaves structure()'s own default, 'strict'. */
  onGap?: StructureOptions['onGap'];
  /** The project's symbol map, by name (`symbolsByName`). */
  symbols?: Map<string, SymbolInfo>;
  contextGlobals?: ContextGlobals;
  /** The array shapes this function's own assembly evidences (raise/globalshape.ts). */
  inferredSymbols?: Map<string, SymbolInfo>;
  /** The order half of the same reading (raise/globalshape.ts `orderLicensedGlobals`). */
  orderLicensedGlobals?: ReadonlySet<string>;
  /** The context's own declaration of `name`, split out of the table (proto-context.ts
   *  `splitOwnContext`). Read here for the printed names only: the parameter names
   *  (`SFn.paramNames`, from `ownParamNames` over `prototypes` and this entry) and whether either
   *  entry declares a void return (`SFn.declaredVoid`; a stated entry carries the context's void as
   *  `FnProto.declaredVoid`, proto-context.ts `withOwnDeclaredVoid`), both derived here and at no call site, so
   *  they are read off the same merged table the structuring reads. */
  ownContextProto?: FnProto;
  /** Print loop counters and the returned local under role names (`SFn.roleNames`). */
  roleNames?: boolean;
}

/** The structurer's options for one lift: `structureOptionsFor` (the target's compiler behaviours,
 *  `returnsVoid` and the declared types), then the backend's spellings, then each optional input
 *  that is present. */
export function structuringOptions(inputs: StructuringInputs): StructureOptions & { joinPastReturns?: boolean } {
  const { target, returnsVoid, prototypes, backend, name, ownContextProto } = inputs;
  const paramNames = ownParamNames(prototypes, name, target, ownContextProto);
  const stated = Object.hasOwn(prototypes, name) ? prototypes[name] : undefined;
  return {
    ...structureOptionsFor(target, returnsVoid, prototypes),
    spellSwitchFallthrough: backend.spellsSwitchFallthrough,
    spellSwitchBreak: backend.spellsSwitchBreak,
    spellEarlyReturns: backend.spellsEarlyReturn,
    ...(inputs.copyReturnTails ? { copyReturnTails: true } : {}),
    ...(inputs.joinPastReturns ? { joinPastReturns: true } : {}),
    ...(inputs.onGap !== undefined ? { onGap: inputs.onGap } : {}),
    ...(inputs.symbols ? { symbols: inputs.symbols } : {}),
    ...(inputs.contextGlobals ? { contextGlobals: inputs.contextGlobals } : {}),
    ...contextArrayElementsOf(inputs.contextGlobals, target),
    ...(inputs.inferredSymbols?.size ? { inferredSymbols: inputs.inferredSymbols } : {}),
    ...(inputs.orderLicensedGlobals?.size ? { orderLicensedGlobals: inputs.orderLicensedGlobals } : {}),
    ...(paramNames?.length ? { paramNames } : {}),
    ...(inputs.roleNames ? { roleNames: true } : {}),
    // read by the role names alone, so carried only beside them: the context's own entry does not
    // bound the lift's return, so a function it declares void may still be lifted returning a value
    ...(inputs.roleNames &&
    (declaresVoidReturn(stated) || stated?.declaredVoid === true || declaresVoidReturn(ownContextProto))
      ? { declaredVoid: true }
      : {}),
  };
}

/** Each struct array the context declares, its element laid out on `target`
 *  (`StructureOptions.contextArrayElements`), memoised per context and target: every lift site calls
 *  the builder, and a project context declares hundreds of arrays. Empty spreads
 *  nothing, so a lift with no such array gets the options it had. None on a target whose subscript
 *  of a declared array is not shown to be another object than the cast's (`arrayShapeFromStride`):
 *  the declared spelling is measured on agbcc alone. */
const ELEMENTS = new WeakMap<
  ContextGlobals,
  Map<TargetDescription, ReadonlyMap<string, { readonly type: IrType; readonly rank: number }>>
>();
function contextArrayElementsOf(
  context: ContextGlobals | undefined,
  target: TargetDescription,
): Pick<StructureOptions, 'contextArrayElements'> {
  if (
    context?.arrayElements === undefined ||
    context.arrayElements.size === 0 ||
    target.compilerBehaviors.arrayShapeFromStride !== true
  ) {
    return {};
  }
  let perTarget = ELEMENTS.get(context);
  if (perTarget === undefined) {
    perTarget = new Map();
    ELEMENTS.set(context, perTarget);
  }
  let laid = perTarget.get(target);
  if (laid === undefined) {
    const out = new Map<string, { readonly type: IrType; readonly rank: number }>();
    for (const [name, el] of context.arrayElements) {
      // the element's own qualifiers are the array's (`volatile` reaches the gate through
      // `contextGlobals.volatiles`), not part of the struct's name
      const named = aggregateTag(el.spelling);
      const type = named === undefined ? undefined : aggregateType(named.tag, named.spelling, el.layout, target);
      if (type?.kind === 'struct' && type.size !== undefined && type.size > 0) {
        out.set(name, { type, rank: el.dims.length });
      }
    }
    laid = out;
    perTarget.set(target, laid);
  }
  return laid.size > 0 ? { contextArrayElements: laid } : {};
}
