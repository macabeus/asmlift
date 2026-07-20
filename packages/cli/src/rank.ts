// asmlift — the cli's ranked decompile: enumerate candidates (the pure @asmlift/core half) and
// re-rank them by the objdiff score. The enumeration (signedness × branch-sense levers, dedup,
// the probe) lives in `@asmlift/core/rank`; this module supplies only the Node/objdiff scorer via
// `rankBy`'s injected scoreFn. The differ is the fitness function — types/branch-sense are
// differ-ranked levers, not asserted truths.
import { cBackend } from '@asmlift/core/backend/c';
import type { AsmData } from '@asmlift/core/frontend/asmdata';
import type { LanguageBackend } from '@asmlift/core/l3/ast';
import { RewritePattern } from '@asmlift/core/pattern/engine';
import type { Prototypes } from '@asmlift/core/proto';
import { type RankedResult as CoreRankedResult, type Scored, enumerateCandidates, rankBy } from '@asmlift/core/rank';
import { type TargetDescription } from '@asmlift/core/target';

import { type CandidateCompiler, MatchScore, scoreSource } from './score';

// The cli's candidate/result shapes are the core generics pinned to the objdiff MatchScore.
export type RankedCandidate = Scored<MatchScore>;
export type RankedResult = CoreRankedResult<MatchScore>;

/** Enumerate each type/branch-sense candidate, recompile + objdiff-score it, and rank by the score. */
export function decompileRanked(
  name: string,
  asm: string,
  target: TargetDescription,
  targetObj: string,
  opts: {
    patterns?: RewritePattern[];
    backend?: LanguageBackend;
    prototypes?: Prototypes;
    asmData?: AsmData;
    /** a project's own toolchain — overrides the compiler registry */
    compile?: CandidateCompiler;
  } = {},
): RankedResult {
  const backend = opts.backend ?? cBackend;
  const candidates = enumerateCandidates(name, asm, target, {
    patterns: opts.patterns,
    backend,
    prototypes: opts.prototypes,
    asmData: opts.asmData,
  });
  return rankBy(candidates, name, (source, symbol) =>
    scoreSource(source, symbol, targetObj, target, backend.id, opts.compile),
  );
}
