// asmlift — ISA-neutral on-the-fly SSA construction (Braun et al. 2013, "Simple and
// Efficient Construction of SSA Form"), shared by every frontend. The frontend supplies the
// CFG (predecessors per block) and, per block, emits ops through `readVar`/`writeVar`; this
// module materialises block-argument phis at joins and back-edges.
//
// `preds` is an EDGE list, not a block list: it carries one entry per CFG edge, so a `switch_br`
// with several case values reaching one block appears there several times. Both readings are
// needed and they are not interchangeable — phi wiring wants the distinct predecessor BLOCKS (one
// value each), while the args it appends belong to the EDGES (every one of them). `distinctPreds`
// names the first; `appendSuccessorArg` walks the second. (ir/core.ts `predecessors` and
// structure.ts `predecessorBlocks` have the same duality, and structure.ts already dedups ad hoc
// at its two join sites.)
//
// Protocol: create the builder, then fill blocks in index order. For each block, emit its
// computation via read/writeVar, push its terminator op last (successors referencing
// `irBlocks`, args left empty — phi wiring appends them), then call `markFilled(b)`. When all
// blocks are filled, call `finish()` to remove trivial phis.
import {
  Block,
  Fn,
  Op,
  type ParamObservation,
  type SlotHomes,
  Value,
  type WriteOrder,
  defOpMap,
  mkOp,
  mkValue,
} from '../ir/core';
import { pruneDeadParams, simplifyTrivialPhis } from '../ir/simplify';
import { type IrType, T } from '../ir/types';
import { FrontendUnsupportedError } from './errors';

export interface SsaBuilder {
  fn: Fn;
  irBlocks: Block[];
  /** Current SSA value of `reg` on entry to block `b` (creating phis/params as needed). */
  readVar(reg: string, b: number): Value;
  /** Read `reg` as an argument register of a call whose arity was GUESSED — otherwise identical to
   *  {@link readVar}, and used INSTEAD of it so the read carries no claim.
   *
   *  `fallbackArgc` counts argument registers by reaching definition, so a read here is a QUESTION
   *  ("did the caller set this up?") rather than an assertion, and {@link trimClobberedCallArgs} is
   *  what answers it. That answer already covers a register a call destroyed, and it covers it
   *  EXHAUSTIVELY: destroyed on any path means not written-since-the-call on that path, so the
   *  must-analysis drops it from the run and the operand goes — bar an argument register the ABI
   *  ALIASES onto the return register, which `noteCall` cannot list as destroyed for that very
   *  reason. So none of these reads can leave a destroyed value in the graph, and refusing the
   *  function over one would cost a row the trim has already made correct.
   *
   *  THAT ALIASING IS A PER-TARGET FACT AND TWO TARGETS HERE DO NOT HAVE IT. ARM and PowerPC both
   *  pass argument 0 in the return register (r0/r0, r3/r3), so on them the exemption is the whole
   *  of the gap. MIPS returns in `v0` and passes in `a0`, so `clobberedByCall` lists `a0` for both
   *  MIPS targets and there is no exemption to reason about — which is the sound direction, not a
   *  hole. What bounds the path today is earlier still: `frontend/mips.ts` refuses on the `jal`
   *  before any argument is read, so neither MIPS target reaches this at all.
   *
   *  A DECLARED arity uses `readVar`, and must: there the callee says the argument exists, so
   *  reading a destroyed register for it is a wrong value with nothing to retract it. */
  readGuessedArg(reg: string, b: number): Value;
  /** Record that `reg` now holds `v` within block `b`. */
  writeVar(reg: string, b: number, v: Value): void;
  /** Mark block `b` fully emitted (terminator pushed); seals any now-ready successors. */
  markFilled(b: number): void;
  /** Live-in parameter value → the key it arrived on (for calling-convention order). Usually an
   *  ABI register name, but a frontend's virtual key (see the module header) ranks here too. */
  paramReg: Map<Value, string>;
  /** The key a block parameter stands for — `paramReg` for a live-in, and the key of a PHI too,
   *  which is how an entry block that is itself a loop header receives its arguments. */
  keyOf(v: Value): string | undefined;
  /** Assert that block `b` takes a parameter for `key`, whether or not anything reads it.
   *
   *  `readVar` cannot express this. It asks "what value does `key` hold here?", so a key the block
   *  DEFINES before any read answers with that local definition and no parameter is created — to it
   *  "never read" and "written before first read" are the same thing. When a calling convention
   *  proves an argument exists, that is an obligation on the SIGNATURE, independent of whether the
   *  body happens to use it, so it needs its own verb.
   *
   *  Never touches the block's definitions: the parameter is added and left unused, so any local
   *  value already flowing keeps flowing. Only meaningful on a block with no predecessors —
   *  elsewhere a parameter is a phi whose position is aligned with its predecessors' terminator
   *  args, and appending an unpaired one would corrupt that. */
  ensureParam(key: string, b: number): void;
  /** Whether `reg` has a definition reaching block `b` (best-effort call-arity heuristic).
   *
   *  `accept` says what counts as a definition. A frontend that defines a register with something
   *  that is NOT a value — PowerPC's `@ha` high half — passes a predicate rejecting it, because
   *  "a def reaches here" and "a value reaches here" are the same question only when every def is
   *  a value. */
  hasReachingDef(reg: string, b: number, accept?: (v: Value) => boolean): boolean;
  /** Record that block `b` makes a call HERE: the ABI's caller-saved registers stop being ones the
   *  caller set up. Call it AFTER `recordGuessedCall` for the same instruction, and after writing
   *  the call's own result — the result is the CALLEE's, so it must not count as caller-side
   *  argument setup for whatever call comes next.
   *
   *  `clobbers` are the registers the callee DESTROYS and leaves holding nothing this function can
   *  name — {@link clobberedByCall} spells it, and it is the ABI's caller-saved set minus the
   *  return register precisely because of the ordering above: the frontend has already written the
   *  callee's own result there, so that one register does have a name. Required rather than
   *  optional: a frontend that omitted it would keep resolving a destroyed register to its
   *  pre-call value, silently. */
  noteCall(b: number, clobbers: readonly string[]): void;
  /** Register a `call` op whose arity was GUESSED (no prototype), so `finish` can cut it back to the
   *  argument registers that were actually set up on every path (see {@link trimClobberedCallArgs}).
   *  `abi` is the target's argument-register order and its return register. */
  recordGuessedCall(op: Op, b: number, abi: { argRegs: string[]; returnReg: string }): void;
  /** Remove trivial phis and enforce the frontend's postconditions; call once every block is
   *  filled. Throws FrontendUnsupportedError if a stack slot escaped as an entry parameter. */
  finish(): void;
}

/** `preds` is per-EDGE (see the module header): one entry per CFG edge into each block. */
// VARIABLE NAMES ARE NOT ALWAYS MACHINE REGISTERS. `readVar`/`writeVar` key on an arbitrary string,
// and frontends mint VIRTUAL keys for storage the ISA has no register for — MIPS `sp@<off>` for a
// stack slot (frontend/mips.ts), Thumb `@sarg<k>` for an incoming stack argument (frontend/thumb.ts).
// A virtual key must be outside its ISA's register grammar so it cannot collide with a real one, and
// a key read with no reaching def becomes a function PARAMETER by the live-in path below — which is
// how both of those capabilities get their parameters without a new opcode or pass.
/** What a def-less live-in MEANS here, in two coordinate systems — the frame in slot-key offsets,
 *  the register file by key. RANGES and LISTS rather than a verdict, so the classification below is
 *  checkable here: a frontend that is wrong about its own frame gets refused instead of believed,
 *  and a range that collapses to empty (an unmeasurable frame) stops claiming anything on its own.
 *  Ghidra carries the same partition as compiler-spec data (`<localrange>`, stack `<pentry>`) read
 *  by architecture-neutral code. */
export interface LiveInModel {
  /** Storage this function owns as LOCALS ⇒ a def-less read is an uninitialised local. `[from, to)`.
   *
   *  Asserts more than ownership: that this function's own stores are the ONLY writer. An address
   *  into the frame that escapes to anything which could write it stops that holding, and the
   *  retraction is the frontend's obligation (frontend/thumb.ts, after the frame-object audit). */
  ownedLocals?: { from: number; to: number };
  /** Storage this function DECLARES as locals ⇒ a `[sp,#k]` spill here is a DECLARATION RANK
   *  (`ir/core.ts` `SlotHomes`, ordered by `l3/slotorder.ts`). `[from, to)`.
   *
   *  WHY THIS IS NOT `ownedLocals`, and the distinction is the whole point of the field. Owning
   *  storage and declaring it are different claims, and agbcc's frame contains storage it owns
   *  and does not declare: `ACCUMULATE_OUTGOING_ARGS` puts the OUTGOING STACK-ARGUMENT area at
   *  the BOTTOM of `localArea` (frontend/thumb.ts says so at its own decline), so `[0, localArea)`
   *  admits argument slots. A def-less read of one is still an uninitialised local — `ownedLocals`
   *  is right for that question — but its offset is an ABI position, not an `expand_decl` rank,
   *  and ranking a declaration list by it would be wrong with no diagnostic.
   *
   *  THE TWO RANGES DIFFER UNDER THUMB, AND A PROOF IS WHAT SEPARATES THEM. The frontend passes
   *  `{ from: area, to: localArea }`, where `area` is the largest outgoing block
   *  `analyzeOutgoingArgs` (frontend/stackargs.ts) LICENSED — the extent over which a callee's declared
   *  parameter count and this function's own staging stores agree word for word. That licence, not
   *  a decline, is what keeps argument slots out of `SlotHomes`: a frame whose outgoing area cannot
   *  be licensed still declines in the frontend and never reaches here, and a frame with no call
   *  taking stack arguments has `area` 0, so the ranges coincide exactly when there is provably
   *  nothing to skip. The dependency is TYPED and LOCAL for that reason — the offsets a frontend
   *  must not report as declarations are stated here rather than implied across modules.
   *
   *  The class is populated, not hypothetical. Over a sweep of every sa3 and klonoa listing, of
   *  2,001 lifted real agbcc functions 27 carry any L1 slot home, 12 of those also CALL, and 11 of
   *  those carry a home at offset 0 — the exact offset an outgoing argument block starts at
   *  (`PackSaveSector` homes [0,4,…,72], `modf` [0,4,…,36], `RenderDialogSprites` [0,4,…,36], and
   *  eight more). None reaches the ordering today, for an unrelated reason (`l3/slotorder.ts`'s
   *  REACH note), so nothing downstream is guarding this.
   *
   *  ABSENT ⇒ NO STAMP. MIPS and PPC declare no frame partition at all, so they stamp nothing,
   *  which is the refusing direction. */
  declaredLocals?: { from: number; to: number };
  /** Storage the CALLER wrote — incoming stack arguments ⇒ a def-less read is a parameter.
   *  `[from, to)`. O32's register-parameter home area belongs to NEITHER range: caller-owned, but
   *  not an argument. */
  callerParams?: { from: number; to: number };
  /** Registers a def-less read of which is an uninitialised local the compiler put in a register.
   *  TWO facts, and the frontend owes both: the ABI passes no argument there (`target.nonArgRegs`,
   *  so no caller could have handed a value over, however early the read happens) AND this function
   *  saved the register (so it is one the compiler was free to home a local in). The ABI half alone
   *  describes the CALLER, and asm that follows no ABI — hand-written, or a mid-function fragment,
   *  which klonoa's `bl`-as-a-long-branch splits produce for real — is genuinely handed live values
   *  in registers it never saved. Passing the ABI list unfiltered cost the MP2K engine's
   *  `ChnVolSetAsm` its two-pointer signature and left it storing through `uninit_r4`, silently.
   *
   *  The save is a MEASUREMENT, like the frame's, and belongs to whoever can make it — Thumb reads
   *  the leading push run (`savedRegs`); a frontend that cannot measure it passes nothing here and
   *  keeps the parameter it would have got anyway.
   *
   *  The frame's sole-writer obligation has no counterpart here and needs none: a register has no
   *  address, so nothing outside this function can name it and there is no escape to retract.
   *
   *  LISTED, not derived as "everything outside argRegs", because the complement contains the
   *  VIRTUAL keys too (`@sarg<k>` — an incoming stack argument, which really is a parameter), and a
   *  rule that had to exclude them would be reading a grammar this module does not own. A register
   *  spelling nobody listed keeps its existing treatment, so the list is safe to grow.
   *
   *  Declaring this obliges `argRegs` below, and the two must be DISJOINT. */
  uninitRegs?: readonly string[];
  /** Registers the ABI DOES pass arguments in — the other side of the register partition, and the
   *  only reason the side above is checkable rather than believed. The frame coordinate declares
   *  both of its sides and refuses an offset in neither; this one declares both and refuses a key
   *  in BOTH, which is the same move.
   *
   *  Without it the whole contract rests on one hand-written list in target.ts being right, in a
   *  file whose idiom is "a compiler fact is one field": spelling `r1` where `r11` was meant
   *  deletes a parameter and emits `s32 uninit_r1;` in its place, with no diagnostic anywhere.
   *  `readRecursive` cannot catch that on its own — it never sees the argument registers, because
   *  a read of one takes the parameter path by falling through every other case. */
  argRegs?: readonly string[];
}

/** The register partition's postcondition, checked at the point of USE. `uninitRegs` asserts "no
 *  caller could have handed a value over in these"; `argRegs` is the set of registers a caller
 *  hands values over in. A key in both is a target that contradicts itself, and a `uninitRegs` with
 *  no `argRegs` beside it is one whose assertion nothing can check — both refuse rather than
 *  silently reclassify an argument as an uninitialised local. */
function checkedLiveInModel(fnName: string, m: LiveInModel): LiveInModel {
  if (m.uninitRegs === undefined) {
    return m;
  }
  const args = m.argRegs;
  if (args === undefined) {
    throw new Error(
      `lifting '${fnName}': the live-in model lists registers the ABI does not pass arguments in ` +
        `but not the ones it does, so nothing can check the two agree`,
    );
  }
  const both = m.uninitRegs.filter((r) => args.includes(r));
  if (both.length > 0) {
    throw new Error(
      `lifting '${fnName}': the live-in model lists ${both.join(', ')} as BOTH an argument register ` +
        `and one the ABI does not pass arguments in`,
    );
  }
  return m;
}

/** A read whose register may be holding a callee's leftover — see `refuseStaleCallerSavedReads`. */
interface StaleRead {
  reg: string;
  value: Value;
  block: number;
  /** the block's op count when the read happened. The uses this read answers for start here: an op
   *  before it consumed a value read while the register was still this function's own, and the same
   *  register really can be read on both sides of a call without its value changing. */
  fromOp: number;
  /** a call in this very block destroyed it, so the predecessors have nothing to add. */
  local: boolean;
}

/** The registers a call leaves holding nothing the CALLER can name — what {@link SsaBuilder.noteCall}
 *  wants. The ABI's caller-saved set minus the return register: every frontend writes the callee's
 *  own result there before recording the clobber, so that one register does have a name and the
 *  rest do not.
 *
 *  CHECKED rather than trusted, the way `checkedLiveInModel` checks the register partition: a
 *  register the caller passes arguments in is by construction one the callee may destroy, so
 *  `argRegs` must be a subset of `callerSaved`. A target spelling one of them differently in the two
 *  lists would silently stop refusing reads of it. */
export function clobberedByCall(target: {
  callerSaved: readonly string[];
  argRegs: readonly string[];
  returnReg: string;
}): readonly string[] {
  const missing = target.argRegs.filter((r) => !target.callerSaved.includes(r));
  if (missing.length > 0) {
    throw new Error(
      `this target passes arguments in ${missing.join(', ')} but does not list ${missing.length > 1 ? 'them' : 'it'} ` +
        `as caller-saved, so a read of one past a call cannot be refused`,
    );
  }
  return target.callerSaved.filter((r) => r !== target.returnReg);
}

export function makeSsaBuilder(
  name: string,
  blockCount: number,
  preds: number[][],
  /** A supplier because half the partition is MEASURED rather than declared: Thumb's local area
   *  comes from a prologue walk that runs after this call. Evaluated once, on first use. Omitted ⇒
   *  no partition is claimed, so every slot refuses and every register is a parameter. */
  liveInOf: () => LiveInModel = () => ({}),
  /** The type of a value that stands for `key` before any instruction defines it — a parameter, a
   *  phi. A register FILE, not a register: the FPU's keys are floats wherever they arrive, and every
   *  other key is `unknown` for type recovery to settle. */
  keyType: (key: string) => IrType | undefined = () => undefined,
): SsaBuilder {
  const unset = (key: string): IrType => keyType(key) ?? T.unk(32);
  let modelMemo: LiveInModel | null = null;
  // Checked ONCE, where the model is materialised — every function with a parameter reads a
  // register def-lessly, so this runs on effectively every lift rather than only on the rare
  // function that reads the mis-listed register. A contradictory or half-declared partition is a
  // bug in the TARGET, not an unliftable function, so it throws a plain Error: a decline would
  // report the target's typo as a property of the input, once per function, forever.
  const model = (): LiveInModel => (modelMemo ??= checkedLiveInModel(name, liveInOf()));
  const inRange = (off: number, r?: { from: number; to: number }) => r !== undefined && off >= r.from && off < r.to;
  const irBlocks: Block[] = Array.from({ length: blockCount }, () => ({ params: [] as Value[], ops: [] }));
  // `writeOrder` and `slotHomes` are filled in below, where the builder's counters live.
  const fn: Fn = { name, blocks: irBlocks, writeOrder: undefined, slotHomes: undefined, paramEvidence: undefined };

  const defs: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const sealed: boolean[] = irBlocks.map(() => false);
  const filled: boolean[] = irBlocks.map(() => false);
  const incompletePhis: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const phiBlock = new Map<Value, number>();
  // The key each phi stands for. `paramReg` covers live-ins only, so without this a slot that
  // arrives as a PHI — which is what happens when the entry block is itself a loop header — is
  // invisible to the escape check below. Braun's construction gives no other way to tell.
  const phiKey = new Map<Value, string>();
  const paramReg = new Map<Value, string>();
  // Parameters created by ensureParam that nothing has read yet. They are deliberately NOT in
  // `defs`: a parameter asserted because a calling convention proves it exists is not evidence that
  // a VALUE reaches anything, and writing one into `defs` would say it does. That distinction is
  // load-bearing — `hasReachingDef` feeds `fallbackArgc`, so a def here silently raises the guessed
  // arity of every prototype-less call in the function, making it pass registers the calling block
  // never set up (`unknown(1)` became `unknown(1, a1, a2, a3)`). The first read adopts the value
  // from here instead of minting a second parameter for the same key.
  const obligedParams: Array<Map<string, Value>> = irBlocks.map(() => new Map());

  // `preds` lists an entry per CFG EDGE; these are the distinct predecessor BLOCKS.
  const distinctPreds = (b: number): number[] => [...new Set(preds[b])];

  // CALLER-SAVED CLOBBER, for guessed call arities (see trimClobberedCallArgs). Tracked HERE
  // because every register write in every frontend already goes through `writeVar`: a frontend
  // that gathered this itself would be sound only while it remembered to route each write past a
  // wrapper, and a MISSED write under-counts an arity — which drops a real argument silently.
  const writtenSinceCall: Array<Set<string>> = irBlocks.map(() => new Set());
  const callsIn = new Set<number>();
  // WHAT A CALL DESTROYED, which is a DIFFERENT question from the one above and not its complement.
  // `writtenSinceCall` asks "did the CALLER set this register up" — a MUST question, whose answer
  // for the return register is deliberately no, because the frontend writes the callee's result
  // there before recording the clobber. This asks "does this register still hold a value anyone can
  // name" — a MAY question, whose answer for that same register is yes. One analysis serving both
  // would have to be wrong about one of them, so they are two, and each names the other.
  //
  // `clobberedLocal[b]`: destroyed by a call in `b` with nothing written since. `decidedLocal[b]`:
  // registers `b` has settled either way, so a register in neither inherits its fate from the
  // predecessors.
  const clobberedLocal: Array<Set<string>> = irBlocks.map(() => new Set());
  const decidedLocal: Array<Set<string>> = irBlocks.map(() => new Set());
  const staleCandidates: StaleRead[] = [];
  // `readVar` runs once per operand, so a memo per (register, verdict) keeps the record list
  // proportional to what a block READS rather than to how many times it reads it. The value a key
  // holds only changes at a write, and the verdict only flips at a call, so a run of identical
  // reads collapses to the earliest — which is the one whose uses cover the rest.
  const staleSeen: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const guessedCalls: GuessedCallSite[] = [];
  let abiSeen: { argRegs: string[]; returnReg: string } = { argRegs: [], returnReg: '' };

  // WRITE ORDER (ir/core.ts `WriteOrder`). Measured here for the same reason the clobber set is:
  // every register write in every frontend already goes through `writeVar`, and a delay-slot write
  // is decoded before its branch is emitted, so the ordinal is the machine's own program order on
  // every ISA with no frontend code. Per block, because the consumer asks a per-EDGE question.
  const writeCount: number[] = irBlocks.map(() => 0);
  const lastWriteAt: Array<Map<string, number>> = irBlocks.map(() => new Map());
  const writeOrder: WriteOrder = { lastWrite: new Map(), writes: new Map() };
  fn.writeOrder = writeOrder;

  // SLOT HOMES (ir/core.ts `SlotHomes`). Measured HERE, in the shared builder, for the same
  // reason the clobber set and the write order are: BOTH frontends already spell a word spill as
  // a write to the key `sp@k` (`stackSlotKey`, below), so the frontend supplies the coordinate
  // and one rule applies it — a per-frontend stamp would be right only while each remembered to
  // route every slot write past a wrapper, and a missed write is a local with no frame order.
  // Empty rather than absent on a function that spills nothing: this builder measured it.
  const slotHomes: SlotHomes = new Map();
  fn.slotHomes = slotHomes;
  const noteSlotHome = (key: string, v: Value) => {
    const off = slotKeyOffset(key);
    if (off === null) {
      return; // an ordinary register: no frame coordinate exists
    }
    // THE KEY SPELLING CANNOT DECIDE THIS, exactly as `readRecursive` says below of a def-less
    // read: `sp@40` is a local on one ABI and the caller's fifth argument on another. So the stamp
    // asks the frontend for a partition and refuses where no answer exists. The two frontends
    // differ here and the refusal is what makes that safe: Thumb declares a range; MIPS declares NO
    // partition (frontend/mips.ts: `addiu sp,sp,±N` is transparent, so its slot keys span O32's
    // caller-owned register-parameter home area `[0,16)` and the incoming stack arguments above
    // it), and PPC declares none either — so both stamp nothing rather than reporting the caller's
    // frame as this function's declaration ranks.
    //
    // AND IT ASKS `declaredLocals`, NOT `ownedLocals`, which is a different question with a
    // different answer under agbcc — the outgoing stack-argument area is storage the function owns
    // and does not declare. Under Thumb the declared range therefore starts where the largest
    // LICENSED outgoing block ends, and the two coincide only when that block is empty; see
    // `declaredLocals`' own doc for what earns the narrowing and for the frames still refused.
    if (!inRange(off, model().declaredLocals)) {
      return;
    }
    // ONE CLASS INSIDE THE PARTITION IS STILL NOT A DECLARATION RANK, and NOTHING HERE REFUSES IT.
    // A stack AGGREGATE the frontend decomposed into per-word keys yields several `sp@k`s that are
    // fields of ONE declared object, not several declared scalars — and it reaches the stamp
    // because a non-address-taken array never mints an `laddr`, which is the only aggregate the
    // structurer's `frame` refusal catches. It is the only class the ordering meets in the wild:
    // over 2,463 real agbcc functions (158 sa3 + klonoa listings) exactly one carries two
    // slot-carrying locals, sa3 `sub_80617E0`, whose [sp,#0]..[sp,#0xc] are the four words of
    // `Vec2_32 sp00[2]` (its own preprocessed source declares it), with the only genuine reload
    // spill at [sp,#0x10].
    //
    // That one is declined downstream — its words land under two names at offset 12, and
    // `l3/slotorder.ts`'s injectivity refusal reads a duplicate as evidence reload did not produce
    // — but the class is NOT covered by that refusal: an aggregate whose words reach L3 under
    // distinct names at distinct offsets is injective and would be ordered. FLIP CONDITION: once
    // stack-array recovery declares `sp00[2]`, ordering an aggregate against a reload spill by the
    // minimum of its element offsets is WRONG — `assign_stack_local` runs before reload and puts
    // every array below every spill slot regardless of declaration rank. The licence this
    // capability rests on (reload hands a spilled pseudo its slot by `expand_decl` rank) is about
    // separately declared SCALARS; intra-aggregate offsets are fixed by the aggregate's layout at
    // expand time.
    //
    // A FORM OF THAT RECOVERY EXISTS, and what keeps the condition unmet is a guard in another
    // file. The Thumb frame-object audit declares an untyped frame object as `u8 name[N]` from
    // the reservation (`notTheWholeArea`, frontend/thumb.ts), but only where the slot model keys
    // NOTHING in the reserved area — so no reload spill can share a frame with one of those
    // arrays and nothing here is ever asked to order the two. Widening that arm to a frame
    // carrying slots is what meets the condition, and it has to bring `l3/slotorder.ts` with it.
    //
    // UNION, not a choice (ir/core.ts `SlotHomes`): whether the earlier declaration rank is the
    // lower or the higher offset is a per-COMPILER fact, and this builder is handed a name, a
    // block count, a predecessor list and a live-in model — no target. `l3/slotorder.ts` reduces.
    // A GUARD WITH NO CORPUS INHABITANT: over both benchmark tiers no value is ever written to two
    // DIFFERENT slots, so the `else` below has never produced a set of size two on a real input.
    const prev = slotHomes.get(v);
    if (prev === undefined) {
      slotHomes.set(v, new Set([off]));
    } else {
      prev.add(off);
    }
  };
  // PARAMETER EVIDENCE (ir/core.ts `ParamEvidence`), measured HERE for the same reason the clobber
  // set, the write order and the slot homes are: a slot write is a `writeVar` and a slot read is a
  // `readVar` in BOTH slot-modelling frontends, so one rule covers them and no frontend can forget
  // to route a store past a wrapper. The two directions are NOT symmetric: raise/paramwidth.ts reads
  // an absent observation as proof the declaration was wide, so a missed one costs a narrowing while
  // a spurious one retypes a parameter the machine never declared narrow.
  //
  // RAW, in two ways that matter. Both halves record VALUES rather than verdicts, because the entry
  // parameters are not final until `pruneDeadParams` has run in `finish()`, which is where the map
  // is sealed. And the slot half asks no frame partition, unlike `noteSlotHome` directly above: see
  // `ParamEvidence` for why "stored and never read back" needs none.
  //
  // A READ IS A `readVar`, AND `hasReachingDef` IS NOT ONE. The guard in `frontend/mips.ts`'s
  // `emitLoad` asks whether a slot was ever stored before it reads it; asking is not reading, and
  // the `readVar` on the line after it is.
  const slotWrites = new Map<string, Set<Value>>();
  const slotReads = new Set<string>();
  const noteSlotTraffic = (key: string, v: Value | null) => {
    if (slotKeyOffset(key) === null) {
      return;
    }
    if (v === null) {
      slotReads.add(key);
      return;
    }
    const at = slotWrites.get(key);
    if (at === undefined) {
      slotWrites.set(key, new Set([v]));
    } else {
      at.add(v);
    }
  };
  // THE FIRST entry-block write to each REGISTER, for `selfRedefined`. First and not any: a later
  // write is the allocator reusing a register the argument is done with, which says nothing about
  // the argument. Entry block only, because a widening the machine performs on the argument's own
  // register is prologue work — a write in a later block has body code before it.
  const firstEntryWrite = new Map<string, Value>();

  const forgetOrder = (p: Value) => {
    for (const m of writeOrder.lastWrite.values()) {
      m.delete(p);
    }
  };

  const writeVar = (reg: string, b: number, v: Value) => {
    noteSlotHome(reg, v);
    noteSlotTraffic(reg, v);
    if (b === 0 && !firstEntryWrite.has(reg)) {
      firstEntryWrite.set(reg, v);
    }
    writtenSinceCall[b].add(reg);
    clobberedLocal[b].delete(reg);
    decidedLocal[b].add(reg);
    defs[b].set(reg, v);
    lastWriteAt[b].set(reg, writeCount[b]++);
  };
  const readVar = (reg: string, b: number): Value => {
    const v = readAny(reg, b);
    noteStaleCandidate(reg, b, v);
    return v;
  };
  /** The lookup, with no claim attached. The FRONTEND's read is what asserts "this register holds
   *  this value here"; the lookups this construction makes on its own — a single predecessor's
   *  definition, a phi's operand at each in-edge — are how that one read is answered, not further
   *  reads to be judged. Recording them would blame a use in one block on a read in another. */
  const readAny = (reg: string, b: number): Value => {
    noteSlotTraffic(reg, null);
    return defs[b].get(reg) ?? readRecursive(reg, b);
  };
  /** Record a read whose register MIGHT be holding a callee's leftover, for `finish` to judge. A
   *  register this block has already settled answers here and needs no record; one it has not takes
   *  its answer from the predecessors, which are not all filled yet. */
  const noteStaleCandidate = (reg: string, b: number, v: Value) => {
    const local = clobberedLocal[b].has(reg);
    if (decidedLocal[b].has(reg) && !local) {
      return; // this function wrote it after the last call in this block: it is its own value
    }
    const key = `${reg}|${local ? 1 : 0}`;
    if (staleSeen[b].get(key) === v) {
      return;
    }
    staleSeen[b].set(key, v);
    staleCandidates.push({ reg, value: v, block: b, fromOp: irBlocks[b].ops.length, local });
  };

  const newPhi = (reg: string, b: number): Value => {
    const phi = mkValue(unset(reg));
    irBlocks[b].params.push(phi);
    phiBlock.set(phi, b);
    phiKey.set(phi, reg);
    // A slot that arrives as a PHI — a loop header reading back what an earlier iteration spilled
    // — is the same frame coordinate under a block param, and the structurer names it like any
    // other value, so it carries the home too.
    noteSlotHome(reg, phi);
    defs[b].set(reg, phi); // set before wiring operands to break cycles
    return phi;
  };
  const readRecursive = (reg: string, b: number): Value => {
    if (!sealed[b]) {
      // predecessors not all filled yet (e.g. a loop back-edge): defer operand wiring.
      const phi = newPhi(reg, b);
      incompletePhis[b].set(reg, phi);
      return phi;
    }
    // DISTINCT predecessor blocks: a switch_br reaching this block on several case values is one
    // predecessor with several edges, and it supplies ONE value — counting the edges instead would
    // manufacture a join (and a phi) where there is none.
    const ps = distinctPreds(b);
    if (ps.length === 0) {
      // A live-in with no predecessor is a value this function never produced: an incoming argument,
      // or storage it allocated and never wrote. WHICH ONE is the partition's answer, in whichever
      // coordinate the key names. The key spelling cannot decide a slot on its own — `sp@40` is a
      // local on one ABI and the caller's fifth argument on another — so a slot in neither range is
      // refused rather than guessed. A register is decided by the calling convention instead of by
      // a measurement: a caller cannot pass a value in a register the ABI does not pass arguments
      // in, so a read of one before any write is an uninitialised local.
      const off = slotKeyOffset(reg);
      if (off !== null && !inRange(off, model().ownedLocals) && !inRange(off, model().callerParams)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': ${reg} is read on a path that never stores it, and lies outside ` +
            `this function's frame partition (uninitialised local, or storage it does not own) — not modelled`,
        );
      }
      const uninitialised =
        off !== null ? inRange(off, model().ownedLocals) : (model().uninitRegs?.includes(reg) ?? false);
      if (uninitialised) {
        const op = mkOp('undef', { results: [mkValue(T.unk(32))], attrs: { key: reg } });
        irBlocks[b].ops.unshift(op); // ahead of everything in a block that nothing precedes
        defs[b].set(reg, op.results[0]);
        return op.results[0];
      }
      // an incoming argument register → function parameter.
      // If one was already asserted for this key (ensureParam), adopt it — minting a second
      // parameter for the same key would put the key in the signature twice.
      const obliged = obligedParams[b].get(reg);
      if (obliged !== undefined) {
        obligedParams[b].delete(reg);
        defs[b].set(reg, obliged);
        return obliged;
      }
      const p = mkValue(unset(reg));
      irBlocks[b].params.push(p);
      defs[b].set(reg, p);
      paramReg.set(p, reg);
      return p;
    }
    if (ps.length === 1) {
      const v = readAny(reg, ps[0]);
      defs[b].set(reg, v);
      return v;
    }
    // sealed join: create the phi and wire every predecessor's terminator arg now.
    const phi = newPhi(reg, b);
    addPhiOperands(reg, b, phi);
    return phi;
  };
  // The ONE point that knows the phi, its key and each predecessor together, which is what the
  // write-order record is keyed by. `phi` is passed rather than looked up: by the time a deferred
  // phi is wired the block may have written its key again, so `defs[b]` no longer names it.
  const addPhiOperands = (reg: string, b: number, phi: Value) => {
    for (const p of distinctPreds(b)) {
      appendSuccessorArg(p, b, readAny(reg, p));
      const at = lastWriteAt[p].get(reg);
      if (at !== undefined) {
        const rec = writeOrder.lastWrite.get(irBlocks[p]) ?? new Map<Value, number>();
        rec.set(phi, at);
        writeOrder.lastWrite.set(irBlocks[p], rec);
      }
    }
  };
  // Append `arg` to EVERY successor edge of predecessor p that targets block b.
  //
  // A predecessor normally has one edge to a given successor, but a `switch_br` has as many as it
  // has case values, and two cases sharing a body (`case 1: case 2:`) is ordinary C. Block args
  // belong to the EDGE, so each of those edges needs its own copy: appending to just the first (a
  // `find`) left the others short, while `preds` listing the block once per edge made the loop run
  // k times and pile k copies onto that same first edge. Both halves of that — every edge, once per
  // predecessor BLOCK — have to hold together, which is why they are fixed in one place.
  const appendSuccessorArg = (p: number, b: number, arg: Value) => {
    const term = irBlocks[p].ops[irBlocks[p].ops.length - 1];
    for (const s of term.successors) {
      if (s.block === irBlocks[b]) {
        s.args.push(arg);
      }
    }
  };
  const sealBlock = (b: number) => {
    if (sealed[b]) {
      return;
    }
    sealed[b] = true; // set first: addPhiOperands may recurse back here
    for (const [reg, phi] of incompletePhis[b]) {
      addPhiOperands(reg, b, phi);
    }
    incompletePhis[b].clear();
  };
  const sealReadyBlocks = () => {
    for (let b = 0; b < irBlocks.length; b++) {
      if (!sealed[b] && preds[b].every((p) => filled[p])) {
        sealBlock(b);
      }
    }
  };
  sealReadyBlocks(); // seals the entry (no predecessors) up front

  // See the interface docs. Two cases, and the split is the whole point: when nothing defines the
  // key, the ordinary live-in path already does exactly the right thing; when something does, a
  // parameter still has to exist for the signature, and it must be added WITHOUT redirecting the
  // dataflow to it.
  const ensureParam = (key: string, b: number): void => {
    if (preds[b].length > 0) {
      return; // a parameter here is a phi; see the precondition on the interface
    }
    for (const p of irBlocks[b].params) {
      if (paramReg.get(p) === key) {
        return; // already a parameter, however it got there
      }
    }
    const p = mkValue(unset(key));
    irBlocks[b].params.push(p);
    paramReg.set(p, key); // ranked by the ABI sort like any other parameter
    obligedParams[b].set(key, p);
  };

  const hasReachingDef = (reg: string, b: number, accept: (v: Value) => boolean = () => true): boolean => {
    const walk = (at: number, seen: Set<number>): boolean => {
      const own = defs[at].get(reg);
      // A def `accept` rejects does not fall through to the predecessors: it is still a def, and
      // nothing older than it reaches past it.
      if (own !== undefined) {
        return accept(own);
      }
      if (seen.has(at)) {
        return false;
      }
      seen.add(at);
      return preds[at].length > 0 && preds[at].some((p) => walk(p, seen));
    };
    return walk(b, new Set<number>());
  };

  /** REFUSE a value the ABI destroyed. The builder is RIGHT that a caller-saved register has a
   *  reaching definition after a call; what it cannot see is that the call destroyed the bytes, so
   *  that definition names something the callee overwrote. Resolving the read to it is a silently
   *  wrong VALUE at exit 0 — `mov r3,#0x2a; bl f; add r4,r3,#0` reading as `return 42` — which is
   *  the one failure a frontend may not produce.
   *
   *  It fires on a USE rather than on the read, and after two things in `finish` that legitimately
   *  retract one: `trimClobberedCallArgs`, which drops a read that fed a guessed call's argument
   *  list — the sound answer for those, and not a reason to refuse the function as well — and
   *  `pruneDeadParams`, which drops one that fed a join nothing reads. A destroyed value nothing is
   *  left holding is a dead register, not a wrong answer.
   *
   *  TWO-SIDED, so both sides are stated. TOO STRICT costs a row and nothing else: a register the
   *  compiler rematerialised in a way no `writeVar` saw reads as destroyed and the function
   *  declines. TOO LOOSE is the wrong value, and the MAY direction below is what rules it out — a
   *  register destroyed on ANY path into a block is destroyed there, so a join cannot launder one. */
  const refuseStaleCallerSavedReads = () => {
    if (staleCandidates.length === 0) {
      return;
    }
    // Destroyed on SOME path: the UNION, against `trimClobberedCallArgs`'s intersection, and for
    // the opposite reason. That one proves the caller set a register up, which needs every path to
    // agree; this one proves nobody can name it, which one path is enough for.
    const destroyedIn: Array<Set<string>> = irBlocks.map(() => new Set());
    const outOf = (b: number): Set<string> => {
      const out = new Set(clobberedLocal[b]);
      for (const r of destroyedIn[b]) {
        if (!decidedLocal[b].has(r)) {
          out.add(r);
        }
      }
      return out;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (let b = 0; b < irBlocks.length; b++) {
        for (const p of distinctPreds(b)) {
          for (const r of outOf(p)) {
            if (!destroyedIn[b].has(r)) {
              destroyedIn[b].add(r);
              changed = true;
            }
          }
        }
      }
    }
    for (const c of staleCandidates) {
      if (!c.local && !destroyedIn[c.block].has(c.reg)) {
        continue;
      }
      const ops = irBlocks[c.block].ops;
      if (ops.slice(c.fromOp).some((op) => op.operands.includes(c.value))) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': ${c.reg} is read on a path where a call has destroyed it, so what ` +
            `it holds is the callee's and not a value this function named — not modelled`,
        );
      }
    }
  };

  const dropPhiRecord = (p: Value) => {
    phiBlock.delete(p);
    phiKey.delete(p);
    forgetOrder(p);
  };

  return {
    fn,
    irBlocks,
    readVar,
    readGuessedArg: readAny, // see the interface: the trim is this read's answer, not a refusal
    writeVar,
    paramReg,
    keyOf: (v: Value) => paramReg.get(v) ?? phiKey.get(v),
    ensureParam,
    hasReachingDef,
    noteCall: (b: number, clobbers: readonly string[]) => {
      callsIn.add(b);
      // the callee clobbers the caller-saved registers, its own result register included — see
      // the ordering contract on the interface
      writtenSinceCall[b] = new Set();
      for (const r of clobbers) {
        clobberedLocal[b].add(r);
        decidedLocal[b].add(r);
      }
    },
    recordGuessedCall: (op: Op, b: number, abi: { argRegs: string[]; returnReg: string }) => {
      abiSeen = abi;
      guessedCalls.push({
        block: b,
        op,
        freshBefore: new Set(writtenSinceCall[b]),
        afterCallInBlock: callsIn.has(b), // `noteCall` runs after this, so this means an EARLIER call
      });
    },
    markFilled: (b: number) => {
      filled[b] = true;
      sealReadyBlocks();
    },
    finish: () => {
      // Guessed arities counted argument registers by reaching definition alone; now that every
      // block's calls are known, drop the ones an intervening call had already clobbered.
      if (guessedCalls.length) {
        const calleeResults = new Set<Value>();
        for (const b of irBlocks) {
          for (const op of b.ops) {
            if (op.opcode === 'call') {
              for (const r of op.results) {
                calleeResults.add(r);
              }
            }
          }
        }
        trimClobberedCallArgs({
          argRegs: abiSeen.argRegs,
          returnReg: abiSeen.returnReg,
          calleeResults,
          preds,
          freshAtEnd: writtenSinceCall,
          callsIn,
          sites: guessedCalls,
        });
      }
      irBlocks.forEach((blk, i) => writeOrder.writes.set(blk, writeCount[i]));
      // The phis nothing reads at all — a register two paths leave holding different junk (a loop
      // counter after its last use, a scratch the epilogue overwrites) still joins as a phi, and a
      // dead phi is not junk downstream: its edge args become post-loop copies in the emitted C and
      // block gates keyed on "this exit carries nothing".
      //
      // DEAD-PHI PRUNING RUNS FIRST, and `refuseStaleCallerSavedReads` is why. That check asks
      // whether a destroyed value still reaches a use, and a dead phi's edge arg is not one. The
      // trivial-phi
      // pass must not run before it for the opposite reason: that one REPLACES the phi's uses with
      // the arg and splices the arg away, which takes the last visible use of a destroyed value out
      // of sight. Running it twice is what keeps both true — trivial-phi removal can orphan a phi's
      // last reader, never the reverse, so the second sweep is the one that pays for the first.
      pruneDeadParams(fn, dropPhiRecord);
      refuseStaleCallerSavedReads();
      simplifyTrivialPhis(fn, dropPhiRecord);
      pruneDeadParams(fn, dropPhiRecord);
      // SEAL THE PARAMETER EVIDENCE (ir/core.ts `ParamEvidence`). Here and not at the store or the
      // write, because `pruneDeadParams` above is the last thing that can retire an entry
      // parameter, and an observation about a value no longer in the signature is one the reader
      // would never find. Every surviving entry parameter gets an entry — EMPTY-but-present on a
      // function that shows neither, because this builder measured it and found nothing.
      const evidence = new Map<Value, ParamObservation>();
      const deadHomed = new Set<Value>();
      for (const [key, stored] of slotWrites) {
        if (slotReads.has(key)) {
          continue; // the slot is read back: the store is live and says nothing about a declaration
        }
        for (const v of stored) {
          deadHomed.add(v);
        }
      }
      const defs0 = defOpMap(fn);
      for (const p of irBlocks[0].params) {
        const reg = paramReg.get(p);
        const first = reg === undefined ? undefined : firstEntryWrite.get(reg);
        // The redefining op must READ the parameter — that is what makes the write the argument's
        // own value moving, rather than an unrelated value landing in a register it had finished
        // with. Direct, not transitive: a chain through body code is body code.
        const redef = first === undefined ? undefined : defs0.get(first);
        evidence.set(p, {
          deadHome: deadHomed.has(p),
          selfRedefined: redef !== undefined && redef.operands.includes(p),
        });
      }
      fn.paramEvidence = evidence;
      // A STACK SLOT MAY NEVER LEAVE AS AN ENTRY PARAMETER. A slot is memory the function itself
      // allocated, so its value can only come from a store the function made; arriving as a live-in
      // instead means it was read on a path that never stored it, and the signature has grown an
      // argument the function does not take, standing in for uninitialised stack.
      //
      // Checked here, of the FINISHED function, rather than as a precondition at each read. The
      // per-read test available during construction (`hasReachingDef`) asks whether a store reaches
      // on SOME path, which a diamond defeats; strengthening it to "every path" is not answerable
      // mid-fill, because a loop's back-edge predecessor is not filled yet and the query would
      // report "unassigned" for a slot initialised before the loop — the commonest real shape.
      // Asking about the symptom instead costs one pass and cannot be defeated by fill order.
      //
      // It is total because in Braun's construction a value undefined on some path can surface only
      // as a live-in of a block with no predecessors — and BOTH spellings of that are checked:
      // `paramReg` for the live-in path, `phiKey` for the case where the entry block is itself a
      // loop header and the fabricated value arrives as a phi instead. Missing the second is what
      // let this survive on MIPS.
      //
      // In `finish()` and not a helper each frontend remembers to call: this is the frontend's only
      // semantic postcondition, and a postcondition enforced by convention is not enforced.
      for (const p of irBlocks[0].params) {
        const key = paramReg.get(p) ?? phiKey.get(p);
        // The SAME rule the mint site used, over the same ranges, so the two cannot disagree. A
        // slot that reached the signature is either owned storage (which should have become an
        // `undef`) or unclassified — both are bugs, and this is where a per-read test cannot be
        // total, so it is asserted over the finished function.
        const koff = key === undefined ? null : slotKeyOffset(key);
        if (koff !== null && !inRange(koff, model().callerParams)) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': ${key} is read on a path that never stores it ` +
              `(partially-initialised local, or storage this function does not own) — not modelled`,
          );
        }
      }
    },
  };
}

// ── shared frontend tail helpers ──

/** Best-effort call arity when a callee has no prototype: the count of contiguous argument
 *  registers with a value reaching the call's block. Correct when the arguments are set up in
 *  the calling block; it can under-count pass-through parameters — which is why a prototype's
 *  declared `params` is authoritative when available. */
export function fallbackArgc(
  ssa: { hasReachingDef(reg: string, b: number): boolean },
  argRegs: string[],
  bi: number,
): number {
  let n = 0;
  while (n < argRegs.length && ssa.hasReachingDef(argRegs[n], bi)) {
    n++;
  }
  return n;
}

/** One call site whose arity was GUESSED by {@link fallbackArgc}, with what the lifting scan saw
 *  of its own block up to that instruction. */
export interface GuessedCallSite {
  block: number;
  /** the `call` op — its operands are the guessed arguments, in argument-register order */
  op: Op;
  /** argument registers written between the last call in this block (or the block's start) and here */
  freshBefore: Set<string>;
  /** did this block already make a call before this one? */
  afterCallInBlock: boolean;
}

export interface CallArgTrim {
  argRegs: string[];
  /** the ABI return register. Load-bearing only where it IS `argRegs[0]` (ARM r0, PPC r3) — that
   *  aliasing is what makes a callee's result indistinguishable from caller-side argument setup. */
  returnReg: string;
  /** every value a `call` op produced. Tells a callee's own return apart from a join that merely
   *  PASSES THROUGH one, which the register file cannot: both leave argument 0 unfresh. */
  calleeResults: ReadonlySet<Value>;
  /** one entry per CFG edge, as passed to {@link makeSsaBuilder} */
  preds: number[][];
  /** per block: the keys written since its LAST call (since its start if it makes none). Indexed by
   *  block, and it holds every key the builder saw, not only argument registers. */
  freshAtEnd: Array<Set<string>>;
  /** blocks that make at least one call */
  callsIn: Set<number>;
  sites: GuessedCallSite[];
}

/** Cut a GUESSED call arity down by the ABI's caller-saved clobber.
 *
 *  `fallbackArgc` counts argument registers that merely have a reaching definition. A call clobbers
 *  r0..r3, so a definition the call sits between cannot be an argument the caller set up — correct
 *  compiled code would have re-materialized it. Counting it anyway INVENTS arguments
 *  (`m4aSongNumStart(0x89, 30, x, &g)` for a one-argument callee) — a hard compile error where the
 *  project's own header is in scope, and silently wrong code where C89's implicit declaration
 *  covers for it.
 *
 *  SCOPE: this closes the arguments an intervening CALL disproves, which is the common case in real
 *  code. It does not close the rest — a dead value the compiler happened to leave in the next
 *  argument register with no call in between still reads as an argument, and nothing about the
 *  register file can say otherwise. A declared prototype closes those outright; short of one, the
 *  narrower reading is recorded here and offered as a ranked candidate ({@link narrowToSetupArgs}).
 *
 *  A must-analysis: a register is FRESH at a point iff on EVERY path reaching it, it was written
 *  after the last call. The entry block starts all-fresh (those are the caller's own arguments).
 *  The result only ever SHRINKS an arity, but two of the shrinks are REFUSALS and not proofs, so a
 *  real argument CAN go with them: a fresh register above a hole stops the run (a 64-bit return
 *  occupies two registers and the frontend cannot express one, so the caller's r2 goes with the
 *  unfillable r1), and a callee's return read as the callee's own drops an argument a `g(f())`
 *  source did pass. A declared prototype is what closes either.
 *
 *  Frontend-agnostic: the caller supplies what its own lifting scan observed, so nothing here
 *  re-derives which instruction writes which register. */
export function trimClobberedCallArgs(inp: CallArgTrim): void {
  const { argRegs, returnReg, calleeResults, preds, freshAtEnd, callsIn, sites } = inp;
  const blockCount = freshAtEnd.length;
  const all = () => new Set(argRegs);
  const localEnd = (b: number) => freshAtEnd[b] ?? new Set<string>();
  // freshOut[b]: registers fresh where b ends. A block that calls forgets everything before its
  // last call; one that does not passes its input through, plus what it wrote.
  const freshOut: Set<string>[] = Array.from({ length: blockCount }, () => all());
  const freshIn: Set<string>[] = Array.from({ length: blockCount }, () => all());
  const inOf = (b: number): Set<string> => {
    // A block with NO predecessors is the function entry (or unreachable): its argument registers
    // are the ones the caller set up. An entry that DOES have predecessors — an entry that is also
    // a loop header — gets the ordinary intersection instead, because on the back edge the caller's
    // setup is long gone and an intervening call may have clobbered it.
    const ps = [...new Set(preds[b] ?? [])];
    if (ps.length === 0) {
      return all();
    }
    const acc = new Set(freshOut[ps[0]]);
    for (const p of ps.slice(1)) {
      for (const r of [...acc]) {
        if (!freshOut[p].has(r)) {
          acc.delete(r);
        }
      }
    }
    return acc;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let b = 0; b < blockCount; b++) {
      const fin = inOf(b);
      const fout = callsIn.has(b) ? localEnd(b) : new Set([...fin, ...localEnd(b)]);
      if (fout.size !== freshOut[b].size || [...fout].some((r) => !freshOut[b].has(r))) {
        changed = true;
      }
      freshIn[b] = fin;
      freshOut[b] = fout;
    }
  }
  const runOfFresh = (fresh: Set<string>, from: number): number => {
    let n = from;
    while (n < argRegs.length && fresh.has(argRegs[n])) {
      n++;
    }
    return n;
  };
  // A LATER argument register this caller set up proves the call takes arguments at all, and
  // argument 0 sits below one that is proven — so it is being passed too, whatever put it there
  // (`bl __mulsf3; add r1,r4,#0; bl __addsf3` is `__addsf3(__mulsf3(a, b), c)`).
  const setsUpLater = (fresh: Set<string>): boolean => argRegs.some((r, i) => i > 0 && fresh.has(r));
  // THE RETURN REGISTER IS NOT ARGUMENT SETUP. Where the ABI aliases it onto argument 0, the
  // frontends record a call's clobber AFTER its own result, so the result leaves the register
  // UNfresh here. That disproves caller setup only where the callee's return is BOTH what the
  // register still holds and all the site has to go on: with a later register set up (above), or
  // with a value no call produced — a join of one path's return with another path's caller-computed
  // value — argument 0 is a real argument, and dropping the second kind would delete the
  // instructions that computed it.
  //
  // With neither, the site carries no argument evidence at all: `bl f; bl g` is `f(); g();` as
  // readily as `g(f())`, the two spell the same bytes on this ABI, and only the nested one needs
  // `f` to return a value and `g` to accept one — a spelling the project's own header rejects
  // outright when it does not. A declared prototype never reaches here, and stays the way `g(f())`
  // is recovered.
  const argcAt = (fresh: Set<string>, op: Op): number => {
    if (argRegs[0] !== returnReg || fresh.has(argRegs[0])) {
      return runOfFresh(fresh, 0);
    }
    if (setsUpLater(fresh) || !calleeResults.has(op.operands[0])) {
      return runOfFresh(new Set([argRegs[0], ...fresh]), 0);
    }
    return 0;
  };
  for (const s of sites) {
    const fresh = s.afterCallInBlock ? s.freshBefore : new Set([...freshIn[s.block], ...s.freshBefore]);
    const n = argcAt(fresh, s.op);
    if (n < s.op.operands.length) {
      s.op.operands.length = n;
    }
    // The SHORTER arity the same evidence also allows, recorded for {@link narrowToSetupArgs}: the
    // run over what THIS BLOCK wrote, dropping the registers that are fresh only because no call
    // stands between here and wherever they were last written. Both readings stay live, so this one
    // is recorded rather than applied. A survivor is what it drops, so the join clause above has no
    // place here — but `setsUpLater` still does: a register this block set up two instructions
    // before the call is not something the narrower reading may call dead.
    const localFresh = setsUpLater(s.freshBefore) ? new Set([argRegs[0], ...s.freshBefore]) : s.freshBefore;
    const local = Math.min(runOfFresh(localFresh, 0), s.op.operands.length);
    if (local < s.op.operands.length) {
      setupArgc.set(s.op, local);
    }
  }
}

/** The narrower arity {@link narrowToSetupArgs} would cut each guessed call to. A SIDE table and
 *  not an attr: this is a fact about one LIFT, not part of the IR the rest of the pipeline compares
 *  and prints — `structure/hazards.ts` decides two ops equal by comparing their attrs verbatim, so
 *  an attr only one of an otherwise-matching pair carries would cost a recovery. */
const setupArgc = new WeakMap<Op, number>();

/** Whether anything in `fn` HAS the narrower reading — the variation's gate, so the ~99% of functions
 *  with no narrowable call cost no re-lift. Read it off the lift itself: a later pipeline stage may
 *  replace a `call` op (softdiv rewrites one to a division), and the table is keyed by op. */
export function hasSetupArgsNarrowing(fn: Fn): boolean {
  return fn.blocks.some((b) => b.ops.some((op) => setupArgc.has(op)));
}

/** Cut every guessed call to the arity its OWN BLOCK set up, and report whether anything moved.
 *
 *  `trimClobberedCallArgs` keeps an argument register whose value merely survives from an earlier
 *  block, because compiled code really does pass one that way: agbcc leaves a value already in r0
 *  where it is and branches to the call (`if (x) f(x);` is `cmp r0,#0; beq; bl f`, no setup at
 *  all). Those are also the bytes `if (x) f();` compiles to, so usually neither reading is
 *  refutable — but where the guard is an EQUALITY the compiler proves the argument constant and
 *  has to materialize it (`if (x == 0) f(x);` opens the arm with `mov r0,#0`), and the absence of
 *  that instruction rules the wider reading out. Which case a function is in is not knowable from
 *  the register file, and is exactly what a differ decides. Hence a ranked candidate rather than a
 *  default: the arm that passes only what the calling block itself put there.
 *
 *  Applies only to arities that were GUESSED — a declared prototype never recorded the fact. */
export function narrowToSetupArgs(fn: Fn): boolean {
  let changed = false;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const setup = setupArgc.get(op);
      if (setup !== undefined && setup < op.operands.length) {
        op.operands.length = setup;
        changed = true;
      }
    }
  }
  if (changed) {
    // A dropped argument can be a join's last reader, and `finish()` pruned the dead phis before
    // this reading existed. Left in, the phi's edge args render as assignments to a local nothing
    // reads (`v0 = UpdateWorldMapCursor();`) — see the note on the prune in `finish`.
    pruneDeadParams(fn);
  }
  return changed;
}

/** The stack-slot key both the MIPS and Thumb frontends use for a word-sized local in the
 *  function's own frame. Shared so the two spell it identically and the frame-partition rule can
 *  recognise either frontend's slots. See the virtual-key note in the module header. */
const SLOT_PREFIX = 'sp@';
export const stackSlotKey = (off: number): string => `${SLOT_PREFIX}${off}`;
/** The byte offset a slot key names, or null if `key` is not a slot key at all (an ordinary
 *  register). The grammar stays owned by this module — {@link LiveInModel} is expressed in the same
 *  coordinate, so the classification rule can be generic. */
export const slotKeyOffset = (key: string): number | null =>
  key.startsWith(SLOT_PREFIX) ? Number(key.slice(SLOT_PREFIX.length)) : null;

/** Where a live-in of the entry block sits in the calling convention: `slotOf` gives its ABI
 *  argument slot (a register or an incoming stack word), or null for a live-in no argument arrives
 *  in — an uninitialised register the body reads; `keyOf` is its inverse. One per frontend, read by
 *  both halves of the entry-parameter rule: {@link mintArgSlotHoles} and {@link abiSortEntryParams}.
 *
 *  Both halves need an entry block with NO predecessors, whose parameters are the function's own.
 *  A loop header's are phis, index-aligned with its predecessors' edge arguments, and neither
 *  minting one nor reordering them is legal there — so a frontend whose first block is a branch
 *  target inserts an empty preheader ahead of it (each frontend's `preheader` note). */
export interface ArgSlots {
  slotOf(key: string): number | null;
  keyOf(slot: number): string;
}

/** The slots of a convention that passes arguments in `argRegs` only. */
export const registerArgSlots = (argRegs: readonly string[]): ArgSlots => ({
  slotOf: (key) => (argRegs.includes(key) ? argRegs.indexOf(key) : null),
  keyOf: (k) => argRegs[k],
});

/** A rank past every argument slot, for a live-in that is not one. */
const NOT_AN_ARGUMENT = Number.MAX_SAFE_INTEGER;

/** Give the entry block a parameter for every argument slot below the highest one it takes. Naming
 *  is POSITIONAL (`a0`, `a1`, … in {@link abiSortEntryParams} order), so a slot the body never reads
 *  drops out of the signature and binds every later argument one slot low, silently: `int f(int a,
 *  int b, int c) { return a + c; }` reads r3 and r5, and lifted as `f(a0, a1)` with r5 in r4's slot.
 *  Arguments take their slots in order, registers first and then the stack words, so reading slot
 *  k proves slots 0..k-1 precede it — an obligation on the signature, which is what `ensureParam`
 *  is for. A live-in that is no slot proves nothing about that sequence. Call it before `finish()`,
 *  which records evidence for every entry parameter. */
export function mintArgSlotHoles(
  ssa: Pick<SsaBuilder, 'irBlocks' | 'paramReg' | 'ensureParam'>,
  entryHasPreds: boolean,
  slots: ArgSlots,
): void {
  assertTrueEntry(entryHasPreds);
  const top = Math.max(-1, ...ssa.irBlocks[0].params.map((p) => slots.slotOf(ssa.paramReg.get(p) ?? '') ?? -1));
  for (let k = 0; k < top; k++) {
    ssa.ensureParam(slots.keyOf(k), 0);
  }
}

/** Order the entry block's parameters by ABI argument slot, so downstream naming (`a0`, `a1`, …)
 *  matches the calling convention, not first-read order (a callee-saved copy can read a later
 *  argument register first). A live-in that is no slot goes after every one that is: ranked
 *  first, it takes `a0` and binds every real argument one slot high. */
export function abiSortEntryParams(
  entry: { params: Value[] },
  entryHasPreds: boolean,
  paramReg: ReadonlyMap<Value, string>,
  slots: ArgSlots,
): void {
  assertTrueEntry(entryHasPreds);
  const rank = (v: Value): number => slots.slotOf(paramReg.get(v) ?? '') ?? NOT_AN_ARGUMENT;
  entry.params.sort((x, y) => rank(x) - rank(y));
}

function assertTrueEntry(entryHasPreds: boolean): void {
  if (entryHasPreds) {
    throw new Error('internal: the entry-parameter rule needs an entry block with no predecessors');
  }
}
