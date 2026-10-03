// The call declarations a frontend reads a callee's declaration through (`callDeclarations`), and
// the plan they make of one call. `thumb-stages.test.ts` drives the Thumb call lowering that reads it.
import { describe, expect, test } from 'vitest';

import { type CallLowering, callDeclarations } from '../src/frontend/call-plan';
import { FrontendUnsupportedError } from '../src/frontend/errors';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC } from '../src/target';

const EVERY: CallLowering = { pairs: true, memoryReturn: true, stackArgs: true, voidReturn: true };
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

describe('callDeclarations.plan for a lowering with no pair, no memory return and no stack argument', () => {
  const NONE: CallLowering = { pairs: false, memoryReturn: false, stackArgs: false, voidReturn: false };
  const ppcCalls = (prototypes: Prototypes) => callDeclarations('f', PPC_MWCC, prototypes, NONE, fail);
  // twelve bytes, which mwcc returns through memory
  const S12 = { kind: 'struct' as const, members: ['a', 'b', 'c'].map((name) => ({ name, type: 's32' })) };

  test('refuses a struct returned through memory before anything else is asked', () => {
    const calls = ppcCalls({ mk: { params: ['long long'], returns: 'struct S12', returnLayout: S12 } });
    expect(() => calls.plan('mk')).toThrow(
      "cannot lift 'f': 'mk' is declared to return struct S12 by value — a struct returned through a hidden pointer, " +
        'or one nothing here can size, is not modelled',
    );
  });

  test('refuses a struct return nothing here can size', () => {
    const calls = ppcCalls({ mk: { params: ['s32'], returns: 'struct Opaque' } });
    expect(() => calls.plan('mk')).toThrow(/^cannot lift 'f': 'mk' is declared to return struct Opaque by value — /);
  });

  test('plans a struct returned in registers as one leaving the return register holding nothing', () => {
    const calls = ppcCalls({ mv: { params: ['s32'], returns: 'struct One', returnLayout: ONE } });
    expect(calls.plan('mv')).toMatchObject({
      widths: [32],
      returns: { kind: 'register-struct' },
      clobbers: [...calls.callClobbers, 'r3'],
    });
  });

  test('refuses a parameter declared wider than a register', () => {
    const calls = ppcCalls({ llsink: { params: ['s32', 'long long'] } });
    expect(() => calls.plan('llsink')).toThrow(
      "cannot lift 'f': one half of a 64-bit value would be handed to 'llsink' — its parameter 2 is declared wider " +
        'than a register, and this frontend passes each argument register as its own value rather than building ' +
        'the pair the ABI passes it in',
    );
  });

  test('refuses more parameters than the argument registers carry', () => {
    const calls = ppcCalls({ g9: { params: Array(9).fill('int') } });
    expect(() => calls.plan('g9')).toThrow(
      "cannot lift 'f': outgoing stack arguments not modelled — 'g9' is declared with 9 parameters and the " +
        'argument registers carry 8, so the rest travel in its parameter area on the stack',
    );
    expect(ppcCalls({ g8: { params: Array(8).fill('int') } }).plan('g8').widths).toHaveLength(8);
  });

  test('refuses a return declared wider than a register', () => {
    const calls = ppcCalls({ g: { params: [], returns: 'long long' } });
    expect(() => calls.plan('g')).toThrow(
      "cannot lift 'f': 'g' would hand back one half of a 64-bit value — its return is declared wider than a " +
        'register, and this frontend reads the return register as the whole value rather than building the pair ' +
        'the ABI hands back',
    );
  });

  test('plans a 64-bit runtime helper as an undeclared call', () => {
    const calls = ppcCalls({});
    expect(calls.plan('__div2i')).toEqual({
      callee: '__div2i',
      wideHelper: null,
      declared: null,
      widths: null,
      returns: { kind: 'word' },
      clobbers: calls.callClobbers,
    });
  });

  test("leaves a 64-bit return a project declares on a runtime helper's name to the table", () => {
    const calls = ppcCalls({ __div2i: { params: ['s32', 's32'], returns: 'long long' } });
    expect(calls.plan('__div2i')).toMatchObject({ widths: [32, 32], returns: { kind: 'word' } });
  });

  test('sizes an undeclared `memcpy` by the signature the C standard fixes', () => {
    expect(ppcCalls({}).plan('memcpy').widths).toEqual([32, 32, 32]);
  });
});

describe('callDeclarations.plan for a callee declared void', () => {
  const O32: CallLowering = { pairs: false, memoryReturn: false, stackArgs: true, voidReturn: true };
  const mipsCalls = (prototypes: Prototypes, lowering = O32) =>
    callDeclarations('f', MIPS_IDO, prototypes, lowering, fail);

  test('plans no value, and the return register among what the call destroys', () => {
    for (const g of [
      { params: ['s32'], returnsVoid: true },
      { params: ['s32'], returns: 'void' },
    ]) {
      const calls = mipsCalls({ g });
      expect(calls.plan('g')).toMatchObject({
        widths: [32],
        returns: { kind: 'void' },
        clobbers: [...calls.callClobbers, 'v0'],
      });
    }
  });

  test('plans a word where the lowering writes the return register for every call', () => {
    const calls = mipsCalls({ g: { params: ['s32'], returnsVoid: true } }, { ...O32, voidReturn: false });
    expect(calls.plan('g')).toMatchObject({ returns: { kind: 'word' }, clobbers: calls.callClobbers });
  });

  test("leaves a runtime helper's return to its table", () => {
    const calls = mipsCalls({ __ll_div: { params: ['s32'], returnsVoid: true } });
    expect(calls.plan('__ll_div').returns).toEqual({ kind: 'word' });
  });
});

describe('callDeclarations.plan for a callee declared with a float', () => {
  test('refuses one where the target passes floats in its FPU', () => {
    const NONE: CallLowering = { pairs: false, memoryReturn: false, stackArgs: false, voidReturn: false };
    const calls = callDeclarations(
      'f',
      PPC_MWCC,
      { r: { params: ['s32'], returns: 'float' }, p: { params: ['s32', 'volatile double'] } },
      NONE,
      fail,
    );
    expect(() => calls.plan('r')).toThrow(
      "cannot lift 'f': 'r' is declared to return float, which comes back in f1 — the floating-point registers a " +
        'call passes and returns in are not modelled',
    );
    expect(() => calls.plan('p')).toThrow(
      "cannot lift 'f': 'p' is declared to take volatile double as its parameter 2, which travels in the FPU's " +
        'registers — the floating-point registers a call passes and returns in are not modelled',
    );
  });

  test('plans one where the target passes floats in general registers', () => {
    expect(thumbCalls({ g: { params: ['float'], returns: 'float' } }).plan('g').returns).toEqual({ kind: 'word' });
  });
});
