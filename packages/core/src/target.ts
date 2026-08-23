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
//   • capabilities.deviceRegisters → rank.ts's volatility tie-break: which of two byte-identical
//     spellings publishes a `volatile` (a preference over the reader's C, never a qualifier the
//     decompiler adds or removes).
//   • compilerBehaviors.* → all consumed by the structurer (threaded via StructureOptions).
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
    // so a source that touched one all but certainly declared it `volatile` — which makes it the
    // gate on rank.ts's volatility tie-break. It never adds or removes a qualifier: which cells a
    // source qualified is not derivable from the asm, so both spellings are still enumerated and
    // the differ still referees. It decides only which of two spellings the bytes CANNOT separate
    // is the one published. ABSENT ⇒ no preference at all, which is the neutral direction — the
    // qualifier then reads as a claim about ordinary memory, and enumeration order decides.
    deviceRegisters?: readonly [number, number];
  };
  // COMPILER BEHAVIORS — the specific compiler's canonicalization choices, distinct from
  // hardware `capabilities`. All consumed by the structurer (threaded through StructureOptions).
  compilerBehaviors: {
    // When a loop induction variable's initial value comes from an argument register, some
    // compilers keep mutating that register across the loop (coalesce → no init copy); others
    // copy to a fresh local. IDO -O2 reuses the arg register (true); agbcc/KMC-GCC allocate
    // fresh (false).
    coalesceLoopInit?: boolean;
    // Divergent-if (both arms terminate, no join): reproduce the source branch DIRECTION by
    // emitting the forward-branch-on-negated-condition (taken arm as `else`). IDO/MIPS preserves
    // source direction so this must be on to be byte-exact; agbcc/GCC canonicalize either way so
    // true is a safe default there. A compiler that inverts branch canonicalization sets it
    // false. Absent ⇒ true; a compiler opts OUT.
    preserveDivergentBranchSense?: boolean;
    // Order the parallel-copy assignments at a CFG edge by the order their values are COMPUTED
    // in the predecessor (vs. source/param order), matching a compiler that lays defining ops
    // (and the copies reading them) out in computation order. Uniform (true) across all current
    // compilers. Absent ⇒ true; a compiler opts OUT.
    orderArgCopiesByComputation?: boolean;
    // Regime-A switch recovery: accept an `x != K` test as a case (the EQUAL side is the case
    // body). GCC freely emits `!=`; IDO prefers `==`/`<`. Absent ⇒ true (permissive); the
    // decline path keeps recovery sound either way.
    switchAllowsNeqCase?: boolean;
    // Regime-A switch recovery: accept a RELATIONAL test whose BRANCH admits exactly one scrutinee
    // value as that case (`cmp r0, #1 / bcc` is `case 0:` of an unsigned switch) rather than as
    // navigation. agbcc declares it from its own sources: `stmt.c` emit_case_nodes jumps straight
    // to `node->left->code_label` on LT once `node_is_bounded (node->left)`, so the remaining
    // value's own test is never emitted. A source-level `if (x < 1) … else if …` compiles to the
    // same asm and the two spell different bytes, so this is a claim about ONE compiler's dispatch
    // — the same class as `switchAllowsNeqCase`, whose IDO entry names that mis-recognition.
    // Absent ⇒ false: ido/kmc-gcc/mwcc have not been put through the evidence, and a compiler opts
    // in on its own, never by inheriting.
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
  },
  compilerBehaviors: {
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByComputation: true,
    nearBaseSpan: 255,
    readsStayWhereWritten: true,
    switchAllowsBoundCase: true,
    switchArmsFollowLayout: true,
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
    orderArgCopiesByComputation: true,
    switchAllowsNeqCase: false,
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
  // KMC GCC allocates a fresh local for the loop init (coalesceLoopInit false — where it differs
  // from IDO); the structuring levers take the universal default until a KMC fixture says otherwise.
  capabilities: { endianness: 'big', hwDivide: true, hwFloat: true, flags: false },
  compilerBehaviors: { coalesceLoopInit: false, preserveDivergentBranchSense: true, orderArgCopiesByComputation: true },
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
  // defaults; coalesceLoopInit false until a CW loop fixture says otherwise.
  compilerBehaviors: { coalesceLoopInit: false, preserveDivergentBranchSense: true, orderArgCopiesByComputation: true },
};

/** Build the structurer's options for a target: the function's own `returnsVoid` plus every
 *  `compilerBehaviors` lever (they map 1:1 onto StructureOptions field names). The ONE place a
 *  target's compiler behaviors flow into the target-agnostic structurer — a new behavior lever
 *  is a field in `compilerBehaviors`, consumed automatically. */
export function structureOptionsFor(t: TargetDescription, returnsVoid: boolean): StructureOptions {
  // `littleEndian` is the one HARDWARE capability the structurer consumes (bitfield extract
  // recognition is LSB-first); everything else is a compiler behavior.
  return { returnsVoid, littleEndian: t.capabilities.endianness === 'little', ...t.compilerBehaviors };
}

export const C_TYPEDEFS =
  'typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;' +
  'typedef signed char s8;typedef short s16;typedef int s32;\n';
