// asmlift — the DecompileReport: a versioned JSON capturing the REASONING and the PROCESS of
// a run. Two consumers:
//   • the self-improve AI agent — reads stage/pass localization, pattern scoreDeltas,
//     ranked candidates, and the failure blame to decide what to change next;
//   • humans — the web playground's Pipeline tab renders the browser-pure TraceReport subset.
//
// The tracing tower itself lives in @asmlift/core/trace (browser-pure). This wrapper is the
// scoring side of the seam: when a target object is available it probes a per-pattern objdiff
// score (the `probeScore` hook), scores the headline source, and ranks candidates. asmlift
// stays a pure generator: the score comes through the scoring seam (scoreSource), never a
// diff of asmlift's own.
import { cBackend } from '@asmlift/core/backend/c';
import type { Block, Fn, Value } from '@asmlift/core/ir/core';
import type { LanguageBackend } from '@asmlift/core/l3/ast';
import { raiseRecovered, structureChecked } from '@asmlift/core/pipeline';
import type { FnProto } from '@asmlift/core/proto';
import { type SymbolInfo, symbolsByName } from '@asmlift/core/symbols';
import { type TargetDescription, structureOptionsFor } from '@asmlift/core/target';
import { type TraceOptions, type TraceReport, decompileTraced } from '@asmlift/core/trace';

import { decompileRanked } from './rank';
import { type CandidateCompiler, MatchScore, NoCandidateCompilerError, scoreSource } from './score';

export type { StageTrace, PatternEvent, TraceReport } from '@asmlift/core/trace';
export interface CandidateReport {
  label: string;
  score: number;
  match: boolean;
  source: string;
}

export interface DecompileReport extends TraceReport {
  candidates?: CandidateReport[];
  score?: MatchScore;
  outcome: 'match' | 'near' | 'unscored';
}

export interface ReportOptions extends Omit<TraceOptions, 'probeScore'> {
  targetObj?: string; // if given, the report is scored + ranked by real objdiff
  /** a project's own toolchain — overrides the compiler registry */
  compile?: CandidateCompiler;
}

/** Run the tower while recording a DecompileReport. */
export function decompileWithReport(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: ReportOptions = {},
): { source: string; report: DecompileReport } {
  const { targetObj, compile, ...traceOpts } = opts;
  const backend = opts.backend ?? cBackend;
  const returnsVoid = opts.prototypes?.[name]?.returnsVoid ?? false;
  // THE PROJECT'S OWN MAP GOES TO THE PROBE TOO, and it is not an optional refinement: the
  // main path structures with it, and a probe that structures without it measures its deltas on
  // a program asmlift does not emit. Built once here rather than per probe — `symbolsByName`
  // walks the whole project map, and a probe fires at every pattern boundary.
  const mapSymbols = opts.symbols ? symbolsByName(opts.symbols) : undefined;
  const probeScore = targetObj
    ? (fn: Fn, inferredSymbols: Map<string, SymbolInfo>) =>
        tryScore(
          backend,
          fn,
          target,
          name,
          targetObj,
          returnsVoid,
          compile,
          opts.prototypes?.[name],
          inferredSymbols,
          mapSymbols,
        )
    : undefined;

  const { source, report } = decompileTraced(name, asm, target, { ...traceOpts, probeScore });

  let score: MatchScore | undefined;
  let candidates: CandidateReport[] | undefined;
  // Score + rank only a run that actually produced the tower's output (an annotate-mode stub
  // has an empty trace and nothing meaningful to score).
  if (targetObj && report.trace.length > 0) {
    try {
      score = scoreSource(source, name, targetObj, target, backend.id, compile);
      const ranked = decompileRanked(name, asm, target, targetObj, {
        patterns: opts.patterns,
        backend,
        prototypes: opts.prototypes,
        asmData: opts.asmData,
        compile,
      });
      candidates = ranked.candidates.map((c) => ({
        label: c.label,
        score: c.score.score,
        match: c.score.match,
        source: c.source,
      }));
    } catch (e) {
      // Annotate mode never throws (the tower's contract) — a SCORING-infrastructure failure
      // (missing/corrupt targetObj, toolchain down, annotate markers making the source
      // uncompilable) must not destroy a good decompilation: keep source + trace, degrade to
      // `outcome: "unscored"`. Strict mode still propagates. A missing candidate COMPILER is
      // different: a SETUP bug (nothing registered, no override) that would otherwise turn
      // every report silently unscored — it propagates in both modes.
      if (e instanceof NoCandidateCompilerError) {
        throw e;
      }
      if ((opts.onGap ?? 'strict') === 'strict') {
        throw e;
      }
      score = undefined;
      candidates = undefined;
    }
  }

  const outcome: DecompileReport['outcome'] = !score ? 'unscored' : score.match ? 'match' : 'near';
  return { source, report: { ...report, candidates, score, outcome } };
}

function tryScore(
  backend: LanguageBackend,
  fn: Fn,
  target: TargetDescription,
  name: string,
  obj: string,
  returnsVoid: boolean,
  compile: CandidateCompiler | undefined,
  self: FnProto | undefined,
  inferredSymbols: Map<string, SymbolInfo>,
  mapSymbols: Map<string, SymbolInfo> | undefined,
): number | undefined {
  try {
    const clone = structuredCloneFn(fn);
    // The SAME shared spine as the main path (patterns are already applied on `fn` at the point
    // this probe is taken, so they are NOT re-run here). The probe's scoreDeltas are REPORTED,
    // so it is verifier-gated like every other path: a corrupt clone yields `undefined`, never
    // a garbage delta.
    raiseRecovered(clone, target, {}, self);
    // …structured with the SAME SYMBOL FACTS the main path uses, which is TWO dictionaries and
    // not one: the project's own map AND the derived array shapes (raise/globalshape.ts), asked
    // in that order, exactly as `decompileTraced` asks them. Either one missing here measures the
    // delta on a program asmlift does not emit — without the derived shapes the probe scores
    // `((T *)&gSym)[i]` on every function the derivation reaches while the headline says
    // `gSym[i]`, and without the MAP it scores the reverse and worse: on a map-ful function the
    // probe would spell a bare `gSym[i]` whose meaning rests on a derived `extern u16 gSym[]`
    // while the map beside it — and the headline source — say `const s16 gSym[4][64]`.
    const sfn = structureChecked(clone, {
      ...structureOptionsFor(target, returnsVoid),
      ...(mapSymbols ? { symbols: mapSymbols } : {}),
      ...(inferredSymbols.size ? { inferredSymbols } : {}),
    });
    return scoreSource(backend.emit(sfn), name, obj, target, backend.id, compile).score;
  } catch {
    return undefined;
  }
}

// Shallow structural clone so a mid-pipeline scoring probe doesn't mutate the live fn's types.
// (The IR is plain data; values keep identity within the clone.) Typed field-by-field against
// Fn: a field added to Fn/Block/Op is a compile error HERE, not a silently-dropped field in
// every score probe.
function structuredCloneFn(fn: Fn): Fn {
  const map = new Map<Value, Value>();
  const cv = (v: Value): Value => {
    if (!map.has(v)) {
      map.set(v, { type: { ...v.type } });
    }
    return map.get(v)!;
  };
  const blocks: Block[] = fn.blocks.map((b) => ({
    params: b.params.map(cv),
    ops: b.ops.map((o) => ({
      opcode: o.opcode,
      operands: o.operands.map(cv),
      results: o.results.map(cv),
      attrs: { ...o.attrs },
      successors: o.successors.map((sc) => ({ block: sc.block, args: sc.args.map(cv) })),
    })),
  }));
  // fix successor block refs to the cloned blocks
  const bmap = new Map<Block, Block>(fn.blocks.map((b, i) => [b, blocks[i]]));
  for (const b of blocks) {
    for (const o of b.ops) {
      for (const sc of o.successors) {
        sc.block = bmap.get(sc.block)!;
      }
    }
  }
  return { name: fn.name, blocks };
}
