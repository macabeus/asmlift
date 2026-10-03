// A call-free function that keeps values in callee-saved registers (frontend/mips.ts, the frame's
// saves). GCC homes the eighteen values a load-all-then-store-all copy holds at once in t*, v*, a2,
// a3 and s0-s5, saving each s-register in the prologue and restoring it in the epilogue. Each save
// stores what the caller left in the register, so none is a parameter: the signature is the two
// pointers, and the recompile is byte-exact.
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_GCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  compileMipsGcc272Target,
  compileMipsGccTarget,
  gcc272Available,
  scoreCMipsGcc,
  scoreObjects,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { dockerGate } from './docker-gate';

const N = 18;
const C =
  'void rev(int *p, int *q){ ' +
  Array.from({ length: N }, (_, i) => `int x${i} = p[${i}];`).join(' ') +
  ' ' +
  Array.from({ length: N }, (_, i) => `q[${i}] = x${N - 1 - i};`).join(' ') +
  ' }';

const savesS0ToS5 = (asm: string) =>
  ['s0', 's1', 's2', 's3', 's4', 's5'].every((r) => new RegExp(`\\bsw\\s+${r},\\d+\\(sp\\)`).test(asm));

describe('a call-free function whose s-register saves are no parameters', () => {
  test.runIf(dockerGate('mips-saves-kmc'))(
    'gcc2.7.2kmc: two parameters, byte-exact',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags;
      const { obj, asm } = compileMipsGccTarget(C, 'rev', flags);
      expect(savesS0ToS5(asm)).toBe(true);
      const r = decompile('rev', asm, MIPS_GCC);
      expect(r.source).toMatch(/^s32 rev\(s32 \*a0, s32 \*a1\) \{/);
      expect(scoreCMipsGcc(r.source, 'rev', obj, flags).score).toBe(0);
    },
    60_000,
  );

  test.runIf(gcc272Available())(
    'gcc2.7.2: two parameters, byte-exact',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
      const { obj, asm } = compileMipsGcc272Target(C, 'rev', flags);
      expect(savesS0ToS5(asm)).toBe(true);
      const r = decompile('rev', asm, MIPS_GCC);
      expect(r.source).toMatch(/^s32 rev\(s32 \*a0, s32 \*a1\) \{/);
      expect(scoreObjects(obj, compileMipsGcc272Target(r.source, 'rev', flags).obj, 'rev').score).toBe(0);
    },
    60_000,
  );
});
