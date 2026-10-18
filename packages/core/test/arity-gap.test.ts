// A GAP IN A GUESSED CALL ARITY, DECIDED (frontend/call-plan.ts `decideGap`). An argument register
// left at its incoming value below one the call's own block set up is the function's own argument
// passed on — where the set one is surely an argument, and the ABI cannot leave the gap empty below
// it. Each fixture is the toolchain's own output (canonical flags, 2026-10-18); the Thumb shapes are
// in thumb-frontend.test.ts beside the refusal they replaced.
import { describe, expect, test } from 'vitest';

import { ownLeadingWordParams } from '../src/proto';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, TOOLCHAIN_TARGETS, argRegisterHoles } from '../src/target';

describe('where an ABI can leave an argument register empty below a filled one', () => {
  test('an 8-byte argument skips an odd word on O32 and PowerPC, and a leading float shadows O32 words', () => {
    expect(argRegisterHoles(ARMV4T_AGBCC)).toEqual({ skippable: new Set(), leadingFloatShadow: false });
    for (const t of [MIPS_IDO, MIPS_GCC]) {
      expect(argRegisterHoles(t)).toEqual({ skippable: new Set(['a1', 'a3']), leadingFloatShadow: true });
    }
    expect(argRegisterHoles(PPC_MWCC)).toEqual({
      skippable: new Set(['r4', 'r6', 'r8', 'r10']),
      leadingFloatShadow: false,
    });
  });

  test('every toolchain states it through the facts that place its arguments', () => {
    const holes = Object.fromEntries(
      Object.entries(TOOLCHAIN_TARGETS).map(([id, r]) => {
        const h = argRegisterHoles(r.description);
        return [id, [[...h.skippable].join(','), h.leadingFloatShadow]];
      }),
    );
    expect(holes).toMatchObject({
      agbcc: ['', false],
      'ido7.1': ['a1,a3', true],
      'gcc2.7.2kmc': ['a1,a3', true],
      'gcc2.7.2': ['a1,a3', true],
      mwcc_242_81: ['r4,r6,r8,r10', false],
      mwcc_233_163n: ['r4,r6,r8,r10', false],
      mwcc_247_107: ['r4,r6,r8,r10', false],
    });
  });
});

describe('the first argument registers that surely hold an own word parameter', () => {
  const n = (p: Parameters<typeof ownLeadingWordParams>[1], target = MIPS_IDO) => ownLeadingWordParams('f', p, target);
  test('counts leading integer words, and stops at anything else', () => {
    expect(n({ params: ['const char *', 's32'], returns: 's32' })).toBe(2);
    expect(n({ params: ['s32', 'float', 's32'], returns: 's32' })).toBe(1);
    expect(n({ params: ['float', 's32'], returns: 's32' })).toBe(0);
    expect(n({ params: ['s32', 'long long'], returns: 'void' })).toBe(1);
  });
  test('is none where a hidden word may come first, or nothing is laid out', () => {
    expect(n(undefined)).toBe(0);
    expect(n({ params: 2 })).toBe(0);
    // an unsized parameter anywhere lays nothing out
    expect(n({ params: ['s32', 'Foo'], returns: 's32' })).toBe(0);
    // a return the declaration does not show is a scalar may be a struct handed back through a0
    expect(n({ params: ['s32'] })).toBe(0);
    expect(n({ params: ['s32'], returns: 'struct Big' })).toBe(0);
  });
});
