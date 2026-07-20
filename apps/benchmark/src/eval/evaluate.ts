// Evaluate one function on one toolchain through BOTH decompilers → a FunctionResult. Shared by the
// synthetic and real-project drivers. `build` yields the scoring target + disassembly; from there
// each decompiler runs and is scored against the SAME object with the SAME compiler — symmetric.
import type { DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import type { Prototypes } from '@asmlift/core/proto';

import { cachedAsmDumpText, cachedM2cResult } from '../cache';
import type { Toolchain } from '../toolchains';
import { type Scorer, runAsmlift } from './asmlift';
import { countCompileErrors } from './asmlift';
import { runM2c } from './m2c';
import { compilerErrorLines, declineMarkersIn } from './outcome';
import { assessQuality } from './quality';

export interface EvalSpec {
  sym: string;
  project: string;
  tier: 'synthetic' | 'real';
  language: 'c' | 'c++';
  features: string[];
  refSource: string; // ground-truth C/C++ (for the report)
  sourceUrl?: string; // real tier: GitHub permalink to the reference source
  loc: number;
  ctx?: string; // m2c --context (full text)
  ctxRef?: string; // published on the row in place of large vendored ctx text
  proto?: Prototypes; // asmlift prototypes
  note?: string;
}

// m2c's output dialect assumes these typedefs (its normal --context supplies them); the shared
// candidate prelude (C_TYPEDEFS) is integer-only, so without them every float row would fail
// candidate compilation on `unknown type f32` — a harness artifact, not an m2c weakness. They
// are a FALLBACK, not an unconditional prepend: real-tier scoring contexts include project
// headers that already define f32/f64, where injecting a second typedef is itself a
// harness-manufactured `redefinition` failure. Scoring-time only; the stored `source` stays
// exactly what m2c emitted.
const M2C_DIALECT_TYPEDEFS = 'typedef float f32;typedef double f64;\n#define NULL ((void *)0)\n';

/** Score plain first; retry with the dialect typedefs only when the plain attempt cannot
 *  compile. Whichever compiles is the measurement. */
function scoreM2c(score: Scorer, source: string, sym: string, obj: string): ReturnType<Scorer> {
  try {
    return score(source, sym, obj);
  } catch (first) {
    try {
      return score(M2C_DIALECT_TYPEDEFS + source, sym, obj);
    } catch {
      throw first; // report the plain attempt's error — the dialect retry is best-effort
    }
  }
}

/** Classify m2c through the same rule set as asmlift (outcome.ts): no usable output ⇒ failed;
 *  marker-bearing output ⇒ declined (never compiled); else compile+score, keeping the source +
 *  real compiler error on noncompile. */
function evaluateM2c(
  tc: Toolchain,
  spec: EvalSpec,
  obj: string,
  asm: string,
  score: Scorer,
  asmDump: string | undefined,
): DecompilerResult {
  const { sym, ctx, language } = spec;
  const m = runM2c(tc, sym, asm, { context: ctx, asmDump, lang: language });
  if (m.failed) {
    return {
      decompiler: 'm2c',
      outcome: 'failed',
      source: m.source,
      score: null,
      maxScore: null,
      compileErrors: null,
      quality: assessQuality(m.source),
      errorMarkers: [firstLine(m.source.trim()) || 'empty output'],
    };
  }
  const declines = declineMarkersIn(m.source);
  if (declines.length > 0) {
    return {
      decompiler: 'm2c',
      outcome: 'declined',
      source: m.source,
      score: null,
      maxScore: null,
      compileErrors: null,
      quality: assessQuality(m.source),
      errorMarkers: declines,
    };
  }
  try {
    const s = scoreM2c(score, m.source, sym, obj);
    return {
      decompiler: 'm2c',
      outcome: s.match ? 'match' : 'nonmatch',
      source: m.source,
      score: s.score,
      maxScore: s.rows,
      compileErrors: null,
      breakdown: s.breakdown,
      quality: assessQuality(m.source),
    };
  } catch (e) {
    return {
      decompiler: 'm2c',
      outcome: 'noncompile',
      source: m.source,
      score: null,
      maxScore: null,
      compileErrors: countCompileErrors((e as Error).message ?? ''),
      quality: assessQuality(m.source),
      errorMarkers: compilerErrorLines((e as Error).message ?? ''),
    };
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 200);
}

export function evaluate(
  tc: Toolchain,
  spec: EvalSpec,
  obj: string,
  asm: string,
  scorer?: Scorer,
  compile?: CandidateCompiler,
): FunctionResult {
  const score: Scorer = scorer ?? tc.score;
  // the object's data sections feed the m2c normalizer (jump tables, anonymous constants) and
  // are PUBLISHED on the row so the reproduction scripts carry them too; best-effort — without
  // a dump both fall back to text-only
  let asmDump: string | undefined;
  try {
    // the dump header names the object's ABSOLUTE path (cache dir — machine-specific); scrub it
    // so published rows and scripts are byte-identical across machines. Nothing parses the
    // header line (the normalizer and --asm-data read the tables below it).
    asmDump = cachedAsmDumpText(obj, tc.id)?.replace(/^\/\S+\.o:/m, 'target.o:');
  } catch {
    // text-only fallback
  }
  const asmlift = runAsmlift(tc, spec.sym, asm, obj, spec.proto, compile);
  // m2c is a frozen baseline (pinned checkout): its half of the row is cached by everything it
  // depends on — m2c commit, toolchain, inputs, target object (cache.ts). asmlift is NEVER cached.
  const m2c = cachedM2cResult({ tcId: tc.id, sym: spec.sym, asm, ctx: spec.ctx, obj, lang: spec.language }, () =>
    evaluateM2c(tc, spec, obj, asm, score, asmDump),
  );
  return {
    id: `${spec.project}:${spec.sym}:${tc.id}`,
    sym: spec.sym,
    project: spec.project,
    tier: spec.tier,
    toolchain: tc.id,
    isa: tc.isa,
    compiler: tc.compiler,
    language: spec.language,
    features: spec.features,
    loc: spec.loc,
    refSource: spec.refSource,
    sourceUrl: spec.sourceUrl,
    targetAsm: asm,
    ctx: spec.ctxRef ? undefined : spec.ctx,
    ctxRef: spec.ctxRef,
    proto: spec.proto,
    asmDump,
    asmlift,
    m2c,
    note: spec.note,
  };
}
