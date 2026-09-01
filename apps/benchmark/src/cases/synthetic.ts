// Synthetic (Tier A) case provider: flatten (authored spec × assigned toolchains) → Case[].
// Reference builds are content-cached (cache.ts); scoring uses the toolchain adapter default.
import { renderDeclarations, selfDeclaredContext } from '@asmlift/core/declare';

import { SYNTHETIC, SYNTHETIC_CPP } from '../../dataset/synthetic';
import { cachedBuildTarget } from '../cache';
import { TOOLCHAINS, type ToolchainId } from '../toolchains';
import type { Case } from './types';

/** THE MAP, RENDERED FOR THE OTHER DECOMPILER — the synthetic tier's symmetry, made structural.
 *
 *  `Case.symbols` reaches asmlift only; m2c's analogue is `ctx`. On the real tier that is
 *  symmetric because the project's own headers ARE the ctx (PR #119 corrected the opposite), but
 *  a synthetic row's ctx is authored, so a row that sets `symbols` and stops hands asmlift a
 *  global's struct layout, its bitfield bit offsets and an array's rank while m2c is told the
 *  function prototype and nothing else. Measured, that asymmetry decides outcomes rather than
 *  decorating them: told only the prototype, m2c emits `extern ? gBgTilemapBufs;` on `sbscope`
 *  and the row publishes a DECLINE; told what the map says, it emits ordinary compiling C.
 *
 *  So the ctx is DERIVED rather than hand-written beside the map, through the same renderer
 *  asmlift's own candidates are declared with (`core/declare.ts`). One source of truth: whatever
 *  the map says, m2c is told, and an author cannot add a fact to one channel and forget the other.
 *
 *  WHAT HOLDS THAT, precisely — the derivation is not self-enforcing, and an earlier draft of this
 *  comment claimed it was. Deriving the ctx here rules out an author writing the two by hand and
 *  letting them drift; it does NOT rule out this function handing the renderer worse input than the
 *  map holds, which is a one-line edit and was measured to leave every gate green while the ctx
 *  degraded to `extern u32 gPacked;`. `authored-facts.test.ts` is what rules that out, and it does
 *  it in two layers because one is not enough: it re-derives the block from `Case.symbols` ITSELF
 *  and requires the ctx to contain it verbatim, and — because a renderer that lost a fact would
 *  lose it on both sides of that comparison — it separately looks for every symbol, every declared
 *  member and every inner array extent in the ctx TEXT. The one map fact that deliberately does not
 *  cross is an array's outermost extent, which `declare.ts` leaves unsized by design; measured on
 *  `sbscope`, spelling it changes m2c's output not at all.
 *
 *  This is not the answer leaking to either side. The map is PROJECT data of the kind a real row
 *  carries off a manifest; the row's own source spelling — the hand-rolled shift, the byte
 *  arithmetic, the scoped declaration — is what the row measures, and it is in neither channel. */
const withMapDeclarations = (ctx: string | undefined, symbols: NonNullable<Case['symbols']>): string => {
  const refs = [...symbols.values()].flat().map((info) => ({ name: info.name, info }));
  return `${selfDeclaredContext(renderDeclarations(refs))}\n${ctx ?? ''}`;
};

export interface SyntheticFilter {
  only?: string; // substring match on the symbol
  toolchain?: ToolchainId;
}

export function syntheticCases(filter: SyntheticFilter = {}): Case[] {
  const specs = [...SYNTHETIC, ...SYNTHETIC_CPP].filter((s) => !filter.only || s.sym.includes(filter.only));
  const cases: Case[] = [];
  for (const spec of specs) {
    for (const tcId of spec.toolchains) {
      if (filter.toolchain && tcId !== filter.toolchain) {
        continue;
      }
      if (spec.lang === 'c++' && tcId !== 'mwcc_242_81') {
        // only the mwcc adapter has a C++ build path; any other pairing would compile C++ as C
        throw new Error(`${spec.sym}: c++ specs must target mwcc_242_81 only, got ${tcId}`);
      }
      const tc = TOOLCHAINS[tcId];
      cases.push({
        id: `synthetic:${spec.sym}:${tcId}`,
        tier: 'synthetic',
        sym: spec.sym,
        project: 'synthetic',
        language: spec.lang ?? 'c',
        features: spec.features,
        loc: spec.src.split('\n').length,
        refSource: spec.src,
        ctx: spec.symbols ? withMapDeclarations(spec.ctx, spec.symbols) : spec.ctx,
        proto: spec.proto,
        ...(spec.symbols ? { symbols: spec.symbols } : {}),
        note: spec.note,
        toolchain: tc,
        build: () => cachedBuildTarget(tc, spec.src, spec.sym, spec.lang),
      });
    }
  }
  return cases;
}
