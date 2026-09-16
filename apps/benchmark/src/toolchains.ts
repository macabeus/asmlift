// Toolchain adapters for the m2c-vs-asmlift benchmark.
//
// A "toolchain" = (ISA, compiler) pair with a live cross-compiler on this machine. Each adapter
// knows how to, from a piece of REFERENCE C source + its symbol:
//   • buildTarget(refC, sym, cflags, lang?) → { obj, asm } : compile the reference at `cflags` to the
//     scoring-target object AND produce the disassembly text that the decompilers consume as input
//     ('c++' selects mwcc's .cp frontend; only the mwcc adapter accepts it).
// What a row compiles and decompiles at is its own flags (`codegenFor`), not the toolchain's.
//
// This deliberately reuses asmlift's own pinned toolchains (@asmlift/toolchains) so the benchmark measures
// the EXACT toolchains asmlift is tested against — no second, drifting copy of the compile logic.
//
// Two asm formats matter downstream (see apps/benchmark/README): asmlift's ARM frontend parses agbcc's
// textual `.s`; its MIPS/PPC frontends parse `objdump -d` output. m2c wants GNU-as text for all.
// The adapter records which format `asm` is in via `asmKind` so each decompiler runner can adapt.
import type { ToolchainId } from '@asmlift/bench-schema';
import { withoutDebugSections } from '@asmlift/core/frontend/thumb';
import { type ResolvedTarget, TOOLCHAIN_TARGETS, targetFor } from '@asmlift/core/target';
import {
  agbccAvailable,
  assembleTarget,
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compileMipsTarget,
  compilePpcCppTarget,
  compilePpcTarget,
  compileTargetAsm,
  dockerAvailable,
  gcc272Available,
  idoAvailable,
  ppcDockerAvailable,
} from '@asmlift/toolchains';
import { statSync } from 'node:fs';

export type { ToolchainId } from '@asmlift/bench-schema';

export interface BuiltTarget {
  obj: string; // path to the scoring-target object
  asm: string; // disassembly / asm text (format per `asmKind`)
}

/** THE `BuiltTarget` INVARIANT, STATED WHERE BOTH TIERS CROSS. Neither half is ever legitimately
 *  empty: the `.asm` is a decompiler's whole input and the `.o` is objdiff's scoring target, so an
 *  empty one is a step that exited 0 having written nothing. Nothing downstream notices, and with a
 *  content-keyed, TTL-less cache in the path it stays wrong forever — one such entry surfaced days
 *  later, in another module, as `disasmToM2c: could not parse objdump output` on a row stable for
 *  weeks.
 *
 *  @asmlift/toolchains' `nonEmptyDump` guards the objdump STEPS that package runs; this guards the
 *  CONTRACT and names the ROW, and it is the only one of the two the real tier reaches —
 *  `compile/{ido,kmc,gcc272}.ts` run their own `disasm()` and agbcc's target is a `.s` read from
 *  disk, no objdump involved. Both `Case.build` implementations go through it — the synthetic
 *  tier's via `cache.ts`, the real tier's via `compile/real.ts` — so EVERY row is covered, not
 *  only the ones the cache sees. */
export function checkedTarget(built: BuiltTarget, what: string): BuiltTarget {
  if (built.asm.trim() === '') {
    throw new Error(`${what} produced an empty disassembly — refusing it as a scoring target`);
  }
  if (statSync(built.obj).size === 0) {
    throw new Error(`${what} produced an empty object — refusing it as a scoring target`);
  }
  return built;
}

/** What one row compiles and decompiles at: the flags its target and every candidate compile at, and
 *  the description asmlift resolves from them. One value, so the two never come from different flag
 *  sets. Throws on a level word the toolchain's family cannot read. */
export const codegenFor = (id: ToolchainId, cflags: readonly string[]): ResolvedTarget => targetFor(id, cflags);

/** A toolchain at its canonical flags. */
export function canonicalCodegen(id: ToolchainId): ResolvedTarget {
  return codegenFor(id, TOOLCHAIN_TARGETS[id].canonicalFlags);
}

export interface Toolchain {
  id: ToolchainId;
  isa: 'arm' | 'mips' | 'ppc';
  label: string; // human label for the report
  asmKind: 'agbcc-s' | 'objdump'; // what format `asm` is in
  /** Reachability gate: the Docker pair probes the daemon/image; the native pair probes the
   *  pinned binary path. An unavailable toolchain SKIPS its rows (the runner logs each skip,
   *  and stale-check's coverage guard keeps a skipping run from ever clobbering the dataset). */
  available: () => boolean;
  buildTarget: (refC: string, sym: string, cflags: readonly string[], lang?: 'c' | 'c++') => BuiltTarget;
}

export const TOOLCHAINS: Record<ToolchainId, Toolchain> = {
  agbcc: {
    id: 'agbcc',
    isa: 'arm',
    label: 'agbcc / ARM (GBA)',
    asmKind: 'agbcc-s',
    available: () => agbccAvailable(),
    buildTarget: (refC, _sym, cflags) => {
      const listing = compileTargetAsm(refC, cflags); // agbcc .s text
      const obj = assembleTarget(listing); // assemble that .s → scoring target
      // both decompilers read the listing without its debug sections; the object keeps them
      return { obj, asm: withoutDebugSections(listing) };
    },
  },
  'ido7.1': {
    id: 'ido7.1',
    isa: 'mips',
    label: 'IDO / MIPS (N64)',
    asmKind: 'objdump',
    available: () => idoAvailable(),
    buildTarget: (refC, sym, cflags) => compileMipsTarget(refC, sym, cflags),
  },
  'gcc2.7.2kmc': {
    id: 'gcc2.7.2kmc',
    isa: 'mips',
    label: 'KMC GCC / MIPS (N64)',
    asmKind: 'objdump',
    available: () => dockerAvailable(),
    buildTarget: (refC, sym, cflags) => compileMipsGccTarget(refC, sym, cflags),
  },
  'gcc2.7.2': {
    id: 'gcc2.7.2',
    isa: 'mips',
    label: 'GCC 2.7.2 / MIPS (N64)',
    asmKind: 'objdump',
    available: () => gcc272Available(),
    buildTarget: (refC, sym, cflags) => compileMipsGcc272Target(refC, sym, cflags),
  },
  mwcc_242_81: {
    id: 'mwcc_242_81',
    isa: 'ppc',
    label: 'CodeWarrior / PowerPC (GC)',
    asmKind: 'objdump',
    available: () => ppcDockerAvailable('mwcc_242_81'),
    buildTarget: (refC, sym, cflags, lang) =>
      lang === 'c++'
        ? compilePpcCppTarget('mwcc_242_81', refC, sym, cflags)
        : compilePpcTarget('mwcc_242_81', refC, sym, cflags),
  },
};

export function availableToolchains(): Toolchain[] {
  return Object.values(TOOLCHAINS).filter((t) => t.available());
}
