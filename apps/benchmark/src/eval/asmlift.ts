// Run asmlift on one function and classify. asmlift never guesses silently: it runs in annotate
// mode, so an unmodelled construct becomes an inline ASMLIFT_ERROR marker (outcome "declined")
// rather than plausible-but-wrong C — the honest counterpart to m2c's M2C_ERROR glue. Gap-free
// output is compiled+scored exactly as the target was built.
import type { DecompilerResult } from '@asmlift/bench-schema';
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import { decompileRanked } from '@asmlift/cli/rank';
import type { MatchScore } from '@asmlift/cli/score';
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import type { SymbolMap } from '@asmlift/core/symbols';

import { cachedExtractAsmData } from '../cache';
import { benchCompilerFor } from '../decomp-config';
import type { Toolchain } from '../toolchains';
import { compilerErrorLines } from './outcome';
import { assessQuality } from './quality';

export type Scorer = (candC: string, sym: string, obj: string) => MatchScore;

// asmlift runs in its differ-ranked production mode (decompileRanked): genuinely-ambiguous levers
// (param signedness, divergent-if branch sense) become candidates and the objdiff score picks the
// winner — single-shot `decompile` would under-score what asmlift can match. decompileRanked
// scores internally via the target-dispatched `scoreSource` (the same per-toolchain scorer).
export function runAsmlift(
  tc: Toolchain,
  sym: string,
  asm: string,
  obj: string,
  prototypes?: Prototypes,
  contextCompile?: CandidateCompiler,
  symbols?: SymbolMap,
): DecompilerResult {
  // Side-table: extract the data-section jump table + relocations from the SAME target object so a
  // dense MIPS/PPC switch can recover. Best-effort — a missing/failed objdump (or agbcc, whose
  // table is inline) yields `undefined`.
  let asmData;
  try {
    asmData = cachedExtractAsmData(obj, tc.targetDesc);
  } catch {
    asmData = undefined;
  }
  // Candidate compilation: on the REAL tier, use the project-context compile (headers + extern
  // globals) so an emission referencing them scores in the same context m2c is scored in —
  // symmetric, and exactly how a user's own project would recompile the decompiled function.
  // On the synthetic tier (no context), the generated decomp.yaml compiler (the unconfigured
  // user path). This is what lets recovered GLOBALS (a bare `gSym`) compile at all.
  const compile = contextCompile ?? benchCompilerFor(tc.id);
  const opts = {
    ...(prototypes ? { prototypes } : {}),
    ...(asmData ? { asmData } : {}),
    ...(compile ? { compile } : {}),
    // the project's vendored symbol map (names + declaration shapes). The '/raw-globals'
    // ranked lever rides along, so a symbol-fed row can never score worse than without.
    ...(symbols ? { symbols } : {}),
  };
  // Phase 1 — single-shot decompile in annotate mode: every detected gap becomes an inline
  // ASMLIFT_ERROR marker plus a structured diagnostic. Gapped ⇒ outcome "declined", never
  // scored (the marker could compile via an implicit declaration and grade meaningless code).
  // Gap-free ⇒ proceed to ranked scoring.
  //
  // NEVER-WORSE contract for the symbol map — BACKSTOP ONLY: core now spells every known
  // map-induced escape legally (the additive lowering intifies `&gSym` to `(u32)&gSym`, so an
  // interior/stride address in a value context renders byte-exact instead of tripping the
  // interior-pointer contract). No current row takes this path; it stays as defense-in-depth so
  // an UNKNOWN future map-induced gap degrades to "the map didn't help", never to a decline the
  // raw path wouldn't have had — a gapped symbol-fed decompile retries WITHOUT the map first.
  let annotated: string;
  let activeOpts = opts;
  let usedSymbols = Boolean(symbols);
  try {
    let dec = decompile(sym, asm, tc.targetDesc, { ...activeOpts, onGap: 'annotate' });
    if (dec.diagnostics.length > 0 && usedSymbols) {
      const { symbols: _dropped, ...rawOpts } = activeOpts as typeof opts & { symbols?: SymbolMap };
      const raw = decompile(sym, asm, tc.targetDesc, { ...rawOpts, onGap: 'annotate' });
      if (raw.diagnostics.length === 0) {
        activeOpts = rawOpts;
        usedSymbols = false;
        dec = raw;
      }
    }
    if (dec.diagnostics.length > 0) {
      return {
        decompiler: 'asmlift',
        ...(usedSymbols ? { symbolMap: true as const } : {}),
        outcome: 'declined',
        source: dec.source,
        score: null,
        maxScore: null,
        compileErrors: null,
        quality: assessQuality(dec.source),
        errorMarkers: dec.diagnostics.map((d) => `${d.stage}: ${firstLine(d.reason)}`),
      };
    }
    annotated = dec.source;
  } catch (e) {
    // Backstop: annotate mode is designed not to throw; anything that still does produced no
    // usable output — the honest "failed".
    const msg = (e as Error).message ?? String(e);
    return {
      decompiler: 'asmlift',
      ...(usedSymbols ? { symbolMap: true as const } : {}),
      outcome: 'failed',
      source: msg,
      score: null,
      maxScore: null,
      compileErrors: null,
      quality: assessQuality(''),
      errorMarkers: [firstLine(msg)],
    };
  }

  // Phase 2 — rank candidates (compile + objdiff-score each) and take the differ-picked best.
  try {
    const best = decompileRanked(sym, asm, tc.targetDesc, obj, activeOpts).best;
    const s = best.score;
    return {
      decompiler: 'asmlift',
      ...(usedSymbols ? { symbolMap: true as const } : {}),
      outcome: s.match ? 'match' : 'nonmatch',
      source: best.source,
      score: s.score,
      maxScore: s.rows,
      compileErrors: null,
      breakdown: s.breakdown,
      quality: assessQuality(best.source),
    };
  } catch (e) {
    // A throw here is recorded as noncompile with the phase-1 source: usually a candidate
    // compile failure (a real emitter defect — core's assertDerefsTyped guards the deref
    // family), but this also catches scorer infrastructure errors; the diagnostics say which.
    const msg = (e as Error).message ?? String(e);
    return {
      decompiler: 'asmlift',
      ...(usedSymbols ? { symbolMap: true as const } : {}),
      outcome: 'noncompile',
      source: annotated,
      score: null,
      maxScore: null,
      compileErrors: countCompileErrors(msg),
      quality: assessQuality(annotated),
      errorMarkers: compilerErrorLines(msg),
    };
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 200);
}

/** Best-effort count of distinct compiler diagnostics in a captured error string. */
export function countCompileErrors(stderr: string): number {
  const errs = (stderr.match(/\berror:/gi) ?? []).length;
  return errs > 0 ? errs : 1;
}
