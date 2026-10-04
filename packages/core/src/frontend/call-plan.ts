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
import { aggregateType, returnedAggregate, returnsInMemory, returnsWithoutHiddenPointer } from '../aggregate';
import { type Value, mkOp, mkValue } from '../ir/core';
import { type IrType, T, typeToString } from '../ir/types';
import {
  type FnProto,
  type Prototypes,
  STANDARD_SIGNATURES,
  declaredCallArgs,
  declaredReturnWidth,
  declaresAggregateReturn,
  declaresParams,
  declaresVoidReturn,
  isFloatingSpelling,
  spellableProto,
  wordsOf,
} from '../proto';
import { helperPrototypes, isFloatHelper, isWideHelper, lookupHelper } from '../runtime-helpers';
import type { TargetDescription } from '../target';
import type { FrontendRefusal } from './errors';
import type { HighHalves } from './high-half';
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
}

/** What one call is, decided from its callee's declaration before any instruction is read. */
export interface CallPlan {
  /** each argument's width, a hidden pointer first; null when nothing sizes them, so `lower`
   *  guesses */
  readonly widths: readonly number[] | null;
  /** the indices into `widths` its declaration types `double` */
  readonly doubles: ReadonlySet<number>;
  readonly returns:
    | { readonly kind: 'word' }
    | { readonly kind: 'void' }
    | { readonly kind: 'pair' }
    | { readonly kind: 'register-struct' }
    | { readonly kind: 'memory-struct'; readonly type: IrType };
  /** what the call leaves holding nothing this function can name, for `SsaBuilder.noteCall` */
  readonly clobbers: readonly string[];
  /** the callee is declared void, whether or not this lowering writes no value for it (`returns`
   *  is `void` only where `CallLowering.voidReturn` says so) */
  readonly declaredVoid: boolean;
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
  /** `lower`'s first half, the call decided from the declaration alone: a value its tests compare
   *  whole, where `lower` leaves IR */
  plan(callee: string): CallPlan;
  /** the call `site` makes, planned and lowered: its `call` op, its result and its clobbers */
  lower(site: CallSite): void;
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
  /** the high halves this frontend defines registers with, which are no argument */
  readonly highHalves?: HighHalves;
  /** what a guessed arity refuses on; without it a gap in the argument registers ends the count */
  readonly guess?: {
    /** the call's address, for the gap refusal */
    readonly at: number;
    /** refuses a guess of `argc` words this ABI's outgoing area could extend */
    refuse(argc: number): void;
  };
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
): CallDeclarations {
  // What a call leaves holding nothing this function can name — checked against `argRegs` there.
  const callClobbers = clobberedByCall(target);
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
  const isFloatHelperName = (callee: string): boolean => {
    const h = lookupHelper(target.runtimeHelpers, callee);
    return h !== undefined && isFloatHelper(h);
  };
  /** the callee that handed back each pair a call returned, by the pair's value */
  const pairCallee = new Map<Value, string>();
  /** the value each call to a callee declared void left in the return register */
  const voidResults = new Set<Value>();
  // The compiler's own runtime, off the TARGET (runtime-helpers.ts): which helpers a compiler
  // emits is a compiler fact, and reading one table for every ISA is how a scan for `__*di3`
  // reports zero on a compiler whose runtime spells them `__ll_*`.
  const helperProtos = helperPrototypes(target.runtimeHelpers);
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
  // (`TargetDescription.doubleArgWords`); one other such spelling and it states no layout at all,
  // because the question here is not how wide that parameter is but whether it occupies one
  // argument register or two, and the choice moves every later argument's home. So the declaration licenses no outgoing block and this returns `null`:
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
    const known = (t: Prototypes) => (Object.hasOwn(t, callee) ? t[callee] : undefined);
    const own = known(prototypes);
    const returned = declaresAggregateReturn(own) ? structReturnOf(name, target, callee, own!, fail) : undefined;
    const proto = declaresParams(own) ? own : (known(helperProtos) ?? known(STANDARD_SIGNATURES));
    const declared = declaredCallArgs(proto, target);
    const params = declared?.widths;
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
    if (returned !== undefined && returned !== 'register' && spellableProto(own, target, returned.type) === undefined) {
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
    const hidden = returned === undefined || returned === 'register' ? 0 : 1;
    const widths = hidden === 0 ? params : [32, ...params];
    const doubles = new Set([...declared!.doubles].map((i) => i + hidden));
    return {
      widths,
      doubles,
      params: params.length,
      ...(returned === undefined ? {} : { returned }),
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
        fail(
          `cannot lift '${name}': one half of a 64-bit value would be handed to '${callee}' — its parameter ` +
            `${wideAt + 1} is declared wider than a register, and this frontend passes each argument ` +
            'register as its own value rather than building the pair the ABI passes it in',
        );
      }
    }
    if (!lowering.stackArgs && declared !== null && wordsOf(declared.widths) > target.argRegs.length) {
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
    return {
      widths: wide?.params ?? declared?.widths ?? null,
      doubles: declared?.doubles ?? new Set(),
      returns: voided
        ? { kind: 'void' }
        : pair
          ? { kind: 'pair' }
          : returned === undefined
            ? { kind: 'word' }
            : returned === 'register'
              ? { kind: 'register-struct' }
              : { kind: 'memory-struct', type: returned.type },
      // a struct leaves the return register holding nothing the caller may read as a value, and a
      // void callee leaves it holding whatever the callee did
      clobbers: pair
        ? pairReturnClobbers
        : returned === undefined && !voided
          ? callClobbers
          : [...callClobbers, target.returnReg],
      declaredVoid,
    };
  };
  // THE CALL A PLAN LOWERS TO, in one order on every ISA: the arity, each argument word, the
  // `call` op, the guessed arity's record, the result and the clobbers.
  const lower = (site: CallSite): void => {
    const { ssa, bi, pairs, guess, highHalves } = site;
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
    const argc =
      widths === null
        ? fallbackArgc(ssa, target.argRegs, bi, {
            accept: (v) => !highHalves?.has(v),
            gap: guess && { name, at: guess.at, fail },
          })
        : wordsOf(widths);
    if (widths === null) {
      guess?.refuse(argc);
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
      return highHalves ? highHalves.guardRead(name, r, v) : v;
    };
    const args: Value[] = [];
    let k = 0;
    for (const w of widths ?? Array.from({ length: argc }, () => 32)) {
      // A 64-BIT PARAMETER IS TWO ARGUMENT WORDS AND ONE VALUE, so the pair is built here
      // rather than recovered from two 32-bit arguments later — `contracts.ts` would fire on
      // the second reading anyway, since the structurer materialises an effectful call once
      // per result. Its words are wherever the frontend's ABI placed them.
      args.push(w > 32 ? pairs!.fuse(word(k), word(k + 1)) : widths === null ? guessed(k) : word(k));
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
      for (const [j, v] of args.entries()) {
        const half = pairs.halfOf.get(v);
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
    const call = mkOp('call', {
      operands: indirect === undefined ? args : [...args, indirect.address],
      results: [res],
      attrs: {
        ...(callee !== undefined ? { target: callee } : { indirect: true }),
        ...(sret === undefined ? {} : { sret: true }),
        ...(doubles === undefined ? {} : { doubles }),
      },
    });
    ssa.irBlocks[bi].ops.push(call);
    // A GUESSED arity is revisited in `finish()`: only once the whole function is lifted is it
    // known whether every path to here passes through another call, which would have clobbered
    // the argument registers this guess just read.
    //
    // A CALL THROUGH A REGISTER IS PASSED AN EARLIER CALLEE'S RESULT its guess reads, which the trim
    // drops from a named call (`trimClobberedCallArgs`): no declaration checks a call through a cast
    // to an unprototyped type, so a dropped argument would never be refused, and `p(g())` would lift
    // as `g(); p();` to the same bytes. Kept, `g(); p();` reads as `p(g())`, which passes what the
    // machine passes — unless `g` is declared void, and its result names nothing.
    if (widths === null) {
      ssa.recordGuessedCall(call, bi, target, indirect !== undefined && args.length > 0 && !voidResults.has(args[0]));
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
    } else if (returns.kind === 'word') {
      site.write(target.returnReg, res); // the callee defines the return register …
    }
    // … and the clobber is recorded after it, so that def is the CALLEE's; a struct, the memory at
    // argument 0 or the return register's bytes, leaves that register holding nothing the caller
    // may read as a value
    ssa.noteCall(bi, p.clobbers);
  };
  return {
    callClobbers,
    returnsWithoutHiddenPointer: (callee) => returnsWithoutHiddenPointer(callee, prototypes, target),
    declaredCall,
    plan,
    lower,
  };
}

// A CALLEE DECLARED TO RETURN A STRUCT OR UNION BY VALUE, where the target returns it through
// memory: the caller hands it the storage in argument 0 and every declared argument one register
// up (on agbcc, thumb.h:644-645, 672), so the call's first word is that pointer. What it returns in
// the return register is not a value the caller reads (calls.c: the struct is the memory at the
// address). One the target returns in registers takes its arguments where they are declared, and
// its registers hold the struct's bytes, which nothing here reads as a struct: the call is
// `'register'` and a read of the return register after it refuses. Every other struct-returning
// call refuses, naming why.
function structReturnOf(
  name: string,
  target: TargetDescription,
  callee: string,
  own: FnProto,
  fail: FrontendRefusal,
): StructReturn | 'register' {
  const refuse = (why: string): never =>
    fail(
      `cannot lift '${name}': \`${callee}\` is declared to return ${own.returns ?? 'a struct or union'} by value, and ${why}`,
    );
  const layout = returnedAggregate(own);
  const inMemory = returnsInMemory(layout, target);
  if (inMemory === undefined) {
    refuse(
      'nothing here says whether it comes back through a hidden pointer — its members are not all known, this target does not ' +
        'say how it lays one of them out (an enum, a bitfield), or it states no rule ' +
        '(a prototype states them as `returnLayout`, a context by defining the struct)',
    );
  }
  if (inMemory === false) {
    return 'register';
  }
  // the local it lands in is declared as the header spells the type, qualifiers aside; the tag
  // is what the declarations block defines it by, and a typedef name is that tag too
  const spelling = (own.returns ?? '')
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const tag = /^(?:(?:struct|union)\s+)?([A-Za-z_]\w*)$/.exec(spelling)?.[1];
  if (tag === undefined) {
    refuse('it names no type a local of it could be declared with');
  }
  const type = aggregateType(tag!, spelling, layout, target);
  if (type === undefined) {
    refuse(
      'it is a union, or its members are not all known or this target does not say how it lays one of them out ' +
        '(an enum, a bitfield) — the local it lands in has no type here',
    );
  }
  return { type: type! };
}
