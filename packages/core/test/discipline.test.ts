// ir/discipline.ts — the questions every pass asks of an op about where, and how often, it runs.
// Each question is pinned as a table over one op of every kind that answers differently, built
// from IR text, so a placement stamp (`volatile`, `helper`, `declaredVolatile`) is asked about exactly
// as a pass sees it.
import { describe, expect, test } from 'vitest';

import type { Op } from '../src/ir/core';
import {
  carryDiscipline,
  counted,
  deletableWhenDead,
  effectful,
  forgetHelperPlacement,
  orderSensitive,
  placedAt,
  qualified,
  qualifiedBy,
  reevalUnsafe,
  speculationUnsafe,
  spelledWhenDead,
} from '../src/ir/discipline';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';

const IR = `fn kinds {
^bb0(%0: u32, %1: s32, %2: s32):
  %3: s32 = load %0 {off=0, signed=false, width=2}
  %4: s32 = load %0 {off=4, signed=false, width=2, volatile=true}
  %5: s32 = aload %0, %1 {elemSize=4, signed=true}
  %6: s32 = aload %0, %1 {elemSize=4, signed=true, volatile=true}
  %13: s32 = load %0 {off=6, signed=false, width=2, declaredVolatile=true}
  %14: s32 = aload %0, %1 {elemSize=4, signed=true, declaredVolatile=true}
  store %0, %1 {off=8, width=4}
  store %0, %1 {off=12, width=4, volatile=true}
  store %0, %1 {off=16, width=4, declaredVolatile=true}
  astore %0, %1, %2 {elemSize=4}
  %7: s32 = sdiv %1, %2
  %8: s32 = sdiv %1, %2 {helper="__divsi3"}
  %9: s32 = call %1 {target="sink"}
  %12: s32 = opaque %1 {helper="__unmodelled", text="bl __unmodelled"}
  %10: s32 = laddr {off=16, width=4, signed=true, count=1, volatile=true}
  %11: s32 = add %1, %2
  ret %11
}
`;

/** Each op of {@link IR} by a name that says what it is. */
function kinds(): Record<string, Op> {
  const fn = parse(IR);
  verify(fn);
  const [
    load,
    pinnedLoad,
    aload,
    pinnedAload,
    declaredLoad,
    declaredAload,
    store,
    pinnedStore,
    declaredStore,
    astore,
    sdiv,
    helperSdiv,
    call,
    opaque,
    laddr,
    add,
    ret,
  ] = fn.blocks[0].ops;
  return {
    load,
    pinnedLoad,
    aload,
    pinnedAload,
    declaredLoad,
    declaredAload,
    store,
    pinnedStore,
    declaredStore,
    astore,
    sdiv,
    helperSdiv,
    call,
    opaque,
    laddr,
    add,
    ret,
  };
}

/** The ops a question answers yes for, by name, sorted. */
const yesFor = (q: (op: Op) => boolean): string[] =>
  Object.entries(kinds())
    .filter(([, op]) => q(op))
    .map(([name]) => name)
    .sort();

describe('placedAt', () => {
  test('names a call, a helper-stamped value op, a volatile memory access and a declared one, and nothing else', () => {
    const ops = kinds();
    expect(Object.fromEntries(Object.entries(ops).map(([name, op]) => [name, placedAt(op)]))).toEqual({
      load: null,
      pinnedLoad: 'device',
      aload: null,
      pinnedAload: 'device',
      declaredLoad: 'declared',
      declaredAload: 'declared',
      store: null,
      pinnedStore: 'device',
      declaredStore: 'declared',
      astore: null,
      sdiv: null,
      helperSdiv: 'helper',
      call: 'call',
      // the helper an `opaque` names is the call nothing could fold, not a value op's placement
      opaque: null,
      // a frame object's `volatile` is a declaration qualifier, not an access
      laddr: null,
      add: null,
      ret: null,
    });
  });
});

describe('the questions', () => {
  test('effectful: a write, a call, an unmodelled instruction — a placement adds nothing', () => {
    expect(yesFor(effectful)).toEqual(['astore', 'call', 'declaredStore', 'opaque', 'pinnedStore', 'store']);
  });

  test('deletableWhenDead: every pure value and plain read, but not a qualified read', () => {
    expect(yesFor(deletableWhenDead)).toEqual(['add', 'aload', 'helperSdiv', 'laddr', 'load', 'sdiv']);
  });

  test('spelledWhenDead: every effect and every read, qualified or not', () => {
    expect(yesFor(spelledWhenDead)).toEqual([
      'aload',
      'astore',
      'call',
      'declaredAload',
      'declaredLoad',
      'declaredStore',
      'load',
      'opaque',
      'pinnedAload',
      'pinnedLoad',
      'pinnedStore',
      'store',
    ]);
  });

  test('speculationUnsafe: every effect and a qualified read, but not a plain read or a helper value', () => {
    expect(yesFor(speculationUnsafe)).toEqual([
      'astore',
      'call',
      'declaredAload',
      'declaredLoad',
      'declaredStore',
      'opaque',
      'pinnedAload',
      'pinnedLoad',
      'pinnedStore',
      'store',
    ]);
  });

  test('orderSensitive: every effect and every read, and no divide', () => {
    expect(yesFor(orderSensitive)).toEqual(yesFor(spelledWhenDead));
  });

  test('reevalUnsafe: orderSensitive plus the trapping divides, stamped or not', () => {
    expect(yesFor(reevalUnsafe)).toEqual([...yesFor(orderSensitive), 'helperSdiv', 'sdiv'].sort());
  });

  test('counted: a call and every qualified access, but not a helper value', () => {
    expect(yesFor(counted)).toEqual([
      'call',
      'declaredAload',
      'declaredLoad',
      'declaredStore',
      'pinnedAload',
      'pinnedLoad',
      'pinnedStore',
    ]);
  });
});

describe('qualifiedBy', () => {
  test('a device access carries its qualifier on a cast, a declared one through its declaration', () => {
    const ops = kinds();
    const by = Object.fromEntries(
      Object.entries(ops)
        .filter(([, op]) => qualifiedBy(op) !== null)
        .map(([name, op]) => [name, qualifiedBy(op)]),
    );
    expect(by).toEqual({
      pinnedLoad: 'cast',
      pinnedAload: 'cast',
      pinnedStore: 'cast',
      declaredLoad: 'declaration',
      declaredAload: 'declaration',
      declaredStore: 'declaration',
    });
    expect(yesFor(qualified)).toEqual(Object.keys(by).sort());
  });
});

describe('forgetHelperPlacement', () => {
  test('drops the helper stamp from a value op and leaves its other attrs', () => {
    const { helperSdiv } = kinds();
    expect(forgetHelperPlacement(helperSdiv)).toBe(helperSdiv);
    expect(placedAt(helperSdiv)).toBeNull();
    expect(helperSdiv.attrs).toEqual({});
  });

  test('does not touch the helper an opaque names, or a device access', () => {
    const { opaque, pinnedLoad } = kinds();
    forgetHelperPlacement(opaque);
    forgetHelperPlacement(pinnedLoad);
    expect(opaque.attrs.helper).toBe('__unmodelled');
    expect(placedAt(pinnedLoad)).toBe('device');
  });
});

describe('carryDiscipline', () => {
  test('adds the placement of the op a rebuilt op stands for, and nothing else of it', () => {
    const { pinnedLoad, declaredLoad, helperSdiv, load, call } = kinds();
    expect(carryDiscipline(pinnedLoad, { elemSize: 2 })).toEqual({ elemSize: 2, volatile: true });
    expect(carryDiscipline(declaredLoad, { elemSize: 2 })).toEqual({ elemSize: 2, declaredVolatile: true });
    expect(carryDiscipline(helperSdiv, { imm: 4 })).toEqual({ imm: 4, helper: '__divsi3' });
    expect(carryDiscipline(load, { elemSize: 2 })).toEqual({ elemSize: 2 });
    // a call's placement is its opcode, which the rebuilt op does not inherit
    expect(carryDiscipline(call, {})).toEqual({});
  });
});
