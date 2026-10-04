// asmlift — the Target: (isa, compiler) as first-class fields. ABI + capabilities are DATA
// consumed generically by shared passes — never a target-name branch inside a shared pass
// (m2c's `arch.arch ==` leakage).
//
// What each datum drives:
//   • id               → frontend dispatch (registry.ts)
//   • compiler         → idiom gating (patternApplies) + the report
//   • argRegs / returnReg → entry-param ordering and return-value read in the frontends
//   • capabilities.hwDivide → gates the MIPS hardware-divide decode (mips.ts), the soft-division
//     pre-recovery pass, and idiom gating; a `div` on a target declaring no divider degrades to
//     a loud opaque (exercised by packages/cli/test/matching/divmul.test.ts). `hwFloat` → idiom
//     gating only (no float pass yet).
//   • capabilities.endianness → structureOptionsFor (`littleEndian`), gating LSB-first
//     bitfield-extract recognition in the structurer.
//   • capabilities.flags → RESERVED, not yet read by any pass (PPC condition regs will).
//   • capabilities.readOnlyAddressSinks → the frame-object audit: a frame address stored to
//     one of these reached a device that only reads through it, so it does not retract `undef`.
//   • capabilities.readSourceControl → the same audit: which frame bytes beside the object that
//     device may read, so a slot it cannot reach is not refused.
//   • capabilities.blockTransferCalls → the same audit: a frame address handed to one of these
//     as its SOURCE is read as far as the call's literal control word says, and never written.
//   • capabilities.deviceRegisters → six readers, and they ask ONE question — "would a source
//     have spelled this address `volatile`" — which is a question about SPELLING and may be
//     approximate: the `/vol-store` variation's eligibility (l3/volstore.ts), rank.ts's volatility
//     tie-break between two byte-identical spellings, the first half of `/unreduce`'s
//     disjointness gate (l3/unreduce.ts), the `/homesplit` pairing's refusal to leave a device
//     READ inline where the spelling it replaces would have qualified it (l3/homesplit.ts), the
//     structurer's refusal to SPELL a dead memory read whose address no qualifier could ever
//     reach (structure.ts `volatileQualifiable`, threaded through StructureOptions), and the
//     device pin (frontend/device-pins.ts), which spells every access in the window `volatile`
//     in a function the frame-object audit keeps as one object, and in one it accepts object by
//     object every device read and the device stores a later store in their block overwrites —
//     under either policy save a read the compiler could not have made of a `volatile`
//     (`volatileReadsExtendInRegister`).
//     That last reader makes the answer a correctness one — agbcc deletes or hoists a plain
//     device access the machine made — so it may be approximate in ONE direction only: the
//     window must cover every register a source reaches, and covering more costs a spelling,
//     never an access.
//   • capabilities.deviceMemoryWriters → the MEMORY-MODEL question, which is a different one and
//     may NOT be approximate: "can a write to this register make the DEVICE write ordinary
//     memory". One reader — `/unreduce`'s second half. Split from `deviceRegisters` because
//     conflating them recorded a false premise (see the field's own comment).
//   • compilerBehaviors.* → mostly consumed by the structurer (threaded via StructureOptions).
//     Others are read off the target directly by a consumer that is not the structurer — among
//     them `nearBaseSpan` and `foldsConstAddrOffset` (rank.ts, L3 respell variations),
//     `reloadsLocalReread`, `narrowParamWitness` and `aggregateBoundary` (raise/pre-recovery.ts),
//     `aggregateReturn`, `largestAlignment`, `enumBytes` and `bitfieldPacking` (aggregate.ts, for
//     frontend/thumb.ts, frontend/ppc.ts and frontend/frame-objects.ts),
//     `hoistsSingleSetArm` (raise/narrowlocal.ts and raise/retsink.ts), `arrayShapeFromStride`
//     (raise/globalshape.ts, run on the LIFTED fn), `eightByteReturnScratch`
//     (frontend/thumb.ts, which reads the epilogue), `callThunks` (frontend/thumb.ts, which
//     lowers a `bl` to one as a call through its register), `roundTripsDoubleLiterals`
//     (raise/floathelpers.ts) and `volatileReadsExtendInRegister` (frontend/device-pins.ts, and
//     raise/declared-volatile.ts through liftStamped and the offset-name pass). The
//     field names are a SUPERSET of
//     StructureOptions' — see `structureOptionsFor`.
//
// `capabilities` (HARDWARE facts) vs `compilerBehaviors` (COMPILER canonicalization decisions) are
// deliberately separate bags: a new compiler must set its behaviors EXPLICITLY instead of
// silently inheriting a universal that is really per-compiler. `coalesceLoopInit` already
// differs across targets (IDO true, agbcc/GCC false).
// This module is browser-pure by contract (no Node APIs, enforced by
// test/browser-safe.test.ts): the toolchain paths that COMPILE for these targets
// live in @asmlift/toolchains.
import { type CodegenProfile, type FlagFamily, dialectOf, parseFlags } from './codegen-flags';
import type { Op } from './ir/core';
import { PRELUDE_TYPEDEFS, type ParamType, type Prototypes, declaredWidth, spellableType } from './proto';
import {
  AGBCC_RUNTIME_HELPERS,
  IDO_RUNTIME_HELPERS,
  MIPS_GCC_RUNTIME_HELPERS,
  PPC_MWCC_RUNTIME_HELPERS,
  type RuntimeHelper,
} from './runtime-helpers';
import type { StaticLayout } from './structure/local-statics';
import type { StructureOptions } from './structure/structure';
import type { SwitchBoundCase } from './structure/switch-recover';

/** What a compiler's OBJECT shows for a narrow declared parameter — see
 *  `compilerBehaviors.narrowParamWitness` for the compiled pair behind each value. */
export type NarrowParamWitness = 'prologue-extension' | 'home-store-and-in-place' | 'none';

/** What one transfer reads from its SOURCE, as its control bits say: the `unit` it reads in, and
 *  which way it `walk`s from the address — `fixed` re-reading one unit, `increment` upward for
 *  `bytes` when the control says how many and without end when it does not, `decrement` downward
 *  without end. Each transfer source decodes its own bit layout into this (`sourceControlRead`,
 *  `blockTransferRead`), and `sourceReach` alone turns it into frame bytes. */
export interface SourceRead {
  unit: number;
  walk: 'fixed' | 'increment' | 'decrement';
  bytes?: number;
}

/** The bytes a source read reaches from an address `off` bytes into the frame, as `[lo, hi)`
 *  relative to that address. The machine may force the address down to a unit boundary — the
 *  GBA's DMA and BIOS both do — so a 32-bit read of the halfword at [sp,#2] reads from [sp,#0],
 *  and the object below shares its unit. The frame base is at least unit-aligned, so the offset
 *  says how far down. */
export function sourceReach(read: SourceRead, off: number): { lo: number; hi: number } {
  return {
    lo: read.walk === 'decrement' ? -Infinity : 0 - (off % read.unit),
    hi: read.walk === 'increment' ? (read.bytes ?? Infinity) : read.unit,
  };
}

/** Could the source have made this read through a `volatile` lvalue, on a compiler that behaves as
 *  `behaviors` says? Not a sign-extending narrow load where the compiler extends a qualified narrow
 *  read in a register (`volatileReadsExtendInRegister`): the qualified read is another instruction
 *  sequence. The device pin (frontend/device-pins.ts) and the `declared` stamp
 *  (raise/declared-volatile.ts) both ask it, so the two placements read one load the same way. */
export function readCouldBeVolatile(
  behaviors: Pick<TargetDescription['compilerBehaviors'], 'volatileReadsExtendInRegister'>,
  op: Op,
): boolean {
  const width = (op.opcode === 'aload' ? op.attrs.elemSize : op.attrs.width) as number;
  return !(behaviors.volatileReadsExtendInRegister === true && op.attrs.signed === true && width < 4);
}

/** A device channel's source control, read off the halfword at `sink + offset` of a
 *  `readOnlyAddressSinks` register: `modes`, indexed by `(control >> modeShift) & (modes.length -
 *  1)`, is the way the source address steps per unit, null for a setting that bounds nothing; a
 *  unit is `units[1]` bytes when `wideBit` is set and `units[0]` when not. See `sourceControlRead`. */
export interface SourceControl {
  offset: number;
  modeShift: number;
  modes: readonly ('increment' | 'decrement' | 'fixed' | null)[];
  wideBit: number;
  units: readonly [number, number];
}

/** The source read one control halfword arms, or null for a mode that bounds nothing. The count
 *  lives in another register, so an incrementing read carries no `bytes`. */
export function sourceControlRead(control: SourceControl, half: number): SourceRead | null {
  const unit = control.units[(half & control.wideBit) !== 0 ? 1 : 0];
  const walk = control.modes[(half >> control.modeShift) & (control.modes.length - 1)];
  return walk === null || walk === undefined ? null : { unit, walk };
}

/** How far a block-transfer call reads through its `source` argument, decoded from the argument
 *  at `control`: `control & countMask` units, of `units[1]` bytes when `wideBit` is set and
 *  `units[0]` when not, rounded up to a multiple of `countGranule` units — or ONE unit when
 *  `fixedBit` is set, since a fill reads its source once. See `blockTransferRead`. */
export interface BlockTransferCall {
  source: number;
  control: number;
  countMask: number;
  fixedBit: number;
  wideBit: number;
  units: readonly [number, number];
  countGranule: number;
}

/** The source read a block-transfer call makes for a literal control word. */
export function blockTransferRead(call: BlockTransferCall, control: number): SourceRead {
  const unit = call.units[(control & call.wideBit) !== 0 ? 1 : 0];
  if ((control & call.fixedBit) !== 0) {
    return { unit, walk: 'fixed' };
  }
  const count = (control & call.countMask) >>> 0;
  return { unit, walk: 'increment', bytes: Math.ceil(count / call.countGranule) * call.countGranule * unit };
}

export interface TargetDescription {
  id: string; // the ISA — 'armv4t' / 'mips' / 'ppc'. Selects the frontend (registry.ts).
  // The COMPILER is a first-class field distinct from the ISA (matching = deoptimize to a specific
  // compiler): two targets can share an ISA (⇒ one frontend) yet differ here — e.g. MIPS_IDO vs
  // MIPS_GCC. Consumed by pattern gating (patternApplies) and the report. (version/flags are future
  // fields, added when earned.)
  compiler: string; // 'agbcc' / 'ido' / 'gcc' / 'mwcc'
  /** `'c++'` when the build compiles its unit as C++ (mwcc `-lang=c++`/`ec++`), which is what
   *  `targetFor` reads off the flags; absent is C. A candidate is C-shaped text either way — only
   *  what the C++ front end refuses differs, and `structureOptionsFor` is where that is answered. */
  dialect?: 'c++';
  argRegs: string[];
  returnReg: string;
  /** The floating-point ABI: where a float argument and a float return travel, on a target whose
   *  frontend lifts hardware floating point (`docs/floating-point.md`). ABSENT ⇒ none is claimed, and
   *  a frontend refuses every read of its FPU file that no instruction of the function wrote.
   *
   *  `argRegs` are the float argument registers in argument order, spelled as the frontend keys
   *  them; `returnReg` the float return. `slots` is how they count against `argRegs` above, and the
   *  two ABIs here differ in kind rather than in degree — both MEASURED by compiling (below):
   *   - `'leading'` (MIPS o32): argument k is in `argRegs[k]` only while arguments 0..k are ALL
   *     floating, and it still takes integer slot k — `float f(float a, int b)` reads `$f12` and
   *     `a1`, while `float f(int a, float b)` receives `b` in `a1` and moves it over with `mtc1`.
   *   - `'separate'` (PowerPC EABI): floating arguments count on their own and take no integer
   *     slot — `float g(int *p, float b)` and `float g(float b, int *p)` are one object, `r3` and
   *     `f1` either way. */
  fpu?: { argRegs: readonly string[]; returnReg: string; slots: 'leading' | 'separate' };
  /** A `double` crosses a call in GENERAL argument words: the two a 64-bit argument takes wherever
   *  this target's call placement puts them, HIGH word first, so the sign and exponent are in the
   *  first word. Its readers are `proto.ts` `declaredCallArgs` (the call's layout) and
   *  `raise/floathelpers.ts` (a literal's two words). ABSENT ⇒ a declared `double` parameter states
   *  no layout and the call takes the arg-register guess.
   *
   *  IT IS AN ABI FACT BESIDE `fpu`, NOT INSTEAD OF IT. Where the words go is the frontend's 64-bit
   *  placement, which a `long long` shares; this states only that a double takes them, and their
   *  order, which a `long long` need not share. agbcc: FLOAT_WORDS_BIG_ENDIAN 1
   *  (gcc/config/arm/thumb.h:335) on a little-endian target, so the pair is not a `long long`'s
   *  naming of the same bits; FUNCTION_ARG (:632) places by word offset, FUNCTION_ARG_PARTIAL_NREGS
   *  (:636) splits a pair across r3 and the stack, FUNCTION_ARG_ADVANCE (:647) rounds to a word and
   *  PARM_BOUNDARY is 32 (:354).
   *
   *  o32 MIPS has an FPU and a double after an integer argument still takes two general words,
   *  high first, at an even word as its `long long` does (IDO 7.1). The MIPS targets do not state it
   *  because their frontend lays out no 64-bit argument (`CallLowering.pairs`). PowerPC EABI passes
   *  a double in a float register that takes no general word (`fpu.slots: 'separate'`), so it has
   *  none to state. */
  doubleArgWords?: 'high-first';
  /** Registers this ABI does NOT pass arguments in — half of what makes a def-less live-in read an
   *  uninitialised local rather than an argument. The other half is a measurement the FRONTEND
   *  owes (did this function save the register), and the rule that combines them is in
   *  frontend/ssa.ts (LiveInModel.uninitRegs). ABSENT ⇒ no register partition is claimed, which is
   *  what MIPS and PPC take today.
   *
   *  It must be DISJOINT from `argRegs`, and the frontend hands both to the builder so that is
   *  checked rather than trusted (`checkedLiveInModel`): a spelling that lands in both lists used
   *  to delete a parameter and emit `uninit_<reg>` in its place, silently. */
  nonArgRegs?: readonly string[];
  /** Of `nonArgRegs`, the ones this ABI does NOT require a callee to preserve — so the compiler may
   *  home a local in one with no prologue save at all, and the save half of the rule above does not
   *  apply to it. AAPCS's `ip` is the whole set here, and agbcc really does use it that way.
   *
   *  UNDER-stating this list only makes the classification stricter: an unlisted register whose save
   *  the frontend cannot find falls back to being a parameter, which is what a target claiming no
   *  partition gets. OVER-stating it is the unsound direction — a callee-saved register listed here
   *  is classified with no evidence at all, which is the defect the save half exists to close. Every
   *  entry must appear in `nonArgRegs`; the frontend refuses a target where one does not. */
  scratchRegs?: readonly string[];
  /** Registers a CALL destroys: after one, they hold whatever the callee left there, and no value
   *  this function computed. The frontends hand this to the SSA builder so a read of one past a
   *  call refuses instead of resolving to the pre-call definition (frontend/ssa.ts).
   *
   *  REQUIRED, unlike its two neighbours above, and the asymmetry is the point. An absent
   *  `nonArgRegs` claims no partition, which only makes classification stricter; an absent
   *  `scratchRegs` under-states a set whose own comment says under-stating is safe. An absent
   *  caller-saved list takes the UNSOUND direction — nothing refuses, so a destroyed register keeps
   *  resolving to a value the callee overwrote, silently and with exit 0. A channel whose omission
   *  is unsound is a required argument, so that forgetting it is a type error.
   *
   *  `argRegs` must be a SUBSET of it — a register the caller passes arguments in is by
   *  construction one the callee may destroy — and `clobberedByCall` (frontend/ssa.ts) checks that
   *  rather than trusting it, the way `checkedLiveInModel` checks the register partition. */
  callerSaved: readonly string[];
  /** The COMPILER RUNTIME HELPERS this compiler's codegen calls, and what each computes
   *  (runtime-helpers.ts). A compiler fact, which is why it lives here and not in `proto.ts`: that
   *  file holds signatures fixed by the C STANDARD, and a helper name is fixed by a runtime
   *  library — agbcc calls `__muldi3`, CodeWarrior `__div2i`, IDO `__ll_mul`.
   *
   *  ABSENT ⇒ no helper is recognised AND none is refused, so every such call stays an ordinary
   *  call with its arguments guessed and the backend spells it. That is the UNMEASURED direction,
   *  not the safe one: re-emitting a compiler's own runtime call is the one failure that MATCHES,
   *  because a compiler handed `__div2i(a, b)` emits the `bl __div2i` the row was lifted from
   *  (`raise/widehelpers.ts` states this at the refusal it exists to make). Absence is still the
   *  right default, because a name outside the table cannot be told from a project's own
   *  `__`-prefixed function by spelling — but it buys nothing on a target whose runtime has simply
   *  not been enumerated. */
  runtimeHelpers?: Readonly<Record<string, RuntimeHelper>>;
  // HARDWARE / ISA facts — independent of the compiler.
  capabilities: {
    endianness: 'little' | 'big'; // consumed by structureOptionsFor (bitfield extract recognition is LSB-first)
    hwDivide: boolean; // consumed by patternApplies (idiom gating)
    hwFloat: boolean; // consumed by patternApplies (idiom gating)
    flags: boolean; // RESERVED — no pass reads it yet (PPC condition regs will)
    // Addresses a device reads an object THROUGH. A frame address stored to one of these is handed
    // over as a transfer SOURCE, and two facts together are what make that safe to model: the
    // device only ever reads from it, and the register is WRITE-ONLY, so nobody can read the
    // address back out and turn it into a destination. The only code that can name the frame is
    // therefore this function's own, which the frame-object audit walks.
    //
    // Hardware, so it belongs here — `endianness` above is a board fact rather than an ISA one too
    // (ARMv4T is bi-endian). ABSENT ⇒ every escape is assumed to write, which is the safe
    // direction and what every other target gets.
    readOnlyAddressSinks?: readonly number[];
    // HOW FAR a device reads from the address a `readOnlyAddressSinks` register was handed, read
    // off the control halfword at `sink + offset` (`SourceControl`). A fixed source re-reads one
    // unit — the unit-aligned one holding the address, since the device may drop its low bits — so
    // the frame bytes outside that unit are provably not read.
    // ABSENT ⇒ the read is unbounded in both directions, the safe direction.
    readSourceControl?: SourceControl;
    // The device-register window, `[start, end)`. A cell in it changes under the program's feet,
    // so a source that touched one all but certainly declared it `volatile`. Its readers all ask
    // the same SPELLING question — "would a source have written `volatile` here" — and the file
    // header's ledger names them and what each does with the answer. All but one leave the
    // decision to the differ: which cells a source qualified is not derivable from the asm, so
    // both spellings are enumerated and the differ referees. The device pin decides, because
    // there the plain spelling recompiles to a different program; that is why the window has to
    // cover every register. ABSENT ⇒ the variation declines everywhere and the tie-break
    // has no preference, which is the neutral direction — outside a declared window the qualifier
    // is a claim about ordinary memory that the target does not support.
    //
    // IT IS NOT A MEMORY-MODEL CLAIM, and reading it as one is how a false premise got recorded
    // in four places (`deviceMemoryWriters` below carries the correction). Approximating the
    // range costs a candidate; approximating the memory model costs a wrong answer.
    deviceRegisters?: readonly [number, number];
    // Byte ranges, `[start, end)`, whose WRITE can make the DEVICE write ordinary memory. The
    // separate, stronger claim: `deviceRegisters` says a cell is not an object a source declares,
    // which is true and says nothing about what the DEVICE then does. A DMA controller reads a
    // control word and writes memory on the program's behalf, so a loop whose every write is a
    // "device register" write can still rewrite any cell — including one a moved read reads.
    //
    // GBA: the four DMA channel CONTROL halfwords (DMAnCNT_H). Bit 15 is the channel enable, and
    // writing it with the bit set starts the transfer immediately; the other three registers of a
    // channel (SAD, DAD, CNT_L) only stage it — which is the same split `readOnlyAddressSinks`
    // above already reasons about from the source side. A store is a trigger when its BYTE RANGE
    // touches one of these, so the 32-bit `DMA3CNT` write every GBA DMA macro ends with
    // (`*(vu32 *)0x040000DC = 0x84000020`) is one, and a halfword write to `DMA3CNT_L` is not.
    //
    // ABSENT ⇒ the target claims nothing, and the one reader treats EVERY device write as a
    // possible memory write — the conservative direction, and what every non-GBA target takes.
    deviceMemoryWriters?: readonly (readonly [number, number])[];
    // CALLS that only READ through one argument, as far as a control argument says — a platform's
    // block-transfer services, bound to a name by the SDK's own stubs. The frame-object audit is
    // the reader: a frame address handed to one as its `source`, with a literal control word,
    // reaches the bytes `blockTransferRead` decodes and is not an address anything writes through.
    // The destination needs no entry, since a frame address handed over anywhere else keeps
    // escaping as one a callee may write through.
    //
    // ABSENT, or a callee it does not name ⇒ an address handed to a callee may be read and written
    // without bound, the safe direction.
    blockTransferCalls?: Readonly<Record<string, BlockTransferCall>>;
  };
  // COMPILER BEHAVIORS — the specific compiler's canonicalization decisions, distinct from
  // hardware `capabilities`. Mostly consumed by the structurer (threaded through StructureOptions);
  // the exceptions are listed at the top of this file and each says so at its own field.
  compilerBehaviors: {
    // When a loop induction variable's initial value comes from an argument register, some
    // compilers keep mutating that register across the loop (coalesce → no init copy); others
    // copy to a fresh local. IDO -O2 and KMC GCC -O2 reuse the arg register (true); agbcc
    // allocates fresh (false).
    coalesceLoopInit?: boolean;
    // Divergent-if (both arms terminate, no join): reproduce the source branch DIRECTION by
    // emitting the forward-branch-on-negated-condition (taken arm as `else`). IDO/MIPS preserves
    // source direction so this must be on to be byte-exact; agbcc/GCC canonicalize either way so
    // true is a safe default there. A compiler that inverts branch canonicalization sets it
    // false. Absent ⇒ true; a compiler opts OUT. It carries the JOINED case with it:
    // StructureOptions.negateJoinedBranchSense defaults to this value, so the first compiler that
    // preserves divergent sense and inverts joined sense splits them by promoting that option to a
    // field here — never by an `arch ==` branch in the structurer.
    preserveDivergentBranchSense?: boolean;
    // Order the parallel-copy assignments at a CFG edge by the order the PREDECESSOR WROTE THEIR
    // DESTINATIONS — the frontend's own measurement (ir/core.ts `WriteOrder`), falling back to a
    // def-position proxy on a predecessor no frontend measured. Not "computation order": a
    // destination written with a value defined elsewhere is a plain register copy, and it ranks by
    // where that copy sits, not by where its value was computed. Uniform (true) across all current
    // compilers; absent ⇒ true, and a compiler that opts OUT turns the sort off entirely and emits
    // in source/param order. WHICH order a measured edge takes is not this flag's question and
    // cannot be: the benchmark has rows on both sides inside one compiler (mwcc), so that decision is
    // refereed per row by `/copy-defpos` (rank.ts), never declared per compiler here.
    orderArgCopiesByWriteOrder?: boolean;
    // Regime-A switch recovery: accept an `x != K` test as a case (the EQUAL side is the case
    // body). GCC freely emits `!=`; IDO prefers `==`/`<`. Absent ⇒ true (permissive); the
    // decline path keeps recovery sound either way.
    switchAllowsNeqCase?: boolean;
    // The compiler collapses `if (…) x = a; else x = b;` into `x = b; if (…) x = a;` when both
    // arms are ONE speculatable SET — gcc 2.x's `jump_optimize` (`gcc/jump.c:443-445`, guard at
    // `:471-502`). Absent ⇒ false, and every clause below never admits. `structureOptionsFor`
    // spreads it onto StructureOptions like every other field here, but NO structurer code reads
    // it: both readers are raising passes, threaded from their driver's own `target`.
    //
    // TWO READERS, ONE FACT, BOTH READING IT BACKWARDS. One field rather than one per reader,
    // because a second boolean for the same guard lets a round that measures another compiler's
    // `jump_optimize` set one and leave the other false, with both comments reading as
    // authoritative.
    //
    //   • raise/narrowlocal.ts's `edge-extends`: a diamond this compiler would have collapsed and
    //     did NOT is evidence the source DECLARED the local narrow, because `gcc/thumb.h:344`
    //     PROMOTE_MODE expands a narrow-declared assignment past one SET.
    //   • raise/retsink.ts's `compiler-hoists-single-set-arm`: a merge-variable select whose arms
    //     this guard would have collapsed never comes back as a diamond, so a TARGET holding one
    //     was written with early returns and its returns should be sunk.
    //
    // Set on agbcc, where the 2x2 in raise/narrowlocal.ts's header was compiled and scored and
    // where retsink's seven-function spelling pair was compiled and committed
    // (`packages/core/test/corpus/agbcc-select-{merge,early}.s`). NOT set on MIPS_GCC despite it
    // being the same compiler family: nothing has measured the pair there, the clause reaches 0 of
    // its benchmark rows on either reader, and `docs/level-tower.md`'s rule for an unmeasured
    // compiler behavior is to claim nothing. The evidence a future round needs is one run of
    // `scripts/regen-select-spelling-probes.ts` retargeted at the compiler in question.
    hoistsSingleSetArm?: boolean;
    // THE REGISTER AN INTERWORKING EPILOGUE POPS THE RETURN ADDRESS INTO WHEN THE RETURN TYPE IS 5
    // TO 8 BYTES, which is then a fact the epilogue states about the function's width. agbcc's
    // `thumb_exit` (gcc/thumb.c) picks that register from the SIZE of the return mode, not from
    // liveness — r0 for `void`, r1 up to 4 bytes, r2 up to 8 — so `pop {r2}; bx r2` ends a function
    // returning a `long long`, a `double`, or an 8-byte aggregate (which DImode covers even when it is
    // returned through memory). Read by `frontend/thumb.ts`'s `refuseWordReturns` directly, not by
    // the structurer. Absent ⇒ the epilogue states nothing.
    eightByteReturnScratch?: string;
    // WHAT, IN THIS COMPILER'S OBJECT, WITNESSES A NARROW DECLARED PARAMETER — the fact
    // raise/paramwidth.ts needs before it may retype `s32 a0` to `s8 a0`. Three answers, because
    // the compilers measured give three, and the pass refuses wherever the object is silent. Each
    // target below carries its own measurement, and raise/paramwidth.ts's header carries the
    // compiled pairs all three readings rest on.
    //
    //   • `'prologue-extension'` — the extension's POSITION decides it: a narrow-declared
    //     parameter widens at the very top of the function, a body cast widens at its use.
    //   • `'home-store-and-in-place'` — the position decides NOTHING, both spellings leading the
    //     function, and TWO other facts decide it together: the parameter is stored to an argument
    //     home nothing reads back AND widened in its own argument register. Each half alone has a
    //     compiled counterexample, so only the PAIR separates a declaration from a body cast.
    //
    //     THE HOME STORE IS AN `-O2` OBSERVABLE, AND `-g` IS NOT WHAT REMOVES IT. Measured on
    //     `int f(s8 x){ return x; }`: present at `-O2` and at `-O2 -g3`, absent at `-O1`, at `-O0`
    //     and at `-g` (which implies `-O0`). So the 42 real af rows that build at
    //     `-G 0 -non_shared -Wab,-r4300_mul -mips2 -EB -O2 -g3` DO carry it — checked at exactly
    //     those flags — and a target built at `-O1`/`-O0` would have to claim `'none'`. The
    //     in-place widening survives every one of those levels, but on its own it decides nothing,
    //     so the pass refuses there rather than reading half a pair.
    //   • `'none'` — the object does not distinguish the two at all, so no reading of it licenses
    //     the narrowing. It is a MEASUREMENT rather than a withholding wherever a target claims it.
    //
    // A compiler that sets nothing here also refuses, which is the right default for one nobody has
    // compiled the pair with (docs/level-tower.md: claim nothing about an unmeasured behavior).
    narrowParamWitness?: NarrowParamWitness;
    // A subscript over a DECLARED ARRAY OBJECT expands its base ahead of the index, where every
    // pointer or cast base expands it last — so the instruction order in the target's own assembly
    // says which of the two the source wrote, and `raise/globalshape.ts` may derive an array shape
    // for a global no symbol map describes. Absent ⇒ the derivation is empty and every indexed
    // global keeps today's `((T *)&gSym)[i]` cast spelling.
    //
    // "Expands it last" is about the SUBSCRIPT, and a second consumer reads the same flag for a
    // question that is not: `orderLicensedGlobals` asks only where the base was materialized, and a
    // pointer LOCAL materializes it in its own initializer STATEMENT, before the subscript runs —
    // so `u16 *p = (u16 *)&gTbl; p[i]` is base-first in the object while `(p = (u16 *)&gTbl)[i]` is
    // index-first, both through this same fork (compiled; raise/globalshape.ts's header carries the
    // four-way table). This flag is therefore NARROWER than that consumer's mechanism — statement
    // ordering needs no fork, only a compiler that does not schedule — so the home variation is denied
    // to ido/kmc/mwcc for a reason that is not its own. Under-reach, unmeasured, and the fix when a
    // row asks for it is a datum of its own rather than a widening of this one.
    //
    // Set on agbcc, where the fork is `gcc/c-typeck.c build_array_ref`'s
    // `TREE_CODE (TREE_TYPE (array)) == ARRAY_TYPE && TREE_CODE (array) != INDIRECT_REF` and both
    // spellings were compiled against the same target. NOT set anywhere else: whether ido, kmc or
    // mwcc distinguish them at all is unmeasured, and `docs/level-tower.md`'s rule for an
    // unmeasured compiler behavior is to claim nothing. Read off the target by a raising pass
    // (`inferGlobalArrays`), not by the structurer.
    arrayShapeFromStride?: boolean;
    // Which way this compiler hands out FRAME SLOTS against a spilled local's DECLARATION RANK:
    // `ascending` = the earlier-declared spilled local takes the LOWER `[sp,#k]`. Consumed by the
    // structurer (StructureOptions.spillSlotOrder) and applied at emit time by l3/slotorder.ts.
    //
    // `'unknown'` and absent both REFUSE the ordering — there is deliberately no default
    // direction, because the wrong one reorders every declaration list on that target for no
    // reason. That is why three of the four descriptions below ship `'unknown'`: no MIPS or PPC
    // benchmark row lifts with two or more spilled user locals, so no row on those tiers can
    // referee a value, and a value no row can falsify does not earn the level. Two of the three
    // have a direction MEASURED against a committed probe and withheld for that reason; the third
    // (mwcc) has no direction at all, because the probe does not spill there. Each says which it
    // is, and its flip condition, at its own site.
    //
    // KEYED BY DESCRIPTION, WHILE THE FACT IS PER TOOLCHAIN — the first field in this bag with a
    // stated instance of that gap. `MIPS_GCC` serves BOTH `gcc2.7.2kmc` (Snowboard Kids 2's Kyoto
    // build at -O2) and `gcc2.7.2` (Mario Party 3's at -O1); they agree here, and a committed probe
    // says so, but nothing in this bag could express it if they did not. Any behavior that can
    // differ between two toolchains sharing one description is mis-keyed by construction.
    spillSlotOrder?: 'ascending' | 'descending' | 'unknown';
    // Arguments past the argument registers are staged into an area this function RESERVES at the
    // BOTTOM of its own frame — `[sp,#0]` upward, one word each — rather than pushed at the call
    // site. It is GCC's ACCUMULATE_OUTGOING_ARGS target macro, and it is what makes an outgoing
    // argument INDISTINGUISHABLE by code alone from a dead local: the words sit inside this
    // frame's reservation and nothing this function does ever reloads one.
    //
    // It says WHERE the words go and nothing about the rest of the frame. Its one reader is the
    // Thumb frontend's stack-argument licence (`frontend/thumb.ts` `declaredCall`): a declared call
    // consumes the words it stages. Absent ⇒ no outgoing area is claimed, and a `[sp,#k]` store
    // reaching a call unread declines.
    //
    // Set on agbcc, where the layout was read off `gcc/config/arm/thumb.h` and then measured — the
    // corpus's `stkarg` and `stkwide` rows and kleod's `sub_0804C300` all stage their words at
    // [sp,#0] upward inside the prologue's own reservation. NOT set anywhere
    // else: a push-based caller would stage nothing inside the frame, and `docs/level-tower.md`'s
    // rule for an unmeasured compiler behavior is to claim nothing. No other frontend calls the
    // analysis today, so a second armv4t compiler must state this premise rather than inherit it.
    stagesOutgoingArgsInFrame?: boolean;
    // The outgoing area is ONE region at the frame bottom, sized for the widest call and shared by
    // every call, with every local and spill above it, and the caller never reads a word of it
    // back after a call — the callee may assign to its stack parameters, so the caller re-stages
    // an argument before every call. A compiler can stage in its frame
    // (`stagesOutgoingArgsInFrame`) and still break this: mwcc may put a local in the words its
    // outgoing parameters use (`frontend/ppc.ts`, "A GUESS THAT FILLS EVERY ARGUMENT REGISTER").
    //
    // It is a UNIVERSAL — for every source, the compiler emits no such read — and its one reader
    // applies the contrapositive (`frontend/stackargs.ts` `survivorBound`): a word loaded after a
    // call before any re-store is not in the area, so it is a local, and so is every word above it,
    // which lets a spill live across a call lift, and a call NO declaration covers
    // (`docs/level-tower.md`, THE CONTRAPOSITIVE OF A UNIVERSAL IS NOT A BACKWARDS READING). It is
    // exactly as sound as the universal, so its residue is every producer the universal does not
    // cover: hand-written asm that reads its outgoing argument back after a call loses that
    // argument silently. The premise is this compiler's, not the ISA's.
    // Absent ⇒ every staged word stays a candidate argument.
    //
    // Set on agbcc: thumb.h puts the locals at sp + outgoing_args_size (ACCUMULATE_OUTGOING_ARGS)
    // and `calls.c` sizes the area as the maximum over all calls; compiled, `spill10` and
    // `spillarg` keep their spills above the area, and `test/corpus/agbcc-restage.s` holds the
    // re-staging and the callee's write. NOT set anywhere else, for the reason above.
    localsAboveOutgoingArea?: boolean;
    // A frame of EXACTLY ONE reserved word whose base escapes this function holds that object and
    // nothing else. It is the layout premise the Thumb frontend's address-taken-local capability
    // rests on (`frontend/thumb.ts`, `capturedObjectIsTheWholeFrame`): a bare `mov rD, sp` names
    // frame offset 0, and the question this answers is whether the rest of that reservation could
    // be somebody else's — an outgoing argument staged at [sp,#0], a by-value struct argument's
    // block-copy destination, or a struct return's hidden pointer.
    //
    // Absent ⇒ no such claim, and every `[sp,#k]` store reaching a call unread keeps the refusal
    // it had before the capability existed. It is a layout fact about ONE compiler and it is not
    // derivable from the architecture, which is why it is a field and not an `arch ==` branch
    // (`docs/level-tower.md`).
    //
    // Set on agbcc, where it is two compiled producer tables rather than a reading — one per
    // escape, both written out at the predicate: at one word agbcc stages no outgoing argument
    // under a captured local (it moves the local above the area and spells its address `add rD,
    // sp, #4`), and it names a block-copy base with a register only from two words up. The one
    // producer a one-word frame does NOT exclude is a <=4-byte non-integer-like struct return,
    // which the post-lift audit settles per call rather than by size.
    oneWordFrameIsTheCapturedObject?: boolean;
    // How this compiler calls through a register: `bl <prefix><reg>` enters a runtime thunk that
    // branches to the address in <reg> with every register as the caller left it, so the call is
    // an indirect call through <reg> and the thunk is no function a source names. `regs` are the
    // thunks whose register can hold an address a source computed; a `<prefix>` callee outside them
    // declines.
    //
    // ABSENT ⇒ a `bl` names a function on this target, whatever it is called.
    callThunks?: { readonly prefix: string; readonly regs: readonly string[] };
    // Regime-A switch recovery: accept a RELATIONAL test as a case where the scrutinee values that
    // can reach it — narrowed by the tests above it — leave exactly one on a side this compiler's
    // dispatch lands a case body on: `'taken'` for its BRANCH only, `'either'` for both sides
    // (structure/switch-recover.ts, the note at `Ranges`).
    //
    // One mechanism on both compilers that declare it: a binary-search dispatch stops testing a
    // value once the tests above have narrowed it to one. agbcc's `emit_case_nodes` jumps straight to
    // `node->left->code_label` on LT once `node_is_bounded (node->left)` holds, so
    // `switch (x) { case 1: … case 2: … case 3: … case 4: … case 5: … case 1000: … case 2000: … }`
    // pins `case 3` with `cmp r1, #2; bgt` under `x < 4`, `x != 2` (`corpus/agbcc-swpathbound.s`),
    // and an unsigned switch's `case 0` with `cmp r0, #1; bcc`, which pins it at the end of the
    // domain whatever came first. mwcc's `switch (x) { case 0: … case 1: … default: … }` is
    // `cmpwi r3,1; beq- case1; bge- default; cmpwi r3,0; bge- case0; b default`, where `x >= 0` is
    // `case 0` only because `x != 1` and `x < 1` came first (`corpus/mwcc-swdispatch.asm`).
    //
    // THE SIDES DIFFER, and each is read off its own compiler. Every jump in `emit_case_nodes` that
    // lands on a case body is its test's BRANCH, while the fall-through always continues into more
    // dispatch, and none of 3176 generated agbcc dispatches lands a body on a fall side — so agbcc
    // is `'taken'`. mwcc lands one on either: `synthetic:sw_ret:mwcc_242_81` pins `case 3` on the
    // FALL side (`cmpwi r3,4; bge- default; b case3` under `x > 2`, `x != 2`), so mwcc is
    // `'either'`.
    //
    // A DEFAULT rather than a candidate variation because each declaring compiler's other producer
    // of the same test is told apart by its LAYOUT. An if/else-if ladder written with relational
    // tests pins values by its path just the same (`if (x >= 4) { if (x < 5) … } else if (x >= 3)
    // …` pins 4 and 3) but puts a body between two tests, where the dispatch puts every test above
    // every body — so this reading needs `switchRequiresFrontLoadedTests` beside it, and both
    // declaring compilers declare that too (`corpus/mwcc-sw{dispatch,ladder,relladder,relnest}.asm`
    // from `corpus/probe-mwcc-sw*.c`, regenerated by `scripts/regen-switch-spelling-probes.ts`). On
    // agbcc the unsigned endpoint has no ladder at all: -O2 fold-const rewrites `x < 1u` into
    // `cmp r0, #0 / bne` before codegen. All three builds PPC_MWCC serves emit the dispatch
    // identically at -O4,p and at -O0,p (`packages/cli/test/matching/ppc-compiler-behaviors.test.ts`).
    //
    // Absent ⇒ every relational test navigates, and inheriting it would be wrong rather than merely
    // unmeasured: on the MIPS lanes `sltiu rd, rs, 1` is the ordinary spelling of `!x`, and it lifts
    // to `icmp_ult rs, 1` with no equality fold anywhere — the identical IR shape, from a producer
    // that is not a dispatch. Each compiler opts in on its own dispatch's evidence.
    switchBoundCase?: SwitchBoundCase;
    // Switch recovery: emit the case arms in the order the ASSEMBLY lays their bodies out, rather
    // than sorted by ascending case value. True claims the compiler emits case bodies as it walks
    // the arms and never MOVES one afterwards — neither reordering basic blocks nor scheduling
    // across them. agbcc declares it from its own sources: `stmt.c` expand_end_case takes
    // `before_case = get_last_insn()` AFTER the bodies are expanded in source order and its closing
    // `reorder_insns` moves only the DISPATCH in front of them, and the Makefile's SRCS compiles
    // neither sched.c nor reorg.c. SCOPE — SRCS does compile jump.c, whose cross-jump merges two
    // identical arm bodies into ONE block, so a merged pair's own order is gone from the asm; that
    // surfaces as two case values sharing a body, which switch-recover.ts ties by ascending value.
    // Absent ⇒ ascending case value, where ido/kmc-gcc/mwcc sit. ido and kmc-gcc have a scheduler
    // and have not been put through that evidence. mwcc_242_81 HAS been, on two compiled pairs, and
    // lays the bodies in source order: `synthetic:sw_defmid` with `default:` between two cases, and
    // a three-case switch whose first case is a `beqlr`. What keeps it from declaring the reading is
    // its FRONTEND: frontend/ppc.ts appends every conditional-return block after all the real ones,
    // so such an arm sorts last whatever its address (switch-recover.ts, at `layoutIndex`). Placing
    // those blocks at their branch's address is the prerequisite, and a declaration after it owes
    // its own pairs. A compiler opts in on its own, never by inheriting.
    switchArmsFollowLayout?: boolean;
    // Switch recovery: DECLINE a comparison tree whose own layout INTERLEAVES a test block with a
    // case body, on the reading that the source wrote an if/else-if LADDER there. True claims the
    // compiler emits a source `switch`'s whole dispatch AHEAD of every arm body — the same
    // `expand_end_case` closing `reorder_insns` `switchArmsFollowLayout` is read off, used for the
    // other half of what it does — while a ladder's tests stay above their own bodies.
    //
    // IT NEEDS HALF OF `switchArmsFollowLayout`'s PREMISE, AND THE IMPLICATION RUNS ONE WAY ONLY.
    // That flag PLACES the arms and so needs the whole no-reordering claim (nothing moved a block
    // at all); this one only asks whether any BODY sits above a test, so a compiler that moves
    // instructions, fills delay slots, or reorders within a block can still declare it. A compiler
    // that declares the PLACING one has therefore already said what this one needs — never the
    // converse. `MIPS_GCC` is the standing counterexample to the converse: it declares this flag on
    // its own pairs (below) and deliberately does NOT declare `switchArmsFollowLayout`, because it
    // has a scheduler. Declaring this one is not evidence for that one.
    //
    // agbcc declares it, and its own pair of objects says the reading is not vacuous: at agbcc's
    // canonical flags the same two-case body is 20 bytes (0x14, ten Thumb instructions)
    // written either way and is a DIFFERENT object — the `switch` emits `cmp #0x1e; beq` then
    // `cmp #0x64; bne` before either body, sorted ascending and so in the reverse of the written
    // order; the ladder emits `cmp #0x64; bne` directly above its own body and reaches `cmp #0x1e`
    // only after it. The pair is committed: `corpus/agbcc-sw{frontload,ladder}.s` from
    // `corpus/probe-agbcc-sw{frontload,ladder}.c`, regenerated by
    // `scripts/regen-switch-spelling-probes.ts`, asserted in switch-arms.test.ts.
    //
    // mwcc declares it on its own objects: its `switch` dispatch puts every test above every body,
    // and a ladder written with relational tests puts a body between two of them
    // (`corpus/mwcc-sw{dispatch,relladder,relnest}.asm`, the note at `switchBoundCase`).
    //
    // Absent ⇒ every recoverable tree is still spelled `switch`, which is where ido sits: it has a
    // scheduler that may move a body above a test, and it has not been put through the pair.
    // A compiler opts in on its own compiled evidence, never by inheriting — and where one
    // description serves two toolchains (`MIPS_GCC`), each toolchain owes its own pair, because the
    // field cannot distinguish them (the KEYED BY DESCRIPTION note at `spillSlotOrder`).
    switchRequiresFrontLoadedTests?: boolean;
    // Commutative load pairs re-spell in def (evaluation) order (structure.ts lowerDef). Absent
    // ⇒ true — verified byte-exact on agbcc and IDO; a compiler whose scheduler is shown
    // re-ordering independent loads opts OUT here.
    defOrderLoadPairs?: boolean;
    // The single-add-immediate derivation reach for the /nearbase variation (l3/nearbase.ts):
    // neighbor absolute addresses within this many bytes may share one base local. Thumb's
    // `add rd, #imm8` reaches 255. Absent ⇒ the variation stands down for this target.
    nearBaseSpan?: number;
    // Does this compiler CONSTANT-FOLD a constant SUBSCRIPT into the literal address it
    // materializes for an inline constant-address access? agbcc does: `((u8 *)0x3001100)[3]`
    // emits `.word 0x3001103` + `ldrb [r1]` where `u8 *p = (u8 *)0x3001100; p[3]` keeps
    // `.word 0x3001100` + `ldrb [r1, #0x3]`. True is what lets an offset surviving into the memory
    // operand say anything about the source at all; what l3/basecse.ts's `/basefold` admission
    // does with it — and why that is a differ-refereed candidate rather than a default — is that
    // file's header. A compiler opts in on its own compiled pair and never by inheriting: the MIPS
    // and PPC lanes put the addend in the instruction by construction (`lui`/`%lo`, `lis`/`ori`),
    // so a surviving offset carries no information there. Absent ⇒ the row is never offered.
    foldsConstAddrOffset?: boolean;
    // Does this compiler fold a pointer local's OWN ADVANCE back into the memory operand —
    // `*p = a; p = p + 1; *p = b;` → `strh [r3, #0]` + `strh [r3, #2]`, no `add` — so the advanced
    // spelling emits the indexed one's stores wherever the pointee is not volatile? agbcc does, on
    // its own compiled evidence: the four corners in test/advance.test.ts's header, each built
    // through the benchmark's agbcc against `kleod:StreamCmd_SetWindowRegs`'s object, and the pair
    // `TARGET_BEHAVIOR_READINGS` compiles to one object in the matching suite. True ⇒
    // the `advance` registry entry's target gate withholds the UN-QUALIFIED variation, whose spelling this compiler cannot
    // distinguish from the indexed one it already offers; `/advance/volatile` still rides, because
    // `volatile` is what bars the fold and that product is the match on this row. Absent ⇒ falsy ⇒
    // the plain variation ships, which is the conservative reading for a compiler whose pair nobody has
    // compiled — a compiler opts in on its own evidence and never by inheriting.
    foldsPointerAdvance?: boolean;
    // Does this compiler EMIT a memory read in the block the source SPELLED it in? One direction
    // only: the def-block placement rule (StructureOptions.readsStayWhereWritten) re-spells a read
    // at the block the asm performed it in, which reproduces the asm iff nothing sinks a spelled
    // read past a branch and nothing lifts one to a dominator. The CONVERSE — the asm's read block
    // is where the source read — is FALSE even here, and no default may be declared as if it held.
    //
    // agbcc (gcc 2.9-arm) declares TRUE from its own sources plus compiled pairs: gcc's Makefile
    // SRCS compiles neither sched.c nor reorg.c and toplev.c never mentions flag_schedule_insns, so
    // there is no scheduler; and `s = *g; if (c) A(s); else B(s);` against `if (c) A(*g); else
    // B(*g);` emits one ldrb + one pool word versus one of each PER ARM, moving neither. gcse.c calls
    // one_code_hoisting_pass only `if (optimize_size)`, which toplev.c sets only for -Os, so at -O2
    // the hoister never runs. At -Os it runs, and on `if (c) A(*gp); else B(*gp);` it moves only the
    // pool ADDRESS load above the branch: each arm keeps its own dereference, so the read still
    // stays in the block that spelled it. That pair is committed: `corpus/agbcc-hoist-{O2,Os}.s` from
    // `corpus/probe-agbcc-hoist.c`, regenerated by `scripts/regen-flag-pair-probes.ts`, asserted in
    // hoist-level-probes.test.ts. The two passes that DO move a read between blocks at -O2 — loop
    // invariant motion, and the PRE that makes the converse false — are refusals the rule owes;
    // structure/analysis.ts carries them.
    //
    // ABSENT ⇒ the rule stands down, where ido/kmc-gcc/mwcc sit: each has a scheduler and none has
    // been put through that pair. A compiler opts in on its own evidence, never by inheriting.
    readsStayWhereWritten?: boolean;
    // Does a LOCAL initialised with a memory read its dominating TEST already performed cost this
    // compiler a SECOND load? The pair is the arm of `if (a && (p[1] & 0x7f) == 0x7f) { … }` spelled
    // `u8 v = p[1]; p[2] = v;` against `p[2] = p[1];`, and again with a store and with a call
    // between the local and its use. agbcc loads `p[1]` TWICE for every local spelling and once
    // for the inline one; ido7.1, gcc2.7.2kmc, gcc2.7.2 and mwcc_242_81 load it ONCE for every
    // local spelling, holding the register across the store and across the call. agbcc is the
    // odd one out of five, so the one agbcc-shaped claim that rested on it — raise/shortcircuit.ts's
    // `read-behind-effect`, "a copy analysis.ts spells as a local costs a load" — reads it here
    // rather than running on every target — on mwcc it costs the probe named at PPC_MWCC's value
    // its byte-match.
    // Read off the target by a raising pass (raise/pre-recovery.ts), not by the structurer.
    //
    // ABSENT ⇒ false: the refusal stands down, and a compiler opts IN on its own compiled pair. The
    // three descriptions that measured false (four compilers) set it anyway, so absent means
    // UNMEASURED rather than "no".
    reloadsLocalReread?: boolean;
    // A LAYOUT fact rather than a canonicalization one, kept here because it is the COMPILER's:
    // the size, in bytes, it aligns and rounds EVERY struct and union to, whatever its members.
    // agbcc: 4 — `sizeof(struct { u16 h; })` is 4, and `struct { u8 a; union { u16 h; u8 b[2]; } u; }`
    // seats `u` at 4 (gcc 2.9's arm STRUCTURE_SIZE_BOUNDARY). ido7.1, gcc2.7.2kmc and mwcc_242_81
    // answer 2 and 2: the natural layout, 1. Compiled as `return sizeof …` / `return (int)&((T *)0)->m`
    // at each row's flags; gcc2.7.2 (-O1), mwcc_233_163n and mwcc_247_107 answer the same as their
    // descriptions' measured compilers. Read by raise/structs.ts (through raise/pre-recovery.ts),
    // which sizes a recovered UNION member with it; raise/struct-arrays.ts sizes element structs
    // without it, which on agbcc is a known gap.
    //
    // ABSENT ⇒ unmeasured, and the union recovery declines every union narrower than a word: no
    // value is safe to assume, since one too small mislays the fields after it on agbcc and one too
    // large drops the pad in front of them everywhere else.
    aggregateBoundary?: number;
    // The largest alignment any member of a struct takes, in bytes (BIGGEST_ALIGNMENT): agbcc 4,
    // thumb.h:358, so a `long long` member sits at a word. With `aggregateBoundary` it is what sizes
    // a declared aggregate (`aggregate.ts`). ABSENT ⇒ unmeasured, and no aggregate is sized.
    largestAlignment?: number;
    // HOW A STRUCT OR UNION RETURNED BY VALUE COMES BACK, which decides whether a call to a function
    // declared to return one hands it a hidden pointer as argument 0 and moves every declared
    // argument one register up (`aggregate.ts` `returnsInMemory`, read by frontend/thumb.ts and
    // frontend/ppc.ts).
    //   • 'apcs' — in memory when bigger than a word, when a struct has a second member that is not
    //     a bitfield, or when a union has a member that would be; in the return register otherwise.
    //     agbcc, thumb.c:1423-1493 (compiled: `{u8 a,b,c,d}` through memory; `{u32}`, `{u32 w[1]}`,
    //     `{u32 a:8; u32 b:8;}` and `union {u32; u16;}` in r0).
    //   • 'svr4' — in r3, or r3:r4, when it is 8 bytes or less, whatever its members (a float's
    //     included); in memory otherwise. mwcc_242_81, mwcc_233_163n and mwcc_247_107 alike
    //     (compiled: 1 to 8 bytes, `{float}`, `{double}` and a union come back in r3/r3:r4; a 9- and a
    //     12-byte struct are handed `addi r3,…` ahead of the call).
    // ABSENT ⇒ unmeasured, and such a call declines. IDO 7.1 returns every aggregate through memory,
    // a one-word one included (compiled: `struct {u32 x;} mkw(s32)` is called `addiu a0,sp,28 / jal
    // mkw / lw v0,28(sp)`), and states nothing: the MIPS frontend lowers no call to read it.
    aggregateReturn?: 'apcs' | 'svr4';
    // The bytes an enum takes as a struct member (`aggregate.ts`). agbcc: 4 — flag_short_enums is 0
    // unless `-fshort-enums` is given (toplev.c:3552-3554 with no DEFAULT_SHORT_ENUMS), so an enum
    // whose values fit an int is an int (c-decl.c:6123-6135); compiled, `sizeof(enum {K0, K1})`
    // and `enum {B0 = 300}` are both 4. `targetFor` drops it under `-fshort-enums`, and an enum
    // declared with an attribute (`packed`), or with a value an int cannot hold, is not sized
    // (proto-context.ts). ABSENT ⇒ unmeasured,
    // and an aggregate with an enum member is not sized.
    enumBytes?: number;
    // How a struct's bitfields are placed (`aggregate.ts`). 'contiguous' — each at the bit after the
    // one before, straddling a byte or a word of its declared type, with the next member that is not
    // a bitfield at the first byte past it that its alignment allows. agbcc: thumb.h defines no
    // PCC_BITFIELD_TYPE_MATTERS, so stor-layout.c:404-405 lays a bitfield at bit alignment and
    // skips the no-straddle rule of :462-481 (compiled: `{u32 a:20; u32 b:20; u8 c;}` puts `c` at
    // 5, `{u32 a:31; u32 b:31; u32 c:2;}` is 8 bytes, `{u8 a:5; u8 b:5; u8 c;}` puts `c` at 2). A
    // zero-width bitfield, which moves the next member to EMPTY_FIELD_BOUNDARY, is not placed.
    // ABSENT ⇒ unmeasured, and an aggregate with a bitfield is not sized.
    bitfieldPacking?: 'contiguous';
    // Can this compiler CONTRACT a float multiply and the add or subtract that reads it into one
    // fused instruction, which rounds once? mwcc can: `-fp_contract on` (set on some pikmin,
    // marioparty4 and ac-decomp units) turns `a * b + c` into `fmadds` and `-(a * b) + c` into
    // `fnmsubs`, but only within one expression, so the structurer names every such product
    // (StructureOptions.contractsFloatProducts) and the spelling compiles to the unfused pair under
    // either setting. The MIPS targets cannot: MIPS II (ido7.1 `-mips2`) and MIPS III (kmc `-mips3`)
    // have no fused multiply-add, and naming the product there only moves the register allocation
    // off the object (`fpu-lift.test.ts` pins one on ido7.1).
    //
    // ABSENT ⇒ false. A compiler with a fused multiply-add must opt in; the no-FPU targets never
    // compute on a float at all.
    contractsFloatProducts?: boolean;
    // Does this compiler read a double literal's shortest round-trip decimal (`ir/float-bits.ts`
    // `doubleLiteral`) back as the same double? That is how an `fconst` is printed, so its
    // producers run only where this is true. agbcc does: c-lex.c:1308 hands the token to
    // REAL_VALUE_ATOF at DFmode, which is real.c:461 `ereal_atof` → `asctoe53` (:3512) →
    // `asctoeg(s, y, 53)` (:3533), a conversion in extended precision rounded once to 53 bits.
    //
    // ABSENT ⇒ unmeasured, and a literal declines.
    roundTripsDoubleLiterals?: boolean;
    // How the compiler lays out a FUNCTION-SCOPE STATIC: the least alignment of an array, the
    // alignment of a string-literal initializer, and whether a zero scalar keeps its `.data`. The
    // bytes of a static do not say how the source declared it; these, with the alignment and
    // section the target shows, say which declaration lands it there (structure/local-statics.ts).
    // A LAYOUT fact like `aggregateBoundary`, and the compiler's, read by the structurer.
    //
    // ABSENT ⇒ unmeasured, and a function that defines a static declines: a wrong floor mislays
    // every static after the first, which no score sees.
    staticLayout?: StaticLayout;
    // Does this compiler load a `volatile` narrow signed read zero-extended and sign-extend it in a
    // register, never in the load itself? agbcc: yes — `*(volatile s16 *)a` is `ldrh; lsl #16; asr
    // #16` and `volatile s8` is `ldrb; lsl; asr`, where the plain `s16` read is `ldrsh`: the
    // sign-extend expander refuses a volatile MEM while expanding (`general_operand`, recog.c:918,
    // under `init_recog_no_volatile`, function.c:5564) and thumb.md:393-409 then extends in a
    // register; compiled at the canonical flags. So a lifted sign-extending narrow load is evidence
    // the source read was plain (`readCouldBeVolatile`): the device pin (frontend/device-pins.ts)
    // leaves it plain, and the `declared` stamp (raise/declared-volatile.ts) leaves it unplaced.
    //
    // ABSENT ⇒ false: a sign-extending load says nothing about the qualifier, and a device read is
    // pinned, and a read of a declared object placed, whatever its extension.
    volatileReadsExtendInRegister?: boolean;
  };
}

export const ARMV4T_AGBCC: TargetDescription = {
  id: 'armv4t',
  compiler: 'agbcc',
  argRegs: ['r0', 'r1', 'r2', 'r3'],
  returnReg: 'r0',
  doubleArgWords: 'high-first',
  // AAPCS passes four in r0-r3, so nothing above them can be an argument. The ATPCS aliases are
  // the spellings this ISA's asm actually uses: censused over the vendored ARM asm, `sb`/`sl`/`ip`/
  // `fp` all occur as operands and no `v<n>`/`a<n>` form does. `sp`, `lr` and `pc` are deliberately
  // absent — sp is the frame, lr is the return address, and neither is a value a source declared.
  nonArgRegs: ['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sb', 'sl', 'fp', 'ip'],
  // AAPCS makes r4-r11 callee-saved and leaves r12 (`ip`, the intra-procedure-call scratch) to the
  // caller, so a local in `ip` needs no save and agbcc puts one there: `dma_fill_uninit` compiles to
  // `mov ip, r1` in two switch arms, no save anywhere, and a `mov r0, ip` past a third arm that
  // writes nothing — an uninitialised local by construction.
  scratchRegs: ['r12', 'ip'],
  // AAPCS: r0-r3 pass arguments and return, r12 (`ip`) is the intra-procedure-call scratch, and lr
  // holds the return address the `bl` itself overwrites. agbcc's own machine description says the
  // same (`thumb.h` CALL_USED_REGISTERS). Both spellings of r12 for the reason `nonArgRegs` carries
  // both: the ATPCS aliases are what this ISA's asm writes.
  callerSaved: ['r0', 'r1', 'r2', 'r3', 'r12', 'ip', 'lr'],
  runtimeHelpers: AGBCC_RUNTIME_HELPERS,
  // GBA hardware, which this target implies: agbcc is the GBA compiler and this is the only
  // armv4t entry, so `armv4t + agbcc` is the platform. Stated because nothing else states it.
  capabilities: {
    endianness: 'little',
    hwDivide: false,
    hwFloat: false,
    flags: true,
    // The four DMA SOURCE registers (DMA0..3 SAD). Every vendored project spells the transfer the
    // same way — `DmaSet(n, src, dest, control)` takes `vu32 *dmaRegs = REG_ADDR_DMA<n>SAD` and
    // writes `dmaRegs[0] = src`, `dmaRegs[1] = dest`, `dmaRegs[2] = control` — so +0 is the address
    // the engine reads from and the destination is 4 bytes above it. Source Address Control has
    // three legal settings (increment, decrement, fixed) and every one of them is a read; the
    // reload mode that could re-arm a transfer exists only on the DESTINATION side.
    //
    // The idiom this exists for is their `DMA_FILL`: `vu16 tmp = value;
    // DmaSet(n, &tmp, dest, … DMA_SRC_FIXED …)`, where the frame local is the source.
    readOnlyAddressSinks: [0x040000b0, 0x040000bc, 0x040000c8, 0x040000d4],
    // DMAnCNT_H, 10 bytes above each SAD: Source Address Control is bits 7-8 (setting 3 is
    // prohibited) and bit 10 selects 32-bit units. `DMA_FILL`'s `DMA_SRC_FIXED` is setting 2.
    readSourceControl: {
      offset: 0xa,
      modeShift: 7,
      modes: ['increment', 'decrement', 'fixed', null],
      wideBit: 0x0400,
      units: [2, 4],
    },
    // The GBA I/O register file — one page from 0x04000000, the last live register being
    // 0x04000301 (HALTCNT). Everything a source reaches through `REG_*` is in here, and nothing
    // else is: IWRAM, EWRAM, palette, VRAM and OAM are ordinary memory a source does not qualify.
    deviceRegisters: [0x04000000, 0x04000400],
    // DMA0..3 CNT_H — the channel-enable halfwords. Writing one with bit 15 set arms the transfer,
    // and the transfer writes ordinary memory at [DMAnDAD]. Every other I/O register on this board
    // is read or written by the CPU alone.
    deviceMemoryWriters: [
      [0x040000ba, 0x040000bc],
      [0x040000c6, 0x040000c8],
      [0x040000d2, 0x040000d4],
      [0x040000de, 0x040000e0],
    ],
    // The BIOS block transfers, SWI 0Bh CpuSet and SWI 0Ch CpuFastSet (GBATEK, "BIOS Memory
    // Copy"): r0 the source, r1 the destination, r2 the control — a count in bits 0-20, bit 24 a
    // FIXED source (a fill, reading one unit of r0), and for CpuSet bit 26 selecting 32-bit units
    // over 16-bit ones; CpuFastSet moves words only, its count rounded up to eight. Neither writes
    // through r0. The names are the SDK's: sa3's and pokeemerald's `libagbsyscall.s` bind
    // `CpuSet: svc #11` and `CpuFastSet: svc #12`, kleod's `CpuSet: svc #0xb`, and each declares
    // `void CpuSet(const void *src, void *dest, u32 control)`.
    blockTransferCalls: {
      CpuSet: {
        source: 0,
        control: 2,
        countMask: 0x1fffff,
        fixedBit: 0x01000000,
        wideBit: 0x04000000,
        units: [2, 4],
        countGranule: 1,
      },
      CpuFastSet: {
        source: 0,
        control: 2,
        countMask: 0x1fffff,
        fixedBit: 0x01000000,
        wideBit: 0,
        units: [4, 4],
        countGranule: 8,
      },
    },
  },
  compilerBehaviors: {
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    nearBaseSpan: 255,
    volatileReadsExtendInRegister: true,
    foldsConstAddrOffset: true,
    foldsPointerAdvance: true,
    readsStayWhereWritten: true,
    switchBoundCase: 'taken',
    switchArmsFollowLayout: true,
    switchRequiresFrontLoadedTests: true,
    hoistsSingleSetArm: true,
    eightByteReturnScratch: 'r2',
    arrayShapeFromStride: true,
    reloadsLocalReread: true,
    aggregateBoundary: 4,
    largestAlignment: 4,
    aggregateReturn: 'apcs',
    enumBytes: 4,
    bitfieldPacking: 'contiguous',
    roundTripsDoubleLiterals: true,
    // agbcc 2.9 (gcc/varasm.c `assemble_variable`, gcc/thumb.h): an array takes its element's
    // alignment (no DATA_ALIGNMENT); a declaration initialized by a STRING_CST is word-aligned —
    // CONSTANT_ALIGNMENT (thumb.h:361) over DECL_INITIAL (varasm.c:1214-1216), so
    // `static const char s[] = "hi"` is at 4 while `= {'h', 'i', 0}` and an array of strings
    // (whose DECL_INITIAL is a CONSTRUCTOR) are at 1; and `= 0` keeps its `.data`, where only a
    // declaration with no initializer is `.lcomm` (compiled).
    staticLayout: { aggregateAlign: 1, stringAlign: 4, zeroScalar: 'data' },
    narrowParamWitness: 'prologue-extension',
    // agbcc: reload walks pseudos ascending handing each global-alloc loser a fresh slot, a user
    // local's pseudo number is its `expand_decl` position, and the Thumb frame grows UPWARD
    // (FRAME_GROWS_DOWNWARD is commented out in thumb.h). So the earlier-declared spilled local
    // takes the lower offset. The rows that referee it are `synthetic:spillorder` (six `[sp,#k]`
    // operand rows and nothing else, from two locals declared the other way round) and its
    // control `synthetic:spillorder_rev` (the same body in the order asmlift already emits, which
    // must stay a MATCH), plus `synthetic:dma_fill_uninit`, a row this did not author.
    spillSlotOrder: 'ascending',
    // agbcc reserves the outgoing area with the rest of the frame (`add sp, sp, #-N` covers both)
    // and stages arguments 5+ into it at [sp,#0] upward — thumb.h's ACCUMULATE_OUTGOING_ARGS.
    stagesOutgoingArgsInFrame: true,
    // …one area for every call, below the locals (thumb.h:573/600-622/628, calls.c:1675), which
    // agbcc re-stages before each call and never reads back after one (agbcc-restage.s).
    localsAboveOutgoingArea: true,
    // the two producer tables behind this are compiled, at agbcc 2.9-arm-000512 and the rows' own
    // flags, and they are written out where the predicate reads it (`frontend/thumb.ts`)
    oneWordFrameIsTheCapturedObject: true,
    // agbcc's `*call_indirect` and `*call_value_indirect` emit `bl _call_via_%0` (gcc/thumb.md:997-1021),
    // and libgcc defines `_call_via_<reg>` as `bx <reg>` for r0-r9, sl, fp, ip, sp and lr
    // (libgcc/lib1thumb.asm:595-633). Neither `sp` (the frame) nor `lr` (which the `bl` itself
    // overwrites) holds a function's address.
    callThunks: {
      prefix: '_call_via_',
      regs: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'sl', 'fp', 'ip'],
    },
  },
};

/** MIPS o32's floating-point homes, shared by both compilers that target it (see `fpu`). The odd
 *  halves (`$f13`, `$f15`) carry the other word of a DOUBLE argument, which no frontend lifts. */
const O32_FPU: TargetDescription['fpu'] = { argRegs: ['$f12', '$f14'], returnReg: '$f0', slots: 'leading' };

/** MIPS-II / IDO 7.1 target. IDO is the IRIX C compiler,
 *  statically recompiled to run natively (ido-static-recomp). Unlike agbcc
 *  it emits no textual asm, so asmlift's input is the DISASSEMBLED object (`mips-linux-gnu-
 *  objdump -d`); the arch-agnostic objdiff scorer scores the MIPS object directly. Big-endian,
 *  hardware divide + FPU (N64). */
export const MIPS_IDO: TargetDescription = {
  id: 'mips',
  compiler: 'ido',
  argRegs: ['a0', 'a1', 'a2', 'a3'],
  returnReg: 'v0',
  // O32: at, v0-v1, a0-a3, t0-t9 and ra are all caller-saved. `frontend/mips.ts` reads the rest, and
  // `ra`, as the registers a frame store SAVES.
  callerSaved: [
    'at',
    'v0',
    'v1',
    'a0',
    'a1',
    'a2',
    'a3',
    't0',
    't1',
    't2',
    't3',
    't4',
    't5',
    't6',
    't7',
    't8',
    't9',
    'ra',
  ],
  runtimeHelpers: IDO_RUNTIME_HELPERS,
  // MEASURED with this toolchain's own flags: `float f(float a, float b){ return a + b; }` is
  // `jr ra; add.s $f0,$f12,$f14`, and the `'leading'` rule's two halves are the pair in `fpu`'s note.
  fpu: O32_FPU,
  capabilities: { endianness: 'big', hwDivide: true, hwFloat: true, flags: false },
  // `switchAllowsNeqCase: false` — IDO's switch dispatch uses `==`/`<`, never `!=` cases;
  // leaving it permissive mis-recognises `!=`-rooted if-else chains as switches.
  compilerBehaviors: {
    contractsFloatProducts: false,
    coalesceLoopInit: true,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    switchAllowsNeqCase: false,
    // MEASURED — the pair at the field compiles to one load of `p[1]` for every local spelling.
    reloadsLocalReread: false,
    aggregateBoundary: 1,
    // MEASURED at `-mips2 -O2 -32 -non_shared -G 0`: the `sll` leads the function for BOTH
    // spellings, so the prologue position cannot decide; a narrow DECLARED parameter is the one that
    // is both homed dead AND widened in its own argument register. raise/paramwidth.ts's header has
    // the disassemblies, including the counterexample for each half alone.
    narrowParamWitness: 'home-store-and-in-place',
    // MEASURED `descending` (the earlier-declared spilled local takes the HIGHER offset) and NOT
    // SHIPPED. The probe is COMMITTED — `packages/core/test/corpus/probe-declrank.c` and its
    // reversed-declaration twin, with this compiler's objects beside them — and a test reads the
    // correspondence off it: 16 of 16 spills, and rank → offset unchanged when the declaration
    // list is reversed, which is what separates declaration rank from the order of the
    // assignments. No ido7.1 benchmark row lifts with two or more spilled user locals, so no row
    // can tell a wrong value from a right one here.
    //
    // FLIP CONDITION, and it has TWO parts because the second is easy to miss. (1) The first
    // ido7.1 row that lifts with two spilled locals. (2) `frontend/mips.ts` must first claim a
    // frame partition (`LiveInModel.declaredLocals`); until it does, the shared stamp refuses every
    // MIPS slot, so this value would order nothing — and if the partition were claimed WRONGLY,
    // O32's caller-owned home area `[0,16)` would be read as this function's first four
    // declaration ranks. Shipping a direction before the partition orders by argument index.
    spillSlotOrder: 'unknown',
  },
};

/** MIPS + KMC GCC — the SAME ISA as MIPS_IDO, a DIFFERENT compiler: `id:"mips"` reuses the
 *  `mips` frontend verbatim, only `compiler` varies. Same N64 hardware ⇒ identical hardware
 *  capabilities to IDO. */
export const MIPS_GCC: TargetDescription = {
  id: 'mips',
  compiler: 'gcc',
  argRegs: ['a0', 'a1', 'a2', 'a3'],
  returnReg: 'v0',
  // The same O32 convention MIPS_IDO carries, read the same way.
  callerSaved: [
    'at',
    'v0',
    'v1',
    'a0',
    'a1',
    'a2',
    'a3',
    't0',
    't1',
    't2',
    't3',
    't4',
    't5',
    't6',
    't7',
    't8',
    't9',
    'ra',
  ],
  runtimeHelpers: MIPS_GCC_RUNTIME_HELPERS,
  // KMC GCC keeps a loop seeded from an argument register IN that register (coalesceLoopInit
  // true, like IDO): test/corpus/gcc-gcd.asm runs its whole loop on a0/a1 with no init copies,
  // and the row it comes from matches only with the parameters as the loop's homes. The other
  // structuring compiler behaviors take the universal default until a KMC fixture says otherwise.
  //
  // THIS IS A COMPILER-WIDE GUESS STANDING IN FOR A PER-FUNCTION OBSERVATION the assembly states
  // outright: whether the compiler kept a loop's induction variable in its argument register. What
  // would say it is "the header param's register key IS the key the entry value already lives in" —
  // known to the SSA builder (`frontend/ssa.ts` `phiKey`) and to this file (`argRegs`), unexposed.
  // Exposing it would replace two booleans (here, and PPC_MWCC's "false until a CW loop fixture
  // says otherwise") with a measurement.
  // NOT the obvious proxy for it, which was built and measured: adopting the entry value's name
  // when the forward predecessor did not WRITE the param's key moves 36 of the 736 synthetic rows
  // and costs four matches net (continueloop, countpos and loopif on mwcc plus dmafill, dmaptrsrc
  // and dmastride on agbcc lost; maxarr and preupdate_exit_call on agbcc gained) — because a pred
  // that computes the initial value INTO the param's own register wrote the key and still
  // coalesces.
  // The same o32 convention, measured on GCC_KMC_TOOLCHAIN at -O2: the fadd pair compiles to the
  // same two instructions IDO's does, and `float f(int a, float b)` moves `b` over with `mtc1 a1`.
  fpu: O32_FPU,
  capabilities: { endianness: 'big', hwDivide: true, hwFloat: true, flags: false },
  compilerBehaviors: {
    contractsFloatProducts: false,
    coalesceLoopInit: true,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    // DECLARED ON A PAIR FROM EACH TOOLCHAIN THIS DESCRIPTION SERVES, never inherited from agbcc's
    // and never from one sibling to the other. This description is keyed per DESCRIPTION while the
    // fact is per TOOLCHAIN (the note at `spillSlotOrder`), and `MIPS_GCC` serves two, so both owe
    // a pair: `corpus/gcc272kmc-sw{frontload,ladder}.asm` from GCC_KMC_TOOLCHAIN at -O2 and
    // `corpus/gcc272-sw{frontload,ladder}.asm` from the Mario Party 3 toolchain at -O1 — one
    // two-case body written each way, regenerated from their committed C bodies by
    // `scripts/regen-switch-spelling-probes.ts`, each carrying a provenance header, and each pair
    // two different objects: the `switch` emits both `beq`s before the first `sw`, while the ladder
    // puts an arm's `sw` above the second test. A test asserts that split off every fixture. The
    // two toolchains come out byte-identical on this body — measured, not assumed, and their
    // declaration-rank probe objects differ, so a sibling pair is not a formality.
    //
    // BOTH TOOLCHAINS EMIT BRANCH-LIKELY on some bodies, and the reading survives it — a property
    // of the pair, not a way the two diverge. `s32 m1(s32 x, s32 *p){ switch (x) { case 6: *p = 1;
    // break; case 7: *p = 2; break; } return 0; }` cross-jumps the two stores into one and compiles
    // instruction for instruction identically at -O1 and at -O2, to `beq` / `beql` with the shared
    // `sw` after both; the same body as an if/else-if ladder puts the first arm's `li v0,1` BETWEEN
    // the two tests. Both spellings get all the way through on both toolchains — the `switch` one
    // recovers a `switch`, the ladder an `if` nest — so what keeps that body out of the fixture set
    // is not a decline. It is that the cross-jumped arms leave no STORE to read the split off: both
    // put their one `sw` after both tests, and the interleaved instruction is the ladder's
    // `li v0,1`. The committed pair keeps its distinct-store arms for that reason. (A THREE-case
    // body says the
    // same more loudly, the balanced tree's `slti` bound test landing ahead of the bodies with the
    // rest, but at three cases neither spelling reaches Regime A on this compiler, so that pair
    // could not also serve as the recovery test.)
    //
    // WHAT IS WEAKER HERE THAN AT agbcc: this compiler HAS a scheduler and fills delay slots, and
    // both fixtures show it — the ladder's `bne` carries the NEXT test's `li` in its slot. What the
    // pair shows is that it moves no BODY above a test, which is the only claim the gate rests on,
    // and the gate's failure direction (switch-recover.ts PRE5) is a lost `switch` spelling, never
    // a wrong answer. A lost spelling is not always a clean ladder: recovery re-runs on the
    // sub-trees a decline leaves, so a NESTED dispatch comes back as an `if` nest around a `switch`
    // over some of its arms.
    switchRequiresFrontLoadedTests: true,
    // MEASURED on BOTH toolchains this description serves (the note above): one load of `p[1]` for
    // every local spelling of the pair at the field, gcc2.7.2kmc at -O2 and gcc2.7.2 at -O1 alike.
    reloadsLocalReread: false,
    aggregateBoundary: 1,
    // MEASURED on BOTH toolchains this description serves: `int f(s8 x){return x;}` and
    // `int f(s32 x){return (s8)x;}` compile to BYTE-IDENTICAL objects, gcc2.7.2kmc at -O2 and
    // gcc2.7.2 at -O1 alike — so the object carries no witness at all and the pass refuses.
    narrowParamWitness: 'none',
    // MEASURED `ascending` on both toolchains this description serves — 7 of 7 spills each, and
    // rank → offset unchanged under a reversed declaration list — and NOT SHIPPED, for the same
    // reason as ido7.1: no row on either tier lifts with two or more spilled user locals. Both
    // probes are COMMITTED beside ido7.1's (`corpus/gcc272kmc-declrank*.txt`,
    // `corpus/gcc272-declrank*.txt`) and a test reads the direction off them.
    //
    // The two agreeing is not a formality. The value is per DESCRIPTION and TWO toolchains map
    // here, so a toolchain whose direction differed from its description's would need a
    // per-toolchain override this bag cannot express — see the note at `compilerBehaviors`.
    spillSlotOrder: 'unknown',
  },
};

/** PowerPC (GameCube/Wii) + Metrowerks CodeWarrior. The real GC/Wii matching target is
 *  CodeWarrior `mwcceppc` (not GCC): active decomp projects and decomp.me standardize on it.
 *  `-proc gekko` = the GC Gekko CPU. Big-endian, hardware divide + FPU. `flags: true`: PPC has
 *  condition registers (cr0–cr7), but compare→branch still fuses into a single `cond_br`
 *  (test/ppc-seam.test.ts), so `flags` stays a documented hardware fact, not yet an IR concern —
 *  real flags-as-data is deferred until a fixture reuses/combines a cr field. */
export const PPC_MWCC: TargetDescription = {
  id: 'ppc',
  compiler: 'mwcc',
  // PPC EABI: r3–r10 pass integer/pointer arguments; r3 also returns.
  argRegs: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'],
  returnReg: 'r3',
  // PPC EABI: r0 and r3-r12 are volatile, and lr carries the return address `bl` overwrites. r11
  // and r12 are the linker's stub scratch, r13 is the small-data base and r14 upward are
  // callee-saved.
  callerSaved: ['r0', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'lr'],
  runtimeHelpers: PPC_MWCC_RUNTIME_HELPERS,
  // PPC EABI with `-fp hard`, measured at the synthetic tier's flags: `fadds f1,f1,f2; blr`, a third
  // float argument in f3, and the GPR/FPR order of mixed parameters absent from the object.
  fpu: { argRegs: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'], returnReg: 'f1', slots: 'separate' },
  capabilities: { endianness: 'big', hwDivide: true, hwFloat: true, flags: true },
  // CodeWarrior's structuring compiler behaviors are UNKNOWN until fixtures reveal them — safe universal
  // defaults; coalesceLoopInit false until a CW loop fixture says otherwise — the second of the
  // two compiler-wide guesses standing in for the per-function observation named at MIPS_GCC.
  compilerBehaviors: {
    contractsFloatProducts: true,
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    // MEASURED — one load of `p[1]` for every local spelling of the pair at the field, the value
    // held in a callee-saved register across the call. And the rule it turns off pays here:
    // `u8 v = p[3]; if ((v & 0x7f) == 0x7f) { fnA(); p[4] = v; return; }` under an `if (a)`
    // matches only once `read-behind-effect` stops refusing it (3/24 → MATCH 0/22).
    reloadsLocalReread: false,
    aggregateBoundary: 1,
    // MEASURED on all three builds: `struct {u8 a; double d;}` and its `long long` twin put the
    // member at 8 and size 16
    largestAlignment: 8,
    aggregateReturn: 'svr4',
    // MEASURED on mwcc_242_81 through the `.comment` alignment record: an array or a struct is at
    // 4 at least (`u8[1]`, a struct of two bytes), a scalar at its width; a string-literal
    // initializer gets no more than the array does (`char s[] = "hello!"` and a `u8` list both 4);
    // and a scalar `= 0` moves to bss, where `int q[1] = {0}` stays in `.data`. In both bss
    // sections the moved scalars come first in declaration order. The statics with no initializer
    // follow reversed in `.sbss`; in `.bss` (an object over the `-sdata` threshold: an array over 8
    // bytes, every scalar at `-sdata 0`) they follow in the order the compiler first uses them
    // (`a[i]=1; b[i]=2;` puts a first, the swap b), which neither the source's text
    // (`x = b[i]; a[i] = 1;` puts a first) nor the emitted code (`a[i] = b[i]` reads b first, puts a
    // first) fixes. The other mwcc builds this description serves are not measured.
    staticLayout: {
      aggregateAlign: 4,
      stringAlign: 4,
      zeroScalar: 'bss',
      uninitOrder: { '.sbss': 'reversed', '.bss': 'first-use' },
    },
    // MEASURED on all three builds at -O4,p and -O0,p: the note at the field. The two are one
    // declaration: without the layout gate a relational if-ladder reads as a `switch`. The gate's
    // reach is the committed probes alone — withdrawn, it moves 0 of the 180 PPC benchmark rows
    // that lift — so switch-arms.test.ts holds the pairing over every target instead of a row.
    switchBoundCase: 'either',
    switchRequiresFrontLoadedTests: true,
    // The PowerPC prologue widens a declared narrow parameter with `extsb`/`extsh`, which the
    // frontend lifts to the same `sext` op agbcc's shift pair folds to — the position shape, on
    // another ISA. `synthetic:{sextb,tos8}:mwcc_242_81` are its rows, MATCH through that pass.
    narrowParamWitness: 'prologue-extension',
    // NOT MEASURED, and `'unknown'` is therefore the only honest value here rather than a withheld
    // one, as it is at MIPS_IDO and MIPS_GCC. No mwcc row lifts with two or more spilled user
    // locals, and the compiler does not spill the committed declaration-rank probe either: at
    // sixteen locals it homes every one in a register, and at forty it sinks the whole computation
    // past the call so nothing is live across it. And, as at MIPS_IDO, the frame partition comes
    // first: `frontend/ppc.ts` claims no `LiveInModel.declaredLocals`, so the shared stamp records
    // no slot home on this target at all and a direction here would order nothing until it does.
    spillSlotOrder: 'unknown',
  },
};

/** A toolchain: one compiler binary, named as decomp.me names it. Several toolchains may share a
 *  description (`MIPS_GCC` serves two), and each keeps its own evidence. */
export interface ToolchainTarget {
  family: FlagFamily;
  /** The codegen flags every committed probe of this toolchain was compiled with: the flags a
   *  synthetic row compiles at, and the flags a decompile with none given assumes. They are in
   *  normal form (`storedFlags` keeps every word), so the words only the harness needs (`-c`, the
   *  diagnostics) live beside the binary's paths in @asmlift/toolchains.
   *
   *  A toolchain with no SYNTHETIC tier has NONE, and inventing one would be the fiction the field
   *  exists to avoid: nothing about the compiler picks a set, every row names the flags its own
   *  build compiles that unit with, and the probes behind its description are run at those. A
   *  decompile that reaches such a toolchain with no flags from anywhere is refused rather than
   *  resolved against a set nobody chose (`resolveFlags`). */
  canonicalFlags?: readonly string[];
  /** What this compiler does. Every flag set of the toolchain decompiles against it: a profile of a
   *  compiler inherits its declarations until a probe refutes one there. */
  description: TargetDescription;
}

export const TOOLCHAIN_TARGETS = {
  agbcc: {
    family: 'agbcc',
    canonicalFlags: ['-mthumb-interwork', '-O2', '-fhex-asm', '-fprologue-bugfix'],
    description: ARMV4T_AGBCC,
  },
  'ido7.1': {
    family: 'ido',
    canonicalFlags: ['-mips2', '-O2', '-32', '-non_shared', '-G', '0'],
    description: MIPS_IDO,
  },
  'gcc2.7.2kmc': {
    family: 'gcc',
    canonicalFlags: [
      '-mabi=32',
      '-mgp32',
      '-mfp32',
      '-mno-abicalls',
      '-fno-PIC',
      '-G',
      '0',
      '-funsigned-char',
      '-mips3',
      '-EB',
      '-O2',
      '-fno-builtin',
      '-fno-asm',
    ],
    description: MIPS_GCC,
  },
  'gcc2.7.2': {
    family: 'gcc',
    canonicalFlags: ['-G0', '-mips3', '-mgp32', '-mfp32', '-O1', '-Wa,--vr4300mul-off'],
    description: MIPS_GCC,
  },
  mwcc_242_81: {
    family: 'mwcc',
    canonicalFlags: [
      '-proc',
      'gekko',
      '-O4,p',
      '-enum',
      'int',
      '-inline',
      'auto',
      '-fp',
      'hard',
      '-Cpp_exceptions',
      'off',
    ],
    description: PPC_MWCC,
  },
  // The other two CodeWarrior builds the GameCube projects compile with: 2.3.3b163n (Pikmin's whole
  // game tree) and 2.4.7b107 (Mario Party 4's DOL). Both SHARE `PPC_MWCC`, and on their own evidence
  // rather than because they are the same compiler family: `test/matching/ppc-compiler-behaviors.test.ts`
  // re-runs both of its probes on each binary at the flags that build's rows compile at, and each
  // reads as the description says. What moves those readings is the optimisation level — at `-O0,p`
  // the shipped `mwcc_242_81` re-reads the local too — so the difference is one no per-compiler
  // field could carry anyway.
  //
  // NEITHER HAS CANONICAL FLAGS. They have no synthetic tier: every row of theirs is a real one that
  // names its unit's own flags, and Pikmin's `-O4,p -lang=c++` and Mario Party 4's `-O0,p -lang=c`
  // are two different sets, neither of which is "the" one. See `canonicalFlags` above.
  mwcc_233_163n: {
    family: 'mwcc',
    description: PPC_MWCC,
  },
  mwcc_247_107: {
    family: 'mwcc',
    description: PPC_MWCC,
  },
} as const satisfies Readonly<Record<string, ToolchainTarget>>;

export type ToolchainId = keyof typeof TOOLCHAIN_TARGETS;

/** A toolchain that HAS canonical flags — every toolchain with a synthetic tier. Computed from the
 *  registry, so the set cannot drift from it: a caller that needs a fallback flag set (the
 *  playground's target picker, the benchmark's synthetic rows) takes this instead of `ToolchainId`
 *  and a real-only toolchain is refused where it is named, not where it is used. */
export type CanonicalToolchainId = {
  [K in ToolchainId]: (typeof TOOLCHAIN_TARGETS)[K] extends { canonicalFlags: readonly string[] } ? K : never;
}[ToolchainId];

/** A toolchain's canonical flags, or `undefined` where it has none. The ONE place the optional
 *  field is read: the registry's literal type says which entries carry it, and every caller that
 *  holds a plain `ToolchainId` has to answer for the ones that do not. */
export function canonicalFlagsOf(id: ToolchainId): readonly string[] | undefined {
  const t: ToolchainTarget = TOOLCHAIN_TARGETS[id];
  return t.canonicalFlags;
}

export function isCanonicalToolchainId(id: ToolchainId): id is CanonicalToolchainId {
  return canonicalFlagsOf(id) !== undefined;
}

export function isToolchainId(id: string): id is ToolchainId {
  return Object.hasOwn(TOOLCHAIN_TARGETS, id);
}

/** A toolchain at one flag set. */
export interface ResolvedTarget {
  toolchain: ToolchainId;
  /** the flags the function's target and every candidate compile with */
  cflags: readonly string[];
  /** the description asmlift decompiles against: the toolchain's, less a fact a flag changes */
  target: TargetDescription;
  /** what the flags make the compiler do */
  profile: CodegenProfile;
}

/** The target a function compiled by `toolchain` at `cflags` decompiles against, and the profile
 *  those flags describe. Throws on a level word the toolchain's family cannot read. */
export function targetFor(toolchain: ToolchainId, cflags: readonly string[]): ResolvedTarget {
  const t: ToolchainTarget = TOOLCHAIN_TARGETS[toolchain];
  const profile = parseFlags(t.family, cflags);
  const cpp = dialectOf(profile.slots.lang) === 'c++';
  let target: TargetDescription = cpp ? { ...t.description, dialect: 'c++' } : t.description;
  if (profile.slots['-fshort-enums'] === 'on') {
    // every enum is the smallest integer its values fit (c-decl.c:6064-6065, :6123; compiled,
    // `sizeof(struct {enum {K0, K1} k[2];})` is 4 under the flag and 8 without), so none is enumBytes
    const { enumBytes: _flagged, ...behaviors } = target.compilerBehaviors;
    target = { ...target, compilerBehaviors: behaviors };
  }
  return { toolchain, cflags, target, profile };
}

/** Build the structurer's options for a target: the function's own `returnsVoid` plus every
 *  `compilerBehaviors` field. The ONE place a target's compiler behaviors flow into the
 *  target-agnostic structurer — a new compiler behavior is a field in `compilerBehaviors`, consumed
 *  automatically.
 *
 *  The spread is over the WHOLE bag, so a behavior whose reader is not the structurer rides along
 *  and is simply never read: `hoistsSingleSetArm` is one (its reader is a pre-recovery pass), and
 *  `nearBaseSpan` / `foldsConstAddrOffset` are read off the target by rank.ts. So the field names
 *  are a SUPERSET of StructureOptions', not a bijection, and nothing may derive one from the other
 *  by enumerating keys. */
export function structureOptionsFor(
  t: TargetDescription,
  returnsVoid: boolean,
  prototypes: Prototypes = {},
): StructureOptions {
  // `littleEndian` and `deviceRegisters` are the HARDWARE capabilities the structurer consumes
  // (bitfield extract recognition is LSB-first; the dead-read spelling refuses outside the device
  // window); everything else is a compiler behavior.
  //
  // ONE FIELD IS NOT A STRAIGHT SPREAD, and this is where the difference belongs. A frame
  // direction has THREE states here — `ascending`, `descending`, and `'unknown'` meaning measured
  // and deliberately not shipped (see `spillSlotOrder` above) — and only TWO downstream: the
  // structurer either has a direction or refuses. `'unknown'` is a fact about what this repo
  // measured, not an instruction to a pass, so it is dropped at the translation rather than
  // carried onto a public option type that would then need a third case nobody branches on.
  const { spillSlotOrder, ...behaviors } = t.compilerBehaviors;
  return {
    returnsVoid,
    ...(t.dialect === 'c++' ? { declaredArgs: declaredArgTypes(prototypes) } : {}),
    littleEndian: t.capabilities.endianness === 'little',
    ...(t.capabilities.deviceRegisters ? { deviceRegisters: t.capabilities.deviceRegisters } : {}),
    ...behaviors,
    ...(spillSlotOrder === 'ascending' || spillSlotOrder === 'descending' ? { spillSlotOrder } : {}),
  };
}

/** The candidate prelude: a `typedef` for every name in the scalar vocabulary. PRINTED from
 *  `proto.ts`'s `PRELUDE_TYPEDEFS` rather than spelled out, because the other reader of that
 *  vocabulary decides which type texts asmlift may PRINT into a candidate, and a second copy of
 *  the list is a copy that can disagree — in the direction no test over two lists catches.
 *
 *  The decomp checkouts all define the same names, and the harness keeps typedefs per NAME against
 *  the vendored ctx, so a unit that already has them gets no redefinition. */
export const C_TYPEDEFS = `${[...PRELUDE_TYPEDEFS].map(([name, base]) => `typedef ${base} ${name};`).join('')}\n`;

/** Each declared callee's parameter types, where one can be PRINTED as a cast — the argument
 *  conversions C++ refuses to make implicitly (backend/cfamily.ts `argConversion`). An entry this
 *  cannot spell is `undefined`, and that argument is printed uncast. */
function declaredArgTypes(prototypes: Prototypes): Record<string, readonly (ParamType | undefined)[]> {
  const out: Record<string, readonly (ParamType | undefined)[]> = {};
  for (const [name, p] of Object.entries(prototypes)) {
    if (Array.isArray(p.params)) {
      out[name] = p.params.map((t) => (spellableType(t) && declaredWidth(t) !== undefined ? t : undefined));
    }
  }
  return out;
}
