// Synthetic (Tier A) case provider: flatten (authored spec × assigned toolchains) → Case[].
// Reference builds are content-cached (cache.ts); scoring uses the toolchain adapter default.
import { SYNTHETIC, SYNTHETIC_CPP } from '../../dataset/synthetic';
import { cachedBuildTarget } from '../cache';
import { TOOLCHAINS, type ToolchainId } from '../toolchains';
import type { Case } from './types';

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
      if (spec.lang === 'c++' && tcId !== 'mwcc-ppc') {
        // only the mwcc adapter has a C++ build path; any other pairing would compile C++ as C
        throw new Error(`${spec.sym}: c++ specs must target mwcc-ppc only, got ${tcId}`);
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
        ctx: spec.ctx,
        proto: spec.proto,
        note: spec.note,
        toolchain: tc,
        build: () => cachedBuildTarget(tc, spec.src, spec.sym, spec.lang),
      });
    }
  }
  return cases;
}
