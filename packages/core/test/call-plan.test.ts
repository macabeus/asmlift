// The call declarations a frontend reads a callee's declaration through (`callDeclarations`), the
// plan they make of one call and the call they lower it to (`lower`), each tested here.
import { describe, expect, test } from 'vitest';

import { type CallLowering, type CallPairs, callDeclarations } from '../src/frontend/call-plan';
import { FrontendUnsupportedError } from '../src/frontend/errors';
import { type SsaBuilder, makeSsaBuilder } from '../src/frontend/ssa';
import { type Value, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC } from '../src/target';

const EVERY: CallLowering = {
  pairs: true,
  memoryReturn: true,
  stackArgs: true,
  voidReturn: true,
  argRegisterBoundsArity: true,
};
const fail = (message: string): never => {
  throw new FrontendUnsupportedError(message);
};
const thumbCalls = (prototypes: Prototypes) => callDeclarations('f', ARMV4T_AGBCC, prototypes, EVERY, fail);

// four bytes, which agbcc returns through memory; one word, which it returns in r0
const S4 = { kind: 'struct' as const, members: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u8' })) };
const ONE = { kind: 'struct' as const, members: [{ name: 'a', type: 's32' }] };

describe('callDeclarations', () => {
  test('sizes a `long long` as one 64-bit argument', () => {
    const { declaredCall } = thumbCalls({
      g: { params: ['s32', 's32', 's32', 'long long'] },
    });
    expect(declaredCall('g')).toEqual({ widths: [32, 32, 32, 64], doubles: new Set(), params: 4 });
  });

  test('puts the hidden pointer of a struct returned through memory first', () => {
    const { declaredCall } = thumbCalls({
      mk4: { params: ['s32'], returns: 'struct S4', returnLayout: S4 },
    });
    const declared = declaredCall('mk4');
    expect(declared).toMatchObject({ widths: [32, 32], params: 1 });
    expect(declared?.returned).toMatchObject({ type: { kind: 'struct' } });
  });

  test('declares nothing for a callee no table names', () => {
    expect(thumbCalls({}).declaredCall('g')).toBeNull();
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
});

describe('callDeclarations.plan', () => {
  // what a call that hands back a pair leaves: everything else it clobbers, the high half aside
  const pairClobbers = (calls: { callClobbers: readonly string[] }) => calls.callClobbers.filter((r) => r !== 'r1');

  test("answers a runtime helper's call from its table, before any declaration is asked", () => {
    const calls = thumbCalls({ __muldi3: { returns: 'struct S4', returnLayout: S4 } });
    expect(() => calls.declaredCall('__muldi3')).toThrow(/through a hidden pointer in r0/);
    expect(calls.plan('__muldi3')).toEqual({
      widths: [64, 64],
      doubles: new Set(),
      returns: { kind: 'pair' },
      clobbers: pairClobbers(calls),
      declaredVoid: false,
    });
  });

  test("lets a project's re-declaration of a runtime helper disable its pair", () => {
    const calls = thumbCalls({ __muldi3: { params: ['s64', 's64'], returns: 's64' } });
    expect(calls.plan('__muldi3')).toMatchObject({
      widths: [64, 64],
      returns: { kind: 'word' },
      clobbers: calls.callClobbers,
    });
  });

  test("answers a project callee's pair return from its declared return width", () => {
    const calls = thumbCalls({
      g: { params: ['s32'], returns: 'long long' },
      h: { params: ['s32'], returns: 's32' },
      __divsi3: { params: ['s32', 's32'], returns: 'long long' },
    });
    expect(calls.plan('g').returns).toEqual({ kind: 'pair' });
    expect(calls.plan('h').returns).toEqual({ kind: 'word' });
    // a name the runtime table carries is answered by the table alone
    expect(calls.plan('__divsi3').returns).toEqual({ kind: 'word' });
  });

  test('plans the doubles its declaration types', () => {
    expect(thumbCalls({ g: { params: ['s32', 'double'] } }).plan('g')).toMatchObject({
      widths: [32, 64],
      doubles: new Set([1]),
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
    expect(calls.declaredCall('mv')).toBeNull();
    expect(calls.plan('mv')).toEqual({
      widths: null,
      doubles: new Set(),
      returns: { kind: 'register-struct' },
      clobbers: [...calls.callClobbers, 'r0'],
      declaredVoid: false,
    });
  });

  test("returns a project callee's declared pair, and plans a word for an undeclared one", () => {
    const calls = thumbCalls({ g: { params: ['s32'], returns: 'long long' } });
    expect(calls.plan('g')).toMatchObject({
      widths: [32],
      returns: { kind: 'pair' },
      clobbers: pairClobbers(calls),
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
  const NONE: CallLowering = {
    pairs: false,
    memoryReturn: false,
    stackArgs: false,
    voidReturn: false,
    argRegisterBoundsArity: false,
  };
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
      widths: null,
      doubles: new Set(),
      returns: { kind: 'word' },
      clobbers: calls.callClobbers,
      declaredVoid: false,
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

describe('callDeclarations.lower', () => {
  const NONE: CallLowering = {
    pairs: false,
    memoryReturn: false,
    stackArgs: false,
    voidReturn: false,
    argRegisterBoundsArity: false,
  };
  /** a call to `callee` made in a one-block function */
  const site = (callee: string) => {
    const ssa = makeSsaBuilder('f', 1, [[]]);
    return {
      callee,
      ssa,
      bi: 0,
      read: (r: string) => ssa.readVar(r, 0),
      write: (r: string, v: Value) => ssa.writeVar(r, 0, v),
      stackWord: (k: number) => ssa.readVar(`stack${k}`, 0),
    };
  };
  const miswired = (target: string) =>
    `target '${target}': a call site's pairs and stack words must be what its lowering states`;
  /** pairs built and split in block 0, as Thumb builds them */
  const pairsIn = (ssa: SsaBuilder): CallPairs => {
    const halfOf = new Map<Value, { whole: Value; half: 'lo' | 'hi' }>();
    const emit = (opcode: 'concat' | 'lo32' | 'hi32', operands: Value[], bits: number) => {
      const v = mkValue(T.unk(bits));
      ssa.irBlocks[0].ops.push(mkOp(opcode, { operands, results: [v] }));
      return v;
    };
    return {
      fuse: (lo, hi) => emit('concat', [lo, hi], 64),
      project: (whole, half) => {
        const v = emit(half === 'lo' ? 'lo32' : 'hi32', [whole], 32);
        halfOf.set(v, { whole, half });
        return v;
      },
      halfOf,
    };
  };

  test('lowers a call whose site is wired as its lowering states', () => {
    const { stackWord: _, ...s } = site('g');
    callDeclarations('f', PPC_MWCC, { g: { params: ['s32'] } }, NONE, fail).lower(s);
    expect(s.ssa.irBlocks[0].ops.map((op) => [op.opcode, op.attrs.target, op.operands.length])).toEqual([
      ['call', 'g', 1],
    ]);
  });

  test('passes a call through argument register N the N registers below it where the lowering states it', () => {
    const { stackWord: _, ...s } = site('g');
    const address = s.ssa.readVar('r2', 0);
    callDeclarations('f', ARMV4T_AGBCC, {}, { ...NONE, argRegisterBoundsArity: true }, fail).lower({
      ...s,
      callee: { address, reg: 'r2' },
    });
    const [call] = s.ssa.irBlocks[0].ops;
    expect([call.attrs.indirect, call.operands.length, call.operands.at(-1)]).toEqual([true, 3, address]);
  });

  test('guesses the arity of a call through an argument register where the lowering does not bound it', () => {
    // o32 calls `g(1.5f, 3)` through a0 with the float in $f12 and the int in a1: a0 bounds nothing
    const O32: CallLowering = {
      pairs: false,
      memoryReturn: false,
      stackArgs: true,
      voidReturn: true,
      argRegisterBoundsArity: false,
    };
    const s = site('g');
    const address = s.ssa.readVar('a0', 0);
    const three = mkValue(T.unk(32));
    s.ssa.writeVar('a1', 0, three);
    let guessed: number | undefined;
    const guess = { at: 0, refuse: (argc: number) => void (guessed = argc) };
    callDeclarations('f', MIPS_IDO, {}, O32, fail).lower({ ...s, guess, callee: { address, reg: 'a0' } });
    const [call] = s.ssa.irBlocks[0].ops;
    expect([guessed, call.operands.includes(three)]).toEqual([2, true]);
  });

  test('refuses a site that places stack words for a lowering that reads none', () => {
    const lower = () => callDeclarations('f', PPC_MWCC, { g: { params: ['s32'] } }, NONE, fail).lower(site('g'));
    // a frontend wired against its own lowering is a bug in the frontend, not a function it declines
    expect(lower).toThrow(miswired('ppc'));
    expect(lower).not.toThrow(FrontendUnsupportedError);
  });

  test('refuses a site that builds no pair for a lowering that builds them', () => {
    expect(() => thumbCalls({ g: { params: ['s32'] } }).lower(site('g'))).toThrow(miswired('armv4t'));
  });

  test('refuses a site that places no stack word for a lowering that reads them', () => {
    const O32: CallLowering = {
      pairs: false,
      memoryReturn: false,
      stackArgs: true,
      voidReturn: true,
      argRegisterBoundsArity: false,
    };
    const { stackWord: _, ...s } = site('g');
    const calls = callDeclarations('f', MIPS_IDO, { g: { params: Array(5).fill('int') } }, O32, fail);
    expect(() => calls.lower(s)).toThrow(miswired('mips'));
  });

  test('refuses a site that builds pairs for a lowering that builds none', () => {
    const { stackWord: _, ...s } = site('g');
    const lower = () =>
      callDeclarations('f', PPC_MWCC, { g: { params: ['s32'] } }, NONE, fail).lower({ ...s, pairs: pairsIn(s.ssa) });
    expect(lower).toThrow(miswired('ppc'));
  });
});

describe('callDeclarations.plan for a callee declared void', () => {
  const O32: CallLowering = {
    pairs: false,
    memoryReturn: false,
    stackArgs: true,
    voidReturn: true,
    argRegisterBoundsArity: false,
  };
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
        declaredVoid: true,
      });
    }
  });

  test('plans a word where the lowering writes the return register for every call', () => {
    const calls = mipsCalls({ g: { params: ['s32'], returnsVoid: true } }, { ...O32, voidReturn: false });
    // …and still says it is declared void, which the lowering's own value does not
    expect(calls.plan('g')).toMatchObject({
      returns: { kind: 'word' },
      clobbers: calls.callClobbers,
      declaredVoid: true,
    });
  });

  test("leaves a runtime helper's return to its table", () => {
    const calls = mipsCalls({ __ll_div: { params: ['s32'], returnsVoid: true } });
    expect(calls.plan('__ll_div')).toMatchObject({ returns: { kind: 'word' }, declaredVoid: false });
  });
});

describe('callDeclarations.plan for a callee declared with a float', () => {
  test('refuses one where the target passes floats in its FPU', () => {
    const NONE: CallLowering = {
      pairs: false,
      memoryReturn: false,
      stackArgs: false,
      voidReturn: false,
      argRegisterBoundsArity: false,
    };
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

  test('refuses one declared through the floating typedefs every project declares', () => {
    const O32: CallLowering = {
      pairs: false,
      memoryReturn: false,
      stackArgs: true,
      voidReturn: true,
      argRegisterBoundsArity: false,
    };
    const calls = callDeclarations(
      'f',
      MIPS_IDO,
      { r: { params: ['s32'], returns: 'f32' }, p: { params: ['const f64'], returnsVoid: true } },
      O32,
      fail,
    );
    expect(() => calls.plan('r')).toThrow(
      /^cannot lift 'f': 'r' is declared to return f32, which comes back in \$f0 — /,
    );
    expect(() => calls.plan('p')).toThrow(
      /^cannot lift 'f': 'p' is declared to take const f64 as its parameter 1, which travels in the FPU's registers — /,
    );
  });

  test('plans one where the target passes floats in general registers', () => {
    expect(thumbCalls({ g: { params: ['float'], returns: 'float' } }).plan('g').returns).toEqual({ kind: 'word' });
  });
});
