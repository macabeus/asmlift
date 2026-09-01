// Run asmlift on one function and classify. asmlift never guesses silently: it runs in annotate
// mode, so an unmodelled construct becomes an inline ASMLIFT_ERROR marker (outcome "declined")
// rather than plausible-but-wrong C — the honest counterpart to m2c's M2C_ERROR glue. Gap-free
// output is compiled+scored exactly as the target was built.
import type { DecompilerResult } from '@asmlift/bench-schema';
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import { decompileRanked } from '@asmlift/cli/rank';
import type { MatchScore } from '@asmlift/cli/score';
import type { SymbolRef } from '@asmlift/core/l3/symbol-refs';
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import type { SymbolInfo, SymbolMap } from '@asmlift/core/symbols';

import { cachedExtractAsmData } from '../cache';
import { benchCompilerFor } from '../decomp-config';
import type { Toolchain } from '../toolchains';
import { compilerErrorLines } from './outcome';
import { assessQuality } from './quality';

/** `declarations` is the fourth argument for the same reason the candidate compiler has one: a
 *  source that NAMES a project global must be compiled with that global declared, and the
 *  declaration belongs in the compiler's own prelude slot rather than glued onto the front of the
 *  source — the prelude already carries `C_TYPEDEFS`, so a hand-concatenated block redefines
 *  `s16`/`s32` and the compile fails for a reason that has nothing to do with the candidate.
 *  Optional: a scorer whose rows declare nothing ignores it. */
export type Scorer = (candC: string, sym: string, obj: string, declarations?: string) => MatchScore;

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
  // Run exactly ONCE, with the map: the core lowering spells every known map-induced escape
  // legally (the addr-intify and the comparison-path rules), so a map can no longer turn a
  // clean function into a decline — there is no never-worse fallback pass to arbitrate.
  let annotated: string;
  const usedSymbols = Boolean(symbols);
  try {
    const dec = decompile(sym, asm, tc.targetDesc, { ...opts, onGap: 'annotate' });
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
    const ranked = decompileRanked(sym, asm, tc.targetDesc, obj, opts);
    const best = ranked.best;
    const s = best.score;
    return {
      decompiler: 'asmlift',
      ...(usedSymbols ? { symbolMap: true as const } : {}),
      // Provenance of the WINNER: which candidate spelling the differ picked, and (map rows)
      // which map symbols its output references — best.symbolRefs is derived in core from the
      // exact tree the winning source was emitted from (post-DCE value refs only; call targets
      // excluded). A raw-globals winner names nothing ⇒ the honest empty list.
      candidateLabel: best.label,
      // Spellings that FAILED TO BUILD. rankBy drops them so a broken sibling cannot sink a
      // candidate that compiles — but dropping them SILENTLY published a clean win over a
      // hidden failure, which is exactly what a scoring harness must not do.
      ...(ranked.dropped.length ? { droppedCandidates: ranked.dropped } : {}),
      // Spellings that BUILT and were then withheld for want of a byte-exact proof. Same rule as
      // above and a different fact: nothing failed, so folding the two would make `[dropped]`
      // report compile errors that never happened.
      ...(ranked.withheld.length ? { withheldCandidates: ranked.withheld } : {}),
      ...(usedSymbols ? { symbolsUsed: symbolsUsedFrom(best.symbolRefs) } : {}),
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

/** The report's human spelling of one map symbol's declaration shape ("struct Unk_03004C20
 *  (24 B)", "u16[]", "scalar u8", "code") — pre-formatted HERE so the schema and the web UI
 *  never learn SymbolInfo's field vocabulary. Name-only symbols (no shape facts) get none. */
export function symbolShape(info: SymbolInfo): string | undefined {
  if (info.kind === 'code') {
    return 'code';
  }
  switch (info.shape) {
    case 'struct': {
      const size = info.size !== undefined ? ` (${info.size} B)` : '';
      return `struct ${info.structName ?? '?'}${size}`;
    }
    case 'array':
      if (info.elemSize === undefined) {
        return 'array';
      }
      // Only a genuine scalar width spells an int type — a struct-element array (e.g. 28 B
      // elements) must not masquerade as a `u224[]`.
      return SCALAR_BYTES.has(info.elemSize)
        ? `${intType(info.elemSize, info.elemSigned ?? false)}[]`
        : `array (${info.elemSize} B/elem)`;
    case 'scalar':
      if (info.size === undefined) {
        return 'scalar';
      }
      return SCALAR_BYTES.has(info.size)
        ? `scalar ${intType(info.size, info.signed ?? false)}`
        : `scalar (${info.size} B)`;
    case 'pointer':
      return 'pointer';
    default:
      return undefined;
  }
}

const SCALAR_BYTES = new Set([1, 2, 4, 8]);
const intType = (bytes: number, signed: boolean): string => `${signed ? 's' : 'u'}${bytes * 8}`;

/** The winning candidate's map references as the schema's provenance rows — name plus the
 *  pre-formatted shape, sorted by name, uncapped. Absent refs (a '/raw-globals' winner names
 *  nothing) become the honest empty list: the map was in scope, the winner used none of it.
 *
 *  SYNTHESIZED refs are excluded, and that is what keeps this field meaning what it says. Since
 *  the map-less declaration round, `Candidate.symbolRefs` is the union of the map's symbols and
 *  the names read out of the asm's own pool (core rank.ts) — a name the map never knew carries
 *  `synthesized: true`. This field answers "which MAP symbols did the winner use", the question
 *  the symbolMap A/B is about, so a synthesized name would be a different fact under the same
 *  key. Measured by re-enumerating the dataset outside the harness: of the 160 real rows that
 *  enumerate standalone (the other 92 decline without the harness's asmData/prototypes), 7 name
 *  a pool symbol their own project's vendored map does not know — 17 distinct names, from
 *  pokeemerald's `BattleScript_*` labels to sa3's `ewram_end`. Without the filter those would
 *  appear as map provenance the A/B never granted. */
export function symbolsUsedFrom(refs: SymbolRef[] | undefined): { name: string; shape?: string }[] {
  return (refs ?? [])
    .filter((r) => !r.synthesized)
    .map((r) => {
      const shape = symbolShape(r.info);
      return { name: r.name, ...(shape ? { shape } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Best-effort count of distinct compiler diagnostics in a captured error string. */
export function countCompileErrors(stderr: string): number {
  const errs = (stderr.match(/\berror:/gi) ?? []).length;
  return errs > 0 ? errs : 1;
}
