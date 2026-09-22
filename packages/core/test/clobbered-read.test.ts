// A caller-saved register read back after a call (frontend/ssa.ts `refuseStaleCallerSavedReads`).
//
// The SSA builder is right that the register has a reaching definition — the ABI is what makes that
// definition worthless. Nothing about the register file says so, so without the refusal the read
// resolves to the pre-call value and the function lifts, silently, at exit 0.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { clobberedByCall } from '../src/frontend/ssa';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-clobbered-read.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC);

describe('a value the callee destroyed', () => {
  test('a read of it refuses, naming the register', () => {
    expect(() => lift('clobbered_read')).toThrow(/r3 is read on a path where a call has destroyed it/);
  });

  test('it does NOT lift to the pre-call value', () => {
    // The shape this guard exists for: `mov r3,#0x2a; bl callee; add r0,r3,#0` reading as
    // `return 42`. A refusal is the whole assertion — any source at all here would be one.
    expect(() => lift('clobbered_read')).toThrow();
  });

  test('the same read lifts once the caller puts the value back', () => {
    expect(lift('rematerialized_read').source).toContain('42');
  });

  test('destroyed on ONE path is destroyed — the join carries one value and it is gone', () => {
    // Both edges into the join pass the same `mov`, so nothing merges and the phi collapses to it.
    // The register file says the value reaches; the path through the call says it does not.
    expect(() => lift('clobbered_on_one_path')).toThrow(/r1 is read on a path where a call has destroyed it/);
  });

  test('a callee that really does preserve the register still declines — the STRICT side', () => {
    expect(() => lift('preserving_callee_read')).toThrow(/r3 is read on a path where a call has destroyed it/);
  });
});

describe('what a call clobbers', () => {
  test('the return register is not in it — the frontend has already named that one', () => {
    expect(clobberedByCall(ARMV4T_AGBCC)).not.toContain('r0');
    expect(clobberedByCall(ARMV4T_AGBCC)).toContain('r1');
    expect(clobberedByCall(PPC_MWCC)).not.toContain('r3');
    expect(clobberedByCall(PPC_MWCC)).toContain('r4');
  });

  test('every target passes arguments only in registers it calls caller-saved', () => {
    for (const t of [ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC]) {
      expect(() => clobberedByCall(t)).not.toThrow();
    }
  });

  test('a target that does not refuses, rather than quietly refusing nothing', () => {
    expect(() => clobberedByCall({ callerSaved: ['r0'], argRegs: ['r0', 'r1'], returnReg: 'r0' })).toThrow(
      /passes arguments in r1 but does not list it as caller-saved/,
    );
  });
});
