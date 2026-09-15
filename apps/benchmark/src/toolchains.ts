// Toolchain adapters for the m2c-vs-asmlift benchmark.
//
// A "toolchain" = (ISA, compiler) pair with a live cross-compiler on this machine. Each adapter
// knows how to, from a piece of REFERENCE C source + its symbol:
//   • buildTarget(refC, sym, lang?) → { obj, asm } : compile the reference to the scoring-target
//     object AND produce the disassembly text that the decompilers consume as input ('c++'
//     selects mwcc's .cp frontend; only the mwcc adapter accepts it).
//   • score(candC, sym, obj)                : compile a candidate C, objdiff it against the target.
//   • targetDesc                            : the asmlift TargetDescription for its frontend.
//
// This deliberately reuses asmlift's own pinned toolchains (@asmlift/toolchains) so the benchmark measures
// the EXACT toolchains asmlift is tested against — no second, drifting copy of the compile logic.
//
// Two asm formats matter downstream (see apps/benchmark/README): asmlift's ARM frontend parses agbcc's
// textual `.s`; its MIPS/PPC frontends parse `objdump -d` output. m2c wants GNU-as text for all.
// The adapter records which format `asm` is in via `asmKind` so each decompiler runner can adapt.
import type { ToolchainId } from '@asmlift/bench-schema';
import { TOOLCHAIN_TARGETS, type TargetDescription, targetFor } from '@asmlift/core/target';
import {
  type MatchScore,
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
  scoreC,
  scoreCMips,
  scoreCMipsGcc,
  scoreCPpc,
} from '@asmlift/toolchains';
import { statSync } from 'node:fs';

import { scoreViaBenchConfig } from './decomp-config';

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

export interface Toolchain {
  id: ToolchainId;
  isa: 'arm' | 'mips' | 'ppc';
  compiler: 'agbcc' | 'ido' | 'gcc' | 'mwcc';
  label: string; // human label for the report
  targetDesc: TargetDescription;
  /** the flags every target and candidate of this toolchain is compiled with */
  cflags: readonly string[];
  asmKind: 'agbcc-s' | 'objdump'; // what format `asm` is in
  /** Reachability gate: the Docker pair probes the daemon/image; the native pair probes the
   *  pinned binary path. An unavailable toolchain SKIPS its rows (the runner logs each skip,
   *  and stale-check's coverage guard keeps a skipping run from ever clobbering the dataset). */
  available: () => boolean;
  buildTarget: (refC: string, sym: string, lang?: 'c' | 'c++') => BuiltTarget;
  score: (candC: string, sym: string, obj: string) => MatchScore;
}

/** A toolchain at its canonical flags, where every benchmark row compiles and decompiles. */
function atCanonicalFlags(id: ToolchainId): Pick<Toolchain, 'targetDesc' | 'cflags'> {
  const cflags = TOOLCHAIN_TARGETS[id].canonicalFlags;
  return { targetDesc: targetFor(id, cflags).target, cflags };
}

export const TOOLCHAINS: Record<ToolchainId, Toolchain> = {
  agbcc: {
    id: 'agbcc',
    isa: 'arm',
    compiler: 'agbcc',
    label: 'agbcc / ARM (GBA)',
    ...atCanonicalFlags('agbcc'),
    asmKind: 'agbcc-s',
    available: () => agbccAvailable(),
    buildTarget: (refC, _sym) => {
      const asm = compileTargetAsm(refC, TOOLCHAIN_TARGETS.agbcc.canonicalFlags); // agbcc .s text — asmlift ARM frontend input
      const obj = assembleTarget(asm); // assemble that .s → scoring target
      return { obj, asm };
    },
    score: scoreViaBenchConfig('agbcc', (candC, sym, obj) =>
      scoreC(candC, sym, obj, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
    ),
  },
  'ido7.1': {
    id: 'ido7.1',
    isa: 'mips',
    compiler: 'ido',
    label: 'IDO / MIPS (N64)',
    ...atCanonicalFlags('ido7.1'),
    asmKind: 'objdump',
    available: () => idoAvailable(),
    buildTarget: (refC, sym) => compileMipsTarget(refC, sym, TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags),
    score: scoreViaBenchConfig('ido7.1', (candC, sym, obj) =>
      scoreCMips(candC, sym, obj, TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags),
    ),
  },
  'gcc2.7.2kmc': {
    id: 'gcc2.7.2kmc',
    isa: 'mips',
    compiler: 'gcc',
    label: 'KMC GCC / MIPS (N64)',
    ...atCanonicalFlags('gcc2.7.2kmc'),
    asmKind: 'objdump',
    available: () => dockerAvailable(),
    buildTarget: (refC, sym) => compileMipsGccTarget(refC, sym, TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags),
    score: scoreViaBenchConfig('gcc2.7.2kmc', (candC, sym, obj) =>
      scoreCMipsGcc(candC, sym, obj, TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags),
    ),
  },
  'gcc2.7.2': {
    id: 'gcc2.7.2',
    isa: 'mips',
    compiler: 'gcc',
    label: 'GCC 2.7.2 / MIPS (N64)',
    ...atCanonicalFlags('gcc2.7.2'),
    asmKind: 'objdump',
    available: () => gcc272Available(),
    buildTarget: (refC, sym) => compileMipsGcc272Target(refC, sym, TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags),
    score: scoreViaBenchConfig('gcc2.7.2', (candC, sym, obj) =>
      scoreCMipsGcc(candC, sym, obj, TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags),
    ),
  },
  mwcc_242_81: {
    id: 'mwcc_242_81',
    isa: 'ppc',
    compiler: 'mwcc',
    label: 'CodeWarrior / PowerPC (GC)',
    ...atCanonicalFlags('mwcc_242_81'),
    asmKind: 'objdump',
    available: () => ppcDockerAvailable(),
    buildTarget: (refC, sym, lang) =>
      lang === 'c++'
        ? compilePpcCppTarget(refC, sym, TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags)
        : compilePpcTarget(refC, sym, TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags),
    score: scoreViaBenchConfig('mwcc_242_81', (candC, sym, obj) =>
      scoreCPpc(candC, sym, obj, TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags),
    ),
  },
};

export function availableToolchains(): Toolchain[] {
  return Object.values(TOOLCHAINS).filter((t) => t.available());
}
