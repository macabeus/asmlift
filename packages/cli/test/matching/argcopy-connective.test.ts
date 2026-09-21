// `/argcopy` ACROSS A SHORT-CIRCUIT, two-sided. l3/argcopy.ts's `straight-line` gate refuses a
// region that is one basic block, and a region holding `&&` is not one: each short-circuit is an
// edge, and agbcc keeps the copy across it. The synthetic `leafand` row is the shape; this pins what
// the row's artifact cannot, that the bare spelling does NOT reach the bytes and only the copy
// does — so a gate that read "straight-line" as "no nested list" would be caught here by the
// side it loses, not by a number that quietly moved.
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { joinVariations } from '@asmlift/core/variation-tokens';
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

import { SYNTHETIC } from '../../../../apps/benchmark/dataset/synthetic';
import { decompileRanked } from '../../src/rank';

const spec = SYNTHETIC.find((s) => s.sym === 'leafand')!;
const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;

test('leafand matches only through a region copy over a `&&`-holding leaf arm', () => {
  const asm = compileTargetAsm(spec.src, FLAGS);
  const ranked = decompileRanked(spec.sym, asm, ARMV4T_AGBCC, assembleTarget(asm), { prototypes: spec.proto });
  const exact = ranked.candidates.filter((c) => c.score.score === 0).map((c) => joinVariations(c.variations));
  expect(exact.length).toBeGreaterThan(0);
  // every byte-exact spelling copies the parameter, and the copy's region is a leaf
  expect(exact.every((name) => /\/argcopy-a0@/.test(name))).toBe(true);
  expect(ranked.winner.score.score).toBe(0);
  // the other side: without the copy the bytes are not reached
  const bare = ranked.candidates.find((c) => joinVariations(c.variations) === 'unsigned')!;
  expect(bare.score.score).toBeGreaterThan(0);
});
