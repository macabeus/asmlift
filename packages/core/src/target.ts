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
//   • capabilities.endianness / flags → RESERVED hardware facts, not yet read by any pass
//     (byte-addressing will consume endianness; PPC condition regs → flags).
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
  // HARDWARE / ISA facts — independent of the compiler.
  capabilities: {
    endianness: 'little' | 'big'; // RESERVED — no pass reads it yet (byte-addressing will)
    hwDivide: boolean; // consumed by patternApplies (idiom gating)
    hwFloat: boolean; // consumed by patternApplies (idiom gating)
    flags: boolean; // RESERVED — no pass reads it yet (PPC condition regs will)
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
  };
}

export const ARMV4T_AGBCC: TargetDescription = {
  id: 'armv4t',
  compiler: 'agbcc',
  argRegs: ['r0', 'r1', 'r2', 'r3'],
  returnReg: 'r0',
  capabilities: { endianness: 'little', hwDivide: false, hwFloat: false, flags: true },
  compilerBehaviors: { coalesceLoopInit: false, preserveDivergentBranchSense: true, orderArgCopiesByComputation: true },
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
  return { returnsVoid, ...t.compilerBehaviors };
}

export const C_TYPEDEFS =
  'typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;' +
  'typedef signed char s8;typedef short s16;typedef int s32;\n';
