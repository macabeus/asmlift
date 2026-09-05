// asmlift — the Target: (isa, compiler) as first-class axes. ABI + capabilities are DATA
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
//   • capabilities.readOnlyAddressSinks → the Thumb frame-object audit: a frame address stored to
//     one of these reached a device that only reads through it, so it does not retract `undef`.
//   • capabilities.deviceRegisters → four readers, and they ask ONE question — "would a source
//     have spelled this address `volatile`" — which is a question about SPELLING and may be
//     approximate: the `/vol-store` lever's eligibility (l3/volstore.ts), rank.ts's volatility
//     tie-break between two byte-identical spellings, the first half of `/unreduce`'s
//     disjointness gate (l3/unreduce.ts), and the `/homesplit` pairing's refusal to leave a device
//     READ inline where the spelling it replaces would have qualified it (l3/homesplit.ts).
//   • capabilities.deviceMemoryWriters → the MEMORY-MODEL question, which is a different one and
//     may NOT be approximate: "can a write to this register make the DEVICE write ordinary
//     memory". One reader — `/unreduce`'s second half. Split from `deviceRegisters` because
//     conflating them recorded a false premise (see the field's own comment).
//   • compilerBehaviors.* → mostly consumed by the structurer (threaded via StructureOptions).
//     Four exceptions are read off the target directly, their consumers not being the
//     structurer: `nearBaseSpan` and `foldsConstAddrOffset` (rank.ts, L3 levers),
//     `hoistsSingleSetArm` (raise/pre-recovery.ts, a raising pass) and `arrayShapeFromStride`
//     (raise/globalshape.ts, run on the LIFTED fn). The field names are a
//     SUPERSET of StructureOptions' — see `structureOptionsFor`.
//
// `capabilities` (HARDWARE facts) vs `compilerBehaviors` (COMPILER canonicalization choices) are
// deliberately separate bags: a new compiler must set its behaviors EXPLICITLY instead of
// silently inheriting a universal that is really per-compiler. `coalesceLoopInit` already
// differs across targets (IDO true, agbcc/GCC false).
// This module is browser-pure by contract (no Node APIs, enforced by
// test/browser-safe.test.ts): the toolchain paths that COMPILE for these targets
// live in @asmlift/toolchains.
import type { StructureOptions } from './structure/structure';

export interface TargetDescription {
  id: string; // the ISA — 'armv4t' / 'mips' / 'ppc'. Selects the frontend (registry.ts).
  // The COMPILER is a first-class axis distinct from the ISA (matching = deoptimize to a specific
  // compiler): two targets can share an ISA (⇒ one frontend) yet differ here — e.g. MIPS_IDO vs
  // MIPS_GCC. Consumed by pattern gating (patternApplies) and the report. (version/flags/language
  // are future axes, added when earned.)
  compiler: string; // 'agbcc' / 'ido' / 'gcc' / 'mwcc'
  argRegs: string[];
  returnReg: string;
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
    // therefore this function's own, which the Thumb frame-object audit walks.
    //
    // Hardware, so it belongs here — `endianness` above is a board fact rather than an ISA one too
    // (ARMv4T is bi-endian). ABSENT ⇒ every escape is assumed to write, which is the safe
    // direction and what every other target gets.
    readOnlyAddressSinks?: readonly number[];
    // The device-register window, `[start, end)`. A cell in it changes under the program's feet,
    // so a source that touched one all but certainly declared it `volatile`. THREE consumers read
    // it and all three ask the same SPELLING question — "would a source have written `volatile`
    // here": it is the ELIGIBILITY predicate for the `/vol-store` lever (l3/volstore.ts), which
    // offers the qualified spelling of a fixed-address store; the GATE on rank.ts's volatility
    // tie-break, which picks the qualified twin when the bytes cannot separate the two; and the
    // half of `/unreduce`'s disjointness gate that keeps a DEVICE read from being duplicated.
    // None of them decides for the reader: which cells a source qualified is not derivable from
    // the asm, so both spellings are enumerated and the differ referees. ABSENT ⇒ the lever
    // declines everywhere and the tie-break has no preference, which is the neutral direction —
    // outside a declared window the qualifier is a claim about ordinary memory that the target
    // does not support.
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
  };
  // COMPILER BEHAVIORS — the specific compiler's canonicalization choices, distinct from
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
    // cannot be: the benchmark has rows on both sides inside one compiler (mwcc), so that choice is
    // refereed per row by `/copy-defpos` (rank.ts), never declared per compiler here.
    orderArgCopiesByWriteOrder?: boolean;
    // Regime-A switch recovery: accept an `x != K` test as a case (the EQUAL side is the case
    // body). GCC freely emits `!=`; IDO prefers `==`/`<`. Absent ⇒ true (permissive); the
    // decline path keeps recovery sound either way.
    switchAllowsNeqCase?: boolean;
    // The compiler collapses `if (…) x = a; else x = b;` into `x = b; if (…) x = a;` when both
    // arms are ONE speculatable SET — gcc 2.x's `jump_optimize` (`gcc/jump.c:443-445`, guard at
    // `:471-502`). The ONE reader is raise/narrowlocal.ts's `edge-extends`, which uses it
    // BACKWARDS: a diamond this compiler would have collapsed and did not is evidence the source
    // DECLARED the local narrow, because `gcc/thumb.h:344` PROMOTE_MODE expands a narrow-declared
    // assignment past one SET. Absent ⇒ false, and the clause never admits. `structureOptionsFor`
    // spreads it onto StructureOptions like every other field here, but NO structurer code reads
    // it: its reader is a pre-recovery pass, threaded from `runPreRecovery`'s own `target`.
    //
    // Set on agbcc, where the 2x2 in raise/narrowlocal.ts's header was compiled and scored. NOT
    // set on MIPS_GCC despite it being the same compiler family: nothing has measured the pair
    // there, the clause reaches 0 of its benchmark rows, and `docs/level-tower.md`'s rule for an
    // unmeasured per-compiler default is to claim nothing.
    hoistsSingleSetArm?: boolean;
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
    // ordering needs no fork, only a compiler that does not schedule — so the home axis is denied
    // to ido/kmc/mwcc for a reason that is not its own. Under-reach, unmeasured, and the fix when a
    // row asks for it is a datum of its own rather than a widening of this one.
    //
    // Set on agbcc, where the fork is `gcc/c-typeck.c build_array_ref`'s
    // `TREE_CODE (TREE_TYPE (array)) == ARRAY_TYPE && TREE_CODE (array) != INDIRECT_REF` and both
    // spellings were compiled against the same target. NOT set anywhere else: whether ido, kmc or
    // mwcc distinguish them at all is unmeasured, and `docs/level-tower.md`'s rule for an
    // unmeasured per-compiler default is to claim nothing. Read off the target by a raising pass
    // (`inferGlobalArrays`), not by the structurer.
    arrayShapeFromStride?: boolean;
    // Which way this compiler hands out FRAME SLOTS against a spilled local's DECLARATION RANK:
    // `ascending` = the earlier-declared spilled local takes the LOWER `[sp,#k]`. Consumed by the
    // structurer (StructureOptions.spillSlotOrder) and applied at emit time by l3/slotorder.ts.
    //
    // `'unknown'` and absent both REFUSE the ordering — there is deliberately no default
    // direction, because the wrong one reorders every declaration list on that target for no
    // reason. That is why three of the four descriptions below ship `'unknown'` even though the
    // direction has been measured for each of their compilers: no MIPS or PPC benchmark row lifts
    // with two or more spilled user locals, so no row on those tiers can referee a value, and a
    // value no row can falsify does not earn the level. Each carries its measurement and its flip
    // condition at its own site.
    //
    // KEYED BY DESCRIPTION, WHILE THE FACT IS PER TOOLCHAIN — the first field in this bag with a
    // stated instance of that gap. `MIPS_GCC` serves BOTH `gcc2.7.2kmc` (Snowboard Kids 2's Kyoto
    // build at -O2) and `gcc2.7.2` (Mario Party 3's at -O1); they agree here, and a committed probe
    // says so, but nothing in this bag could express it if they did not. Any behavior that can
    // differ between two toolchains sharing one description is mis-keyed by construction.
    spillSlotOrder?: 'ascending' | 'descending' | 'unknown';
    // Regime-A switch recovery: accept a RELATIONAL test whose BRANCH admits exactly one scrutinee
    // value as that case (`cmp r0, #1 / bcc` is `case 0:` of an unsigned switch) rather than as
    // navigation.
    //
    // A DEFAULT rather than a candidate axis because for agbcc the asm determines the source: at
    // -O2 fold-const rewrites a bounded unsigned comparison into an equality before codegen, so
    // `x < 1u` compiles to `cmp r0, #0 / bne` and `x > 0u` to `cmp r0, #0 / beq` — no source-level
    // comparison chain emits a bound test at all. `emit_case_nodes` runs after folding and does:
    // it jumps straight to `node->left->code_label` on LT once `node_is_bounded (node->left)`, so
    // the remaining value's own test is never emitted. One producer, one reading.
    //
    // Absent ⇒ false, and inheriting it would be wrong rather than merely unmeasured: on the MIPS
    // lanes `sltiu rd, rs, 1` is the ordinary spelling of `!x`, and it lifts to `icmp_ult rs, 1`
    // with no equality fold anywhere — the identical IR shape, from a producer that is not a
    // dispatch. Each compiler opts in on its own dispatch's evidence.
    switchAllowsBoundCase?: boolean;
    // Switch recovery: emit the case arms in the order the ASSEMBLY lays their bodies out, rather
    // than sorted by ascending case value. True claims the compiler emits case bodies as it walks
    // the arms and never MOVES one afterwards — neither reordering basic blocks nor scheduling
    // across them. agbcc declares it from its own sources: `stmt.c` expand_end_case takes
    // `before_case = get_last_insn()` AFTER the bodies are expanded in source order and its closing
    // `reorder_insns` moves only the DISPATCH in front of them, and the Makefile's SRCS compiles
    // neither sched.c nor reorg.c. SCOPE — SRCS does compile jump.c, whose cross-jump merges two
    // identical arm bodies into ONE block, so a merged pair's own order is gone from the asm; that
    // surfaces as two case values sharing a body, which switch-recover.ts ties by ascending value.
    // Absent ⇒ ascending case value, where ido/kmc-gcc/mwcc sit: each has a scheduler and none has
    // been put through that evidence. A compiler opts in on its own, never by inheriting.
    switchArmsFollowLayout?: boolean;
    // Commutative load pairs re-spell in def (evaluation) order (structure.ts lowerDef). Absent
    // ⇒ true — verified byte-exact on agbcc and IDO; a compiler whose scheduler is shown
    // re-ordering independent loads opts OUT here.
    defOrderLoadPairs?: boolean;
    // The single-add-immediate derivation reach for the /nearbase lever (l3/nearbase.ts):
    // neighbor absolute addresses within this many bytes may share one base local. Thumb's
    // `add rd, #imm8` reaches 255. Absent ⇒ the lever stands down for this target.
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
    // Does this compiler EMIT a memory read in the block the source SPELLED it in? One direction
    // only: the def-block placement rule (StructureOptions.readsStayWhereWritten) re-spells a read
    // at the block the asm performed it in, which reproduces the asm iff nothing sinks a spelled
    // read past a branch and nothing lifts one to a dominator. The CONVERSE — the asm's read block
    // is where the source read — is FALSE even here, and no default may be declared as if it held.
    //
    // agbcc (gcc 2.9-arm, -O2) declares TRUE from its own sources plus a compiled pair: gcc's
    // Makefile SRCS compiles neither sched.c nor reorg.c and toplev.c never mentions
    // flag_schedule_insns, so there is no scheduler; gcse.c calls one_code_hoisting_pass only
    // `if (optimize_size)`, which toplev.c sets only for -Os, so at -O2 the hoister is compiled in
    // and never runs (a -Os project would NOT get this declaration); and `s = *g; if (c) A(s);
    // else B(s);` against `if (c) A(*g); else B(*g);` emits one ldrb + one pool word versus one of
    // each PER ARM, moving neither. The two passes that DO move a read between blocks at -O2 —
    // loop invariant motion, and the PRE that makes the converse false — are refusals the rule
    // owes; structure/analysis.ts carries them.
    //
    // ABSENT ⇒ the rule stands down, where ido/kmc-gcc/mwcc sit: each has a scheduler and none has
    // been put through that pair. A compiler opts in on its own evidence, never by inheriting.
    readsStayWhereWritten?: boolean;
  };
}

export const ARMV4T_AGBCC: TargetDescription = {
  id: 'armv4t',
  compiler: 'agbcc',
  argRegs: ['r0', 'r1', 'r2', 'r3'],
  returnReg: 'r0',
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
  },
  compilerBehaviors: {
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    nearBaseSpan: 255,
    foldsConstAddrOffset: true,
    readsStayWhereWritten: true,
    switchAllowsBoundCase: true,
    switchArmsFollowLayout: true,
    hoistsSingleSetArm: true,
    arrayShapeFromStride: true,
    // agbcc: reload walks pseudos ascending handing each global-alloc loser a fresh slot, a user
    // local's pseudo number is its `expand_decl` position, and the Thumb frame grows UPWARD
    // (FRAME_GROWS_DOWNWARD is commented out in thumb.h). So the earlier-declared spilled local
    // takes the lower offset. The rows that referee it are `synthetic:spillorder` (six `[sp,#k]`
    // operand rows and nothing else, from two locals declared the other way round) and its
    // control `synthetic:spillorder_rev` (the same body in the order asmlift already emits, which
    // must stay a MATCH), plus `synthetic:dma_fill_uninit`, a row this did not author.
    spillSlotOrder: 'ascending',
  },
};

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
  capabilities: { endianness: 'big', hwDivide: true, hwFloat: true, flags: false },
  // `switchAllowsNeqCase: false` — IDO's switch dispatch uses `==`/`<`, never `!=` cases;
  // leaving it permissive mis-recognises `!=`-rooted if-else chains as switches.
  compilerBehaviors: {
    coalesceLoopInit: true,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    switchAllowsNeqCase: false,
    // MEASURED `descending` (the earlier-declared spilled local takes the HIGHER offset) and NOT
    // SHIPPED. The probe is COMMITTED — `packages/core/test/corpus/probe-declrank.c` and its
    // reversed-declaration twin, with this compiler's objects beside them — and a test reads the
    // correspondence off it: 16 of 16 spills, and rank → offset unchanged when the declaration
    // list is reversed, which is what separates declaration rank from the order of the assignments. No ido7.1 benchmark row lifts with
    // two or more spilled user locals — the only spilling shape in the corpus carries a call, and
    // this frontend declines a call — so no row can tell a wrong value from a right one here.
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
  // KMC GCC keeps a loop seeded from an argument register IN that register (coalesceLoopInit
  // true, like IDO): test/corpus/gcc-gcd.asm runs its whole loop on a0/a1 with no init copies,
  // and the row it comes from matches only with the parameters as the loop's homes. The other
  // structuring levers take the universal default until a KMC fixture says otherwise.
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
  capabilities: { endianness: 'big', hwDivide: true, hwFloat: true, flags: false },
  compilerBehaviors: {
    coalesceLoopInit: true,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
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
  capabilities: { endianness: 'big', hwDivide: true, hwFloat: true, flags: true },
  // CodeWarrior's structuring levers are UNKNOWN until fixtures reveal them — safe universal
  // defaults; coalesceLoopInit false until a CW loop fixture says otherwise — the second of the
  // two compiler-wide guesses standing in for the per-function observation named at MIPS_GCC.
  compilerBehaviors: {
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    // NOT MEASURED, and `'unknown'` is therefore the only honest value rather than a withheld one.
    // No mwcc row lifts with two or more spilled user locals, and the compiler does not spill the
    // committed declaration-rank probe either: at sixteen locals it homes every one in a register,
    // and at forty it sinks the whole computation past the call so nothing is live across it. An
    // earlier note here claimed `descending` "9 of 9"; that measurement is not reproducible from
    // this repo and its own next clause said the probe did not spill, so it is withdrawn. And, as at MIPS_IDO, the
    // frame partition comes first: `frontend/ppc.ts` claims no `LiveInModel.declaredLocals`, so the
    // shared stamp records no slot home on this target at all and a direction here would order
    // nothing until it does.
    spillSlotOrder: 'unknown',
  },
};

/** Build the structurer's options for a target: the function's own `returnsVoid` plus every
 *  `compilerBehaviors` lever. The ONE place a target's compiler behaviors flow into the
 *  target-agnostic structurer — a new behavior lever is a field in `compilerBehaviors`, consumed
 *  automatically.
 *
 *  The spread is over the WHOLE bag, so a behavior whose reader is not the structurer rides along
 *  and is simply never read: `hoistsSingleSetArm` is one (its reader is a pre-recovery pass), and
 *  `nearBaseSpan` / `foldsConstAddrOffset` are read off the target by rank.ts. So the field names
 *  are a SUPERSET of StructureOptions', not a bijection, and nothing may derive one from the other
 *  by enumerating keys. */
export function structureOptionsFor(t: TargetDescription, returnsVoid: boolean): StructureOptions {
  // `littleEndian` is the one HARDWARE capability the structurer consumes (bitfield extract
  // recognition is LSB-first); everything else is a compiler behavior.
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
    littleEndian: t.capabilities.endianness === 'little',
    ...behaviors,
    ...(spillSlotOrder === 'ascending' || spillSlotOrder === 'descending' ? { spillSlotOrder } : {}),
  };
}

export const C_TYPEDEFS =
  'typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;' +
  'typedef signed char s8;typedef short s16;typedef int s32;\n';
