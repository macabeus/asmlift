// asmlift — the scoring seam. asmlift is a pure generator; it does NOT own the scorer.
// Scoring calls the community objdiff engine in-process (src/objdiff.ts, the pinned
// `objdiff-wasm` npm package) and returns its DiffBreakdown. Never a hand-rolled diff.
//
// This module holds ONLY the seam: the candidate-compile registry and the target-dispatched
// scoreSource. It ships EMPTY — a compiler gets in exactly two ways: the `compile` override
// (built from a project's decomp.yaml `compiler` command), or an explicit
// registerCandidateCompiler call. asmlift's own pinned toolchains live in the private
// @asmlift/toolchains workspace package (benchmark + matching-suite infrastructure) and
// register themselves when imported; they are deliberately NOT part of this npm package.
import { TargetDescription } from '@asmlift/core/target';

import type { CandidateCompiler } from './compile-command';
import { type MatchScore, scoreObjects } from './objdiff';

export { scoreObjects } from './objdiff';
export type { DiffBreakdown, MatchScore } from './objdiff';
export type { CandidateCompiler } from './compile-command';

/** Scoring was requested but no compiler is available for the target. A SETUP error, not a
 *  scoring failure — report.ts propagates it even in annotate mode. */
export class NoCandidateCompilerError extends Error {}

const CANDIDATE_COMPILERS = new Map<string, CandidateCompiler>();

/** Register the candidate compiler for a `target.compiler` id (library extension point;
 *  @asmlift/toolchains registers asmlift's four pinned ones this way). */
export function registerCandidateCompiler(compiler: string, fn: CandidateCompiler): void {
  CANDIDATE_COMPILERS.set(compiler, fn);
}

/** Score `source` for `target`+`backendId` — the target-aware entry every scoring path must
 *  use. `compile` overrides the registry (a project's own toolchain); with neither, throws
 *  rather than compiling with the wrong one. */
export function scoreSource(
  source: string,
  symbol: string,
  targetObj: string,
  target: TargetDescription,
  backendId: string,
  compile?: CandidateCompiler,
): MatchScore {
  const fn = compile ?? CANDIDATE_COMPILERS.get(target.compiler);
  if (!fn) {
    throw new NoCandidateCompilerError(
      `no candidate compiler for '${target.compiler}' — register one or pass a compile override`,
    );
  }
  return scoreObjects(targetObj, fn(source, symbol, backendId), symbol);
}
