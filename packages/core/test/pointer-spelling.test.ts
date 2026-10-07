// UNIT tests for the pointer/integer spelling of operands (structure/pointer-spelling.ts): whether
// a value is written as a pointer or as an integer, and through which cast. Each case builds the
// facts structure() hands the factory — the map's declarations, the globals the IR loads as a
// pointer or as a word, the declared variable types — and the IR op being spelled, and pins what
// the rules spell for them today. The compiled evidence for each spelling stays with the
// end-to-end suites (pointer-members.test.ts, ptrcell.test.ts, deref-typing.test.ts).
import { describe, expect, test } from 'vitest';

import { type Op, mkOp, mkValue } from '../src/ir/core';
import { type IrType, T } from '../src/ir/types';
import type { BinOp, Expr } from '../src/l3/ast';
import { makePointerSpelling } from '../src/structure/pointer-spelling';
import { ARITH_TO_BIN } from '../src/structure/structure';
import { type SymbolInfo, declaredFields, pointeeFields } from '../src/symbols';

interface Fixture {
  /** the project map's entries; absent ⇒ no map */
  map?: SymbolInfo[];
  pointerGlobals?: string[];
  pointerLoaded?: string[];
  wordLoaded?: string[];
  varType?: Record<string, IrType>;
}
// The map lookup as structure() builds it from a SymbolMap: by name, a struct global seating its
// own members and a pointer global its pointee's.
const make = (f: Fixture = {}) => {
  const byName = new Map((f.map ?? []).map((si) => [si.name, si]));
  return makePointerSpelling({
    sym:
      f.map === undefined
        ? undefined
        : {
            info: (n) => byName.get(n),
            fieldsOf: (n) => {
              const si = byName.get(n);
              return si?.shape === 'struct'
                ? declaredFields(si.layout)
                : si?.shape === 'pointer'
                  ? pointeeFields(si.pointee)
                  : null;
            },
          },
    pointerGlobals: f.pointerGlobals === undefined ? undefined : new Set(f.pointerGlobals),
    pointerLoadedGlobals: new Set(f.pointerLoaded ?? []),
    wordLoadedGlobals: new Set(f.wordLoaded ?? []),
    varType: new Map(Object.entries(f.varType ?? {})),
  });
};

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const addr = (name: string): Expr => ({ k: 'addr', name });
const cast = (to: IrType, e: Expr): Expr => ({ k: 'cast', to, e });
const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const bytes = (e: Expr): Expr => cast(T.ptr(T.u(8)), e);
const word = (e: Expr): Expr => cast(T.u(32), e);

/** A two-operand integer arithmetic op whose result the IR types `result`. */
const arithOp = (opcode: 'add' | 'sub' | 'and', result: IrType): Op =>
  mkOp(opcode, { operands: [mkValue(T.u(32)), mkValue(T.u(32))], results: [mkValue(result)] });
const spell = (s: ReturnType<typeof make>, d: Op, l: Expr, r: Expr) => s.arith(d, ARITH_TO_BIN[d.opcode], l, r);

const ptrInfo = (name: string): SymbolInfo => ({ name, kind: 'data', declared: true, shape: 'pointer', size: 4 });
const u16Info = (name: string, over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  name,
  kind: 'data',
  declared: true,
  shape: 'scalar',
  size: 2,
  signed: false,
  ...over,
});

describe('needsIntSpelling', () => {
  test('a pointer-typed local, a bare address and an undeclared pointer-loaded global need the integer', () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { a0: T.ptr(T.u(16)) } });
    expect(s.needsIntSpelling(v('a0'))).toBe(true);
    expect(s.needsIntSpelling(addr('gArr'))).toBe(true);
    expect(s.needsIntSpelling(v('gPtr'))).toBe(true);
  });

  test('an integer local, and a pointer-loaded global the map declares a scalar, take `-` as spelled', () => {
    const s = make({ map: [u16Info('gPtr')], pointerLoaded: ['gPtr'], varType: { a0: T.s(32) } });
    expect(s.needsIntSpelling(v('a0'))).toBe(false);
    expect(s.needsIntSpelling(v('gPtr'))).toBe(false);
  });

  test('a global the map declares a pointer needs it whatever the IR loaded it as', () => {
    expect(make({ map: [ptrInfo('gP')] }).needsIntSpelling(v('gP'))).toBe(true);
    expect(make({ pointerGlobals: ['gP'] }).needsIntSpelling(v('gP'))).toBe(true);
  });
});

describe('intoDeclaredTemp', () => {
  test("a pointer global value goes into a declared temp through the temp's own type", () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { v0: T.ptr(T.u(16)) } });
    expect(s.intoDeclaredTemp('v0', v('gPtr'))).toEqual(cast(T.ptr(T.u(16)), v('gPtr')));
  });

  test('a name with no declared type takes the value as it is', () => {
    expect(make({ pointerLoaded: ['gPtr'] }).intoDeclaredTemp('v9', v('gPtr'))).toEqual(v('gPtr'));
  });

  test('a rendered pointer of another type is cast, one of the same type is not', () => {
    const s = make({ varType: { v0: T.ptr(T.s(32)), a0: T.ptr(T.s(32)) } });
    expect(s.intoDeclaredTemp('v0', bytes(v('a0')))).toEqual(cast(T.ptr(T.s(32)), bytes(v('a0'))));
    expect(s.intoDeclaredTemp('v0', v('a0'))).toEqual(v('a0'));
  });

  test("`&g` stays bare only where the map declares g a plain scalar of the temp's pointee", () => {
    const into = (si: SymbolInfo | undefined, t: IrType) =>
      make({ map: si === undefined ? [] : [si], varType: { v0: t } }).intoDeclaredTemp('v0', addr('gS'));
    expect(into(u16Info('gS'), T.ptr(T.u(16)))).toEqual(addr('gS'));
    expect(into(u16Info('gS', { volatile: true }), T.ptr(T.u(16)))).toEqual(cast(T.ptr(T.u(16)), addr('gS')));
    expect(into(u16Info('gS'), T.ptr(T.s(16)))).toEqual(cast(T.ptr(T.s(16)), addr('gS')));
    expect(into(undefined, T.ptr(T.u(16)))).toEqual(cast(T.ptr(T.u(16)), addr('gS')));
  });

  test('an integer temp takes a pointer value through its integer type', () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { v0: T.u(32) } });
    expect(s.intoDeclaredTemp('v0', v('gPtr'))).toEqual(word(v('gPtr')));
  });
});

describe('intoPtrCell', () => {
  test('a pointer value stored into a pointer cell goes through `void *`', () => {
    const s = make({ pointerLoaded: ['gCell', 'gPtr'], varType: { a0: T.ptr(T.u(16)) } });
    expect(s.intoPtrCell(v('gCell'), v('a0'))).toEqual(cast(T.ptr(T.void()), v('a0')));
    expect(s.intoPtrCell(v('gCell'), v('gPtr'))).toEqual(cast(T.ptr(T.void()), v('gPtr')));
  });

  test('a `void *` value, an integer value and a cell that is no pointer value are left alone', () => {
    const s = make({ pointerLoaded: ['gCell'], varType: { a0: T.ptr(T.void()), a1: T.s(32) } });
    expect(s.intoPtrCell(v('gCell'), v('a0'))).toEqual(v('a0'));
    expect(s.intoPtrCell(v('gCell'), v('a1'))).toEqual(v('a1'));
    expect(s.intoPtrCell(v('gWord'), v('a0'))).toEqual(v('a0'));
  });
});

describe('ptrGlobalSide', () => {
  test('a pointer-loaded global no map declares is a pointer side of any sum', () => {
    const s = make({ pointerLoaded: ['gPtr'] });
    expect(s.ptrGlobalSide(v('gPtr'), arithOp('add', T.u(32)))).toBe(true);
  });

  test('a word-loaded global is one only in a sum the IR types a pointer', () => {
    const s = make({ wordLoaded: ['gW'] });
    expect(s.ptrGlobalSide(v('gW'), arithOp('add', T.ptr(T.u(8))))).toBe(true);
    expect(s.ptrGlobalSide(v('gW'), arithOp('add', T.u(32)))).toBe(false);
  });

  test('a global the map declares is not, nor is anything but a bare global', () => {
    const s = make({ map: [ptrInfo('gP')], pointerLoaded: ['gP', 'gPtr'] });
    expect(s.ptrGlobalSide(v('gP'), arithOp('add', T.u(32)))).toBe(false);
    expect(s.ptrGlobalSide(bytes(v('gPtr')), arithOp('add', T.u(32)))).toBe(false);
  });

  test('a `pointerGlobals` name with no map entry is a pointer side', () => {
    const s = make({ pointerGlobals: ['gP'], pointerLoaded: ['gP'] });
    expect(s.ptrGlobalSide(v('gP'), arithOp('add', T.u(32)))).toBe(true);
  });
});

describe('arith: the pointer stride of a rendered pointer', () => {
  const s = make({ varType: { a0: T.ptr(T.s(32)), a1: T.s(32), a2: T.ptr(T.u(16)), a3: T.ptr(T.s(32)) } });
  const add = arithOp('add', T.ptr(T.s(32)));

  test('an exact byte constant becomes an element count, on either side', () => {
    expect(spell(s, add, v('a0'), c(8))).toEqual({ l: v('a0'), r: c(2), restoreTo: undefined });
    expect(spell(s, add, c(8), v('a0'))).toEqual({ l: c(2), r: v('a0'), restoreTo: undefined });
  });

  test('an inexact byte constant walks a byte pointer and is not cast back', () => {
    expect(spell(s, add, v('a0'), c(6))).toEqual({ l: bytes(v('a0')), r: c(6), restoreTo: undefined });
  });

  test('a runtime offset walks a byte pointer and the sum goes back to the pointer type', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(16))), v('a2'), v('a1'))).toEqual({
      l: bytes(v('a2')),
      r: v('a1'),
      restoreTo: T.ptr(T.u(16)),
    });
  });

  test('a pointer difference is the byte count', () => {
    expect(spell(s, arithOp('sub', T.s(32)), v('a0'), v('a3'))).toEqual({
      l: bytes(v('a0')),
      r: bytes(v('a3')),
      restoreTo: undefined,
    });
  });
});

describe('arith: the integer legalizations', () => {
  test('a non-additive operator takes a rendered pointer as an `s32`', () => {
    const s = make({ varType: { a0: T.ptr(T.u(8)) } });
    expect(spell(s, arithOp('and', T.u(32)), v('a0'), c(3))).toEqual({
      l: cast(T.s(32), v('a0')),
      r: c(3),
      restoreTo: undefined,
    });
  });

  test('`int - ptr` takes the subtrahend as an `s32`', () => {
    const s = make({ varType: { a0: T.ptr(T.u(8)), a1: T.s(32) } });
    expect(spell(s, arithOp('sub', T.s(32)), v('a1'), v('a0'))).toEqual({
      l: v('a1'),
      r: cast(T.s(32), v('a0')),
      restoreTo: undefined,
    });
  });

  test('a bare global address is added as the `u32` it is', () => {
    const s = make({ varType: { a1: T.s(32) } });
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), addr('gArr'), v('a1'))).toEqual({
      l: word(addr('gArr')),
      r: v('a1'),
      restoreTo: undefined,
    });
  });

  test('a non-additive operator takes a pointer global value as its word', () => {
    const s = make({ pointerLoaded: ['gPtr'] });
    expect(spell(s, arithOp('and', T.u(32)), v('gPtr'), c(3))).toEqual({
      l: word(v('gPtr')),
      r: c(3),
      restoreTo: undefined,
    });
  });
});

describe('arith: a pointer global value', () => {
  const s = make({ map: [ptrInfo('gP')], pointerLoaded: ['gPtr', 'gP'], varType: { a1: T.s(32) } });

  test('plus a constant is byte arithmetic on the value', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gPtr'), c(16))).toEqual({
      l: bytes(v('gPtr')),
      r: c(16),
      restoreTo: undefined,
    });
  });

  test('an undeclared one plus a runtime offset is the integer sum, cast back to a byte pointer', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gPtr'), v('a1'))).toEqual({
      l: word(v('gPtr')),
      r: v('a1'),
      restoreTo: T.ptr(T.u(8)),
    });
  });

  test('a map-declared one plus a runtime offset keeps the byte pointer for the member spellings', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gP'), v('a1'))).toEqual({
      l: bytes(v('gP')),
      r: v('a1'),
      restoreTo: undefined,
    });
  });

  test('an undeclared one right of an integer is added as an integer in that order', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), v('gPtr'))).toEqual({
      l: v('a1'),
      r: word(v('gPtr')),
      restoreTo: T.ptr(T.u(8)),
    });
  });

  test('a map-declared one right of an integer is the byte pointer, in that order', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), v('gP'))).toEqual({
      l: v('a1'),
      r: bytes(v('gP')),
      restoreTo: undefined,
    });
  });
});

describe('arith: a word-loaded global no declaration types', () => {
  const s = make({ wordLoaded: ['gW', 'gB2', 'gB3'], pointerLoaded: ['gPtr'], varType: { a1: T.s(32) } });

  test('is the base of a sum the IR types a pointer, as its word through `(u8 *)`', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gW'), v('a1'))).toEqual({
      l: word(bytes(v('gW'))),
      r: v('a1'),
      restoreTo: T.ptr(T.u(8)),
    });
  });

  test('is left as spelled in a sum the IR types an integer', () => {
    expect(spell(s, arithOp('add', T.u(32)), v('gW'), v('a1'))).toEqual({
      l: v('gW'),
      r: v('a1'),
      restoreTo: undefined,
    });
  });

  test('subtracted as a sum from a byte sum, each global goes its word', () => {
    const byteSum = bin('+', bytes(v('gPtr')), v('a1'));
    expect(spell(s, arithOp('sub', T.u(32)), byteSum, bin('-', v('gB2'), v('gB3')))).toEqual({
      l: byteSum,
      r: bin('-', word(bytes(v('gB2'))), word(bytes(v('gB3')))),
      restoreTo: undefined,
    });
  });
});

describe('arith: a byte sum the rule already spelled', () => {
  const s = make({ pointerLoaded: ['gPtr'], varType: { a1: T.s(32) } });

  test('right of an integer, it is added as the integer it also is', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), bin('+', bytes(v('gPtr')), c(4)))).toEqual({
      l: v('a1'),
      r: bin('+', word(v('gPtr')), c(4)),
      restoreTo: T.ptr(T.u(8)),
    });
  });

  test('as the subtrahend of `int - ptr`, the restored integer sum is taken unwrapped', () => {
    const restored = bytes(bin('+', word(v('gPtr')), v('a1')));
    expect(spell(s, arithOp('sub', T.s(32)), c(100), restored)).toEqual({
      l: c(100),
      r: bin('+', word(v('gPtr')), v('a1')),
      restoreTo: undefined,
    });
  });
});
