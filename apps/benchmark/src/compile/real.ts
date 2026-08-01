// Real-tier compilation dispatch: ONE table from toolchain id to its compile module. An
// unsupported toolchain is a TYPED null in the table (see mwcc.ts), not a default-case throw.
//
// Design: the dataset VENDORS each function's preprocessed translation unit (cases/vendor.ts) —
// the compiler's actual input, frozen — so the runner needs no project checkouts. Targets are
// asmlift's canonical flags for the ISA (not the project's exact flags): the target is our
// deterministic re-compile of real game code, not the shipped ROM object.
import { type MatchScore, scoreObjects } from '@asmlift/cli/score';
import { macroDefinesOf } from '@asmlift/core/declare';
import { C_TYPEDEFS } from '@asmlift/core/target';

import type { BuiltTarget, ToolchainId } from '../toolchains';
import { agbccReal, stripPrototype } from './agbcc';
import { gcc272Real } from './gcc272';
import { idoReal } from './ido';
import { kmcReal } from './kmc';
import { mwccReal } from './mwcc';
import type { RealCompile, RealProjectCfg } from './types';
import { ctxTypedefPrelude } from './util';

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

/** The escalation ladder for ONE real function: complete prelude texts, cheapest → richest,
 *  each ready to be concatenated ahead of a candidate.
 *
 *    1. bare C_TYPEDEFS — enough for a candidate that names nothing of the project;
 *    2. + the manifest's prependC (skipping C_TYPEDEFS when that prelude owns `u8` already);
 *    3. the function's VENDORED preprocessed context — its real types + extern globals, with the
 *       prototype of `sym` itself stripped (the candidate's definition must be the only one) and
 *       the typedefs that context does not itself define added back (ctxTypedefPrelude — the SAME
 *       helper decomp-config.ts materializes into the reproduction's ctx.i).
 *
 *  Every rung re-provides `NULL`: the vendored context is PREPROCESSED, so the standard macro is
 *  expanded away, and a candidate spelling a null check the idiomatic way (`p != NULL`, as m2c
 *  does) would fail to compile purely for that while a `p != 0` candidate (as asmlift emits)
 *  would not. Both decompilers are judged on the code, not on this artifact.
 *
 *  EXPORTED because the reproduction scripts must materialize the very rung the harness used —
 *  see resolveScoringPrelude. */
export function scoringPreludes(prependC: string, ctxI: string, sym: string): string[] {
  const proDefsU8 = /typedef\s+unsigned\s+char\s+u8\b/.test(prependC);
  const rungs = [
    `${C_TYPEDEFS}\n`,
    `${proDefsU8 ? '' : C_TYPEDEFS}\n${prependC}\n`,
    ...(ctxI ? [`${ctxTypedefPrelude(ctxI)}${stripPrototype(ctxI, sym)}\n`] : []),
  ];
  return rungs.map((r) => `#define NULL ((void *)0)\n${r}`);
}

/** Compile a candidate in the project's escalating context, returning the object of the FIRST
 *  prelude that compiles. The context is what lets an emission referencing project types/GLOBALS
 *  compile at all — the same context m2c is scored in, so asmlift's real-tier scoring is
 *  symmetric. Throws if none compile. */
export function makeRealCompile(toolchain: ToolchainId, prependC: string, ctxI: string) {
  const rc = realCompilerFor(toolchain);
  return (candC: string, sym: string, _backendId?: string, declarations?: string): string => {
    // The candidate's ADDRESS-CAST MACRO defines ride every rung. Every rung here is a headers
    // world — rungs 1/2 are asmlift's own prelude, rung 3 the project's PREPROCESSED context —
    // and none of them can contain a macro, so a macro-named candidate is `undeclared identifier`
    // without this. The rest of the synthesized block stays dropped: the context owns it.
    const macros = macroDefinesOf(declarations);
    let lastErr = '';
    for (const prelude of scoringPreludes(prependC, ctxI, sym)) {
      try {
        return rc.compileCandidate(`${prelude}${macros}${candC}\n`, sym);
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    throw new Error(lastErr || 'candidate did not compile in any context');
  };
}

/** Which rung of the ladder a KNOWN source actually compiles in — i.e. the world the harness
 *  scored that source in. `bench target` replays it over a published row's winning source so the
 *  reproduction script grades where the benchmark graded: materializing the richest rung
 *  unconditionally is wrong whenever escalation stopped earlier, because a richer context can
 *  REJECT what a poorer one accepts (a project prototype vs. the candidate's implicitly-declared
 *  call). Costs 1–3 candidate compiles. Falls back to the richest rung when nothing compiles —
 *  the same context today's unconditional materialization would have used. */
export function resolveScoringPrelude(
  toolchain: ToolchainId,
  prependC: string,
  ctxI: string,
  sym: string,
  candC: string,
): { prelude: string; rung: number } {
  const rc = realCompilerFor(toolchain);
  const preludes = scoringPreludes(prependC, ctxI, sym);
  for (const [i, prelude] of preludes.entries()) {
    try {
      rc.compileCandidate(`${prelude}${candC}\n`, sym);
      return { prelude, rung: i + 1 };
    } catch {
      // next rung
    }
  }
  return { prelude: preludes[preludes.length - 1], rung: preludes.length };
}

/** A context-aware Scorer (real tier): compile the candidate in project context, then objdiff it
 *  against the target. Shares makeRealCompile so asmlift and m2c compile in the identical context. */
export function makeRealScorer(toolchain: ToolchainId, prependC: string, ctxI: string) {
  const compile = makeRealCompile(toolchain, prependC, ctxI);
  return (candC: string, sym: string, targetObj: string): MatchScore =>
    scoreObjects(targetObj, compile(candC, sym), sym);
}
