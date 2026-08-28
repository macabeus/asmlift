// Tier 1 hardware-divide recovery (T1, T3). Each scored byte-exact on the real toolchain
// (mwcc-PPC docker / KMC-gcc-MIPS docker), so a regression shows as a non-match, not a stale
// golden string.
//
//  • T1 — PowerPC `divw`/`divwu` decode (ppc.ts). mwcc emits a BARE `divw r3,r3,r4; blr` with no
//    hi/lo pair and no div-by-zero/overflow trap envelope, so it must recover to `a / b` and MATCH.
//  • T3 — function-scoped `divState` (mips.ts). GCC schedules the `mflo` into a SEPARATE block
//    after the div-by-zero trap branch; a block-local record would see `null` there and emit an
//    opaque `?`. Function-scoping carries the div's (SSA-global) operands across, so gcc divide
//    (unsigned AND signed — see the signed cases below) MATCHES.
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_GCC, PPC_MWCC } from '@asmlift/core/target';
import { compileMipsGccTarget, compilePpcTarget, scoreCMipsGcc, scoreCPpc } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { dockerGate, ppcDockerGate } from './docker-gate';

const HAVE_PPC = ppcDockerGate('hw-divide-tier1');
const HAVE_DOCKER = dockerGate('hw-divide-tier1');

describe.runIf(HAVE_PPC)('T1: PowerPC hardware divide (divw/divwu) → a / b, byte-exact', () => {
  const CASES = [
    { sym: 'divv', c: 'int divv(int a, int b){ return a / b; }', op: '/' },
    { sym: 'udivv', c: 'unsigned udivv(unsigned a, unsigned b){ return a / b; }', op: '/' },
  ];
  for (const { sym, c, op } of CASES) {
    test(`${sym} matches`, () => {
      const { obj, asm } = compilePpcTarget(c, sym);
      const r = decompile(sym, asm, PPC_MWCC);
      const sc = scoreCPpc(r.source, sym, obj);
      expect(r.source).toContain(op);
      expect(r.source).not.toContain('?'); // no unresolved opaque
      expect(sc.match).toBe(true); // byte-exact on real mwcc
    });
  }
});

// T5 — PowerPC has no remainder INSTRUCTION: mwcc lowers `a % b` to `divw; mullw; subf`, so the
// operator survives only in the source. The idiom fold (pattern/engine.ts HWMOD_PATTERNS) puts it
// back, and only `%` recompiles to that exact triple — spelling the decomposition out instead
// swaps the multiply's operands. The third case is the control that keeps the fold order-sensitive:
// its reference C IS the decomposition, mwcc emits the swapped multiply for it, and asmlift must
// leave that alone rather than fold it to a `%` that would recompile to the other order.
describe.runIf(HAVE_PPC)('T5: PowerPC synthesized remainder (divw/mullw/subf) → a % b, byte-exact', () => {
  const CASES = [
    { sym: 'modv', c: 'int modv(int a, int b){ return a % b; }', expect: 'return a0 % a1;' },
    { sym: 'umodv', c: 'unsigned umodv(unsigned a, unsigned b){ return a % b; }', expect: 'return a0 % a1;' },
    // the divisor-first multiply: NOT a remainder recovery, and byte-exact as the decomposition
    { sym: 'modb', c: 'int modb(int a, int b){ return a - b * (a / b); }', expect: 'return a0 - a1 * (a0 / a1);' },
  ];
  for (const { sym, c, expect: want } of CASES) {
    test(`${sym} matches`, () => {
      const { obj, asm } = compilePpcTarget(c, sym);
      const r = decompile(sym, asm, PPC_MWCC);
      const sc = scoreCPpc(r.source, sym, obj);
      expect(r.source).toContain(want);
      expect(r.source).not.toContain('?'); // no unresolved opaque
      expect(sc.match).toBe(true); // byte-exact on real mwcc
    });
  }
});

describe.runIf(HAVE_DOCKER)('T3: GCC-MIPS unsigned divide with cross-block mflo → a / b, byte-exact', () => {
  test('udivg matches (mflo scheduled past the trap branch)', () => {
    const { obj, asm } = compileMipsGccTarget('unsigned udivg(unsigned a, unsigned b){ return a / b; }', 'udivg');
    const r = decompile('udivg', asm, MIPS_GCC);
    const sc = scoreCMipsGcc(r.source, 'udivg', obj);
    expect(r.source).toContain('/');
    expect(r.source).not.toContain('?');
    expect(sc.match).toBe(true);
  });

  // The signed forms carry an INT_MIN/-1 overflow check (`lui at,0x8000`). F-CONST materialises
  // that `lui` as `const(-2147483648)`, so the whole trap envelope becomes empty-body `if`s that
  // gcc recompiles away → the divide matches BYTE-EXACT. The output is ugly (empty ifs); stripping
  // them to a bare `return a/b` is a readability task, not a match blocker.
  for (const [sym, c, op] of [
    ['divg', 'int divg(int a, int b){ return a / b; }', '/'],
    ['modg', 'int modg(int a, int b){ return a % b; }', '%'],
  ] as const) {
    test(`${sym} (signed, F-CONST resolves the overflow const) matches`, () => {
      const { obj, asm } = compileMipsGccTarget(c, sym);
      const r = decompile(sym, asm, MIPS_GCC);
      expect(r.source).toContain(op);
      expect(r.source).not.toContain('?');
      expect(scoreCMipsGcc(r.source, sym, obj).match).toBe(true);
    });
  }
});
