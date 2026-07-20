// Real-project (Tier B) case provider: manifests + their VENDORED preprocessed TUs → Case[].
// Targets compile from the frozen `.i` blobs (no project checkouts at run time); m2c candidates
// score with progressively richer context up to the function's own vendored context
// (makeRealScorer), so an output referencing project globals/structs is never noncompile merely
// for missing context.
import { buildRealTarget, makeRealCompile, makeRealScorer } from '../compile/real';
import { sanitizeM2cContext } from '../eval/m2c-normalizer';
import { TOOLCHAINS } from '../toolchains';
import { type RealFunction, type VendoredManifest, loadManifests } from './manifests';
import type { Case } from './types';

export interface RealFilter {
  project?: string;
  only?: string; // substring match on the symbol
}

export function realCases(filter: RealFilter = {}): Case[] {
  const manifests = loadManifests().filter((m) => !filter.project || m.project === filter.project);
  const cases: Case[] = [];
  for (const man of manifests) {
    const tc = TOOLCHAINS[man.toolchain];
    for (const f of man.functions.filter((x) => !filter.only || x.sym.includes(filter.only))) {
      cases.push({
        id: `${man.project}:${f.sym}:${man.toolchain}`,
        tier: 'real',
        sym: f.sym,
        project: man.project,
        language: 'c',
        features: f.features,
        loc: f.funcC.split('\n').length,
        refSource: f.funcC,
        sourceUrl: f.sourceUrl,
        // m2cCtx functions get the vendored project context (sanitized for m2c's C parser),
        // plus the function's OWN prototype (the TU-derived ctx never forward-declares it, so
        // m2c would guess the signature); the row references the vendored blob (ctxRef)
        // instead of embedding ~100 KB of text
        ctx: f.m2cCtx ? m2cRealCtx(man, f) : f.ctx,
        ctxRef: f.m2cCtx ? man.ctxPath(f.sym) : undefined,
        proto: f.proto,
        note: f.note,
        toolchain: tc,
        build: () => buildRealTarget(man.toolchain, man.vendored(f.sym).tuI),
        scorer: makeRealScorer(man.toolchain, f.prependC ?? '', man.vendored(f.sym).ctxI),
        compile: makeRealCompile(man.toolchain, f.prependC ?? '', man.vendored(f.sym).ctxI),
      });
    }
  }
  return cases;
}

/** The m2c context for an m2cCtx-flagged function: the sanitized vendored project context plus
 *  the function's OWN prototype (the TU-derived ctx never forward-declares it). The prototype
 *  comes from the manifest's funcC — but ONLY when its signature declares the symbol as a plain
 *  identifier; raw project sources can wrap the name in an unexpanded macro
 *  (`void SA2_LABEL(sub_8083504)(…)`), which m2c's parser hard-fails on as K&R. */
function m2cRealCtx(man: VendoredManifest, f: RealFunction): string {
  const base = sanitizeM2cContext(man.vendored(f.sym).ctxI);
  const sig = m2cFnPrototype(f.sym, f.funcC);
  return sig ? `${base}\n${sig}\n` : base;
}

/** The function's own prototype line for the m2c context, or null when the source's signature
 *  does not declare the symbol as a plain identifier (unexpanded project macros — injecting
 *  those hard-fails m2c's parser as K&R). ALSO used by the repro-script generator: the script
 *  reconstructs the ctx from the vendored blob and must append the same line, or the published
 *  output would not reproduce (the fidelity gate holds the two equal by execution). */
export function m2cFnPrototype(sym: string, funcC: string): string | null {
  const sig = funcC.slice(0, funcC.indexOf('{')).trim();
  return new RegExp(`\\b${sym}\\s*\\(`).test(sig) ? `${sig};` : null;
}
