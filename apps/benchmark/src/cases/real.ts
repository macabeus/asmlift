// Real-project (Tier B) case provider: manifests + their VENDORED preprocessed TUs → Case[].
// Targets compile from the frozen `.i` blobs (no project checkouts at run time) at their unit's flags, and a
// target that is not the function the ROM holds is refused; m2c candidates score with progressively richer
// context up to the function's own vendored context (makeRealScorer), so an output referencing project
// globals/structs is never noncompile merely for missing context.
//
// PROVISIONING: both tools read the project's declarations out of the same vendored freeze —
// asmlift the vendored symbol map (`symbols`), m2c the vendored preprocessed context (`m2cCtx`).
// Neither is handed the row's own signature out of the reference source. manifests.ts's `m2cCtx`
// doc states what each channel carries; README.md lists the residuals, in both directions, and
// the one corner where a signature fact still reaches m2c only. Do not re-derive either here.
import { moduleOf, onlySelects } from '@asmlift/bench-schema';
import { unitLanguage } from '@asmlift/core/codegen-flags';
import type { Prototypes } from '@asmlift/core/proto';
import { asIfUndecompiled } from '@asmlift/core/symbols';
import { readFileSync } from 'node:fs';

import { buildRealTarget, makeRealCompile, makeRealScorer } from '../compile/real';
import { type BuiltTarget, TOOLCHAINS, type ToolchainId, codegenFor } from '../toolchains';
import { type RealFunction, loadManifests } from './manifests';
import { targetDigest } from './rom-function';
import type { Case } from './types';

export interface RealFilter {
  project?: string;
  only?: string; // substring match on the symbol or a former name (bench-schema onlySelects)
}

export function realCases(filter: RealFilter = {}): Case[] {
  const manifests = loadManifests().filter((m) => !filter.project || m.project === filter.project);
  const cases: Case[] = [];
  for (const man of manifests) {
    for (const f of man.functions.filter((x) => onlySelects(filter.only, x.sym, x.aliases))) {
      const unit = man.units[f.unit];
      const tc = TOOLCHAINS[unit.toolchain];
      // the map the row is read with: the project's, or — for a row in a REL module — the
      // module's own symbols over the base ELF's globals
      const symbols = man.symbolsFor(moduleOf(f.addr));
      const codegen = codegenFor(unit.toolchain, unit.cflags);
      // THE DIALECT THE ROW'S OWN BUILD READS ITS UNIT IN, and never a property of the row's name:
      // it picks m2c's target, the `-lang` word the target and every candidate compile state, and
      // the linkage a candidate needs to export the mangled symbol a C++ target is keyed by.
      const language = unitLanguage(f.unit, unit.cflags);
      const id = `${man.project}:${f.sym}:${unit.toolchain}`;
      const ctxI = f.m2cCtx ? man.vendored(f.sym).ctxI : null;
      const ctxProto = ctxI === null ? null : m2cOwnPrototype(f.sym, f.proto, ctxI);
      cases.push({
        id,
        tier: 'real',
        sym: f.sym,
        addr: f.addr,
        aliases: f.aliases,
        project: man.project,
        language,
        features: f.features,
        loc: f.funcC.split('\n').length,
        refSource: f.funcC,
        sourceUrl: f.sourceUrl,
        // m2cCtx rows get the vendored project context VERBATIM, plus at most the void-ness
        // `proto` already gives asmlift (m2cOwnPrototype). The row references the vendored blob
        // (ctxRef) instead of embedding ~100 KB of text. A row whose vendored context m2c's C
        // parser cannot be given at all — a C++ unit — keeps a hand-written `ctx` instead, and
        // that path has no m2cOwnPrototype cap on it: README residual 5 states what it costs.
        ctx: ctxI === null ? f.ctx : appendCtxProto(ctxI, ctxProto),
        ctxRef: f.m2cCtx ? man.ctxPath(f.sym) : undefined,
        ctxProto: ctxProto ?? undefined,
        proto: f.proto,
        // LEAKAGE-FREE by construction: every row here is a function someone already decompiled,
        // so the project ELF knows things about it that a user mid-decomp cannot. Score against
        // the map as it would look with this function still `INCLUDE_ASM` (core's
        // asIfUndecompiled) — otherwise any future signature/local/location feature scores on
        // facts it could never have in the flow the dogfood reproduces.
        symbols: symbols && asIfUndecompiled(symbols, f.sym),
        note: f.note,
        toolchain: tc,
        codegen,
        unit: f.unit,
        flagsFrom: unit.flagsFrom,
        build: () =>
          romTarget(
            id,
            f,
            unit.toolchain,
            buildRealTarget(unit.toolchain, f.sym, codegen.cflags, man.vendored(f.sym).tuI, language),
          ),
        scorer: makeRealScorer(unit.toolchain, codegen.cflags, f.prependC ?? '', man.vendored(f.sym).ctxI, language),
        compile: makeRealCompile(unit.toolchain, codegen.cflags, f.prependC ?? '', man.vendored(f.sym).ctxI, language),
      });
    }
  }
  return cases;
}

/** A real row's target, refused unless it holds the function `bench vendor` proved against the ROM: the
 *  row's `romDigest`. A row that builds anything else publishes nothing. */
export function romTarget(id: string, f: RealFunction, toolchain: ToolchainId, built: BuiltTarget): BuiltTarget {
  const digest = targetDigest(readFileSync(built.obj), f.sym);
  if (digest !== f.romDigest) {
    throw new Error(
      `${id}: the target built in unit ${f.unit} by ${toolchain} is not the function the ROM holds ` +
        `(digest ${digest.slice(0, 12)}, romDigest ${f.romDigest.slice(0, 12)}) — ` +
        `run \`pnpm bench flags --project ${id.split(':')[0]}\`, then \`pnpm bench vendor\``,
    );
  }
  return built;
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
