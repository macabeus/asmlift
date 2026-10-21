// asmlift — WHAT A CALL IS, read off its callee's declaration: the one place a frontend reads one.
//
// A declaration is the project's prototype, the compiler's runtime table or a signature the C
// standard fixes, and every frontend asks the same questions of it: how wide each argument is,
// whether argument 0 is a hidden struct-return pointer, whether the result comes back as a pair,
// and which registers the call leaves holding nothing the caller can name. The frontend states what
// its own lowering can carry out (`CallLowering`) and refuses in its own error class (`fail`).
// Every answer is read through the generic `TargetDescription` surface. WHERE each argument word
// travels is the frontend's own placement (Thumb's outgoing block, O32's `16(sp)`): a width list
// here counts words as `wordsOf` does, which is agbcc's placement, and a lowering that builds no
// pair (`CallLowering.pairs`) refuses a 64-bit width before any count is taken. The call a plan
// lowers to is built here too (`CallDeclarations.lower`), and asks the frontend (`CallSite`) only
// what its ISA alone knows: how it reads and writes a register, where an argument word past the
// registers lives, and how it builds a pair.
import {
  type ByValueArg,
  aggregateType,
  byValueCallArgs,
  byValueRefusal,
  ownArgumentWordsOn,
  ownLeadingWordParamsOn,
  returnedAggregate,
  returnsInMemory,
  returnsWithoutHiddenPointer,
} from '../aggregate';
import { type Block, type Op, REGISTER_STRUCT, type Value, calleeName, mkOp, mkValue } from '../ir/core';
import { qualified } from '../ir/discipline';
import { OPCODES, type OpSig } from '../ir/opcodes';
import { type IrType, T, structSpelling, typeToString } from '../ir/types';
import {
  type FnProto,
  type ParamClass,
  type Prototypes,
  calleeDeclaration,
  declaredCallArgs,
  declaredReturnWidth,
  declaresAggregateReturn,
  declaresParams,
  declaresVoidReturn,
  floatingSpelling,
  isFloatingSpelling,
  ownDeclaresFloatingParam,
  paramClassOf,
  spellableProto,
  variadicRefusal,
  wordsOf,
} from '../proto';
import { type ContextGlobals, structNamed } from '../proto-context';
import { floatSidesOf, helperPrototypes, isFloatHelper, isWideHelper, lookupHelper } from '../runtime-helpers';
import { type SymbolMap, symbolsByName } from '../symbols';
import { type TargetDescription, argRegisterHoles } from '../target';
import { type FrontendRefusal, FrontendUnsupportedError } from './errors';
import { type OwnDeclaration, ownDeclarationOf } from './frontend';
import type { HighHalves } from './high-half';
import { unspellableReason } from './reloc-symbol';
import { type SsaBuilder, clobberedByCall, fallbackArgc } from './ssa';

/** What the frontend's own call lowering can carry out. */
export interface CallLowering {
  /** builds a 64-bit value out of two argument words, and splits a 64-bit return */
  readonly pairs: boolean;
  /** passes a hidden struct-return pointer in argument 0 and types the call's value as the struct */
  readonly memoryReturn: boolean;
  /** reads argument words past the registers off its own frame */
  readonly stackArgs: boolean;
  /** writes no value for a callee declared void, and its own return reads the return register only
   *  where a value reaches it (`SsaBuilder.holdsValue`), so the register the call destroyed is no
   *  return value */
  readonly voidReturn: boolean;
  /** a call through argument register rN passes r0..r(N-1). The compiler's arguments fill the
   *  registers from r0 up and the address cannot share one, which holds for agbcc: soft-float, no
   *  pair alignment. o32 refutes it twice — a leading float takes slot a0 and leaves the register
   *  free (`jalr a0` passing $f12 and a1), and a 64-bit argument's even pair leaves a1 empty
   *  (`jalr a1` passing a0, a2 and a3) — so a lowering that does not state it guesses. */
  readonly argRegisterBoundsArity: boolean;
}

/** A call's struct return through memory: the declared struct, laid out on this target. */
interface StructReturn {
  type: IrType;
}

/** What one callee's declaration states about a call (`CallDeclarations.declaredCall`). */
export interface DeclaredCall {
  /** each argument's width, in bits, a hidden struct-return pointer first */
  readonly widths: readonly number[];
  /** the indices into `widths` that are a `double` */
  readonly doubles: ReadonlySet<number>;
  /** the declared parameter count, a hidden pointer aside */
  readonly params: number;
  readonly returned?: StructReturn | 'register';
  /** each struct passed by value, by its first word in `widths` (a hidden pointer counted) */
  readonly byValue?: readonly ByValueArg[];
}

/** WHAT A DECLARED PARAMETER IS, as far as where the caller places it goes (`paramClassOf`,
 *  proto.ts, which `declaredCall`'s widths read too). */
export type { ParamClass };

/** One declared parameter: its class, and the spelling it was read from (empty for a count). */
export interface DeclaredParam {
  readonly kind: ParamClass;
  readonly spelling: string;
}

/** What one call is, decided from its callee's declaration before any instruction is read. */
export interface CallPlan {
  /** each argument's width, a hidden pointer first; null when nothing sizes them, so `lower`
   *  guesses */
  readonly widths: readonly number[] | null;
  /** the indices into `widths` its declaration types `double` */
  readonly doubles: ReadonlySet<number>;
  /** the structs its declaration passes by value, by their words in `widths` */
  readonly byValue?: readonly ByValueArg[];
  readonly returns:
    | { readonly kind: 'word' }
    | { readonly kind: 'void' }
    | { readonly kind: 'pair' }
    | {
        readonly kind: 'register-struct';
        /** the return register holds the struct's image, which a local of it is read off
         *  (`registerStructLocal`); false, it holds nothing the caller may read */
        readonly image: boolean;
      }
    | { readonly kind: 'memory-struct'; readonly type: IrType };
  /** what the call leaves holding nothing this function can name, for `SsaBuilder.noteCall` */
  readonly clobbers: readonly string[];
  /** the callee is declared void, whether or not this lowering writes no value for it (`returns`
   *  is `void` only where `CallLowering.voidReturn` says so) */
  readonly declaredVoid: boolean;
  /** the floating type an ordinary callee is declared to return where the target has no FPU, so
   *  the return register holds its bits (`raise/floathelpers.ts` holds every read of them) */
  readonly floatReturn?: 'float' | 'double' | 'long double';
}

/** WHAT EACH CALLEE'S DECLARATION SAYS, and what a call leaves holding nothing this function can
 *  name. A declaration is the project's prototype or the compiler's runtime table, and a frontend
 *  reads either only here: its outgoing-argument analysis, its call lowering (`lower`) and the
 *  frame-object audit (`FrameObjectAudit.returnsWithoutHiddenPointer`) ask these questions. */
export interface CallDeclarations {
  /** what any call leaves holding nothing this function can name (`clobberedByCall`) */
  readonly callClobbers: readonly string[];
  /** whether a declaration rules out a struct returned through a hidden pointer at argument 0
   *  (`returnsWithoutHiddenPointer`, aggregate.ts) */
  returnsWithoutHiddenPointer(callee: string): boolean;
  /** the callee's declared argument widths, for a frontend that places them before it lowers the
   *  call; null where no declaration sizes them */
  declaredCall(callee: string): DeclaredCall | null;
  /** what each parameter the callee's declaration spells is (`ParamClass`), read through the tiers
   *  `declaredCall` reads; null where no declaration states the parameters */
  declaredParams(callee: string): readonly DeclaredParam[] | null;
  /** `lower`'s first half, the call decided from the declaration alone: a value its tests compare
   *  whole, where `lower` leaves IR */
  plan(callee: string): CallPlan;
  /** the call `site` makes, planned and lowered: its `call` op, its result and its clobbers */
  lower(site: CallSite): void;
  /** every value an argument register may hold at a call `lower` lowered at an UNDECLARED arity — a
   *  guess, or the bound a call through an argument register sets — gathered as each such call is
   *  lowered. One the call does not pass is unused by the LIFT, not proved unused by the source: the
   *  dead-read pin refuses it (frontend/dead-reads.ts `held-at-undeclared-call`). */
  readonly heldAtUndeclaredCall: ReadonlySet<Value>;
  /** THE #351 GAPLESS GUESS, NOT LET IN THROUGH A JUMP TABLE'S CASES. Once every call is lowered:
   *  where the function lifts only because of what an elided or kept dispatch left in its registers
   *  — a dispatch's marker or scaled index reaching some guessed call's argument registers
   *  (`CallSite.parked`, `CallSite.scaledIndex`; a PowerPC pair's r4 too), which stands where the
   *  pre-dispatch value had made a gap refuse, or `caseStateRead`, a read of the scaled index a case
   *  target is entered with — refuse the first guessed arity the bytes cannot tell from another:
   *    - its last counted register holds a value some path from the dispatch's block to the call
   *      did not write (`SsaBuilder.writtenOnEveryPath`; a cross-jumped call's block writes nothing,
   *      its cases do), a value passed on unchanged (`g0(a, 9)` lifted `g0(a0, 9, a0)`, agbcc's pre-dispatch copy of
   *      a0 still in r2; mwcc `return g()` lifted `return g(a0)`);
   *    - a counted register holds a value an effect of its block uses, a store's address or value
   *      left in the register (`gc = ga; g()` lifted `g(&gc, v0)`);
   *    - a register it leaves out below that marker still holds its incoming value, an argument
   *      passed on or not (mwcc `g(a)` with the table base in r4 lifted `g()`).
   *  Elsewhere the guess takes these, an open gap (`g()` and `g(a0)` are the same bytes); there the
   *  function declined before the dispatch's registers were modelled, and a decline is not turned
   *  into that guess. */
  refuseDispatchUnlockedPassThrough(caseStateRead: boolean): void;
}

/** WHAT ONE ISA ALONE KNOWS ABOUT A CALL: everything `CallDeclarations.lower` asks a frontend. The
 *  argument and return registers are the target's. */
export interface CallSite {
  /** the callee's name, or the address of the function a call through a register calls */
  readonly callee: string | IndirectCallee;
  readonly ssa: SsaBuilder;
  /** the block the call is made in */
  readonly bi: number;
  /** an argument register the plan states, read as this frontend reads a register */
  read(reg: string): Value;
  /** the call's result, written as this frontend writes a register */
  write(reg: string, v: Value): void;
  /** argument word `k` past the registers, where this ABI places it (`CallLowering.stackArgs`) */
  stackWord?(k: number): Value;
  /** how this frontend builds and splits a pair (`CallLowering.pairs`) */
  readonly pairs?: CallPairs;
  /** what this frontend defines registers with that is no value and so no argument — a pending
   *  high half (frontend/high-half.ts), a jump table's base (frontend/jump-table.ts) */
  readonly placeholders?: Pick<HighHalves, 'has' | 'guardRead'>;
  /** whether `v`, in argument register `reg`, is what a jump-table dispatch left in that very
   *  register (frontend/jump-table.ts `parkedIn`): no argument, as a table base is none, so a guessed
   *  arity stops below the lowest register only it reaches (`fallbackArgc`'s `parked`), except one
   *  this ABI may skip (an O32 double's a1, a PowerPC pair's r4, a leading float's a0), which stays a
   *  gap. A copy of one below that ceiling is counted, and its read declines; a copy above it is
   *  dropped with everything else there (`mov r2,r1` ahead of `bl g` lifts `g(…)` without it), which
   *  only hand asm meets: no compiler copies a marker. */
  readonly parked?: (v: Value, reg: string) => boolean;
  /** whether `v`, in argument register `reg`, is the scaled index a jump-table dispatch left in that
   *  very register (frontend/jump-table.ts `scaledIndexIn`): a call handed it and one not compile
   *  alike, so a guessed arity that counts it refuses */
  readonly scaledIndex?: (v: Value, reg: string) => boolean;
  /** what a guessed arity refuses on. Required, as the gap refusal it feeds (`fallbackArgc`) has
   *  no opt-out: a count that stopped at the first register nothing reaches would drop every
   *  argument past an incoming one the call is handed unchanged (`logv(s, 1)` as `logv()`). */
  readonly guess: {
    /** where the call is, for the gap refusal: its address, or — for an ISA whose instructions
     *  carry none (Thumb's `.s` text) — a phrase that names it, printed as written */
    readonly at: number | string;
    /** refuses a guess of `argc` words this ABI's outgoing area could extend; absent where the
     *  frontend's frame model already refuses every word such a guess could leave out */
    refuse?(argc: number): void;
  };
  /** handed the argument registers an UNDECLARED arity leaves out although a value reaches them —
   *  past a guessed count, or past the bound of a call through an argument register — and the ones
   *  it passes. The call drops what the left-out ones hold, so a frontend that knows one to be an
   *  argument all the same refuses here. */
  readonly leftOut?: (regs: readonly string[], passed: readonly string[]) => void;
  /** whether the frontend withholds the shorter `/setup-args` reading from THIS CALL whatever it
   *  cuts; the frontend says why where it sets it. A thunk: it is asked once every block is lowered. */
  readonly withholdsSetupArgs?: () => boolean;
  /** whether the shorter `/setup-args` reading of this call asks `leftOut` of EVERY register it
   *  cuts, not only of those the call's own block wrote (`GuessedCallSite.asksEveryCut`); the
   *  frontend says why where it sets it. A thunk: it is asked once every block is lowered. */
  readonly asksEveryCut?: () => boolean;
}

/** A call through a register. It names no callee, so no declaration plans it: an argument
 *  register holding the address bounds its arity where the lowering states it
 *  (`CallLowering.argRegisterBoundsArity`), and otherwise it is guessed. */
export interface IndirectCallee {
  readonly address: Value;
  /** the register the address is in */
  readonly reg: string;
}

/** How a frontend builds a 64-bit value out of two words and splits one. */
export interface CallPairs {
  fuse(lo: Value, hi: Value): Value;
  project(whole: Value, half: 'lo' | 'hi'): Value;
  /** the pair each projected half was split from */
  readonly halfOf: ReadonlyMap<Value, { readonly whole: Value; readonly half: 'lo' | 'hi' }>;
}

export function callDeclarations(
  name: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lowering: CallLowering,
  fail: FrontendRefusal,
  /** the function's own declaration, where one binds its body — asked as a call is lowered */
  ownDeclaration: () => OwnDeclaration | undefined = () => ownDeclarationOf(name, prototypes, undefined),
): CallDeclarations {
  // What a call leaves holding nothing this function can name — checked against `argRegs` there.
  const callClobbers = clobberedByCall(target);
  // `refuseDispatchUnlockedPassThrough`'s two facts, gathered as each call is lowered: whether a
  // dispatch's marker reached a guessed call's argument registers, and the first guessed count
  // the bytes cannot tell from another, as its refusal
  let parkedInArgs = false;
  let passThrough: { call: string; reg: string; why: string } | undefined;
  // …and what a call to a PAIR-RETURNING helper leaves: the same set minus the high half, because
  // the low half is the return register (already excluded) and `lower` writes the high one itself
  // from the callee's own result. The two arms of one rule: where the callee hands a register back,
  // the lowering names it; where it does not, nobody can.
  //
  // `argRegs[1]` IS THE PAIR'S HIGH REGISTER ONLY WHERE THE ABI ALIASES THE FIRST ARGUMENT ONTO
  // THE RETURN REGISTER, which makes the returned pair occupy the first two argument registers.
  // True on Thumb (r0:r1) and PowerPC (r3:r4); FALSE on MIPS o32, which returns in v0:v1 and passes
  // in a0:a1, so reading a high half out of `argRegs[1]` there would name an argument register. A
  // lowering that builds pairs on a target without the identity is a target bug.
  if (lowering.pairs && target.returnReg !== target.argRegs[0]) {
    throw new Error(
      `target '${target.id}': a lowering that builds pairs needs the return register to be the first ` +
        `argument register, and ${target.returnReg} is not ${target.argRegs[0]}`,
    );
  }
  const pairReturnClobbers = callClobbers.filter((r) => r !== target.argRegs[1]);
  const heldAtUndeclaredCall = new Set<Value>();
  const isFloatHelperName = (callee: string): boolean => {
    const h = lookupHelper(target.runtimeHelpers, callee);
    return h !== undefined && isFloatHelper(h) && floatSidesOf(h).result;
  };
  /** the callee that handed back each pair a call returned, by the pair's value */
  const pairCallee = new Map<Value, string>();
  /** the value each call to a callee declared void left in the return register */
  const voidResults = new Set<Value>();
  // The compiler's own runtime, off the TARGET (runtime-helpers.ts): which helpers a compiler
  // emits is a compiler fact, and reading one table for every ISA is how a scan for `__*di3`
  // reports zero on a compiler whose runtime spells them `__ll_*`.
  const helperProtos = helperPrototypes(target);
  const wideHelper = (callee: string) => {
    // Through the table's one reader (`lookupHelper`): a bare index answers with a member of
    // `Object.prototype` for a callee named `toString`, which is truthy and has no `params` for
    // `isWideHelper` to read. The `prototypes` read below needs no such guard because
    // `declaresParams` is that table's designated safe reader — it answers "nothing is declared"
    // for an entry that is not an `FnProto`, whatever it is.
    const h = lookupHelper(target.runtimeHelpers, callee);
    if (!h || !isWideHelper(h)) {
      return null;
    }
    // A PROJECT RE-DECLARATION DISABLES THE CAPABILITY, it does not redirect it. A runtime helper's
    // signature is its COMPILER's — `proto.ts` holds the signatures the C standard fixes, which this is precisely
    // not — so a header declaring `__muldi3` is not a better source for the same fact; it is a
    // claim that the name is the project's own function. Neither reading can be honoured: as the
    // table's helper it would contradict the header, and as an ordinary call it becomes the
    // pass-through that MATCHES for free. So no pair is built and `raise/widehelpers.ts` gaps the
    // call, at whichever arity was declared.
    if (declaresParams(prototypes[callee])) {
      return null;
    }
    return h;
  };
  /** Whether the target's own runtime table claims this name — asked of the TABLE, not of what
   *  `wideHelper` made of it.
   *
   *  A PROJECT'S `returns` NEVER BUILDS A PAIR FOR A RUNTIME HELPER'S NAME: a re-declaration
   *  disables the capability for the result as it does for the arguments. `wideHelper` answers
   *  null for a re-declared helper, which stops the ARGUMENT pair; the RESULT pair comes from a
   *  separate source, and `raise/widehelpers.ts` folds on the result alone (`arrivesAsDeclared`
   *  needs `results[0]` 64 bits wide). A pair built from the project's `returns` would fold the
   *  call into the compiler's own operation — `__muldi3` printed as `a0 * a1` — for a name the
   *  project says is its own function.
   *
   *  A NON-WIDE ENTRY IS COVERED TOO, and deliberately: a `returns` on `__divsi3` states a width
   *  about a function whose signature is its compiler's, and `refuseUnmodelledHelpers` is going to
   *  gap the call whatever this answers. The table is the authority for every name in it. */
  const isRuntimeHelperName = (callee: string): boolean => lookupHelper(target.runtimeHelpers, callee) !== undefined;
  // WHETHER THE CALLEE HANDS BACK A PAIR — two sources for one ABI fact, and they answer the same
  // question about the same two registers. A runtime helper's signature is its compiler's and needs
  // no header; a project's callee needs one, and `returns` is where a header states it. Silence
  // means a word — the callee then defines the return register alone and `frontend/ssa.ts` refuses
  // a read of the other, because in that reading it is right to.
  //
  // AND THEY ARE ASKED IN THAT ORDER, never unioned: a name the runtime table carries is answered
  // by the table or by nothing (`isRuntimeHelperName`), so a header that re-declares a helper
  // disables the capability rather than restoring it through the other key.
  const returnsPair = (callee: string): boolean => {
    const wide = wideHelper(callee);
    return (
      (wide
        ? wide.returns
        : isRuntimeHelperName(callee)
          ? undefined
          : declaredReturnWidth(prototypes[callee], target)) === 64
    );
  };
  // A callee the project declares to return a struct in registers, asked where `declaredCall` has
  // no arity to answer with: the return is the declaration's, and needs none.
  const registerStructReturn = (callee: string | undefined): 'register' | undefined => {
    const own = callee !== undefined && Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined;
    return declaresAggregateReturn(own) && structReturnOf(name, target, callee!, own!, fail) === 'register'
      ? 'register'
      : undefined;
  };
  // WHAT ONE CALLEE'S DECLARATION SAYS — the ONE place that reads it. A frontend's outgoing-argument
  // analysis and its call lowering both come through here, so the arity that LICENSED a block and
  // the arity that CONSUMES it cannot drift apart; a disagreement between two spellings of this
  // lookup would read an argument register's neighbour as argument 5 or throw a slot-model error
  // naming the wrong thing.
  //
  // THE WIDTHS ARE WHAT IS ASKED FOR, not a C parameter count, which would be the wrong number the
  // moment one parameter is wider than a word: a `long long` adds a word AND moves every later
  // argument's home, in the registers and on the stack alike. `proto.ts` converts the declaration
  // once and every reader of it takes the same answer.
  //
  // WHAT THE CONVERSION CANNOT DO ON ITS OWN. `declaredWidth` answers for every type asmlift can
  // spell, `long long` included, and `undefined` for a project typedef, a by-value struct or a
  // floating type. `declaredCallArgs` sizes a `double` from the target
  // (`TargetDescription.doubleArgWords`) and a typedef the declaration lists in `wordParams` (an
  // enum, an array or a function type: `proto.ts` `paramClassOf`) at one word; one other such
  // spelling and it states no layout at all, because the question here is not how wide that
  // parameter is but whether it occupies one argument register or two, and the choice moves every
  // later argument's home. So the declaration licenses no outgoing block and this returns `null`:
  // the call is lifted at the arg-register guess, exactly as a callee the project never declared
  // is, and the guess retracts the registers a call destroyed where a stated width would assert
  // them.
  //
  // The COUNT form (`{ params: 5 }`) carries no spellings at all: it is the user's word for how
  // many argument REGISTERS the call takes, and a count that lies is garbage in —
  // `validatePrototypes` can no more check it than it can check `returnsVoid`. The machine-derived
  // side upholds the premise at its source: `prototypesFromSymbols` drops a whole entry rather
  // than spell a parameter that is not 1, 2 or 4 bytes (test/proto.test.ts).
  //
  // A frontend that places the widths before it lowers the call runs this over every call, so a
  // refusal thrown here reaches the caller ahead of every other slot-model refusal, which is right
  // because it is the most specific thing that was seen.
  const known = (t: Prototypes, callee: string) => (Object.hasOwn(t, callee) ? t[callee] : undefined);
  /** the declaration a callee is read at: the project's, then the runtime table's, then the C
   *  standard's (`proto.ts` `calleeDeclaration`; `declaredCall` gives the reasons for the order) */
  const declarationOf = (callee: string): FnProto | undefined => calleeDeclaration(callee, prototypes, helperProtos);
  const declaredParams = (callee: string): readonly DeclaredParam[] | null => {
    const params = declarationOf(callee)?.params;
    if (typeof params === 'number') {
      return Array.from({ length: params }, () => ({ kind: 'word', spelling: '' }));
    }
    if (!Array.isArray(params)) {
      return null;
    }
    const declared = declarationOf(callee)!;
    return params.map((spelling, k) => ({ kind: paramClassOf(declared, params, k), spelling }));
  };
  // A STRUCT OR UNION PASSED BY VALUE THAT NO RULE PLACES REFUSES; IT IS NOT GUESSED. The arity
  // guess counts argument registers, and a struct is not one: it takes as many words as its size
  // (agbcc, O32), starts at an even word when it is 8-aligned (O32), or travels as the address of
  // a copy (mwcc). A guess over it drops the struct (agbcc `takeQ(k, gQ)` with no layout for
  // `struct Q` guesses `takeQ();`) or reads its words as separate arguments (O32 `takeW(gW)` as
  // `takeW(*(s32 *)&gW)`), and either is C that compiles. This is
  // not the abstention `declaredCallArgs` documents for an unsized typedef, which may still be one
  // word: a parameter the declaration names a struct or union is known not to be.
  //
  // A VARIADIC DECLARATION REFUSES THE SAME GUESS over a fixed parameter that is not one word: it
  // states a layout only where each fixed parameter is one word (`variadicFloor`), and otherwise its
  // call is placed by the guess (`FnProto.variadicParams`), which splits a struct, a 64-bit value or
  // a `double` into words. Its parameters are the project's fact, read off its own entry,
  // which `declarationOf` reads past because it states no `params`.
  const refuseUnplacedByValue = (callee: string, hidden: number): void => {
    const own = known(prototypes, callee);
    const fixed = variadicRefusal(own);
    if (fixed !== undefined) {
      const spelling = own!.variadicParams![fixed.param];
      const byValue = paramClassOf(own!, own!.variadicParams!, fixed.param) === 'by-value';
      fail(
        `cannot lift '${name}': \`${callee}\` takes '${spelling}'${byValue ? ' by value' : ''} as its parameter ` +
          `${fixed.param + 1}, and ${fixed.refused} — a variadic call is lifted only where each fixed parameter is one argument word`,
      );
    }
    const p = declarationOf(callee);
    const why = byValueRefusal(p, target, hidden);
    if (why !== undefined) {
      fail(
        `cannot lift '${name}': \`${callee}\` takes '${(p!.params as readonly string[])[why.param]}' by value as its ` +
          `parameter ${why.param + 1}, and ${why.refused} — a struct passed by value is lifted only where its argument words are known`,
      );
    }
  };
  // A FLOATING PARAMETER THE DECLARATION STATES BUT NOTHING LAYS OUT REFUSES; IT IS NOT GUESSED.
  // Where the target has an FPU, `plan` refuses every floating parameter first (it travels in the
  // FPU's registers). Where it has none — agbcc — a `double` is laid out in general words
  // (`TargetDescription.doubleArgWords`) and a `float` or `long double` is not (`proto.ts`
  // `declaredCallArgs`), so the call would fall to the arity guess, which is wrong both ways: a
  // trailing argument passed through unchanged is dropped (`int g(int, float)`: `g(a + 1, b)` as
  // `g(a0 + 1)`), and a register left over from the caller is counted (`float h(float)`: `h(v)` as
  // `h(a1, a1)`). Neither compiles against the header. The unsized-typedef abstention does not
  // apply: a floating spelling is known, and what is missing is a layout, not a width.
  const refuseUnplacedFloat = (callee: string): void => {
    const p = declarationOf(callee);
    const params = p?.params;
    if (target.fpu !== undefined || !Array.isArray(params)) {
      return;
    }
    const at = params.findIndex((_, k) => paramClassOf(p!, params, k) === 'float');
    if (at >= 0) {
      fail(
        `cannot lift '${name}': \`${callee}\` is declared to take '${params[at]}' as its parameter ${at + 1}, ` +
          'which this target passes in general argument words that are not laid out here — the arity guess ' +
          'in its place drops an argument passed through unchanged, or counts a leftover register as one',
      );
    }
  };
  const declaredCall = (callee: string): DeclaredCall | null => {
    // Three tiers, narrowing: the project's own headers, then the compiler's runtime helpers,
    // then the signatures the C standard fixes (proto.ts). A project that re-declares one of the
    // last two is read at its own declaration: it may be building against it. On a runtime
    // helper's name that disables the helper rather than redirecting it (`wideHelper`).
    //
    // THE TIER QUESTION IS WHETHER THE PROJECT DECLARED THE CALLEE, not whether the declaration
    // could be sized. A header that spells `memcpy`'s third parameter through a project typedef
    // has still re-declared `memcpy`, and reading the standard's signature past it would answer
    // for a different function — which is the one reading this tier order exists to prevent.
    //
    // `Object.hasOwn` on all three tables: a callee named `toString` or `valueOf` would otherwise
    // read a `Function` off `Object.prototype` as its prototype entry.
    const own = known(prototypes, callee);
    const returned = declaresAggregateReturn(own) ? structReturnOf(name, target, callee, own!, fail) : undefined;
    const hidden = returned === undefined || returned === 'register' ? 0 : 1;
    const declared:
      { widths: readonly number[]; doubles: ReadonlySet<number>; byValue?: readonly ByValueArg[] } | undefined =
      declaredCallArgs(declarationOf(callee), target) ?? byValueCallArgs(declarationOf(callee), target, hidden);
    const params = declared?.widths;
    if (params === undefined) {
      refuseUnplacedByValue(callee, hidden);
      refuseUnplacedFloat(callee);
    }
    if (params === undefined && returned !== undefined && returned !== 'register') {
      // a guessed arity reads argument registers from the first, which holds the hidden pointer
      fail(
        `cannot lift '${name}': \`${callee}\` returns ${returned.type.kind === 'struct' ? returned.type.declared : typeToString(returned.type)} through a hidden ` +
          `pointer in ${target.argRegs[0]}, and its parameters are not all sized, so which registers carry its arguments is not known`,
      );
    }
    if (params === undefined) {
      return null;
    }
    // THE STRUCT'S LOCAL NEEDS THE CALLEE PRINTED. A self-declared candidate defines the struct only
    // beside the callee's printed prototype (`declare.ts`), so a declaration the printer cannot spell
    // (`double *`, `size_t`, or a bare parameter count, which states no type) lifts to a candidate
    // that does not compile. Asked of the printer's own predicate, so the two cannot disagree; a
    // headers world, which would declare the callee itself, loses the lift with it.
    const byValueParams = new Set((declared?.byValue ?? []).map((b) => b.param));
    if (
      returned !== undefined &&
      returned !== 'register' &&
      spellableProto(own, target, returned.type, byValueParams) === undefined
    ) {
      const via = `\`${callee}\` returns ${returned.type.kind === 'struct' ? returned.type.declared : typeToString(returned.type)} through a hidden pointer in ${target.argRegs[0]}`;
      if (typeof own!.params === 'number') {
        fail(
          `cannot lift '${name}': ${via}, and its declaration states only a count of parameters, no type the lifted source can declare it with`,
        );
      }
      fail(
        `cannot lift '${name}': ${via}, and a parameter type of its declaration has no spelling the lifted source can declare it with`,
      );
    }
    const widths = hidden === 0 ? params : [32, ...params];
    const doubles = new Set([...declared!.doubles].map((i) => i + hidden));
    const byValue = (declared!.byValue ?? []).map((b) => ({
      ...b,
      word: b.word + hidden,
    }));
    // a struct partly in the registers and partly on the stack (FUNCTION_ARG_PARTIAL_NREGS) is
    // one value read from two places, which no lowering here builds
    const past = byValue.find((b) => wordsOf(widths.slice(0, b.word), target) + b.words > target.argRegs.length);
    if (past !== undefined) {
      fail(
        `cannot lift '${name}': \`${callee}\` takes ${structSpelling(past.type)} by value as its parameter ${past.param + 1}, ` +
          'and it does not fit in the argument registers — a struct passed on the stack is not modelled',
      );
    }
    return {
      widths,
      doubles,
      params: declared!.widths.length - byValue.reduce((n, b) => n + b.words - 1, 0),
      ...(returned === undefined ? {} : { returned }),
      ...(byValue.length === 0 ? {} : { byValue }),
    };
  };
  // ONE CALL, IN THE ORDER ITS QUESTIONS REFUSE: a struct the lowering cannot receive and a float,
  // then the runtime helper, whose signature is its compiler's, so no declaration is asked for one;
  // the declaration's own refusals come next, then the return.
  const plan = (callee: string): CallPlan => {
    const own = Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined;
    // One returned through memory is handed a hidden pointer in argument 0, with every argument one
    // register up. One returned in registers takes its arguments where they are declared.
    if (
      !lowering.memoryReturn &&
      declaresAggregateReturn(own) &&
      returnsInMemory(returnedAggregate(own!), target) !== false
    ) {
      fail(
        `cannot lift '${name}': '${callee}' is declared to return ${own?.returns ?? 'a struct or union'} by value — ` +
          'a struct returned through a hidden pointer, or one nothing here can size, is not modelled',
      );
    }
    // A FLOAT CROSSES A CALL IN THE FPU'S REGISTERS where the target has one (`TargetDescription.fpu`),
    // and a call here passes and reads general registers alone.
    if (target.fpu !== undefined && own !== undefined) {
      if (typeof own.returns === 'string' && isFloatingSpelling(own.returns)) {
        fail(
          `cannot lift '${name}': '${callee}' is declared to return ${own.returns}, which comes back in ` +
            `${target.fpu.returnReg} — the floating-point registers a call passes and returns in are not modelled`,
        );
      }
      const params = Array.isArray(own.params) ? own.params : [];
      const at = params.findIndex(isFloatingSpelling);
      if (at >= 0) {
        fail(
          `cannot lift '${name}': '${callee}' is declared to take ${params[at]} as its ` +
            `parameter ${at + 1}, which travels in the FPU's registers — the floating-point registers a call ` +
            'passes and returns in are not modelled',
        );
      }
    }
    const helper = wideHelper(callee);
    // WITHOUT PAIRS A 64-BIT HELPER IS AN UNDECLARED CALL. Its table signature passes a pair, which
    // such a lowering cannot build; guessed, the call reaches `raise/widehelpers.ts`, which gaps it
    // by name.
    const wide = lowering.pairs ? helper : null;
    const declared = helper ? null : declaredCall(callee);
    if (!lowering.pairs && declared !== null) {
      // A PARAMETER WIDER THAN A REGISTER TRAVELS IN A PAIR. A lowering that passes every argument
      // register as its own value would honour the declaration by handing the callee one half.
      const wideAt = declared.widths.findIndex((w) => w > 32);
      if (wideAt >= 0) {
        // `widths` holds argument words — a hidden struct-return pointer ahead of the declared
        // list, and each word of a struct passed by value — and the text names the parameter
        const hidden = declared.returned !== undefined && declared.returned !== 'register' ? 1 : 0;
        const param =
          wideAt -
          hidden -
          (declared.byValue ?? []).filter((b) => b.word < wideAt).reduce((n, b) => n + b.words - 1, 0);
        fail(
          `cannot lift '${name}': one half of a 64-bit value would be handed to '${callee}' — its parameter ` +
            `${param + 1} is declared wider than a register, and this frontend passes each argument ` +
            'register as its own value rather than building the pair the ABI passes it in',
        );
      }
    }
    if (!lowering.stackArgs && declared !== null && wordsOf(declared.widths, target) > target.argRegs.length) {
      fail(
        `cannot lift '${name}': outgoing stack arguments not modelled — '${callee}' is declared with ` +
          `${declared.widths.length} parameters and the argument registers carry ${target.argRegs.length}, so the rest ` +
          `travel in its parameter area on the stack`,
      );
    }
    const pair = helper !== null && !lowering.pairs ? false : returnsPair(callee);
    // THE SAME RULE ON THE WAY BACK. The declaration reaches the candidate whether or not the
    // lowering can act on it (`l3/symbol-refs.ts` prints `long long g(void);`), so reading the
    // return register alone would lift `return g();` off one half under a declaration that makes
    // it mean the whole value.
    if (pair && !lowering.pairs) {
      fail(
        `cannot lift '${name}': '${callee}' would hand back one half of a 64-bit value — its return is ` +
          'declared wider than a register, and this frontend reads the return register as the whole ' +
          'value rather than building the pair the ABI hands back',
      );
    }
    // a struct returned through memory is the call's value, and argument 0 is where it lands; one
    // returned in registers is their bytes, whether or not anything states the call's arity
    const returned = declared?.returned ?? (declared === null && !wide ? registerStructReturn(callee) : undefined);
    // two answers to which registers hold the result, and to whether argument 0 is a hidden pointer
    if (pair && returned !== undefined) {
      fail(`cannot lift '${name}': \`${callee}\` is declared to return both a struct or union and a 64-bit value`);
    }
    // a runtime helper's return is its table's, whatever a project declares on its name
    const declaredVoid = !isRuntimeHelperName(callee) && declaresVoidReturn(own);
    const voided = lowering.voidReturn && declaredVoid;
    const image = returned === 'register' && registerStructLocal(known(prototypes, callee), target) !== undefined;
    // A FLOAT RETURNED WITHOUT AN FPU IS BITS IN THE RETURN REGISTER. The candidate prints the call
    // against the declaration, so `v = f()` into anything but a float converts the value (agbcc:
    // `bl f; bl __fixsfsi`), where the bytes moved the bits. The call names the type, and
    // `raise/floathelpers.ts` reads the result as that float or refuses. A target with an FPU
    // refused the call above; a runtime helper's return is its table's.
    const returnSpelling = own?.returns ?? declarationOf(callee)?.returns;
    const floatReturn =
      target.fpu === undefined && !isRuntimeHelperName(callee) && !voided && typeof returnSpelling === 'string'
        ? floatingSpelling(returnSpelling)
        : undefined;
    return {
      ...(floatReturn === undefined ? {} : { floatReturn }),
      widths: wide?.params ?? declared?.widths ?? null,
      doubles: declared?.doubles ?? new Set(),
      ...(declared?.byValue === undefined ? {} : { byValue: declared.byValue }),
      returns: voided
        ? { kind: 'void' }
        : pair
          ? { kind: 'pair' }
          : returned === undefined
            ? { kind: 'word' }
            : returned === 'register'
              ? { kind: 'register-struct', image }
              : { kind: 'memory-struct', type: returned.type },
      // a struct leaves the return register holding nothing the caller may read as a value, save
      // the image of one a local can be read off, and a void callee leaves it holding whatever the
      // callee did
      clobbers: pair
        ? pairReturnClobbers
        : (returned === undefined && !voided) || image
          ? callClobbers
          : [...callClobbers, target.returnReg],
      declaredVoid,
    };
  };
  // A VARIADIC DECLARATION WHOSE FIXED PARAMETERS ARE EACH ONE WORD STATES ITS FIRST ARGUMENTS:
  // they are the first that many argument words, exactly, so they are read as stated words and only
  // what the `...` takes is guessed, above them (`fallbackArgc`'s and the trim's `floor`). Read the
  // way a call through argument register rN reads the registers below N (`lower`): one this
  // function never wrote is its own argument passed on, and one a call destroyed names nothing and
  // refuses (`SsaBuilder.finish`). So `int logv(const char *, int, ...)` lifts `logv(s + 1, c)` as
  // `logv(a0 + 1, a1)`, where a guess from r0 sees r1 untouched and refuses the gap. A fixed list
  // holding an UNSIZED spelling states no such words — the one may be two — and gets no floor; a
  // fixed parameter known not to be one word refuses (`refuseUnplacedByValue`, in `declaredCall`).
  const variadicFloor = (callee: string | undefined): number => {
    const own = callee === undefined ? undefined : known(prototypes, callee);
    const fixed = own?.params === undefined ? own?.variadicParams : undefined;
    return fixed !== undefined && fixed.every((_, k) => paramClassOf(own!, fixed, k) === 'word') ? fixed.length : 0;
  };
  // A GUESS SHORTER THAN THE DECLARATION REFUSES. A declaration the lowering cannot lay out (an
  // UNSIZED spelling: `proto.ts` `declaredCallArgs`), or a variadic one whose fixed parameters
  // include one, still states how many parameters it has — fixed ones, for a variadic — and every
  // one of them is at least one argument word. A guess that counts fewer registers has dropped
  // arguments: the last one passed through unchanged leaves its register with no definition, so
  // `void h(int, Foo)` with `Foo` unresolved lifts `h(n + 1, v)` as `h(a0 + 1)`. The count bounds
  // the guess from below only — an unsized parameter may be two words, or a struct of several. A
  // variadic call with a `variadicFloor` never reaches the bound: its guess starts there.
  //
  // KNOWN GAP: this bounds the count `fallbackArgc` takes, not what `SsaBuilder.finish` later
  // retracts from it (a register a call between the setup and this one destroyed).
  const refuseShortOfDeclared = (callee: string | undefined, argc: number): void => {
    if (callee === undefined) {
      return;
    }
    const p = declarationOf(callee);
    const own = known(prototypes, callee);
    const stated = Array.isArray(p?.params)
      ? { n: p.params.length, what: 'parameters' }
      : own?.variadicParams !== undefined && own.params === undefined
        ? { n: own.variadicParams.length, what: 'fixed parameters before its `...`' }
        : undefined;
    if (stated !== undefined && argc < stated.n) {
      fail(
        `cannot lift '${name}': \`${callee}\` is declared with ${stated.n} ${stated.what}, which no layout here ` +
          `places, and the arity guess in its place finds ${argc} argument register${argc === 1 ? '' : 's'} set up — ` +
          'an argument passed through unchanged leaves its register with nothing the guess can see',
      );
    }
  };
  // A GAP IN A GUESSED ARITY IS DECIDED WHERE THE REGISTER ABOVE IT IS SURELY AN ARGUMENT
  // (`fallbackArgc`'s `decide`). The gap refuses because an argument register left at its incoming
  // value and one the call does not pass look the same — but only while nothing says the call takes
  // an argument above it. A register the call's own block wrote with a value that no memory read
  // produced and that nothing but the call reads says exactly that: an optimising compiler deletes a
  // dead computation, so the value exists only to be passed. And where argument words fill in order,
  // every word below an argument is an argument too, so the gap's registers are passed on unchanged.
  // Measured on 2026-10-18 at every toolchain's canonical flags: `logv(s, 1)` sets r1/a1/r4 alone,
  // and at -O0 no gap arises at all (every argument is reloaded from its home first).
  //
  // EACH CLAUSE IS A MEASURED COUNTEREXAMPLE, so each refuses:
  //   - the value must be the call's own block's. Where a discarded read may land in an argument
  //     register (`compilerBehaviors.discardedReadMayFillArgRegister`), it must also be something no
  //     memory read produced: agbcc puts a DISCARDED volatile read in the lowest free argument
  //     register (`*(volatile int *)K; g(s)` is `ldr r1,[r1]; bl g`, at -O0 too), the passgap shape
  //     exactly. gcc2.7.2kmc, gcc2.7.2 and the three mwcc builds do the same once their usual
  //     discard register (v0/v1, r0) is busy: `int a = ga * 3; *(volatile int *)&gx; ...; logv(s)`
  //     is `lw a1,0(v0); ... jal logv` on KMC and `lwz r4,gx` on mwcc, the bytes of the twin that
  //     passes the read. Only ido7.1 discards into $zero every time, so only there a load only the
  //     call reads is an argument: `logv(s, gx)` lifts. Nothing else may read the value either
  //     (`SsaBuilder.requireSoleReader`, asked of the finished function): `gx = 1; logv(s)` and
  //     `gx = 1; logv(s, 1)` are one agbcc object, the stored constant left in r1.
  //   - the value must be no instruction's side effect (`SsaBuilder.noteIncidentalWrite`): a base
  //     writeback is left in its register whether anything wants it or not. agbcc copies a struct of
  //     3+ words as `ldmia r3!, {r4, r5, r6}; stmia r2!, {r4, r5, r6}` and leaves both writebacks
  //     dead, so `*p = *q; return logv(s, n) + 1;` would lift `logv(a0, a1, a2 + 3, a3 + 3)`.
  //   - where a caller forwards its own destination as a callee's hidden pointer
  //     (`compilerBehaviors.forwardsStructReturnDestination`, ido7.1), a gap at the first argument
  //     register is decided only where the call's result is read (`SsaBuilder.requireReader`,
  //     owed by `lower`), by anything but a `ret`. `int b3(struct S *p){ *p = sg(1); return 0; }` is
  //     `jal sg; li a1,1` with a0 untouched, and would lift `sg(a0, 1)` even with `int b3(struct S *)`
  //     declared: the hidden pointer stated as a C argument, and the `*p =` store dropped. IDO reads
  //     no forwarded struct return's result register (five shapes, at the target.ts field), but a
  //     `ret` reads it in a function ending in the call, `void b7(struct S *p){ *p = sg(1); }`.
  //   - each gap register must hold the function's own incoming value on every path
  //     (`holdsEntryValue`): one a call destroyed is the trim's, and holds nothing.
  //   - where the ABI can leave a register empty below a filled one (target.ts `argRegisterHoles`)
  //     the gap may be that hole. An argument aligned to 8 skips an odd word (O32 a1, PowerPC
  //     r4/r6/r8), and the hole is ruled out only where that argument's second word holds nothing:
  //     no value reaches it and the own declaration fills fewer words. A leading float shadows the
  //     first general words on O32. It is ruled out only where the own declaration surely puts an
  //     integer word in each gap register. No register value can rule it out: the MIPS frontend
  //     refuses every instruction naming the FPU's file in a function that calls
  //     (frontend/mips.ts), so a float here is one passed on untouched in $f12, which nothing
  //     reads. A gap that starts at a1 under an a0 that only a read set up (`gx = a; gp(d, 5)`) is
  //     the 8-byte skip's case and refuses through it: a1 is odd, so it needs the own declaration's
  //     word bound, and `ownLeadingWordParamsOn` stops at the double.
  //   - where the own declaration binds the body, each gap register must surely hold one of its
  //     integer word parameters (`ownLeadingWordParamsOn`): no hidden struct pointer, no float.
  //   - at flags that keep a read nothing uses (`compilerBehaviors.keepsUnusedReads`, the -O0
  //     levels) the premise is suspended, as frontend/ppc.ts `computedPairHalf` suspends it. mwcc -O0
  //     keeps a dead `li r31,5`. The gap was measured never to arise there (mwcc -O0,p on all three
  //     builds, IDO -O1 and agbcc -O0 reload every argument from its home first), so this costs no
  //     lift.
  // What the decision leaves open above the proven register is the call's own check
  // (`decidedCallRefusal`). The proven register's value is returned, for the sole-reader
  // obligation the call then takes on.
  const decideGap = (
    ssa: SsaBuilder,
    bi: number,
    gap: readonly string[],
    set: string,
    accept: (v: Value) => boolean,
  ): Value | undefined => {
    const regs = target.argRegs;
    if (target.compilerBehaviors.keepsUnusedReads === true || !ssa.writtenSinceCall(set, bi)) {
      return undefined;
    }
    const v = ssa.readVar(set, bi);
    const def = ssa.irBlocks[bi].ops.find((op) => op.results.includes(v));
    const sig = def === undefined ? undefined : (OPCODES[def.opcode as keyof typeof OPCODES] as OpSig | undefined);
    const readsRefuse = target.compilerBehaviors.discardedReadMayFillArgRegister !== false;
    if (
      !accept(v) ||
      ssa.isIncidentalWrite(v) ||
      sig === undefined ||
      sig.effects ||
      (sig.reads && readsRefuse) ||
      sig.terminator ||
      def!.opcode === 'undef'
    ) {
      return undefined;
    }
    if (gap.some((g) => ssa.writtenSinceCall(g, bi) || !ssa.holdsEntryValue(g, bi))) {
      return undefined;
    }
    const own = ownDeclaration();
    const surelyOwn = own === undefined ? undefined : ownLeadingWordParamsOn(name, own.proto, target);
    if (surelyOwn !== undefined && gap.some((g) => regs.indexOf(g) >= surelyOwn)) {
      return undefined;
    }
    const holes = argRegisterHoles(target);
    if (holes.leadingFloatShadow && regs.indexOf(gap[0]) === 0 && own?.proves !== true) {
      return undefined;
    }
    const ownWords = own?.proves !== true ? undefined : ownArgumentWordsOn(name, own.proto, target);
    for (const g of gap.filter((r) => holes.skippable.has(r))) {
      const j = regs.indexOf(g);
      const second = regs[j + 2];
      if (
        regs[j + 1] !== set ||
        second === undefined ||
        ssa.hasReachingDef(second, bi, accept) ||
        ownWords === undefined ||
        j + 2 < ownWords
      ) {
        return undefined;
      }
    }
    return v;
  };
  // WHAT A DECIDED GAP LEAVES OPEN ABOVE THE COUNT: whether the call takes more than the `argc`
  // words counted. The decision proves that the gap registers are this function's own arguments
  // passed on. Past the count, the guess reads an unwritten register as no argument, as it does at
  // every gapless call, and three things say otherwise. Each refuses (returns true):
  //   - an own parameter that may sit past the count (`ownArgumentWordsOn`, an upper bound). It is
  //     just as likely passed on as the gap below it was. On gcc2.7.2kmc and ido7.1, `int ll6(int a,
  //     int b, int c, int d){ return g(a, 2, c, d, 5) + 1; }` leaves c and d in a2/a3 and would lift
  //     `g(a0, 2)`.
  //   - a word of the outgoing area that reaches the call (`guess.refuse`, asked as if the count
  //     filled every argument register). It is a fifth argument, so every register below it is an
  //     argument too: the same `ll6`'s `sw v0,16(sp)`.
  //   - a floating argument this ABI passes apart from the general words (`fpu.slots: 'separate'`,
  //     PowerPC), which no guess counts. `int fl2(int b, float x){ return g(b, x, 3) + 1; }` leaves
  //     x in f1 on all three mwcc builds and would lift `g(a0, 3)`. A float in f1 that nothing reads is
  //     invisible, so on such an ABI only an own declaration whose parameters are all integers rules
  //     it out. Without a declaration this refuses. A value reaching an FPU argument register refuses
  //     on every ABI.
  const decidedCallRefusal = (ssa: SsaBuilder, bi: number, argc: number, site: CallSite): boolean => {
    const own = ownDeclaration();
    if (own !== undefined) {
      const words = ownArgumentWordsOn(name, own.proto, target);
      if (words === undefined || words > argc) {
        return true;
      }
    }
    const fpu = target.fpu;
    if (fpu !== undefined) {
      if (fpu.argRegs.some((r) => ssa.hasReachingDef(r, bi, (v) => !site.placeholders?.has(v)))) {
        return true;
      }
      const floats = own === undefined ? undefined : ownDeclaresFloatingParam(name, own.proto);
      if (floats === true || (fpu.slots === 'separate' && !(own?.proves === true && floats === false))) {
        return true;
      }
    }
    try {
      site.guess.refuse?.(target.argRegs.length);
    } catch (e) {
      if (e instanceof FrontendUnsupportedError) {
        return true;
      }
      throw e;
    }
    return false;
  };
  // THE CALL A PLAN LOWERS TO, in one order on every ISA: the arity, each argument word, the
  // `call` op, the guessed arity's record, the result and the clobbers.
  const lower = (site: CallSite): void => {
    const { ssa, bi, pairs, guess, placeholders } = site;
    // whether `v`, reaching argument register `r`, may be an argument the caller set up
    const mayPass = (v: Value, r: string) => !placeholders?.has(v) && site.parked?.(v, r) !== true;
    const holes = argRegisterHoles(target);
    if (lowering.pairs !== (pairs !== undefined) || lowering.stackArgs !== (site.stackWord !== undefined)) {
      throw new Error(`target '${target.id}': a call site's pairs and stack words must be what its lowering states`);
    }
    const indirect = typeof site.callee === 'string' ? undefined : site.callee;
    const callee = typeof site.callee === 'string' ? site.callee : undefined;
    // A CALL THROUGH ARGUMENT REGISTER rN PASSES r0..r(N-1) where the lowering states it
    // (`CallLowering.argRegisterBoundsArity`): N bounds the arity, and reading every register below
    // it passes what the machine passes. An untouched one is this function's own argument passed
    // on; one a call destroyed names nothing, and its read refuses (`SsaBuilder.finish`). Through
    // any other register, or on a lowering that does not state it, the arity is guessed.
    //
    // KNOWN GAP: N is only a bound. agbcc's address lands above r(argc) when an argument register
    // still holds a live temp, and a pointer that arrived as an argument stays where it arrived
    // (`void f(int x, void (*g)(void)) { g(); }` calls through r1, the bytes `g(x)` compiles to), so
    // the registers in between read as arguments the source never passed. Only the pointer's
    // declared type decides the arity, and nothing reads one.
    const bound =
      indirect === undefined || !lowering.argRegisterBoundsArity ? -1 : target.argRegs.indexOf(indirect.reg);
    const p: CallPlan =
      indirect === undefined
        ? plan(callee!)
        : {
            widths: bound < 0 ? null : Array.from({ length: bound }, () => 32),
            doubles: new Set(),
            returns: { kind: 'word' },
            clobbers: callClobbers,
            declaredVoid: false,
          };
    // ONE LIST OF PARAMETER WIDTHS, FROM WHICHEVER SOURCE STATES THEM — the compiler's own
    // runtime table or the project's headers. Both answer the same question, so the walk that
    // reads argument registers off the answer is written once; two walks would be two chances
    // for the pairing rule and the arity rule to disagree.
    //
    // A DECLARATION HOLDING A SPELLING NOTHING CAN SIZE STATES NO LAYOUT (`proto.ts`
    // `declaredCallArgs`), so `widths` is null for it and this falls to the guess below —
    // the same answer the callee would get with no prototype at all.
    const { widths, returns } = p;
    // the leading arguments a variadic declaration states, where the rest is guessed
    const floor = widths === null ? variadicFloor(callee) : 0;
    // the gaps `decideGap` decided: the value that proved each, and the gap's own refusal, owed if
    // that proof fails once the function is lifted
    const decided: Array<{ value: Value; refuse: () => void }> = [];
    // the refusals of the decided gaps at the first argument register that the call's result must
    // be read to keep (`compilerBehaviors.forwardsStructReturnDestination`, at `decideGap`)
    const resultOwed: Array<() => void> = [];
    // how many argument words the decided gaps put beyond doubt
    let decidedWords = 0;
    const argc =
      widths === null
        ? fallbackArgc(ssa, target.argRegs, bi, {
            accept: mayPass,
            gap: { name, at: guess.at, fail },
            floor,
            parked: (r) =>
              !holes.skippable.has(r) &&
              !(holes.leadingFloatShadow && r === target.argRegs[0]) &&
              (ssa.holdsValue(r, bi, (v) => site.parked?.(v, r) === true) ||
                // a call in the case destroyed it: the hole is that call's, and refuses only where a
                // register above holds a value written since (`fallbackArgc`'s `parked`)
                (ssa.hasReachingDef(r, bi, (v) => site.parked?.(v, r) === true) &&
                  !target.argRegs
                    .slice(target.argRegs.indexOf(r) + 1)
                    .some((a) => ssa.holdsValue(a, bi, (v) => mayPass(v, a))))),
            decide: (gap, set, refuse) => {
              const value = decideGap(ssa, bi, gap, set, (v) => mayPass(v, set));
              if (value === undefined) {
                return false;
              }
              decided.push({ value, refuse });
              if (gap[0] === target.argRegs[0] && target.compilerBehaviors.forwardsStructReturnDestination !== false) {
                resultOwed.push(refuse);
              }
              decidedWords = target.argRegs.indexOf(set) + 1;
              return true;
            },
            entry: (reg) =>
              !ssa.writtenSinceCall(reg, bi) &&
              ssa.holdsValue(
                reg,
                bi,
                (v) => mayPass(v, reg) && ssa.paramReg.get(v) === reg && ssa.irBlocks[0].params.includes(v),
              ),
          })
        : wordsOf(widths, target);
    if (widths === null) {
      const index = target.argRegs
        .slice(floor, argc)
        .find((r) => ssa.hasReachingDef(r, bi, (v) => site.scaledIndex?.(v, r) === true));
      if (index !== undefined) {
        fail(
          `cannot lift '${name}': the call ${typeof guess.at === 'number' ? `at 0x${guess.at.toString(16)}` : guess.at} ` +
            `has no prototype, and ${index}, which the arity guessed without one counts, still holds the index the ` +
            "jump table's dispatch scaled — a call handed it and one that is not compile to the same bytes, so the " +
            'argument count is not decidable',
        );
      }
      // the lowest argument register past the stated ones that a marker or the scaled index a
      // dispatch left there may reach, parked or not (a PowerPC pair's r4 never parks): where the
      // pre-dispatch value stood
      const markedAt = target.argRegs.findIndex(
        (r, k) =>
          k >= floor &&
          ssa.hasReachingDef(r, bi, (v) => site.parked?.(v, r) === true || site.scaledIndex?.(v, r) === true),
      );
      parkedInArgs ||= markedAt >= 0;
      if (passThrough === undefined) {
        const call = typeof guess.at === 'number' ? `at 0x${guess.at.toString(16)}` : guess.at;
        const last = target.argRegs[argc - 1];
        // the blocks since the dispatch on the way to the call: a path stops at a `switch_br`'s block
        const since = new Set<number>([bi]);
        const dispatch = (at: number) => ssa.irBlocks[at].ops.some((op) => op.opcode === 'switch_br');
        const lastWritten = argc <= floor || ssa.writtenOnEveryPath(last, bi, dispatch, (at) => since.add(at));
        // what an effect those blocks made so far reads
        const effectReads = new Set(
          [...since].flatMap((at) =>
            ssa.irBlocks[at].ops.flatMap((op) =>
              (OPCODES[op.opcode as keyof typeof OPCODES] as OpSig | undefined)?.effects ? op.operands : [],
            ),
          ),
        );
        const stored = target.argRegs
          .slice(floor, argc)
          .find((r) => ssa.holdsValue(r, bi, (v) => mayPass(v, r) && effectReads.has(v)));
        const leftIncoming =
          markedAt < 0 ? undefined : target.argRegs.slice(argc, markedAt).find((r) => ssa.holdsEntryValue(r, bi));
        if (!lastWritten) {
          passThrough = {
            call,
            reg: last,
            why: 'the last register the count takes, holds a value some path since the dispatch did not write',
          };
        } else if (stored !== undefined) {
          passThrough = { call, reg: stored, why: 'which the count takes, holds a value an effect of its block uses' };
        } else if (leftIncoming !== undefined) {
          passThrough = {
            call,
            reg: leftIncoming,
            why: "which the count leaves out below a dispatch's register, holds its incoming value",
          };
        }
      }
      guess.refuse?.(argc);
      refuseShortOfDeclared(callee, argc);
      if (decided.length > 0 && decidedCallRefusal(ssa, bi, argc, site)) {
        decided[0].refuse();
      }
    }
    // WHAT EVERY ARGUMENT REGISTER HOLDS HERE, where no declaration stated the arity: a value the
    // count leaves out (or a later trim cuts) may be an argument the source passed, so the dead-read
    // pin may not call it unused. Asked through `holdsValue`, which reads no register.
    if (widths === null || bound >= 0) {
      for (const r of target.argRegs) {
        ssa.holdsValue(r, bi, (v) => {
          heldAtUndeclaredCall.add(v);
          return false; // keep walking: every path's value, not the first
        });
      }
    }
    // WHAT THE ARITY LEFT OUT, where no declaration stated it: an argument register past a guessed
    // count, or past the bound a call through an argument register sets, that a value reaches.
    // The gap refusal has already fired on any such register past a guess; past the bound, the
    // register leaves the call silently, and the frontend says whether it knows that one to be an
    // argument all the same.
    if (site.leftOut !== undefined && (widths === null || bound >= 0)) {
      site.leftOut(
        target.argRegs
          .slice(argc)
          .filter((r) => r !== indirect?.reg && ssa.hasReachingDef(r, bi, (v) => mayPass(v, r))),
        target.argRegs.slice(0, argc),
      );
    }
    // ARGUMENT WORD `k`: a register, or past the registers the word the frontend's ABI places
    // there. A guess never exceeds `argRegs.length`, so a stack word can only come from a stated
    // width.
    const word = (k: number): Value => (k < target.argRegs.length ? site.read(target.argRegs[k]) : site.stackWord!(k));
    // A GUESSED arity reads argument registers to ASK whether the caller set them up, and
    // `finish()` answers by dropping the ones a call has been through; a STATED width asserts
    // they exist, so a destroyed register read for it is a wrong value nothing retracts. A
    // guess is a list of single words by construction — `fallbackArgc` counts registers.
    const guessed = (k: number): Value => {
      const r = target.argRegs[k];
      const v = ssa.readGuessedArg(r, bi);
      return placeholders ? placeholders.guardRead(name, r, v) : v;
    };
    const args: Value[] = [];
    let k = 0;
    for (const w of widths ?? Array.from({ length: argc }, () => 32)) {
      // A 64-BIT PARAMETER IS TWO ARGUMENT WORDS AND ONE VALUE, so the pair is built here
      // rather than recovered from two 32-bit arguments later — `contracts.ts` would fire on
      // the second reading anyway, since the structurer materialises an effectful call once
      // per result. Its words are wherever the frontend's ABI placed them.
      args.push(w > 32 ? pairs!.fuse(word(k), word(k + 1)) : widths === null && k >= floor ? guessed(k) : word(k));
      k += w > 32 ? 2 : 1;
    }
    // A 64-BIT VALUE MAY NOT LEAVE AS A WORD WHERE NOTHING SAYS HOW WIDE THE PARAMETER IS,
    // and this is the refusal — GUARDED ON `widths === null`, which is the whole of the
    // condition. A guessed arity counts argument registers, so a caller that computes a pair
    // and a caller that computes two words set up the same two registers: passing the low
    // half alone invents a truncation the asm never wrote, passing both halves as two words
    // invents an argument. Both recompile to the very call being lifted, so the differ
    // scores them exactly as it scores the right answer and nothing downstream can referee
    // either.
    //
    // A STATED WIDTH IS THE DISAMBIGUATION AND IT IS ONE WHETHER IT SAYS 64 OR 32. A stated
    // 64 built the pair in the walk above. A stated 32 says the callee takes a word, so
    // handing it a half is the narrowing the header authorises — `void sink(int)` against
    // `sink((int)(a * b))` — and refusing it here would contradict a fact the user supplied.
    //
    // SO THE MESSAGE IS ABOUT THE WIDTH AND NOT ABOUT A PROTOTYPE, because a supplied one
    // reaches here too: a typed list holding a spelling `declaredWidth` cannot size states
    // no layout at all (`proto.ts` `declaredCallArgs`), and a bare COUNT states argument
    // registers rather than widths. Both leave `widths` null with a `--proto` on the command
    // line, and blaming an absent prototype would be false about its own input.
    if (widths === null && pairs !== undefined) {
      // no prototype keys a call through a register, so the hint names one only for a named callee
      const theCall = indirect === undefined ? `the call to '${callee}'` : `the call through ${indirect.reg}`;
      const itsParams = indirect === undefined ? `'${callee}'s parameters` : "the function pointer's parameters";
      // a stated fixed word (`variadicFloor`) takes a half as the narrowing its declaration authorises
      for (const [j, v] of args.entries()) {
        const half = j < floor ? undefined : pairs.halfOf.get(v);
        // A DOUBLE THE RUNTIME RETURNED IS NO long long, so the hint below would send the
        // reader to the wrong declaration: a double leaves a soft-float helper only into
        // another one, the return, or a parameter declared `double` (`raise/floathelpers.ts`),
        // and a pair built here for a callee declared to take a `long long` is refused there.
        const producer = half && pairCallee.get(half.whole);
        if (half && producer && isFloatHelperName(producer)) {
          fail(
            `cannot lift '${name}': argument ${j + 1} of ${theCall} is the ` +
              `${half.half === 'lo' ? 'low' : 'high'} half of a 64-bit value, the double '${producer}' ` +
              `returned, and nothing states how wide ${itsParams} are. A double is ` +
              "modelled into the runtime's arithmetic helpers, the return and a parameter a prototype " +
              'declares `double`, so a runtime compare or conversion declines' +
              (indirect === undefined
                ? '; a callee that takes a double, or fewer arguments than its registers suggest, lifts ' +
                  `once a prototype states them (\`{"${callee}": {"params": [...]}}\`)`
                : ''),
          );
        }
        if (half) {
          fail(
            `cannot lift '${name}': argument ${j + 1} of ${theCall} is the ` +
              `${half.half === 'lo' ? 'low' : 'high'} half of a 64-bit value, and nothing states ` +
              `how wide ${itsParams} are, so a pair cannot be told from two ordinary arguments` +
              (indirect === undefined
                ? `. A typed prototype states it (\`{"${callee}": {"params": ` +
                  '["long long", …]}}`); a count, or a list holding a spelling asmlift cannot size, does not'
                : ' — not modelled'),
          );
        }
      }
    }
    const sret = returns.kind === 'memory-struct' ? returns.type : undefined;
    const res = mkValue(sret ?? T.unk(returns.kind === 'pair' ? 64 : 32));
    // A DECLARED `double` IS TWO WORDS THAT ARE NOT A `long long`: its first word holds the
    // sign and exponent (`TargetDescription.doubleArgWords`), so the pair read as an integer
    // spells a different number — `g(1.5)` as `g(1073217536, 0)`. The call names the operands
    // that are doubles, and `raise/floathelpers.ts` retypes each or refuses it.
    const doubles = p.doubles.size ? [...p.doubles] : undefined;
    // A STRUCT PASSED BY VALUE IS ITS WORDS HERE, one operand each, and the call names them as
    // (first operand, words) pairs: `foldByValueArgs` folds them into the one object passed whole
    // once the function is lifted, or refuses.
    const byValue = p.byValue?.flatMap((b) => [b.word, b.words]);
    const call = mkOp('call', {
      operands: indirect === undefined ? args : [...args, indirect.address],
      results: [res],
      attrs: {
        ...(callee !== undefined ? { target: callee } : { indirect: true }),
        ...(sret === undefined ? {} : { sret: true }),
        ...(returns.kind === 'register-struct' && returns.image ? { [REGISTER_STRUCT]: true } : {}),
        ...(doubles === undefined ? {} : { doubles }),
        ...(p.floatReturn === undefined ? {} : { floatReturn: p.floatReturn }),
        ...(byValue === undefined ? {} : { byValueWords: byValue }),
      },
    });
    ssa.irBlocks[bi].ops.push(call);
    for (const d of decided) {
      ssa.requireSoleReader(d.value, call, d.refuse);
    }
    for (const refuse of resultOwed) {
      if (returns.kind === 'word') {
        ssa.requireReader(res, refuse);
      } else {
        refuse();
      }
    }
    // A GUESSED arity is revisited in `finish()`: only once the whole function is lifted is it
    // known whether every path to here passes through another call, which would have clobbered
    // the argument registers this guess just read.
    //
    // A CALL THROUGH A REGISTER IS PASSED AN EARLIER CALLEE'S RESULT its guess reads, which the trim
    // drops from a named call (`trimClobberedCallArgs`): no declaration checks a call through a cast
    // to an unprototyped type, so a dropped argument would never be refused, and `p(g())` would lift
    // as `g(); p();`, which compiles to the same bytes. Kept, it lifts as `p(g())`, which passes what
    // the machine passes — unless `g` is declared void, and its result names nothing.
    //
    // …AND WHAT THE TRIM CUTS IS LEFT OUT TOO, so the frontend is asked the `leftOut` question of it
    // as well: a guess of four the check above passed can still lose a frame address in r2 when
    // the trim cuts it back to the run below an unfresh r1 (`v = f64(); g(v, &s)` with neither
    // declared, which otherwise lifts as `g(v)`).
    if (widths === null) {
      const leftOut = site.leftOut;
      ssa.recordGuessedCall(
        call,
        bi,
        target,
        indirect === undefined ? undefined : (r) => !voidResults.has(r),
        leftOut === undefined
          ? undefined
          : (cut, kept) =>
              leftOut(
                cut.filter((r) => r !== indirect?.reg),
                kept,
              ),
        site.withholdsSetupArgs,
        site.asksEveryCut,
        // a decided gap puts its words beyond doubt, so neither reading cuts below them
        Math.max(floor, decidedWords),
      );
    }
    if (p.declaredVoid) {
      voidResults.add(res);
    }
    if (returns.kind === 'pair') {
      // A PAIR RETURN IS ONE VALUE, SPLIT. The callee defines BOTH registers, so both are
      // named here and neither is in the clobber set — which is the acceptance arm of the
      // very rule whose refusal arm `frontend/ssa.ts` applies to every other register.
      site.write(target.returnReg, pairs!.project(res, 'lo'));
      site.write(target.argRegs[1], pairs!.project(res, 'hi'));
      if (callee !== undefined) {
        pairCallee.set(res, callee);
      }
    } else if (returns.kind === 'word' || (returns.kind === 'register-struct' && returns.image)) {
      site.write(target.returnReg, res); // the callee defines the return register …
    }
    // … and the clobber is recorded after it, so that def is the CALLEE's; a struct, the memory at
    // argument 0 or the return register's bytes, leaves that register holding nothing the caller
    // may read as a value, save the image of one a local is declared for, which a guessed arity
    // still does not count (`SsaBuilder.noteStructImage`)
    ssa.noteCall(bi, p.clobbers);
    if (returns.kind === 'register-struct' && returns.image) {
      ssa.noteStructImage(bi, target.returnReg, res);
    }
  };
  return {
    callClobbers,
    returnsWithoutHiddenPointer: (callee) => returnsWithoutHiddenPointer(callee, prototypes, target),
    declaredCall,
    declaredParams,
    plan,
    lower,
    heldAtUndeclaredCall,
    refuseDispatchUnlockedPassThrough: (caseStateRead) => {
      if ((parkedInArgs || caseStateRead) && passThrough !== undefined) {
        fail(
          `cannot lift '${name}': the call ${passThrough.call} has no prototype, and ${passThrough.reg}, ` +
            `${passThrough.why}, in a function that lifts only through what a jump-table dispatch left in its ` +
            'registers — the arity guessed without a prototype and another compile to the same bytes, so the ' +
            'argument count is not decidable',
        );
      }
    },
  };
}

// A CALLEE DECLARED TO RETURN A STRUCT OR UNION BY VALUE, where the target returns it through
// memory: the caller hands it the storage in argument 0 and every declared argument one register
// up (on agbcc, thumb.h:644-645, 672), so the call's first word is that pointer. What it returns in
// the return register is not a value the caller reads (calls.c: the struct is the memory at the
// address). One the target returns in registers takes its arguments where they are declared, and
// its registers hold the struct's bytes: the call is `'register'`, and the return register is the
// struct's image where a local of it can be declared (`registerStructLocal`) and holds nothing the
// caller may read otherwise. Every other struct-returning call refuses, naming why.
function structReturnOf(
  name: string,
  target: TargetDescription,
  callee: string,
  own: FnProto,
  fail: FrontendRefusal,
): StructReturn | 'register' {
  const read = returnedStruct(own, target);
  if (typeof read === 'object' && 'refused' in read) {
    fail(
      `cannot lift '${name}': \`${callee}\` is declared to return ${own.returns ?? 'a struct or union'} by value, and ${read.refused}`,
    );
  }
  return read as StructReturn | 'register';
}

/** HOW A FUNCTION DECLARED TO RETURN A STRUCT OR UNION BY VALUE HANDS IT BACK on this target: the
 *  struct laid out as a local of it is declared (`type`) where the target returns it through a
 *  hidden pointer in argument 0, `'register'` where it returns it in registers, and the reason
 *  otherwise. Both halves of the return read this: a call to such a callee (`structReturnOf`) and a
 *  function that itself returns one (pipeline.ts `ownStructReturnThroughMemory`). */
export function returnedStruct(
  own: FnProto,
  target: TargetDescription,
): { type: Extract<IrType, { kind: 'struct' }> } | 'register' | { refused: string } {
  const layout = returnedAggregate(own);
  const inMemory = returnsInMemory(layout, target);
  if (inMemory === undefined) {
    return {
      refused:
        'nothing here says whether it comes back through a hidden pointer — its members are not all known, this target does not ' +
        'say how it lays one of them out (an enum, a bitfield), or it states no rule ' +
        '(a prototype states them as `returnLayout`, a context by defining the struct)',
    };
  }
  if (inMemory === false) {
    return 'register';
  }
  const type = structLocalType(own, target);
  return 'refused' in type ? type : { type };
}

/** The struct a declaration returns by value as a local of it is declared, or why it has none. */
export function structLocalType(
  own: FnProto,
  target: TargetDescription,
): Extract<IrType, { kind: 'struct' }> | { refused: string } {
  // the local it lands in is declared as the header spells the type, qualifiers aside; the tag
  // is what the declarations block defines it by, and a typedef name is that tag too
  const spelling = (own.returns ?? '')
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const tag = /^(?:(?:struct|union)\s+)?([A-Za-z_]\w*)$/.exec(spelling)?.[1];
  if (tag === undefined) {
    return { refused: 'it names no type a local of it could be declared with' };
  }
  const type = aggregateType(tag, spelling, returnedAggregate(own), target);
  if (type?.kind !== 'struct') {
    return {
      refused:
        'it is a union, or its members are not all known or this target does not say how it lays one of them out ' +
        '(an enum, a bitfield) — the local it lands in has no type here',
    };
  }
  return type;
}

// A STRUCT RETURNED IN THE RETURN REGISTER IS READ OFF A LOCAL OF IT (frontend/register-struct-call.ts).
// The register holds the struct's bytes as the target lays them in a word: from bit 0 up where
// the target is little-endian (agbcc's `{u16}` is `strh r0` off the call), from bit 31 down where it
// is big-endian (mwcc's is `srwi r0,r3,16`). So the register is the struct's image, which the call
// writes and `liftRegisterStructCalls` re-reads as a load of the local the call assigns, and the
// member a later read takes out of it is that local's member: `s = mk(x); gV = s.h;`, which is
// what every such compiler compiles to these bytes. Only the declaration says the call returns a
// struct at all, since the bytes are a scalar callee's, so only a callee the project declares
// gets one, and only where the local can be:
//   - declared with a type (`structLocalType`): a union or a bitfield has none here;
//   - one, two or four bytes, the widths one load reads whole — three bytes, or the second
//     register of an eight-byte struct, is an image no load here builds;
//   - printed beside its callee's prototype, which the declarations block defines it by;
//   - all integers: a floating member has no spelling here that reads its bits as the float they
//     are (structure.ts `frameStructMember` spells an integer field), and `*(s32 *)&s` stored to a
//     `float` converts the value (agbcc: `bl __floatsisf`).
// Otherwise the register still holds nothing the caller may read. The ONE derivation of that type:
// the call plan marks the call by it, and `liftRegisterStructCalls` declares the local by it.
export function registerStructLocal(
  own: FnProto | undefined,
  target: TargetDescription,
): Extract<IrType, { kind: 'struct' }> | undefined {
  if (own === undefined) {
    return undefined;
  }
  const type = structLocalType(own, target);
  if ('refused' in type || ![1, 2, 4].includes(type.size ?? 0) || hasFloatingMember(type)) {
    return undefined;
  }
  return spellableProto(own, target, type) === undefined ? undefined : type;
}

function hasFloatingMember(t: IrType): boolean {
  switch (t.kind) {
    case 'float':
      return true;
    case 'struct':
      return t.fields.some((f) => hasFloatingMember(f.type));
    case 'union':
      return t.members.some((f) => hasFloatingMember(f.type));
    case 'array':
      return hasFloatingMember(t.elem);
    default:
      return false;
  }
}

/** A STRUCT PASSED BY VALUE IS THE ONE OBJECT ITS ARGUMENT WORDS HOLD AT THE CALL. The lowering
 *  hands its words over one operand each (`byValueWords`, pairs of first operand and word count);
 *  C passes the struct, so the words must be one object's, whole, and that object is what the call
 *  is handed. Two objects are:
 *
 *  - A FRAME OBJECT the words are loaded off — word loads at consecutive words from one `laddr`
 *    offset. The operand becomes that offset's address, and the frame-object audit judges the
 *    object as the struct (frame-objects.ts `objectShapes`).
 *  - A GLOBAL the words are loaded off, or were just stored to — word accesses at consecutive words
 *    from the symbol's own address (`gaddr`, one or one per word of the same symbol), loaded off it
 *    or stored there as the very values passed. The operand becomes the symbol's address, spelled
 *    bare (`take(gS)`), which compiles only where the declarations type the global as the struct.
 *    So a symbol C cannot name (a section symbol, `.bss`; a function-scope static's `sQ.3`)
 *    refuses, and so does one the declaration context or the symbol map types as anything else:
 *    the struct at offset 0 of `gQs[4]` or of `struct O2 { struct Q q; … } gO2` sits at the
 *    symbol's own address too, and `take(gQs)` is a type error against the header that declares
 *    it (`bareStructRefusal`).
 *
 *  Either way every access is unqualified and in the call's own block, and no store or call lies
 *  between the earliest of them and the call but those accesses themselves, so the object holds at
 *  the call what the words carry. Every other source — registers computed in place, words off two
 *  objects, off a pointer or into a global's interior, a store the call may not see last — refuses.
 *
 *  The operand's value is typed a pointer to the struct, and a global's `gaddr` is a fresh one that
 *  names the struct too (`passedAs`), so value numbering never merges it with a plain address of
 *  the symbol. The call then names which operands it passes by value (`byValue`, pairs of operand
 *  and declared parameter, read by ir/core.ts `byValueOperands`). */
export function foldByValueArgs(
  name: string,
  irBlocks: Block[],
  calls: Pick<CallDeclarations, 'declaredCall'>,
  declarations: { symbols: SymbolMap | undefined; context: ContextGlobals | undefined },
): void {
  const defs = new Map<Value, { op: Op; blk: Block }>();
  for (const blk of irBlocks) {
    for (const op of blk.ops) {
      op.results.forEach((r) => defs.set(r, { op, blk }));
    }
  }
  for (const blk of irBlocks) {
    for (const call of [...blk.ops]) {
      const words = call.attrs.byValueWords as number[] | undefined;
      if (call.opcode !== 'call' || words === undefined) {
        continue;
      }
      const callee = calleeName(call);
      const declared = callee === undefined ? undefined : calls.declaredCall(callee)?.byValue;
      const pairs = Array.from({ length: words.length / 2 }, (_, i) => {
        const arg = declared?.find((b) => b.word === words[2 * i]);
        const type = arg?.type;
        if (type?.kind !== 'struct' || type.size === undefined) {
          throw new Error(`internal: a by-value operand of a call to '${callee}' has no declared struct`);
        }
        return { first: words[2 * i], n: words[2 * i + 1], type, param: arg!.param };
      });
      // highest first, so folding one leaves the operand places of those below it as they were
      for (const { first, n, type } of [...pairs].sort((x, y) => y.first - x.first)) {
        const at = blk.ops.indexOf(call);
        const passed = call.operands.slice(first, first + n);
        // the earliest of `accesses` and every op after it up to the call writes nothing else
        const settled = (accesses: readonly Op[]): boolean => {
          const earliest = Math.min(...accesses.map((a) => blk.ops.indexOf(a)));
          return blk.ops
            .slice(earliest, at)
            .every((op) => (op.opcode !== 'store' && op.opcode !== 'call') || accesses.includes(op));
        };
        // a word access at byte `start + 4 * i` from one base, unqualified, in the call's block
        // before the call
        const wordAt = (op: Op | undefined, i: number, base: Value | undefined, start = 0): op is Op =>
          op !== undefined &&
          blk.ops.indexOf(op) >= 0 &&
          blk.ops.indexOf(op) < at &&
          (op.attrs.width as number) === 4 &&
          !qualified(op) &&
          op.operands[0] === base &&
          (op.attrs.off as number) === start + 4 * i;
        const loads = passed.map((v) => defs.get(v)?.op);
        const loaded = loads.every((d) => d?.opcode === 'load');
        const base0 = loaded ? loads[0]!.operands[0] : undefined;
        const baseDef = base0 === undefined ? undefined : defs.get(base0)?.op;
        let object: Op | undefined;
        if (baseDef?.opcode === 'laddr') {
          // off the frame, through one `laddr` or several of the same offset (the slot model mints
          // one per access): the displacement is past the `laddr`'s own offset
          const frameAt = loads.map((d) => {
            const b = defs.get(d!.operands[0])?.op;
            return b?.opcode === 'laddr' && wordAt(d, 0, d!.operands[0], d!.attrs.off as number)
              ? (b.attrs.off as number) + (d!.attrs.off as number)
              : undefined;
          });
          const from = frameAt[0];
          if (from !== undefined && frameAt.every((o, i) => o === from + 4 * i) && settled(loads as Op[])) {
            object = mkOp('laddr', { results: [mkValue(T.ptr(type))], attrs: { off: from } });
          }
        } else {
          const symbol = (v: Value | undefined): string | undefined => {
            const d = v === undefined ? undefined : defs.get(v)?.op;
            return d?.opcode === 'gaddr' && d.attrs.code !== true ? (d.attrs.sym as string) : undefined;
          };
          // ONE SYMBOL, NOT ONE VALUE: kmc addresses each word through a `lui`/`lw` pair of its own,
          // so the words come off several `gaddr`s of the same symbol rather than one base. Each
          // access is still at its word's offset from the symbol's own address.
          const ofSymbol = (op: Op | undefined, i: number, sym0: string): op is Op =>
            op !== undefined && symbol(op.operands[0]) === sym0 && wordAt(op, i, op.operands[0]);
          const sym0 = symbol(base0);
          let sym: string | undefined;
          if (loaded && sym0 !== undefined && loads.every((d, i) => ofSymbol(d, i, sym0)) && settled(loads as Op[])) {
            sym = sym0;
          } else {
            // the words stored to a global just before the call: the last store of each, in order
            const stores = passed.map((v) =>
              blk.ops
                .slice(0, at)
                .filter((op) => op.opcode === 'store' && op.operands[1] === v)
                .at(-1),
            );
            const sink = symbol(stores[0]?.operands[0]);
            if (sink !== undefined && stores.every((st, i) => ofSymbol(st, i, sink)) && settled(stores as Op[])) {
              sym = sink;
            }
          }
          const misnamed = sym === undefined ? undefined : bareStructRefusal(sym, type, declarations);
          if (misnamed !== undefined) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': the call to \`${callee ?? 'a function pointer'}\` passes ${structSpelling(type)} ` +
                `by value off '${sym}', and ${misnamed} — the struct would be spelled as that symbol bare`,
            );
          }
          if (sym !== undefined) {
            object = mkOp('gaddr', {
              results: [mkValue(T.ptr(type))],
              attrs: { sym, passedAs: structSpelling(type) },
            });
          }
        }
        if (object === undefined) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': the call to \`${callee ?? 'a function pointer'}\` passes ${structSpelling(type)} ` +
              'by value, and its words are not one frame object or one global, read whole just before the call — ' +
              'a struct passed from anywhere else is not modelled',
          );
        }
        blk.ops.splice(at, 0, object);
        call.operands.splice(first, n, object.results[0]);
        // the word loads, and a frame address only they read, are dead now, and would otherwise be
        // judged as accesses of their own
        for (const d of loads) {
          if (d?.opcode === 'load') {
            dropIfUnread(irBlocks, d);
            const b = defs.get(d.operands[0])?.op;
            if (b?.opcode === 'laddr') {
              dropIfUnread(irBlocks, b);
            }
          }
        }
      }
      // each folded struct is one operand now: its place is its first word less the words folded
      // below it
      const sorted = [...pairs].sort((x, y) => x.first - y.first);
      const { byValueWords: _, ...attrs } = call.attrs;
      call.attrs = {
        ...attrs,
        byValue: sorted.flatMap(({ first, param }) => [
          first - pairs.filter((q) => q.first < first).reduce((m, q) => m + q.n - 1, 0),
          param,
        ]),
      };
    }
  }
}

/** Why the global `sym` cannot be spelled bare as the struct `type` a call passes by value, or
 *  undefined where it can: a C name, declared as exactly that struct where a declaration context or
 *  a symbol map types it at all. A symbol neither types is declared from the call (declare.ts
 *  `passedAs`). */
function bareStructRefusal(
  sym: string,
  type: IrType,
  { symbols, context }: { symbols: SymbolMap | undefined; context: ContextGlobals | undefined },
): string | undefined {
  // the linker's name for the object, where it is one no C source spells: a static at its
  // section's start relocated against the section (`.bss`), or a function-scope static's name and
  // counter (`sQ.3`), which only the static's definition spells (frontend/reloc-symbol.ts)
  const unspellable = unspellableReason(sym);
  if (unspellable !== null) {
    return `that is no name C can spell: it ${unspellable}`;
  }
  // ONE STRUCT, MANY SPELLINGS: `typedef struct Q {…} Q_t;` spells it `Q_t` and `struct Q`, and a
  // header passes one and declares the other. Each side is resolved to the struct it names through
  // the context's typedefs (`structNamed`), and a spelling that resolves to none matches only as
  // written.
  const spelling = structSpelling(type);
  const passed = structNamed(spelling, context);
  const isPassed = (other: string): boolean =>
    other === spelling || (passed !== undefined && structNamed(other, context) === passed);
  if (context?.declared.has(sym) && !isPassed(context.objectTypes.get(sym) ?? '')) {
    return `the declaration context does not declare it as ${spelling} (an array, an enclosing struct, another type)`;
  }
  const info = symbols === undefined ? undefined : symbolsByName(symbols, new Set([sym])).get(sym);
  // the map names a struct by its tag, or by the typedef name that binds an untagged one
  // (symbols.ts `structName`)
  const mapped = info?.structName;
  if (
    info?.shape !== undefined &&
    !(info.shape === 'struct' && mapped !== undefined && (isPassed(`struct ${mapped}`) || passed === mapped))
  ) {
    return `the symbol map types it as ${info.shape === 'struct' ? `struct ${info.structName ?? '(untagged)'}` : `${info.shape === 'array' ? 'an' : 'a'} ${info.shape}`}`;
  }
  return undefined;
}

/** Removes `op` where nothing reads its result. */
function dropIfUnread(irBlocks: Block[], op: Op): void {
  const r = op.results[0];
  const read = irBlocks.some((b) =>
    b.ops.some((x) => x.operands.includes(r) || x.successors.some((sc) => sc.args.includes(r))),
  );
  if (!read) {
    for (const b of irBlocks) {
      b.ops = b.ops.filter((x) => x !== op);
    }
  }
}
