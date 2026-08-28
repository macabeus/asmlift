// Real-project (Tier B) case provider: manifests + their VENDORED preprocessed TUs → Case[].
// Targets compile from the frozen `.i` blobs (no project checkouts at run time); m2c candidates
// score with progressively richer context up to the function's own vendored context
// (makeRealScorer), so an output referencing project globals/structs is never noncompile merely
// for missing context.
//
// PROVISIONING: both tools read the project's declarations out of the same vendored freeze —
// asmlift the vendored symbol map (`symbols`), m2c the vendored preprocessed context (`m2cCtx`).
// Neither is handed the row's own signature out of the reference source. manifests.ts's `m2cCtx`
// doc states what each channel carries; README.md lists the residuals, in both directions, and
// the one corner where a signature fact still reaches m2c only. Do not re-derive either here.
import type { Prototypes } from '@asmlift/core/proto';
import { asIfUndecompiled } from '@asmlift/core/symbols';

import { buildRealTarget, makeRealCompile, makeRealScorer } from '../compile/real';
import { TOOLCHAINS } from '../toolchains';
import { loadManifests } from './manifests';
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
      const ctxI = f.m2cCtx ? man.vendored(f.sym).ctxI : null;
      const ctxProto = ctxI === null ? null : m2cOwnPrototype(f.sym, f.proto, ctxI);
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
        // m2cCtx rows get the vendored project context VERBATIM, plus at most the void-ness
        // `proto` already gives asmlift (m2cOwnPrototype). The row references the vendored blob
        // (ctxRef) instead of embedding ~100 KB of text. Set on every real row except the six
        // whose callees the vendored headers do not declare, which keep a hand-written `ctx`.
        ctx: ctxI === null ? f.ctx : appendCtxProto(ctxI, ctxProto),
        ctxRef: f.m2cCtx ? man.ctxPath(f.sym) : undefined,
        ctxProto: ctxProto ?? undefined,
        proto: f.proto,
        // LEAKAGE-FREE by construction: every row here is a function someone already decompiled,
        // so the project ELF knows things about it that a user mid-decomp cannot. Score against
        // the map as it would look with this function still `INCLUDE_ASM` (core's
        // asIfUndecompiled) — otherwise any future signature/local/location feature scores on
        // facts it could never have in the flow the dogfood reproduces.
        symbols: man.symbols && asIfUndecompiled(man.symbols, f.sym),
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

/** The m2c `--context` text = the vendored blob, then the prototype line if there is one. ONE
 *  expression, because the published repro script reconstructs the same file by appending a
 *  heredoc to the gunzipped blob and the two must be byte-identical — `bench fidelity` compares
 *  m2c's OUTPUT, so a divergence here is invisible to it. Every vendored blob ends in a newline
 *  (held by test/authored-facts.test.ts), which is what makes the script's plain `>>` equal. */
export function appendCtxProto(ctx: string, proto: string | null): string {
  return proto === null ? ctx : `${ctx.endsWith('\n') ? ctx : `${ctx}\n`}${proto}\n`;
}

/** The function's OWN prototype for the m2c context — derived from the manifest's `proto`, which
 *  is the SAME field asmlift reads, and never from `funcC`.
 *
 *  WHY NOT `funcC`. It used to be reconstructed from the reference source, and that made the
 *  benchmark hold two opposite policies on one fact: core's `asIfUndecompiled` strips the row's
 *  own `declared`/`signature` from asmlift's symbol map as definition-derived leakage ("only
 *  CALLEE signatures transfer"), while the same signature — return type, parameter types and the
 *  reference's own parameter NAMES — was pasted into m2c's context. It was load-bearing, not
 *  cosmetic: ablating it moves matches. A fact the harness calls leakage on one side cannot be
 *  provisioning on the other.
 *
 *  WHAT SURVIVES, in order:
 *    1. the context already declares the symbol → nothing is appended, m2c reads that
 *       declaration. On 31 of those rows it is the project's own header, which is a fact a user
 *       mid-decomp genuinely has: a header declares a function whose body is still `INCLUDE_ASM`.
 *       On 8 it is the manifest's `prependC`, which is a residual and is disclosed as one
 *       (README residual 4, pinned by test/authored-facts.test.ts).
 *    2. otherwise, at most what `proto[sym]` gives asmlift. `returnsVoid: true` is the only
 *       return-type fact in that field, so it is the only one emitted; a non-void row gets
 *       nothing, which is already m2c's default assumption. Parameter TYPES ride along where
 *       `proto` lists them, parameter names never do. */
export function m2cOwnPrototype(sym: string, proto: Prototypes | undefined, ctx: string): string | null {
  if (new RegExp(`\\b${sym}\\s*\\(`).test(ctx)) {
    return null; // the project's headers declare it — m2c reads it there
  }
  const p = proto?.[sym];
  if (p?.returnsVoid !== true) {
    return null;
  }
  const params = Array.isArray(p.params) ? (p.params.length === 0 ? 'void' : p.params.join(', ')) : '';
  return `void ${sym}(${params});`;
}
