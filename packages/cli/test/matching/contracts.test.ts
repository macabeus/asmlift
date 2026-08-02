// Stage boundary contracts (see docs/level-tower.md). The teeth that make the tower "real": a
// pass that regresses fails AT its boundary with a diagnostic, not three stages later as wrong
// C. Each contract is tested to trip on broken input and pass on good input; the entry paths are
// checked to run them in production without false positives.
import { ContractError, assertResolved, assertTypesRecovered } from '@asmlift/core/contracts';
import { parse } from '@asmlift/core/ir/parse';
import type { SFn } from '@asmlift/core/l3/ast';
import { decompile } from '@asmlift/core/pipeline';
import { recoverTypes } from '@asmlift/core/raise/recover';
import { StructureError, structure } from '@asmlift/core/structure/structure';
import { MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';
import { decompileWithReport } from '../../src/report';

describe('recovery boundary — assertTypesRecovered', () => {
  test('trips when a value is still unknown (a recovery pass that stopped short)', () => {
    const fn = parse(`fn f {\n^bb0(%0: unk32):\n  ret %0\n}\n`); // recovery would have typed %0
    expect(() => assertTypesRecovered(fn)).toThrow(ContractError);
  });
  test('passes after real recovery types everything', () => {
    const fn = parse(`fn f {\n^bb0(%0: unk32):\n  ret %0\n}\n`);
    recoverTypes(fn);
    expect(() => assertTypesRecovered(fn)).not.toThrow();
  });
});

describe('structuring boundary — assertResolved', () => {
  test("an op the structurer can't lower declines LOUD at structure(), naming the gap", () => {
    // `opaque` has no expr lowering: strict-mode structure() now records the gap reason and
    // throws itself — the decline names the unmodelled instruction (the same text annotate's
    // markers carry), instead of leaking an anonymous '?' to the boundary contract.
    const fn = parse(`fn f {\n^bb0(%0: s32):\n  %1: s32 = opaque %0\n  ret %1\n}\n`);
    expect(() => structure(fn)).toThrow(StructureError);
    expect(() => structure(fn)).toThrow('unmodelled instruction');
  });
  test("assertResolved stays the backstop for any OTHER '?' producer", () => {
    const sfn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      retType: { kind: 'int', width: 32, signed: true },
      body: [{ k: 'return', value: { k: 'var', name: '?' } }],
    };
    expect(() => assertResolved(sfn)).toThrow(ContractError);
  });
  test('passes on a well-lowered function', () => {
    const fn = parse(`fn f {\n^bb0(%0: s32):\n  %1: s32 = add %0, %0\n  ret %1\n}\n`);
    expect(() => assertResolved(structure(fn))).not.toThrow();
  });
});

describe('all three entry paths run the contracts in production (no false positive)', () => {
  const { obj, asm } = compileMipsTarget('int cf(int x){ return x + 1; }', 'cf');
  test('decompile', () => {
    expect(() => decompile('cf', asm, MIPS_IDO)).not.toThrow();
  });
  test('decompileRanked', () => {
    expect(() => decompileRanked('cf', asm, MIPS_IDO, obj)).not.toThrow();
  });
  test('decompileWithReport', () => {
    expect(() => decompileWithReport('cf', asm, MIPS_IDO, { targetObj: obj })).not.toThrow();
  });
});
