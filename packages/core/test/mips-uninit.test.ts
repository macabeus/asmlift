// UNINITIALISED LOCALS ON MIPS: the O32 register partition (MIPS_IDO/MIPS_GCC `nonArgRegs`,
// `scratchRegs`, `hiddenInputRegs`), which frontend/ssa.ts `registerLiveIns` composes.
import { describe, expect, test } from 'vitest';

import { assertScratchRegsPartitioned, registerLiveIns } from '../src/frontend/ssa';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

describe('the O32 register partition', () => {
  test.each([
    ['ido', MIPS_IDO],
    ['gcc', MIPS_GCC],
  ])('is stated, disjoint from the argument registers, and its scratch half is inside it (%s)', (_c, target) => {
    expect(target.nonArgRegs).toBeDefined();
    expect(target.nonArgRegs!.filter((r) => target.argRegs.includes(r))).toEqual([]);
    expect([...assertScratchRegsPartitioned(target)].sort()).toEqual(
      ['at', 'v0', 'v1', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'].sort(),
    );
    // the scratch half is every caller-saved register no argument travels in, and nothing else
    expect(target.callerSaved.filter((r) => r !== 'ra' && !target.argRegs.includes(r)).sort()).toEqual(
      [...(target.scratchRegs ?? [])].sort(),
    );
    // a callee-saved register is a local's home only once the frontend measures its save
    expect(registerLiveIns(target, new Set()).uninitRegs).not.toContain('s0');
    expect(registerLiveIns(target, new Set(['s0'])).uninitRegs).toContain('s0');
  });
});
