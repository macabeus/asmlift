// Real-tier compilation dispatch: ONE table from toolchain id to its compile module. An
// unsupported toolchain is a TYPED null in the table (see mwcc.ts), not a default-case throw.
//
// Design: the dataset VENDORS each function's preprocessed translation unit (cases/vendor.ts) —
// the compiler's actual input, frozen — so the runner needs no project checkouts. Targets are
// asmlift's canonical flags for the ISA (not the project's exact flags): the target is our
// deterministic re-compile of real game code, not the shipped ROM object.
import { type MatchScore, scoreObjects } from '@asmlift/cli/score';
import { C_TYPEDEFS } from '@asmlift/core/target';

import type { BuiltTarget, ToolchainId } from '../toolchains';
import { agbccReal, stripPrototype } from './agbcc';
import { gcc272Real } from './gcc272';
import { idoReal } from './ido';
import { kmcReal } from './kmc';
import { mwccReal } from './mwcc';
import type { RealCompile, RealProjectCfg } from './types';

export type { RealProjectCfg } from './types';

const REAL_COMPILERS: Record<ToolchainId, RealCompile | null> = {
  agbcc: agbccReal,
  'ido7.1': idoReal,
  'gcc2.7.2kmc': kmcReal,
  'gcc2.7.2': gcc272Real,
  mwcc_242_81: mwccReal, // typed "not wired" — see compile/mwcc.ts
};

/** Build the full translation unit: project #includes + any per-function prelude + the function.
 *  Vendor/verify time only — the runner consumes the preprocessed result. */
export function makeTU(cfg: RealProjectCfg, prependC: string, funcC: string): string {
  const inc = cfg.headers.map((h) => `#include "${h}"`).join('\n');
  return `${inc}\n${prependC ?? ''}\n${funcC}\n`;
}

export function realCompilerFor(toolchain: ToolchainId): RealCompile {
  const rc = REAL_COMPILERS[toolchain];
  if (!rc) {
    throw new Error(`real tier not wired for ${toolchain} (add it to REAL_COMPILERS in compile/real.ts)`);
  }
  return rc;
}

/** Compile a vendored (preprocessed) target TU → scoring target + disassembly. */
export function buildRealTarget(toolchain: ToolchainId, tuI: string): BuiltTarget {
  return realCompilerFor(toolchain).buildTarget(tuI);
}

// ── context-aware candidate scoring ────────────────────────────────────────────────────────
// A decompiler's output for a REAL function may reference the project's globals/structs; with
// only bare typedefs available, every such function would be noncompile — a harness artifact,
// not a decompiler weakness. The scorer therefore escalates context, up to the function's
// VENDORED preprocessed context (the same text the target compiled against).

/** Compile a candidate in the project's escalating context, returning the object of the FIRST
 *  prelude that compiles (cheap C_TYPEDEFS → +prependC → the vendored project context). The
 *  context is what lets an emission referencing project types/GLOBALS compile at all — the same
 *  context m2c is scored in, so asmlift's real-tier scoring is symmetric. Throws if none compile. */
export function makeRealCompile(toolchain: ToolchainId, prependC: string, ctxI: string) {
  const proDefsU8 = /typedef\s+unsigned\s+char\s+u8\b/.test(prependC);
  const rc = realCompilerFor(toolchain);
  return (candC: string, sym: string): string => {
    // cheap → rich. candidate never typedefs u8, so C_TYPEDEFS is safe in (1); in (2) skip it if
    // the prelude already defines u8; (3) uses the vendored context's own types + extern globals
    // (the prototype of `sym` itself stripped, so the candidate's own definition is the only one).
    const strategies: (string | null)[] = [
      `${C_TYPEDEFS}\n`,
      `${proDefsU8 ? '' : C_TYPEDEFS}\n${prependC}\n`,
      ctxI ? `${stripPrototype(ctxI, sym)}\n` : null,
    ];
    let lastErr = '';
    for (const prelude of strategies) {
      if (prelude === null) {
        continue;
      }
      try {
        return rc.compileCandidate(`${prelude}${candC}\n`, sym);
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    throw new Error(lastErr || 'candidate did not compile in any context');
  };
}

/** A context-aware Scorer (real tier): compile the candidate in project context, then objdiff it
 *  against the target. Shares makeRealCompile so asmlift and m2c compile in the identical context. */
export function makeRealScorer(toolchain: ToolchainId, prependC: string, ctxI: string) {
  const compile = makeRealCompile(toolchain, prependC, ctxI);
  return (candC: string, sym: string, targetObj: string): MatchScore =>
    scoreObjects(targetObj, compile(candC, sym), sym);
}
