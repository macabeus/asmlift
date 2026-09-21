// A BARE `/regionbase` WINNER ON ORDINARY MEMORY. Every corpus row that reaches a per-region base
// writes a device register, where the `/volatile` sibling is the right answer and `compareScored`'s
// device tie-break picks it. The synthetic `memscope` row is `dmascope` with its write base in RAM
// and no `volatile` in the reference: both siblings reach the bytes, and the published one must be
// the spelling that adds no `volatile` to memory the reference never marked. This pins that the
// tie exists (so the tie-break is what decides) and which way it falls.
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { joinVariations } from '@asmlift/core/variation-tokens';
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

import { SYNTHETIC } from '../../../../apps/benchmark/dataset/synthetic';
import { decompileRanked } from '../../src/rank';

const spec = SYNTHETIC.find((s) => s.sym === 'memscope')!;
const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;

test('memscope publishes the byte-exact spelling WITHOUT `volatile`, over its `/volatile` twin', () => {
  const asm = compileTargetAsm(spec.src, FLAGS);
  const ranked = decompileRanked(spec.sym, asm, ARMV4T_AGBCC, assembleTarget(asm), { prototypes: spec.proto });
  const exact = ranked.candidates.filter((c) => c.score.score === 0).map((c) => joinVariations(c.variations));
  const volatile = (name: string) => /(^|\/)volatile(-|\/|$)/.test(name);
  // the tie is real: a `/volatile` spelling reaches the bytes too
  expect(exact.some(volatile)).toBe(true);
  expect(exact.some((name) => !volatile(name))).toBe(true);
  expect(ranked.winner.score.score).toBe(0);
  expect(volatile(joinVariations(ranked.winner.variations))).toBe(false);
  expect(joinVariations(ranked.winner.variations)).toContain('regionbase');
});
