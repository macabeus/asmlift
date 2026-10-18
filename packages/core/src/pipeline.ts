// asmlift — the library entry point. `decompile(name, asm, target)` runs the raising tower and
// returns structured results: the source, the per-level IR dumps, and diagnostics.
import { aggregateSize, ownArgumentWordsOn, returnedAggregate, returnsInMemory } from './aggregate';
import { cBackend } from './backend/c';
import {
  ContractError,
  assertDerefsTyped,
  assertEffectsPreserved,
  assertFrameUnionsViewed,
  assertLocalsWritten,
  assertPostIncrUnshared,
  assertResolved,
  assertTypesRecovered,
} from './contracts';
import type { AsmData } from './frontend/asmdata';
import { returnedStruct, structLocalType } from './frontend/call-plan';
import { FrontendUnsupportedError } from './frontend/errors';
import type { LiftOptions } from './frontend/frontend';
import { liftOwnRegisterStruct, liftOwnStructReturn } from './frontend/own-struct-return';
import { frontendFor } from './frontend/registry';
import { ABSORBED_KEYS, HOMED_UNDEF } from './frontend/ssa';
import { type Fn, reachableBlocks } from './ir/core';
import { deadOps } from './ir/discipline';
import { print } from './ir/print';
import { firstTrivialPhi } from './ir/simplify';
import { type IrType, T, intWidth } from './ir/types';
import { VerifyError, verify } from './ir/verify';
import { LanguageBackend, SFn, gapReasonFor, walkExprs } from './l3/ast';
import { BASECSE_GATES, hoistBaseLocals } from './l3/basecse';
import { eliminateDeadStores } from './l3/dce';
import { mergeCommonTails } from './l3/tailmerge';
import { dropUnspelledReturns } from './l3/tailret';
import { DEFAULT_IDIOM_PATTERNS, RewritePattern, applyPattern, dce, patternApplies } from './pattern/engine';
import {
  type FnProto,
  type Prototypes,
  declaresAggregateReturn,
  declaresVoidReturn,
  ownReturnWidth,
  prototypesFromSymbols,
} from './proto';
import { type ContextGlobals, splitOwnContext } from './proto-context';
import { type StampBehaviors, stampDeclaredVolatileUnder } from './raise/declared-volatile';
import { RaiseUnsupportedError } from './raise/errors';
import { assumedShapes, inferGlobalArrays, orderLicensedGlobals } from './raise/globalshape';
import { OFFSET_NAME_PASS } from './raise/offsetnames';
import { type PreRecoveryOptions, type PreRecoveryPass, runPreRecovery } from './raise/pre-recovery';
import { PRE_STRUCTURE_FOLDS, type PreStructureFold } from './raise/pre-structure';
import { recoverTypes } from './raise/recover';
import { sinkReturns } from './raise/retsink';
import { StructureError, structure } from './structure/structure';
import { type SymbolInfo, type SymbolMap, symbolsByName } from './symbols';
import { type TargetDescription, structureOptionsFor } from './target';

/** How a gap (a construct asmlift cannot faithfully model) degrades:
 *    "strict"   — throw / `"?"`-sentinel → ContractError. Loud in the PROCESS. The default, and
 *                 what every contract/loud-fail test pins: asmlift knows when it doesn't know.
 *    "annotate" — always emit SOMETHING (the m2c usefulness property), but every gap is loud in
 *                 the ARTIFACT: a localizable gap becomes an undefined ASMLIFT_ERROR("reason", …)
 *                 marker inline; a non-localizable failure (unliftable control flow, a broken
 *                 invariant) degrades to a stub carrying the reason + the original asm as a
 *                 comment. Either way the source cannot compile un-acknowledged, and the gaps are
 *                 ALSO returned as structured `diagnostics` for the harness / self-improve loop. */
export type OnGap = 'strict' | 'annotate';

/** One machine-readable gap: which stage declined and why. The comments/markers in the emitted
 *  source are the human projection of these entries — a tool should read THIS, not parse text. */
export interface Diagnostic {
  stage: 'lift' | 'raise' | 'structure' | 'contract' | 'verify' | 'internal';
  reason: string;
}

export interface DecompileOptions {
  backend?: LanguageBackend;
  /** idiom patterns applied at L1. DEFAULTS to `DEFAULT_IDIOM_PATTERNS` (every idiom asmlift
   *  owns, each `{compilers}`-gated so it self-selects per target). Pass an explicit list to
   *  override, or `[]` to run the naive lift with no idiom folding. */
  patterns?: RewritePattern[];
  /** function prototypes from the project's headers, keyed by symbol: a callee's `params`
   *  drives its `bl` argument recovery; the current function's own entry supplies its
   *  `returnsVoid`. One table, resolved at the point of use (see proto.ts). */
  prototypes?: Prototypes;
  /** OPTIONAL Regime-B side-table (data-section jump tables + relocations). Absent ⇒ a dense
   *  MIPS/PPC switch declines/loud-fails; present ⇒ the frontend recovers the `switch_br`.
   *  Produced by `extractAsmData(obj, target)` from the scoring object. */
  asmData?: AsmData;
  /** OPTIONAL address→symbol map (symbols.ts) — the project's own names (ELF symtab) and
   *  declaration shapes (DWARF types-sidecar). Drives the Thumb numeric-pool promotion and the
   *  byte-sensitive global spellings. Absent ⇒ byte-identical to today. */
  symbols?: SymbolMap;
  /** what the project's declaration context states about its globals (proto-context.ts
   *  `globalsFromContext`): no aggregate is spelled as a bare scalar name, and every access to a
   *  volatile object the map does not lay out, or through a pointer to one, is stamped
   *  (raise/declared-volatile.ts), so the cast it is read through carries the qualifier. */
  contextGlobals?: ContextGlobals;
  /** the declaration context's own entry for `name` (proto-context.ts `ownContextEntry`), which
   *  bounds the argument registers SOFTLY where `prototypes` states no entry for it, and whose
   *  struct return, where it declares one, is lifted where the machine proves it (`liftStamped`);
   *  absent ⇒ nothing bounds them softly. A `prototypes` entry for `name` marked
   *  `fromContext` is read as this, and taken out of the table (proto-context.ts
   *  `splitOwnContext`). */
  ownContextProto?: FnProto;
  /** gap policy — see `OnGap`. Default "strict". */
  onGap?: OnGap;
}

export interface DecompileResult {
  source: string;
  sfn: SFn;
  ir: { raw: string; folded: string; recovered: string }; // IR dumps: post-lift, post-idiom, post-recovery
  patternHits: number;
  /** structured gap list — ALWAYS present. Non-empty ⇔ the source contains ASMLIFT_ERROR markers /
   *  a stub and will NOT compile until the user acts (the loud-in-artifact contract).
   *
   *  EMPTY IS THE ABSENCE OF A GAP, NOT A PROMISE THAT THE C COMPILES. A candidate can also fail
   *  on a symbol the caller never declared, which is a CONTEXT question the benchmark answers by
   *  escalating to the vendored preprocessed context. Most such names survive K&R implicit
   *  declaration; a function ADDRESS does not, and klonoa's `UpdateStageSelectScreen` reports 0
   *  gaps while emitting `((s32 *)50345232)[1] = &HandlePauseMenuInput;`, which agbcc rejects
   *  where the plain call above it passes with a warning. Declaring an address-taken unknown
   *  callee would close it — an emitter change, moving source bytes on every row that has one. */
  diagnostics: Diagnostic[];
  /** THE SHAPES THIS SOURCE'S SPELLING ASSUMES, which no symbol map supplied (raise/globalshape.ts).
   *
   *  Everything else a backend emits is byte-correct under ANY declaration of the names it spells
   *  — that is exactly why `((T *)&gSym)[i]` is the fallback (structure/globalaccess.ts). A bare
   *  `gSym[i]` is not: it means what the DECLARATION of `gSym` says it means, and where that
   *  declaration was derived from the assembly rather than read from the project's map, the
   *  emitted source is right about the target's bytes only beside the declaration derived with it.
   *  The element SIGNEDNESS is the sharp case, and it is an assumption rather than a reading:
   *  compiled through the benchmark's own agbcc command, `(u16)gS[i]` over `extern const s16 gS[]`
   *  and `gS[i]` over `extern const u16 gS[]` are the SAME OBJECT, so the assembly cannot say which
   *  the source wrote — asmlift picks the one its own declaration block states.
   *
   *  So this travels with the source on every path that can emit it: the scoring layer renders it
   *  (declare.ts, and main.ts's `[declared]` block), and a caller that shows the source alone must
   *  show these too, or it is publishing a spelling whose meaning it has not stated. Empty on every
   *  run that assumed nothing — which includes every derived shape the structurer did not spell
   *  bare, and every name the caller's own map described (raise/globalshape.ts `assumedShapes`
   *  computes that narrowing and names the corpus row behind each half). */
  assumedSymbols: SymbolInfo[];
  /** THE NAMES THIS SOURCE REACHED BY ARITHMETIC, not by the map alone (raise/offsetnames.ts).
   *  A pool-loaded `gaddr` is the map answering about an address the machine code carries; a
   *  walked one is asmlift computing `addr(base) + K` and asking about THAT — so the base's own
   *  address in the map is load-bearing for a name the reader sees spelled bare. Sibling of
   *  `assumedSymbols` and reported beside it (`main.ts`'s `[walked]` block, the trace's
   *  `stage:offsetnames`), and it is also the only thing in a result that says a walk spelling
   *  stopped being enumerable here. Empty on every run with no symbol map. */
  walkedNames: string[];
  /** WHERE THE LIFT WENT PAST ITS CONTEXT DECLARATION (`liftStamped`'s `[own-arity]` notes): each
   *  names the declaration and either the argument registers the body reads past it, kept as
   *  parameters, or the refusal that made the lift drop the bound. A note is no gap, but the
   *  parameter list printed contradicts the header, which every compiler here rejects as
   *  conflicting types. Empty where no context entry was handed over, or where the lift stayed
   *  within it. */
  ownArityNotes: string[];
}

export function decompile(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: DecompileOptions = {},
): DecompileResult {
  const onGap = opts.onGap ?? 'strict';
  if (onGap === 'strict') {
    return runTower(name, asm, target, opts, 'strict');
  }
  try {
    return runTower(name, asm, target, opts, 'annotate');
  } catch (e) {
    // A NON-localizable failure (unliftable control transfer, frame model, a broken internal
    // invariant): there is no line to mark, so degrade to a stub — the failure reason + the
    // original asm as comments, and one ASMLIFT_ERROR marker so the file stays uncompilable
    // un-acknowledged. The user/LLM gets the raw material to finish by hand instead of a throw.
    return stubResult(name, asm, opts.backend ?? cBackend, e);
  }
}

function runTower(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: DecompileOptions,
  onGap: OnGap,
): DecompileResult {
  const backend = opts.backend ?? cBackend;
  // The project's own DWARF signatures fill in what the caller did not state — in practice the
  // CALLEES (a function still in assembly has none), which is what makes this transferable.
  const own = splitOwnContext(opts.prototypes, name, opts.ownContextProto);
  const prototypes = prototypesFromSymbols(opts.symbols, own.prototypes ?? {});
  // (1) lift: ISA frontend (resolved by target) → L1 with block-argument SSA
  const ownArityNotes: string[] = [];
  const fn = liftStamped(
    name,
    asm,
    target,
    prototypes,
    opts.asmData,
    opts.symbols,
    opts.contextGlobals,
    undefined,
    own.ownContextProto,
    ownArityNotes,
  );
  // Every dump carries the write-order record (ir/print.ts `PrintOptions`): it decides the
  // edge-copy order and the raising folds mutate it, so two dumps compare whole program states.
  const raw = print(fn, { writeOrder: true });
  // (1.5) the ARRAY SHAPES this function's own assembly evidences, for globals the project map
  // does not describe. Read HERE, off the lifted fn, because the fact it needs — whether the base
  // was materialized before the index was scaled — is destroyed by the raising tower below
  // (raise/globalshape.ts's module note). Empty unless the target opts in.
  const inferredSymbols = inferGlobalArrays(fn, target);
  // …and the ORDER half of the same reading, which reaches names the shape derivation refuses (a
  // struct element among them). Read off the same lifted fn, for the same reason.
  const orderLicensed = orderLicensedGlobals(fn, target);
  // (1.6) …and the NAMES the map holds for the addresses this function's machine code built by
  // arithmetic off a named one (raise/offsetnames.ts). After the two readings above, which are
  // about the lift as the frontend emitted it; before everything below, so the whole raising
  // tower sees a walked-to cell as the named global it is.
  //
  // The two readings therefore attribute a walked access to the base rather than to the name this
  // pass gives it, and that costs nothing either way: a SHAPE is a declaration, so a name the map
  // describes — which every base here is, or the pass could not have fired — is dropped from
  // `inferredSymbols`, and the ORDER licence only enables a cast spelling that is byte-correct
  // under any declaration. Measured: with this call moved ABOVE both readings, the three corpus
  // rows the pass fires on keep their fan size, their winner and their score exactly.
  const walkedNames = opts.symbols
    ? OFFSET_NAME_PASS.run(fn, opts.symbols, stampBehaviorsFor(target, opts.contextGlobals))
    : [];

  // (2) idiom fold: apply serializable patterns on the IR (the AI-improvement surface),
  // gated generically by the Target's capabilities (not an `arch ==` branch).
  const patternHits = applyIdiomPatterns(fn, target, opts.patterns);
  const folded = print(fn, { writeOrder: true });

  // (2.35–3.5) pre-recovery recognizers → type recovery → return-sinking, the ONE shared spine
  // (`raiseRecovered`) that trace.ts and the cli's rank.ts/report.ts also run.
  raiseRecovered(fn, target, {}, prototypes[name]);
  const recovered = print(fn, { writeOrder: true });

  // (4) structure: IR → neutral AST; boundary contract: no unresolved value leaked (strict), or
  // every unresolved value spelled as a loud ASMLIFT_ERROR marker (annotate).
  const mapSymbols = opts.symbols ? symbolsByName(opts.symbols) : undefined;
  const sfn = structureChecked(fn, {
    ...structureOptionsFor(target, declaresVoidReturn(prototypes[name]), prototypes),
    // What the EMITTED LANGUAGE can say is a structuring input wherever two recoveries of one
    // shape are behaviourally identical and only one of them is printable (switch fall-through
    // vs plain if-nesting): recovery must not mint a tree this backend would refuse.
    spellSwitchFallthrough: backend.spellsSwitchFallthrough,
    onGap,
    ...(mapSymbols ? { symbols: mapSymbols } : {}),
    ...(opts.contextGlobals ? { contextGlobals: opts.contextGlobals } : {}),
    ...(inferredSymbols.size ? { inferredSymbols } : {}),
    ...(orderLicensed.size ? { orderLicensedGlobals: orderLicensed } : {}),
  });

  // (5) lower + print: neutral AST → target language
  const source = backend.emit(sfn);

  return {
    source,
    sfn,
    ir: { raw, folded, recovered },
    patternHits,
    diagnostics: collectMarkers(sfn),
    // WHAT THE SOURCE RESTS ON, not what the derivation found: a shape the structurer did not
    // spell bare, and a name the caller's own map described, are both obligations this reader
    // does not have (raise/globalshape.ts `assumedShapes`).
    assumedSymbols: assumedShapes(inferredSymbols, sfn, mapSymbols),
    walkedNames,
    ownArityNotes,
  };
}

/** The `[own-arity]` notes (`DecompileResult.ownArityNotes`) of one lift under `opts`, for a caller
 *  whose result carries none — the ranked path, whose every candidate lifts as this one does. Empty
 *  where the lift fails: the run reports that failure itself. */
export function ownArityNotesOf(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: Pick<DecompileOptions, 'prototypes' | 'asmData' | 'symbols' | 'contextGlobals' | 'ownContextProto'>,
): string[] {
  const own = splitOwnContext(opts.prototypes, name, opts.ownContextProto);
  if (own.ownContextProto === undefined) {
    return [];
  }
  const notes: string[] = [];
  try {
    liftStamped(
      name,
      asm,
      target,
      prototypesFromSymbols(opts.symbols, own.prototypes ?? {}),
      opts.asmData,
      opts.symbols,
      opts.contextGlobals,
      undefined,
      own.ownContextProto,
      notes,
    );
  } catch {
    return [];
  }
  return notes;
}

/** What the declared-volatile stamp reads besides the IR and the map: the compiler's fact and the
 *  declaration context's globals. Every stamp a driver puts reads the same two. */
export function stampBehaviorsFor(
  target: TargetDescription,
  contextGlobals: ContextGlobals | undefined,
): StampBehaviors {
  return {
    volatileReadsExtendInRegister: target.compilerBehaviors.volatileReadsExtendInRegister,
    contextGlobals,
  };
}

/** Stage 1 — lift: the target's ISA frontend → L1, verified, with every read of an object
 *  `symbols` or `contextGlobals` declares volatile stamped `declared` (raise/declared-volatile.ts)
 *  before any pass asks whether it may be deleted. Every entry path lifts through here, each lift
 *  under the map its structuring will be handed, and each bounded by the context's own entry
 *  (`ownContext`) the same way (`liftWithinContextBound`); `notes` collects that bound's
 *  `[own-arity]` notes. */
export function liftStamped(
  name: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  asmData: AsmData | undefined,
  symbols: SymbolMap | undefined,
  contextGlobals: ContextGlobals | undefined,
  liftOptions?: LiftOptions,
  ownContext?: FnProto,
  notes?: string[],
): Fn {
  // Its callers split the table already; split again here, where every lift passes, so that no
  // frontend is handed a marked context entry to read as a stated, hard bound.
  const split = splitOwnContext(prototypes, name, ownContext);
  const table = split.prototypes ?? {};
  const own = Object.hasOwn(table, name) ? table[name] : undefined;
  const ownReturn = ownStructReturnThroughMemory(name, target, own, split.ownContextProto, notes);
  // a refusal about the return's width that the declared struct explains waits for the proof
  let deferred: ((unproved: string) => never) | undefined;
  const bytes = ownReturn?.register === true ? undefined : ownReturn?.type.size;
  const fn = liftWithinContextBound(
    name,
    asm,
    target,
    table,
    asmData,
    symbols,
    contextGlobals,
    bytes === undefined
      ? liftOptions
      : { ...liftOptions, ownMemoryReturn: { bytes, defer: (refuse) => void (deferred ??= refuse) } },
    split.ownContextProto,
    notes,
  );
  verify(fn);
  if (ownReturn !== undefined) {
    returnOwnStruct(fn, name, target, ownReturn, notes, deferred);
    verify(fn);
  }
  refuseNarrowReturnsOfWideDeclaration(fn, name, own);
  stampDeclaredVolatileUnder(fn, symbols, stampBehaviorsFor(target, contextGlobals));
  return fn;
}

/** THE CONTEXT'S OWN ENTRY BOUNDS THE ARGUMENT REGISTERS, SOFTLY: an argument register past the
 *  words it fills (`ownArgumentWordsOn`, the layout a stated entry gets) is lifted as an uninitialised
 *  local's home, and where the finished lift still READS one, the function is lifted again with
 *  the bound raised past it, so that register stays the parameter a context-less lift makes it,
 *  with an `[own-arity]` note naming the declaration and the register.
 *
 *  WHY SOFT, where a stated entry is hard. A header entry for a function still in assembly was
 *  written with no compiler checking it against a definition, and the two directions of its error
 *  cost differently. Too long, it only keeps a parameter. Too short, a hard bound turns a real
 *  argument into `uninit_<reg>`, which compiles silently: sbk2's task callbacks are declared
 *  `void f(void);` ahead of a definition that reads `a0`, 407 of 525 such headers were short when
 *  their functions were decompiled, and a hard bound lifted 16 of 33 sampled ones as `s32
 *  uninit_a0; … memcpy(uninit_a0 + 28, …)`. Kept as a parameter instead, the lift is the right
 *  function and contradicts the header, which every compiler here rejects as conflicting types —
 *  loud — and the note says which register. What the bound buys is the other direction: a
 *  register nothing in the lift reads is no parameter (sa3's `void Task_802F698(void)` lifted
 *  `(s32 a0, s32 a1, s32 a2, s32 a3)`).
 *
 *  "READS" MEANS THE FINISHED LIFT, not the SSA builder. A register is read as the argument of a
 *  call whose arity was guessed, and the guess then trims it (`k4(a, b, 2, 0); zq(a); sl();` reads
 *  a2/a3 as `zq`'s and `sl`'s possible arguments); so the test is that an undefined value of a
 *  dropped register survives into the lift — an `undef` keyed by it, or by a join that took it,
 *  that `dce` would not delete, or one the machine homes to a slot nothing reads
 *  (`readDroppedArgRegs`). A read the raising tower would delete later still counts: that only
 *  keeps the parameter.
 *
 *  A LIFT THAT REFUSES WITHIN THE BOUND IS LIFTED WITHOUT IT, with a note, so the bound turns no
 *  lift into a decline. The one refusal it adds is a stated entry's (frontend/ssa.ts
 *  `LiveInModel.ownArgWords`): an incoming stack argument past it, which no local can be, and which,
 *  named by position past the registers the bound dropped, would be one slot low. A stated entry for
 *  `name` — `prototypes`, which includes what the symbol map derives — wins, and the context's is
 *  not read. */
function liftWithinContextBound(
  name: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  asmData: AsmData | undefined,
  symbols: SymbolMap | undefined,
  contextGlobals: ContextGlobals | undefined,
  liftOptions: LiftOptions | undefined,
  ownContext: FnProto | undefined,
  notes: string[] | undefined,
): Fn {
  const frontend = frontendFor(target);
  const unbounded = () =>
    forgetAbsorbedKeys(frontend.lift(name, asm, target, prototypes, asmData, symbols, contextGlobals, liftOptions));
  let words =
    ownContext === undefined || Object.hasOwn(prototypes, name)
      ? undefined
      : ownArgumentWordsOn(name, ownContext, target);
  if (words === undefined || words >= target.argRegs.length) {
    return unbounded();
  }
  const declared = spelledDeclaration(name, ownContext!);
  for (;;) {
    let fn: Fn;
    try {
      fn = frontend.lift(name, asm, target, prototypes, asmData, symbols, contextGlobals, {
        ...liftOptions,
        contextOwnWords: words,
      });
    } catch (e) {
      if (!(e instanceof FrontendUnsupportedError)) {
        throw e;
      }
      const lifted = unbounded();
      notes?.push(
        `${name}: lifted without its context declaration \`${declared}\`, which it could not be lifted within ` +
          `(${e.message.split('\n')[0]})`,
      );
      return lifted;
    }
    const read = readDroppedArgRegs(fn, target.argRegs.slice(words));
    if (read.length === 0) {
      return forgetAbsorbedKeys(fn);
    }
    notes?.push(
      `${name}: its context declaration \`${declared}\` fills ${words} argument word${words === 1 ? '' : 's'}, ` +
        `and the body reads ${read.join(', ')} past ${words === 1 ? 'it' : 'them'} — kept as ` +
        `${read.length === 1 ? 'a parameter' : 'parameters'}, which the header contradicts`,
    );
    words = Math.max(...read.map((r) => target.argRegs.indexOf(r))) + 1;
    if (words >= target.argRegs.length) {
      return unbounded();
    }
  }
}

/** The dropped argument registers whose undefined value the lift still reads: an `undef` keyed by
 *  one, or that absorbed one when its join collapsed (frontend/ssa.ts `ABSORBED_KEYS`), which is
 *  not dead (`deadOps`, the definition `dce` deletes by) or which the machine stored to a slot
 *  nothing reads back (`HOMED_UNDEF`). That store reaches no op, and it is still a read: IDO -g3 and
 *  -O0 home every argument register the definition declares, so a header naming fewer contradicts
 *  the asm, and the main lift's `(a0, a1)` is the one that recompiles to the same words. */
function readDroppedArgRegs(fn: Fn, dropped: readonly string[]): string[] {
  const dead = deadOps(fn.blocks);
  const read = new Set<string>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'undef' && (!dead.has(op) || op.attrs[HOMED_UNDEF] === true)) {
        for (const k of [String(op.attrs.key), ...String(op.attrs[ABSORBED_KEYS] ?? '').split(',')]) {
          read.add(k);
        }
      }
    }
  }
  return dropped.filter((r) => read.has(r));
}

/** `fn` with no `undef` carrying `ABSORBED_KEYS` or `HOMED_UNDEF`, which nothing past the own-entry
 *  bound reads. */
function forgetAbsorbedKeys(fn: Fn): Fn {
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'undef') {
        delete op.attrs[ABSORBED_KEYS];
        delete op.attrs[HOMED_UNDEF];
      }
    }
  }
  return fn;
}

/** A declaration as a note spells it: `int f(short, int)`, `void f(void)`, `int f(int, ...)`, and
 *  `int f()` for one that states no parameters. */
function spelledDeclaration(name: string, p: FnProto): string {
  const ret = p.returns ?? (p.returnsVoid === true ? 'void' : 'int');
  const params =
    p.variadicParams !== undefined
      ? [...p.variadicParams, '...'].join(', ')
      : Array.isArray(p.params)
        ? p.params.length > 0
          ? p.params.join(', ')
          : 'void'
        : '';
  return `${ret} ${name}(${params})`;
}

/** A FUNCTION THAT ITSELF RETURNS A STRUCT BY VALUE, as its declaration says: a stated entry for
 *  `name` (`own`), or else the context's own entry (`ownContext`, proto-context.ts
 *  `ownContextEntry`). Where its target's rule (`returnsInMemory`) returns the struct through
 *  memory, its caller hands it the storage in the first argument register, so its declared
 *  parameters sit one register up, and the lift is the pointer function `s32 *f(s32 *a0, s32 a1)`
 *  until `returnOwnStruct` proves that pointer is the storage and lifts the struct return the
 *  declaration names. This answers what that proof is handed — the struct laid out, and which
 *  declaration said so — and refuses, before any frontend runs, where no lift can be the declared
 *  function:
 *   - a struct the rule hands back in two registers (mwcc's svr4 eight-byte struct in r3:r4): the
 *     lift returns one word, and would drop the second register — on both declarations, since a
 *     context's header that says so is the only thing that says the second register is live;
 *   - a stated declaration whose struct the rule cannot place, because the target states no rule
 *     or nothing lays the struct out, or that names no type a local can be declared with. A context
 *     entry that cannot be placed keeps the pointer lift, with a note in `notes`: what it costs is
 *     a signature the header contradicts, which the compiler rejects.
 *  A struct the rule hands back in one register (agbcc's and mwcc's one-word struct in r0/r3) is
 *  that register's word: the plan says so (`register`), and a struct that is all one word-wide
 *  integer member is spelled as that member (frontend/own-struct-return.ts
 *  `liftOwnRegisterStruct`), where any other one stays the word the lift returns, with a note in
 *  `notes` saying why (`returnOwnStruct`). */
function ownStructReturnThroughMemory(
  name: string,
  target: TargetDescription,
  own: FnProto | undefined,
  ownContext: FnProto | undefined,
  notes: string[] | undefined,
): OwnStructReturn | undefined {
  const stated = own !== undefined;
  const declared = stated ? own : ownContext;
  if (!declaresAggregateReturn(declared)) {
    return undefined;
  }
  const spelled = declared!.returns ?? 'a struct or union';
  const read = returnedStruct(declared!, target);
  if (read === 'register') {
    // A struct wider than a word that comes back in registers is a pair the lift returns one word
    // of, dropping the second register; one of a word or less is that word
    const size = aggregateSize(returnedAggregate(declared!), target)?.size;
    if (size !== undefined && size <= 4) {
      const type = structLocalType(declared!, target);
      return 'refused' in type
        ? undefined
        : { type, stated, declaration: spelledDeclaration(name, declared!), register: true };
    }
    if (size !== undefined) {
      const pair =
        `this target hands its ${size} bytes back in two registers — a function that itself returns a struct ` +
        'in a register pair is not modelled';
      if (stated) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': it is declared to return ${spelled} by value, and ${pair}`,
        );
      }
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': its context declaration says it returns ${spelled} by value, and ${pair} ` +
          `(\`${spelledDeclaration(name, declared!)}\`)`,
      );
    }
    return undefined;
  }
  if ('refused' in read) {
    const how =
      returnsInMemory(returnedAggregate(declared!), target) === true
        ? `this target returns that through a hidden pointer in ${target.argRegs[0]}, and ${read.refused}`
        : target.compilerBehaviors.aggregateReturn === undefined
          ? `nothing here says whether this target returns it through a hidden pointer in ${target.argRegs[0]}`
          : `nothing here lays it out, and this target's rule needs its layout to say whether it comes back through a ` +
            `hidden pointer in ${target.argRegs[0]}`;
    if (stated) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': it is declared to return ${spelled} by value, and ${how}`,
      );
    }
    notes?.push(
      `[own-return] ${name}: its context declaration \`${spelledDeclaration(name, declared!)}\` returns a struct by value, ` +
        `and ${how} — lifted as the machine code's function, which the header contradicts`,
    );
    return undefined;
  }
  return { type: read.type, stated, declaration: spelledDeclaration(name, declared!) };
}

/** The struct a function returns through a hidden pointer, and which declaration said so. */
interface OwnStructReturn {
  type: Extract<IrType, { kind: 'struct' }>;
  stated: boolean;
  declaration: string;
  /** the target hands it back in the return register, not through a hidden pointer */
  register?: true;
}

/** Lifts `fn`'s struct return (frontend/own-struct-return.ts `liftOwnStructReturn`), where the
 *  lift proves the hidden pointer is the struct's storage. Where it does not, a STATED declaration
 *  refuses — the pointer function contradicts it — and a context's keeps the pointer lift, as the
 *  machine code's function, with a note in `notes`: the context's own entry is a header nothing
 *  checked against a definition (`liftWithinContextBound` says why that makes it soft). Either way, a
 *  refusal the frontend `deferred` because this struct would explain it (agbcc's 8-byte epilogue,
 *  `LiftOptions.ownMemoryReturn`) is thrown where the proof fails, since nothing else explains it, and
 *  says why the proof failed. */
function returnOwnStruct(
  fn: Fn,
  name: string,
  target: TargetDescription,
  own: OwnStructReturn,
  notes: string[] | undefined,
  deferred: ((unproved: string) => never) | undefined,
): void {
  if (own.register) {
    // a word the struct may not be all of stays the lift's own return, as the machine has it, and
    // the note says why the declared struct is not what it returns
    const kept = liftOwnRegisterStruct(fn, own.type);
    if (kept !== undefined) {
      notes?.push(
        `[own-return] ${name}: its ${own.stated ? '' : 'context '}declaration \`${own.declaration}\` returns ` +
          `${own.type.declared ?? 'a struct'} by value in ${target.returnReg}, and ${kept} — lifted as the word ` +
          'the machine code returns, which the header contradicts',
      );
    }
    return;
  }
  const why = liftOwnStructReturn(fn, own.type, target);
  if (why === undefined) {
    return;
  }
  // a refusal the frontend deferred because this struct would explain it stands where it does not
  deferred?.(why);
  const declared = `${own.type.declared ?? 'a struct'} by value, which this target returns through a hidden pointer in ${target.argRegs[0]}`;
  if (own.stated) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': it is declared to return ${own.type.declared ?? 'a struct'} by value, which this target returns ` +
        `through a hidden pointer in ${target.argRegs[0]}, and the lift cannot show that pointer is only its storage: ${why}`,
    );
  }
  notes?.push(
    `[own-return] ${name}: its context declaration \`${own.declaration}\` returns ${declared}, and the lift cannot show ` +
      `that pointer is only its storage (${why}) — lifted as the machine code's pointer function, which the header contradicts`,
  );
}

/** A FUNCTION DECLARED TO RETURN AN INTEGER WIDER THAN A REGISTER, whose lift returns one word or
 *  none, refuses — on every frontend, since this reads only the lifted `ret`s.
 *
 *  Only the declaration can decide this. A `long long` comes back in a register pair (Thumb r0:r1,
 *  O32 v0:v1, PowerPC r3:r4), and where the body never reads the pair's second register back, the
 *  asm of `long long f(long long *p, long long *q) { long long x = *p; *q = x; return x; }` is
 *  byte-identical to that of the `s32` function storing the same two words (kmc-gcc and gcc 2.7.2
 *  compile both to one object). A frontend that builds the pair returns one 64-bit value and
 *  passes; one that lowered a word would print `s32 f(...)` against the project's own `long long
 *  f(...)` — a candidate the compiler rejects as conflicting types. The frontends' asm rules
 *  (Thumb's `refuseWordReturns`, O32's `v1MayHoldLowWord`) stay as the backstop for a function
 *  nothing declares, and that byte-identical shape is their blind spot. */
function refuseNarrowReturnsOfWideDeclaration(fn: Fn, name: string, own: FnProto | undefined): void {
  const width = ownReturnWidth(own);
  if (width === undefined || width <= 32) {
    return;
  }
  for (const blk of fn.blocks) {
    for (const op of blk.ops) {
      if (op.opcode === 'ret' && !op.operands.some((v) => (intWidth(v.type) ?? 0) > 32)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': its declaration returns a ${width}-bit integer, which comes back as the halves of a ` +
            '64-bit pair, and this lowering returns one word',
        );
      }
    }
  }
}

// ── the shared raising tower ────────────────────────────────────────────────────────────────
// decompile(), decompileTraced (trace.ts), rank.ts's decompileRanked and the cli's
// decompileWithReport + its score probe (report.ts) all raise a lifted fn through the SAME stage
// sequence. Two things vary per caller and nothing else does: the optional HOOKS — rank pins its
// signedness candidate at `beforeRecover`, decompileTraced pushes a trace entry after each stage —
// and the `pre` options bag, which reaches the pre-recovery passes themselves. Every hook fires
// AFTER the stage's verify, so a hook can never observe unverified IR.

/** Stage 2 — idiom fold: filter the pattern set by target capabilities, apply, dce + verify.
 *  Returns total hits. `patterns` defaults to DEFAULT_IDIOM_PATTERNS exactly like decompile(). */
export function applyIdiomPatterns(fn: Fn, target: TargetDescription, patterns?: RewritePattern[]): number {
  const active = (patterns ?? DEFAULT_IDIOM_PATTERNS).filter((p) => patternApplies(p, target));
  let hits = 0;
  for (const p of active) {
    hits += applyPattern(fn, p, target);
  }
  if (active.length) {
    dce(fn);
    verify(fn);
  }
  return hits;
}

export interface RaiseHooks {
  /** after each pre-recovery pass that changed the IR (fires after its verify) */
  afterPass?: (pass: PreRecoveryPass, result: number | boolean) => void;
  /** between pre-recovery and recoverTypes — rank.ts pins candidate signedness here */
  beforeRecover?: () => void;
  /** after recoverTypes + verify + assertTypesRecovered */
  afterRecover?: () => void;
  /** after return-sinking, only when it changed the fn (fires after its verify) */
  afterRetsink?: () => void;
  /** after each pre-structure fold (raise/pre-structure.ts) that changed the fn (fires after its verify) */
  afterFold?: (fold: PreStructureFold) => void;
}

/** Stages 2.35–3.5 — pre-recovery recognizers (the shared ordered list in raise/pre-recovery.ts)
 *  → type recovery (boundary contract: no `unknown` survives) → return-sinking (tail-duplicate a
 *  return-only merge so short-circuits emit early returns) → the pre-structure folds
 *  (raise/pre-structure.ts: empty latches, exit trampolines, peeled loop tests). `verify` after
 *  every pass that changed the IR.
 *
 *  Return-sinking and latch folding look ordered and are not: running latch folding FIRST instead
 *  changes nothing across a 3337-function agbcc corpus. Worth saying, because folding an empty block ahead
 *  of return-sinking does take away `br` predecessors it needs — the dominance gate is what makes
 *  that unreachable, since the blocks retsink wants are never back-edge sources. The folds go last
 *  because that is where the CFG stops moving.
 *
 *  The tail is three separate parameters rather than an options bag on purpose: this is the
 *  published package root export, so every caller outside this repo is pinned to the positions.
 *
 *  @param hooks per-stage observers; see {@link RaiseHooks}. Each fires after that stage's verify.
 *  @param self  this function's own prototype, where the caller has one — what the pre-recovery
 *               passes read to type the parameters they are narrowing.
 *  @param pre   per-caller PRE-RECOVERY options. One shipped user: rank.ts's `/connective`
 *               candidate, which passes `{ shortCircuit: { foldTreeOwned: true } }` to take the
 *               fold the comparison-tree refusal owns (raise/shortcircuit.ts). */
export function raiseRecovered(
  fn: Fn,
  target: TargetDescription,
  hooks: RaiseHooks = {},
  self?: FnProto,
  pre: PreRecoveryOptions = {},
): void {
  const lifted = runPreRecovery(
    fn,
    target,
    (pass, result) => {
      verify(fn);
      hooks.afterPass?.(pass, result);
    },
    self,
    pre,
  );
  hooks.beforeRecover?.();
  recoverTypes(fn);
  verify(fn);
  assertTypesRecovered(fn);
  hooks.afterRecover?.();
  // `lifted.mergeShapes` is the CFG as it ENTERED pre-recovery, and retsink's `pre-diamond` needs
  // exactly that: `raise/shortcircuit.ts` manufactures two-armed diamonds out of condition trees the
  // ROM never merged, and a diamond this pass reads at its own turn may be one of those.
  if (
    sinkReturns(fn, {
      hoistsSingleSetArm: target.compilerBehaviors.hoistsSingleSetArm,
      mergeShapes: lifted.mergeShapes,
    })
  ) {
    verify(fn);
    hooks.afterRetsink?.();
  }
  for (const fold of PRE_STRUCTURE_FOLDS) {
    if (fold.run(fn) > 0) {
      verify(fn);
      hooks.afterFold?.(fold);
    }
  }
  // THE BOUNDARY POSTCONDITION. Above this line passes move the CFG; below it nothing does, and the
  // structurer reads a block parameter as a JOIN — a name it must give a local of its own. A param
  // whose every in-edge carries one value is not a join, and leaving one standing is how a
  // CFG-motion pass does its damage three stages away rather than where it happened: retsink's own
  // stranded merge was destroyed into `v0 = 0; return v0;` and read by Regime-A switch recovery as a
  // SECOND `default` candidate, declining every fall-through tree. This names it at retsink.
  // Not an `ir/verify.ts` rule: a trivial phi is well-formed IR, and both SSA construction and the
  // `addrnum` pass mint one and clear it inside their own scope (see `firstTrivialPhi`).
  const stranded = firstTrivialPhi(fn);
  if (stranded) {
    throw new Error(
      `internal: raising left a trivial phi — block #${fn.blocks.indexOf(stranded.block)} takes ` +
        `'${stranded.param}', whose every in-edge carries one value. A pass that retires an in-edge ` +
        `must run simplifyTrivialPhis after it.`,
    );
  }
}

/** Run `body`; if it declines, name the unmodelled instructions the function carries.
 *
 *  An `opaque` degrades its own value AND makes its block impure, so a shape recognizer refuses:
 *  a loop none of whose recognizers takes it declines with "unrecovered back-edge …".
 *  True and useless — the shape is fine, an instruction is missing — and the benchmark classifies
 *  declines by that text, so the round is filed as a loop-capability gap and the improvement loop
 *  builds the wrong thing.
 *
 *  Only ADDS attribution: never converts a decline into a success, never fires without an
 *  unmodelled instruction, reachable blocks only (one in dead code did not cause the refusal). */
function attributeOpaques<T>(fn: Fn, body: () => T): T {
  try {
    return body();
  } catch (e) {
    // Attribution is a nicety, so it must not be able to throw: a crash here would replace a
    // DESIGNED loud failure with an incidental one, which contract-invariant.test.ts rejects by name.
    if (!(e instanceof StructureError) || !fn.blocks[0]) {
      throw e;
    }
    const seen = reachableBlocks(fn);
    // THE REASONS, not the mnemonics: an `opaque` a recogniser left behind for a runtime helper it
    // could not fold carries no mnemonic at all, and asking for one would attribute the decline to
    // an instruction named `?`.
    const reasons = new Set<string>();
    for (const b of seen) {
      for (const op of b.ops) {
        if (op.opcode === 'opaque') {
          reasons.add(gapReasonFor(op.attrs));
        }
      }
    }
    if (!reasons.size || /unmodelled instruction|no model for the runtime helper/.test(e.message)) {
      throw e;
    }
    const list = [...reasons].sort().join(', ');
    throw new StructureError(`${e.message} — and the function carries ${list}, which is the more likely cause`);
  }
}

/** The committed readability/quality rewrites, in the order they are committed in: merge a
 *  statement common to every arm of an if, drop the void returns the assembly did not spell, drop
 *  dead stores (whose empty-then peephole flips the arm the merge empties), then hoist each leaf
 *  base the DEFAULT gate table admits into a typed local pointer.
 *
 *  THE ORDER IS OBSERVABLE, not a preference: drop the returns before the merge and the same arms
 *  become peelable, emptying both of them. `l3/tailret.ts` states the mechanism, and
 *  `test/tailret.test.ts` pins the difference and which side of it this function is on.
 *
 *  `hoistBaseLocals`' two arguments are SPELLED, defaults or not: this is the one call to that pass
 *  that is committed rather than offered, so it is the one whose gate table and whose placement can
 *  cost a MATCH instead of a candidate (docs/level-tower.md). A committed policy that reads as
 *  "whatever the default is" is the policy nobody reviews. */
export function readabilityRewrites(raw: SFn): SFn {
  return hoistBaseLocals(eliminateDeadStores(dropUnspelledReturns(mergeCommonTails(raw))), BASECSE_GATES, 'head');
}

/** Stage 4 — structure + its boundary contracts, always as a pair. */
export function structureChecked(
  fn: Fn,
  opts: Parameters<typeof structure>[1],
  hooks?: Parameters<typeof structure>[2],
  memo?: Parameters<typeof structure>[3],
): SFn {
  const raw = attributeOpaques(fn, () => structure(fn, opts, hooks, memo));
  // The boundary contracts run on the pre-DCE tree: the readability pass must never be able to
  // hide a structuring defect by dropping the dead statement that carries it. assertResolved
  // catches an unresolved `?` value; assertDerefsTyped catches an ill-typed deref (e.g. a pointer
  // under a rejected operator) — even one sitting in dead code structure emitted;
  // assertLocalsWritten catches a materialized def whose assignment no position emitted. DCE then
  // only removes statements/flips branches over an already-validated tree.
  assertResolved(raw);
  assertDerefsTyped(raw);
  assertLocalsWritten(raw);
  assertPostIncrUnshared(raw);
  assertEffectsPreserved(fn, raw);
  // The hoist moves the deref cast from each `index` node onto the local's initializer, so
  // re-validate deref typing on the rewritten tree.
  const sfn = readabilityRewrites(raw);
  assertDerefsTyped(sfn);
  assertFrameUnionsViewed(sfn);
  assertPostIncrUnshared(sfn);
  // Re-checked after the readability rewrites for the same reason deref typing is: a pass that
  // merges arms or drops statements must not be able to lose or duplicate a call.
  assertEffectsPreserved(fn, sfn);
  return sfn;
}

// ── annotate-mode support ─────────────────────────────────────────────────────────────────

/** Classify a caught failure by which stage's designed signal it is. `instanceof`, not name
 *  strings: a renamed or newly-subclassed error class (PpcUnsupported subclasses
 *  FrontendUnsupported) stays correctly classified instead of silently degrading to "internal". */
function stageOf(e: unknown): Diagnostic['stage'] {
  if (e instanceof FrontendUnsupportedError) {
    return 'lift';
  }
  if (e instanceof RaiseUnsupportedError) {
    return 'raise';
  }
  if (e instanceof StructureError) {
    return 'structure';
  }
  if (e instanceof ContractError) {
    return 'contract';
  }
  if (e instanceof VerifyError) {
    return 'verify';
  }
  return 'internal';
}

/** The annotate-mode fallback for a failure with no line to mark: a compilable-shaped stub whose
 *  body is one ASMLIFT_ERROR marker, headed by the reason + the ORIGINAL ASM as comments.
 *  Exported for trace.ts (decompileTraced), whose annotate mode must degrade to the SAME stub
 *  as decompile(). */
export function stubResult(name: string, asm: string, backend: LanguageBackend, e: unknown): DecompileResult {
  const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
  const stage = stageOf(e);
  const sfn: SFn = {
    name,
    params: [],
    locals: [],
    retType: T.void(),
    body: [{ k: 'exprstmt', value: { k: 'marker', reason: `could not decompile (${stage}): ${msg}`, args: [] } }],
  };
  const header = [
    backend.comment(`asmlift could not decompile '${name}' — ${stage}: ${msg}`),
    backend.comment('original assembly:'),
    ...asm
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => backend.comment(`  ${l}`)),
  ];
  return {
    source: header.join('\n') + '\n' + backend.emit(sfn),
    sfn,
    ir: { raw: '', folded: '', recovered: '' },
    patternHits: 0,
    diagnostics: [{ stage, reason: msg }],
    // A stub spells no global, so it assumes nothing about one and walked to none.
    assumedSymbols: [],
    walkedNames: [],
    ownArityNotes: [],
  };
}

/** Every ASMLIFT_ERROR marker in the emitted AST, as a structured diagnostic (one per marker,
 *  document order). The harness/self-improve loop reads THIS; the source text is for humans. */
function collectMarkers(sfn: SFn): Diagnostic[] {
  // On the shared `walkExprs` traversal (l3/ast.ts). Order is exprs-then-nested-statements per
  // statement — deterministic and near-document-order (a `for`'s cond is visited before its init;
  // see the note on stmtChildren).
  const out: Diagnostic[] = [];
  for (const e of walkExprs(sfn.body)) {
    if (e.k === 'marker') {
      out.push({ stage: 'structure', reason: e.reason });
    }
  }
  return out;
}
