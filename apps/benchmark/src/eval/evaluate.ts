// Evaluate one function on one toolchain through BOTH decompilers → a FunctionResult. Shared by the
// synthetic and real-project drivers. `build` yields the scoring target + disassembly; from there
// each decompiler runs and is scored against the SAME object with the SAME compiler — symmetric.
import type { DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import { renderDeclarations } from '@asmlift/core/declare';
import type { Prototypes } from '@asmlift/core/proto';
import type { SymbolMap } from '@asmlift/core/symbols';

import { cachedAsmDumpText, cachedM2cResult } from '../cache';
import { rowFeatures } from '../cases/features';
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
  ctxProto?: string; // the one line appended after the vendored blob, published verbatim
  proto?: Prototypes; // asmlift prototypes
  /** the project's vendored symbol map — asmlift-only input (m2c's analogue is its ctx) */
  symbols?: SymbolMap;
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

/** Score plain first; retry with the dialect typedefs, then with the row's map declarations, only
 *  when the attempt before could not compile. Whichever compiles is the measurement.
 *
 *  WHICH FAILURE IS PUBLISHED, when none of them compiles. It used to be rung 0's, on the rule that
 *  "every retry is best-effort" — right while the only retry ADDED TYPEDEFS the source might not
 *  need, wrong the moment a rung started adding the DECLARATIONS the row is actually compiled
 *  against. Measured at the commit that added them: `bfwordread` and `bfwordwrite` published
 *  ``gPacked' undeclared`` — the pre-fix diagnostic, for a symbol the deciding rung DOES declare —
 *  while that rung failed with `invalid operands to binary <<` and `invalid operands to binary &`.
 *  A published error naming a cause the run does not have is a silent wrong answer wearing a
 *  measurement's clothes, and `errorMarkers` is not among `FIELDS.m2c` in report/diff.ts, so no
 *  artifact comparison would ever have reported it.
 *
 *  So the reported failure is the LAST rung that compiled the source AS EMITTED — rung 0 where
 *  there are no declarations, rung 2 where there are. The dialect rungs stay unreported for the
 *  original reason, unchanged: they prepend typedefs, so their failure can be their own. Pinned by
 *  `m2c-rungs.test.ts`, which is why this function is exported. */
export function scoreM2c(
  score: Scorer,
  source: string,
  sym: string,
  obj: string,
  decls: string | undefined,
): ReturnType<Scorer> {
  const rungs: { src: string; decls?: string }[] = [
    { src: source },
    { src: M2C_DIALECT_TYPEDEFS + source },
    ...(decls
      ? [
          { src: source, decls },
          { src: M2C_DIALECT_TYPEDEFS + source, decls },
        ]
      : []),
  ];
  let report: unknown;
  for (const rung of rungs) {
    try {
      return score(rung.src, sym, obj, rung.decls);
    } catch (e) {
      if (rung.src === source) {
        report = e; // the most informed attempt on the source m2c actually emitted
      }
    }
  }
  throw report;
}

/** THE DECLARATIONS m2c'S OUTPUT IS COMPILED WITH, on a synthetic row whose `ctx` carries a map.
 *
 *  A decompiler told about a global in its `--context` correctly OMITS the declaration from its
 *  output — the user already has that header. asmlift's candidates are handled that way too: the
 *  scoring layer prepends `declarationsOf(cand)` at compile. The synthetic tier has no project
 *  context to compile in, so before the map rows existed m2c's self-declaration was all it needed
 *  and this was moot.
 *
 *  It stopped being moot the moment `ctx` started carrying a map's declarations. Measured without
 *  this: m2c emits `gPacked = (gPacked & 0xFFFFF01F) | …` — correct, and exactly what it should
 *  emit having been told the symbol — and the compile fails with "`gPacked' undeclared". That is a
 *  rig artifact of handing a tool a context it is then not compiled against, not a capability it
 *  lacks, and publishing it would be a wrong answer dressed as a measurement.
 *
 *  The real tier needs none of this: there `scorer` is the project-context compile, which already
 *  supplies the headers m2c was given. So this is the synthetic tier's analogue of that, and it is
 *  a RETRY rung rather than an unconditional prelude — a row that already compiles is untouched,
 *  so this can only ever turn a harness-caused failure into a score.
 *
 *  WHAT THE RUNG DID AND DID NOT DISSOLVE, measured through `evaluate()` with both caches off, and
 *  stated because an earlier draft of this comment stopped at the sentence above and left the two
 *  cases indistinguishable. On `sbscope` it dissolves the artifact outright — the row was a DECLINE
 *  under the prototype-only ctx and scores under the map. On `bfwordread` and `bfwordwrite` it does
 *  NOT: told the true `struct Packed`, m2c emits `(gPacked << 0x14) >> 0x19` and
 *  `gPacked = (gPacked & 0xFFFFF01F) | …` — integer arithmetic on a struct — and the rung's compile
 *  fails with `invalid operands to binary <<` / `invalid operands to binary &`. Both rows go from a
 *  published m2c MATCH to a noncompile, and that loss is the round's, not a stale artifact's.
 *
 *  THE COUNTERFACTUAL, because attributing that to m2c without it would overstate the case: the
 *  same emitted body compiled against the `extern s32 gPacked;` m2c ITSELF used to emit scores 0
 *  and MATCHES. Only the declaration changed, so this is not m2c failing to decompile the function
 *  — it is m2c's output not compiling against the context m2c was given. The harness books that as
 *  a limit rather than an artifact for one reason, and it is a policy reason: the REAL tier already
 *  compiles m2c's output against the project's own headers, so letting the synthetic tier fall back
 *  to a declaration of m2c's choosing would hand it a privilege the real tier denies it and asmlift
 *  has nowhere — asmlift's own self-declaring arm, `/raw-globals`, is DROPPED on these rows for
 *  failing to compile, loudly, and is published as a dropped candidate. */
function m2cDeclarationsFor(spec: EvalSpec): string | undefined {
  if (spec.tier !== 'synthetic' || !spec.symbols) {
    return undefined;
  }
  // The declaration BLOCK only — not `selfDeclaredContext`, which prepends `C_TYPEDEFS`. This goes
  // into the compiler's own prelude slot, which already emits those typedefs, and the first draft
  // of this fix concatenated the whole context onto the source instead: every rung then died on
  // `redefinition of s16` and the four rows stayed noncompile, which reads exactly like the bug
  // being fixed. A retry that fails for its OWN reason is worse than no retry, because it looks
  // like evidence.
  return renderDeclarations([...spec.symbols.values()].flat().map((info) => ({ name: info.name, info })));
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
    const s = scoreM2c(score, m.source, sym, obj, m2cDeclarationsFor(spec));
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
  const asmlift = runAsmlift(tc, spec.sym, asm, obj, spec.proto, compile, spec.symbols);
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
    // Source and codegen tags are DERIVED per row; the dataset carries judgement tags only. Codegen
    // because what the compiler did with a constant divide differs per toolchain and one synthetic
    // spec feeds four of them.
    features: rowFeatures(spec.features, spec.refSource ?? '', asm),
    loc: spec.loc,
    refSource: spec.refSource,
    sourceUrl: spec.sourceUrl,
    targetAsm: asm,
    ctx: spec.ctxRef ? undefined : spec.ctx,
    ctxRef: spec.ctxRef,
    ctxProto: spec.ctxProto,
    proto: spec.proto,
    asmDump,
    asmlift,
    m2c,
    note: spec.note,
  };
}
