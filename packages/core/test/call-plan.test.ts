// The call declarations a frontend reads a callee's declaration through (`callDeclarations`), and
// the plan they make of one call. `thumb-stages.test.ts` drives the Thumb call lowering that reads it.
import { describe, expect, test } from 'vitest';

import { type CallLowering, callDeclarations } from '../src/frontend/call-plan';
import { FrontendUnsupportedError } from '../src/frontend/errors';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';

const EVERY: CallLowering = { pairs: true, memoryReturn: true, stackArgs: true };
const fail = (message: string): never => {
  throw new FrontendUnsupportedError(message);
};
const thumbCalls = (prototypes: Prototypes) => callDeclarations('f', ARMV4T_AGBCC, prototypes, EVERY, fail);

// four bytes, which agbcc returns through memory; one word, which it returns in r0
const S4 = { kind: 'struct' as const, members: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u8' })) };
const ONE = { kind: 'struct' as const, members: [{ name: 'a', type: 's32' }] };

describe('callDeclarations', () => {
  test('places a `long long` in two argument words, the second one staged', () => {
    const { declaredCall } = thumbCalls({
      g: { params: ['s32', 's32', 's32', 'long long'] },
    });
    expect(declaredCall('g')).toEqual({ widths: [32, 32, 32, 64], doubles: new Set(), block: [0], params: 4 });
  });

  test('puts the hidden pointer of a struct returned through memory first', () => {
    const { declaredCall } = thumbCalls({
      mk4: { params: ['s32'], returns: 'struct S4', returnLayout: S4 },
    });
    const declared = declaredCall('mk4');
    expect(declared).toMatchObject({ widths: [32, 32], block: null, params: 1 });
    expect(declared?.returned).toMatchObject({ type: { kind: 'struct' } });
  });

  test('answers a struct returned in r0 with no arity stated', () => {
    const calls = thumbCalls({ mv: { returns: 'struct One', returnLayout: ONE } });
    expect(calls.declaredCall('mv')).toBeNull();
    expect(calls.registerStructReturn('mv')).toBe('register');
  });

  test('declares nothing for a callee no table names', () => {
    const calls = thumbCalls({});
    expect(calls.declaredCall('g')).toBeNull();
    expect(calls.returnsPair('g')).toBe(false);
  });

  test("lets a project's re-declaration of a runtime helper disable its pair", () => {
    const declared = thumbCalls({});
    expect(declared.wideHelper('__muldi3')).not.toBeNull();
    expect(declared.returnsPair('__muldi3')).toBe(true);
    const redeclared = thumbCalls({
      __muldi3: { params: ['s64', 's64'], returns: 's64' },
    });
    expect(redeclared.wideHelper('__muldi3')).toBeNull();
    expect(redeclared.returnsPair('__muldi3')).toBe(false);
  });

  test("answers a project callee's pair return from its declared return width", () => {
    const calls = thumbCalls({
      g: { params: ['s32'], returns: 'long long' },
      h: { params: ['s32'], returns: 's32' },
      __divsi3: { params: ['s32', 's32'], returns: 'long long' },
    });
    expect(calls.returnsPair('g')).toBe(true);
    expect(calls.returnsPair('h')).toBe(false);
    // a name the runtime table carries is answered by the table alone
    expect(calls.returnsPair('__divsi3')).toBe(false);
  });

  test("names the runtime's soft-float helpers, and nothing else, as float helpers", () => {
    const calls = thumbCalls({});
    expect(calls.isFloatHelper('__adddf3')).toBe(true);
    expect(calls.isFloatHelper('__muldi3')).toBe(false);
    expect(calls.isFloatHelper('g')).toBe(false);
    expect(calls.isFloatHelper('toString')).toBe(false);
  });

  test("answers whether a callee's declaration rules out a hidden return pointer", () => {
    const calls = thumbCalls({
      g: { params: 1, returnsVoid: true },
      h: { params: [] },
    });
    expect(calls.returnsWithoutHiddenPointer('g')).toBe(true);
    expect(calls.returnsWithoutHiddenPointer('h')).toBe(false);
    expect(calls.returnsWithoutHiddenPointer('k')).toBe(false);
    // a signature the C standard fixes
    expect(calls.returnsWithoutHiddenPointer('memcpy')).toBe(true);
  });

  test("leaves a pair-returning call's high register out of what it clobbers", () => {
    const { callClobbers, pairReturnClobbers } = thumbCalls({});
    expect(callClobbers).toContain('r1');
    expect(pairReturnClobbers).toEqual(callClobbers.filter((r) => r !== 'r1'));
  });
});

describe('callDeclarations.plan', () => {
  test("answers a runtime helper's call from its table, before any declaration is asked", () => {
    const calls = thumbCalls({ __muldi3: { returns: 'struct S4', returnLayout: S4 } });
    expect(() => calls.declaredCall('__muldi3')).toThrow(/through a hidden pointer in r0/);
    expect(calls.plan('__muldi3')).toMatchObject({
      wideHelper: { params: [64, 64], returns: 64 },
      declared: null,
      widths: [64, 64],
      returns: { kind: 'pair' },
      clobbers: calls.pairReturnClobbers,
    });
  });

  test('puts the hidden pointer first and types the call as the struct it returns through memory', () => {
    const calls = thumbCalls({ mk4: { params: ['s32'], returns: 'struct S4', returnLayout: S4 } });
    const plan = calls.plan('mk4');
    expect(plan.widths).toEqual([32, 32]);
    expect(plan.returns).toMatchObject({ kind: 'memory-struct', type: { kind: 'struct', declared: 'struct S4' } });
    expect(plan.clobbers).toEqual([...calls.callClobbers, 'r0']);
  });

  test('plans a struct returned in r0 with no arity stated, leaving r0 holding nothing', () => {
    const calls = thumbCalls({ mv: { returns: 'struct One', returnLayout: ONE } });
    expect(calls.plan('mv')).toEqual({
      callee: 'mv',
      wideHelper: null,
      declared: null,
      widths: null,
      returns: { kind: 'register-struct' },
      clobbers: [...calls.callClobbers, 'r0'],
    });
  });

  test("returns a project callee's declared pair, and plans a word for an undeclared one", () => {
    const calls = thumbCalls({ g: { params: ['s32'], returns: 'long long' } });
    expect(calls.plan('g')).toMatchObject({
      widths: [32],
      returns: { kind: 'pair' },
      clobbers: calls.pairReturnClobbers,
    });
    expect(calls.plan('h')).toMatchObject({ widths: null, returns: { kind: 'word' }, clobbers: calls.callClobbers });
  });

  test("refuses through the frontend's own `fail` where the declaration refuses", () => {
    const calls = thumbCalls({ mk4: { returns: 'struct S4', returnLayout: S4 } });
    expect(() => calls.plan('mk4')).toThrow(FrontendUnsupportedError);
    expect(() => calls.plan('mk4')).toThrow(
      /returns struct S4 through a hidden pointer in r0, and its parameters are not all sized/,
    );
  });

  test('refuses a callee declared to return a struct and a 64-bit value', () => {
    const calls = thumbCalls({ g: { params: ['s32'], returns: 's64', returnLayout: ONE } });
    expect(() => calls.plan('g')).toThrow(
      "cannot lift 'f': `g` is declared to return both a struct or union and a 64-bit value",
    );
  });

  test('refuses a lowering that builds pairs on a target whose return register is not argument 0', () => {
    expect(() => callDeclarations('f', MIPS_IDO, {}, EVERY, fail)).toThrow(
      /^target 'mips': a lowering that builds pairs needs the return register to be the first argument register, and v0 is not a0$/,
    );
    expect(() => callDeclarations('f', MIPS_IDO, {}, { ...EVERY, pairs: false }, fail)).not.toThrow();
  });
});
