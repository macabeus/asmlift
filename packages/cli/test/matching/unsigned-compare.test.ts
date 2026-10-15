// An unsigned compare is published unsigned on every toolchain, matched or not. The default spells
// an icmp_u* over signed-rendering operands with a `(u32)` cast or a u32 declaration
// (structure.ts unsignedCompareSpelling); the signed spelling is `/signed-cmp`, published only
// byte-exact. Before that, a nonmatch winner could be the signed spelling wherever it tied or scored
// better — gcc 2.7.2kmc published `return v1 >= 6` over `s32 v1` against `sltiu`.
import type { TargetDescription } from '@asmlift/core/target';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { hasVariation } from '@asmlift/core/variation-tokens';
import {
  assembleTarget,
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compileMipsTarget,
  compilePpcTarget,
  compileTargetAsm,
  extractAsmData,
  gcc272Available,
  idoAvailable,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';
import { kmcGate, ppcDockerGate } from './docker-gate';

// `bcc` / `sltu` / `cmplw`: wrong spelled signed at n == 0, where n - 1 is 0xFFFFFFFF
const P1 =
  'void g(unsigned);\nvoid f(int n){ unsigned i=0; if (n!=1) do { g(i); i++; } while (i < (unsigned)(n-1)); }\n';
// `bls` / `sltiu`: wrong spelled signed for a negative sum
const P2 = 'int f(int *p, int n){ int s=0,i; for(i=0;i<n;i++) s+=p[i]; return (unsigned)s > 5u; }\n';

type Compile = (c: string) => { asm: string; obj: string };
const agbcc: Compile = (c) => {
  const asm = compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
  return { asm, obj: assembleTarget(asm) };
};
const TOOLCHAINS: [string, boolean, Compile, TargetDescription][] = [
  ['agbcc', true, agbcc, TOOLCHAIN_TARGETS.agbcc.description],
  [
    'ido7.1',
    idoAvailable(),
    (c) => compileMipsTarget(c, 'f', TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags),
    TOOLCHAIN_TARGETS['ido7.1'].description,
  ],
  [
    'gcc2.7.2kmc',
    kmcGate('unsigned-compare'),
    (c) => compileMipsGccTarget(c, 'f', TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags),
    TOOLCHAIN_TARGETS['gcc2.7.2kmc'].description,
  ],
  [
    'gcc2.7.2',
    gcc272Available(),
    (c) => compileMipsGcc272Target(c, 'f', TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags),
    TOOLCHAIN_TARGETS['gcc2.7.2'].description,
  ],
  [
    'mwcc_242_81',
    ppcDockerGate('unsigned-compare', 'mwcc_242_81'),
    (c) => compilePpcTarget('mwcc_242_81', c, 'f', TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags),
    TOOLCHAIN_TARGETS.mwcc_242_81.description,
  ],
];

const ranked = async (c: string, compile: Compile, target: TargetDescription) => {
  const { asm, obj } = compile(c);
  // an object-file target names its callees through the relocations
  const asmData = target.compiler === 'agbcc' ? undefined : extractAsmData(obj, target, 'f');
  return decompileRanked('f', asm, target, obj, asmData ? { asmData } : {});
};

/** The names `src` declares `u32`, parameters included. */
const unsignedNames = (src: string): Set<string> => new Set([...src.matchAll(/\bu32 (\w+)[;,)]/g)].map((m) => m[1]));

describe('the unsigned do-while test of `i < (unsigned)(n - 1)`', () => {
  for (const [id, have, compile, target] of TOOLCHAINS) {
    test.runIf(have)(`${id}: the published loop test compares unsigned`, async () => {
      const rk = await ranked(P1, compile, target);
      const src = rk.winner.source;
      const loop = /while \((\w+) < (\w+) (?:- 1|\+ -1)\)/.exec(src);
      expect(loop, src).not.toBeNull();
      const u = unsignedNames(src);
      // C compares unsigned when either side is unsigned
      expect(u.has(loop![1]) || u.has(loop![2]), src).toBe(true);
      if (!rk.winner.score.match) {
        expect(hasVariation(rk.winner.variations, 'signed-cmp')).toBe(false);
      }
    });
  }
});

describe('the unsigned select `(unsigned)s > 5u` after a summing loop', () => {
  // ido7.1 and mwcc decline this shape for unrelated gaps (a delay-slot block boundary, `clz`)
  for (const [id, have, compile, target] of TOOLCHAINS.filter(
    ([id]) => !id.startsWith('ido') && !id.startsWith('mwcc'),
  )) {
    test.runIf(have)(`${id}: the published select compares unsigned`, async () => {
      const rk = await ranked(P2, compile, target);
      const src = rk.winner.source;
      const cast = /\(u32\)\w+ > 5/.test(src);
      const sel = /(\w+) (?:>= 6|> 5)/.exec(src);
      expect(cast || (sel !== null && unsignedNames(src).has(sel[1])), src).toBe(true);
    });
  }

  test.runIf(gcc272Available())('gcc2.7.2: the loop guard over `n` stays a signed compare', async () => {
    // `blez a1`: a guard read through a u32 name holding the 0 would compare unsigned
    // (l3/initfirst.ts's common-arm hoist asks the compare-meaning gate)
    const rk = await ranked(P2, TOOLCHAINS[3][2], TOOLCHAINS[3][3]);
    const src = rk.winner.source;
    const guard = /if \((\w+) > (\w+)\)/.exec(src);
    expect(guard, src).not.toBeNull();
    const u = unsignedNames(src);
    expect(u.has(guard![1]) || u.has(guard![2]), src).toBe(false);
  });
});
