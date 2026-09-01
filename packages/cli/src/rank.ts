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
import {
  type Candidate,
  type RankedResult as CoreRankedResult,
  type Scored,
  enumerateCandidates,
  rankBy,
} from '@asmlift/core/rank';
import type { SymbolMap } from '@asmlift/core/symbols';
import { type TargetDescription } from '@asmlift/core/target';

import type { AsyncCandidateCompiler, CandidateCompiler as SyncCompiler } from './compile-command';
import { renderDeclarations } from './declare';
import { type PhaseClock, timed, timedAsync } from './phase';
import { type CandidateCompiler, MatchScore, scoreObjects, scoreSource } from './score';

// The cli's candidate/result shapes are the core generics pinned to the objdiff MatchScore.
export type RankedCandidate = Scored<MatchScore>;
export type RankedResult = CoreRankedResult<MatchScore>;

export interface RankOptions {
  patterns?: RewritePattern[];
  backend?: LanguageBackend;
  prototypes?: Prototypes;
  asmData?: AsmData;
  /** address→symbol map (core symbols.ts) — same contract as DecompileOptions.symbols */
  symbols?: SymbolMap;
  /** a project's own toolchain — overrides the compiler registry */
  compile?: CandidateCompiler;
  /** Liveness only, never a measurement: called once per candidate as it is scored, carrying the
   *  lowest score seen SO FAR. The ranking below is what decides the winner. */
  onProgress?: (done: number, total: number, bestSoFar: number | undefined) => void;
  /** Where this run's phase timings accumulate (phase.ts). Absent = no timing taken. The serial
   *  driver can only separate the compile from the score when `compile` is supplied; reached
   *  through the registry instead, the compile is charged to `score`. */
  clock?: PhaseClock;
  /** A lever that THREW, rather than declining — core rank.ts's own channel, forwarded so the CLI
   *  can print it. Core's header states why the distinction matters ("a lever that never fires
   *  because it always throws is a defect, and without this it looks identical to a lever that
   *  correctly declined"), and until this was threaded the channel had no consumer outside core:
   *  a whole pre-fan half of the fan could vanish from a row with nothing printed anywhere. */
  onLeverError?: (label: string, error: string) => void;
}

// Self-declaring candidates: a candidate that names map-derived symbols carries their refs
// (Candidate.symbolRefs) — rendered here into its per-candidate declaration block. The
// compiler seam decides whether the block is USED (probed self-declared world) or ignored
// (headers world / context-injecting compilers) — see compile-command.ts.
const declarationsOf = (cand: Candidate): string | undefined =>
  cand.symbolRefs?.length ? renderDeclarations(cand.symbolRefs) : undefined;

// ONE enumeration for both drivers below: they must rank the same candidate set, or the pooled
// run would be answering a different question than the serial one.
const enumerate = (name: string, asm: string, target: TargetDescription, opts: RankOptions): Candidate[] =>
  enumerateCandidates(name, asm, target, {
    patterns: opts.patterns,
    backend: opts.backend ?? cBackend,
    prototypes: opts.prototypes,
    asmData: opts.asmData,
    symbols: opts.symbols,
    ...(opts.onLeverError ? { onLeverError: opts.onLeverError } : {}),
  });

/** Enumerate each type/branch-sense candidate, recompile + objdiff-score it, and rank by the score. */
export function decompileRanked(
  name: string,
  asm: string,
  target: TargetDescription,
  targetObj: string,
  opts: RankOptions = {},
): RankedResult {
  const backend = opts.backend ?? cBackend;
  const candidates = timed(opts.clock, 'enumerate', () => enumerate(name, asm, target, opts));
  // The compile happens INSIDE scoreSource here, so it is charged from the compiler itself and the
  // `score` frame around the call keeps the rest. The pooled driver awaits the two separately.
  const compile: SyncCompiler | undefined =
    opts.clock && opts.compile
      ? (source, symbol, backendId, declarations) =>
          timed(opts.clock, 'compile', () => opts.compile!(source, symbol, backendId, declarations))
      : opts.compile;
  let done = 0;
  let best: number | undefined;
  return rankBy(candidates, name, (source, symbol, cand) => {
    try {
      const s = timed(opts.clock, 'score', () =>
        scoreSource(source, symbol, targetObj, target, backend.id, compile, declarationsOf(cand)),
      );
      best = best === undefined || s.score < best ? s.score : best;
      return s;
    } finally {
      // a candidate the scorer REFUSED still counts as processed: progress must not stall on a
      // lever whose every spelling fails to build
      opts.onProgress?.(++done, candidates.length, best);
    }
  });
}

/** The same ranking with the candidate COMPILES run `jobs` at a time.
 *
 *  A ranked run is mostly subprocess — on LoadBGTilemapData the compiles outweigh the scoring
 *  about 8:1, and the run's own `[phase]` line (phase.ts) is where a current figure comes from —
 *  and `rankBy`'s driver is synchronous, so today tens of thousands of
 *  candidates compile one at a time on one core. Here each worker owns a scratch slot
 *  (compile-command.ts `worker()`), takes the next unclaimed candidate, and scores its object the
 *  moment it lands; the score runs on the main thread and overlaps the other workers' subprocesses.
 *
 *  ONLY the compile moves. The ordering is still core's `rankBy` over the same enumeration, run
 *  afterwards against the memoized scores — so the winner, every tie-break and the `dropped` list
 *  are what the serial path would have produced. The benchmark deliberately keeps calling
 *  `decompileRanked`: a published measurement must not depend on a scheduler. */
export async function decompileRankedParallel(
  name: string,
  asm: string,
  target: TargetDescription,
  targetObj: string,
  opts: RankOptions & {
    jobs: number;
    /** mints one INDEPENDENT async compiler per worker (compile-command.ts `worker()`) */
    worker: () => AsyncCandidateCompiler;
  },
): Promise<RankedResult> {
  const backend = opts.backend ?? cBackend;
  const clock = opts.clock;
  if (clock) {
    clock.workers = Math.max(1, opts.jobs);
  }
  const candidates = timed(clock, 'enumerate', () => enumerate(name, asm, target, opts));
  // keyed by source, which core's enumeration has already deduped on — so it identifies a candidate
  const scored = new Map<string, MatchScore | Error>();
  let next = 0;
  let done = 0;
  let best: number | undefined;
  await Promise.all(
    Array.from({ length: Math.max(1, opts.jobs) }, async () => {
      const compile = opts.worker();
      for (;;) {
        const i = next++;
        if (i >= candidates.length) {
          return;
        }
        const cand = candidates[i];
        let result: MatchScore | Error;
        try {
          const obj = await timedAsync(clock, 'compile', () =>
            compile(cand.source, name, backend.id, declarationsOf(cand)),
          );
          result = timed(clock, 'score', () => scoreObjects(targetObj, obj, name));
          best = best === undefined || result.score < best ? result.score : best;
        } catch (e) {
          // recorded, not thrown: `rankBy` below is what decides whether a refused candidate is
          // survivable (a sibling scored) or fatal (every one failed)
          result = e instanceof Error ? e : new Error(String(e));
        }
        scored.set(cand.source, result);
        opts.onProgress?.(++done, candidates.length, best);
      }
    }),
  );
  return timed(clock, 'rank', () =>
    rankBy(candidates, name, (source) => {
      const r = scored.get(source);
      if (r === undefined) {
        throw new Error(`internal: a candidate reached ranking unscored (${source.length} bytes)`);
      }
      if (r instanceof Error) {
        throw r;
      }
      return r;
    }),
  );
}
